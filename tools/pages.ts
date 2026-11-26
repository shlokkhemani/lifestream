import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "@lifestreamprotocol/core";
import { contractText, describe, PAGES, PageShapeError, type Contract, type Described, type Member, type PageContract } from "../packages/home/pages.js";
import { SETTINGS_ANSWERS, SETTINGS_INDEX, type SettingsEntry, type SettingsGroup } from "../packages/home/page-settings.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const FILES = {
  swift: "homelink/Sources/HomeLink/Pages.swift",
  types: "dashboard/public/pages.d.ts",
  contract: "packages/home/contract/pages.json",
  settingsSwift: "homelink/Sources/HomeLink/SettingsIndex.swift",
  settingsScript: "dashboard/public/settings-index.js",
} as const;

const PROJECT = "ios-app/project.yml";
const RELEASE = "packages/home/release.json";

const MEMBER = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const VALUE = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)*$/u;
const PAGE_NAME = /^[a-z][a-zA-Z0-9]*$/u;

const SWIFT_KEYWORDS = new Set([
  "associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout", "internal", "let", "open",
  "operator", "private", "precedencegroup", "protocol", "public", "rethrows", "static", "struct", "subscript", "typealias", "var", "break",
  "case", "catch", "continue", "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return", "throw",
  "switch", "where", "while", "as", "Any", "false", "is", "nil", "self", "Self", "super", "throws", "true", "try",
]);
const RESERVED_TYPES = new Set([
  "Any", "Array", "Bool", "Decodable", "Decoder", "Double", "Equatable", "Error", "HomeLink", "Int", "Keys", "Optional", "Pages", "Protocol",
  "Self", "Sendable", "String", "Type",
]);

export const camel = (snake: string): string => snake.replace(/[_.-]([a-z0-9])/gu, (_, next: string) => next.toUpperCase());
const pascal = (snake: string): string => {
  const made = camel(snake);
  return made.charAt(0).toUpperCase() + made.slice(1);
};
const singular = (word: string): string =>
  word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 1 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
const ident = (name: string): string => (SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name);
const LABEL_KEYWORDS = new Set(["inout", "let", "var"]);
const label = (name: string): string => (LABEL_KEYWORDS.has(name) ? `\`${name}\`` : name);
const indented = (lines: readonly string[], by = "    "): string[] => lines.map((line) => (line === "" ? "" : `${by}${line}`));

interface Where {
  readonly page: string;
  readonly at: string;
}

const deeper = (where: Where, member: string): Where => ({ page: where.page, at: where.at === "" ? member : `${where.at}.${member}` });

function names(where: Where, members: readonly string[], what: string, rule: RegExp): Map<string, string> {
  const made = new Map<string, string>();
  for (const member of members) {
    if (!rule.test(member)) throw new PageShapeError(where.page, deeper(where, member).at, `the ${what} ${JSON.stringify(member)} makes no Swift name; ${what}s are lower-case words joined by ${rule === MEMBER ? "_" : "_, . or -"}`);
    const swift = camel(member);
    const clash = [...made].find(([, held]) => held === swift);
    if (clash !== undefined) throw new PageShapeError(where.page, deeper(where, member).at, `the ${what}s ${clash[0]} and ${member} make one Swift name, ${swift}`);
    made.set(member, swift);
  }
  return made;
}

class Swift {
  constructor(private readonly top: ReadonlySet<string>) {}

  private claim(hint: string, where: Where, taken: Set<string>, ancestors: readonly string[]): string {
    if (RESERVED_TYPES.has(hint)) throw new PageShapeError(where.page, where.at, `its Swift type would be named ${hint}, which Swift holds; name the shape`);
    if (this.top.has(hint)) throw new PageShapeError(where.page, where.at, `its Swift type would be named ${hint}, a named shape's or a page's name; name the shape`);
    if (ancestors.includes(hint)) throw new PageShapeError(where.page, where.at, `its Swift type would be named ${hint}, as a type that holds it; name the shape`);
    if (taken.has(hint)) throw new PageShapeError(where.page, where.at, `its Swift type would be named ${hint}, as another type beside it; name the shape`);
    taken.add(hint);
    return hint;
  }

  private type(shape: Described, hint: string, where: Where, taken: Set<string>, ancestors: readonly string[], nested: string[][]): string {
    switch (shape.of) {
      case "text":
        return "String";
      case "int":
        return "Int";
      case "num":
        return "Double";
      case "bool":
        return "Bool";
      case "ref":
        return shape.name;
      case "kept":
        throw new PageShapeError(where.page, where.at, "a kept value stands only as a member of an object");
      case "list":
        return `[${this.type(shape.each, singular(hint), where, taken, ancestors, nested)}]`;
      case "nullable":
        return `${this.type(shape.inner, hint, where, taken, ancestors, nested)}?`;
      case "object":
      case "enum":
      case "tagged": {
        const title = this.claim(hint, where, taken, ancestors);
        nested.push(this.declare(title, shape, where, ancestors));
        return title;
      }
    }
  }

  private decode(shape: Described, type: string, key: string): string {
    if (shape.of !== "nullable") return `container.decode(${type}.self, forKey: .${key})`;
    return `container.decodeNil(forKey: .${key}) ? nil : container.decode(${type.slice(0, -1)}.self, forKey: .${key})`;
  }

  private keys(swift: ReadonlyMap<string, string>): string[] {
    return ["private enum Keys: String, CodingKey {", ...indented([...swift].map(([json, name]) => (json === name ? `case ${ident(name)}` : `case ${ident(name)} = ${JSON.stringify(json)}`))), "}"];
  }

  declare(title: string, shape: Described, where: Where, ancestors: readonly string[], route?: string): string[] {
    const inside = [...ancestors, title];
    const taken = new Set<string>();
    const nested: string[][] = [];
    if (shape.of === "enum") {
      const swift = names(where, shape.values, "value", VALUE);
      const unknown = [...swift].find(([, name]) => name === "unknown");
      if (unknown !== undefined) throw new PageShapeError(where.page, where.at, `the value ${JSON.stringify(unknown[0])} takes the name unknown, which every oneOf keeps for a value it does not know`);
      return [
        `public enum ${title}: String, Decodable, Sendable, Equatable {`,
        ...indented([...swift].map(([json, name]) => (json === name ? `case ${ident(name)}` : `case ${ident(name)} = ${JSON.stringify(json)}`))),
        "    case unknown",
        "",
        "    public init(from decoder: Decoder) throws {",
        "        self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown",
        "    }",
        "}",
      ];
    }
    if (shape.of === "tagged") {
      const cases = names(where, shape.cases.map(([each]) => each), "tag", VALUE);
      const unknown = [...cases].find(([, name]) => name === "unknown");
      if (unknown !== undefined) throw new PageShapeError(where.page, where.at, `the tag ${JSON.stringify(unknown[0])} takes the name unknown, which every tagged keeps for a tag it does not know`);
      const keys = new Map<string, string>(names(where, [shape.tag], "member", MEMBER));
      const declared: string[] = [];
      const decoded: string[] = [];
      for (const [each, members] of shape.cases) {
        const at: Where = { page: where.page, at: `${where.at}(${each})` };
        const swift = names(at, typedOf(members).map(([member]) => member), "member", MEMBER);
        for (const [json, name] of swift) {
          const clash = [...keys].find(([held, other]) => other === name && held !== json);
          if (clash !== undefined) throw new PageShapeError(where.page, deeper(at, json).at, `the members ${clash[0]} and ${json} make one Swift name, ${name}`);
          if (name === camel(shape.tag)) throw new PageShapeError(where.page, deeper(at, json).at, `it takes the tag's Swift name, ${name}`);
          keys.set(json, name);
        }
        const typed = typedOf(members).map(([member, shaped]) => [member, shaped, this.type(shaped, pascal(member), deeper(at, member), taken, inside, nested)] as const);
        const name = ident(cases.get(each)!);
        declared.push(typed.length === 0 ? `case ${name}` : `case ${name}(${typed.map(([member, , type]) => `${ident(swift.get(member)!)}: ${type}`).join(", ")})`);
        decoded.push(`case ${JSON.stringify(each)}:`);
        if (typed.length === 0) decoded.push(`    self = .${name}`);
        else decoded.push(`    self = .${name}(`, ...typed.map(([member, shaped, type], index) =>
          `        ${label(swift.get(member)!)}: try ${this.decode(shaped, type, ident(keys.get(member)!))}${index === typed.length - 1 ? "" : ","}`), "    )");
      }
      return [
        `public enum ${title}: Decodable, Sendable, Equatable {`,
        ...indented(declared),
        "    case unknown",
        "",
        ...indented(this.keys(keys)),
        "",
        "    public init(from decoder: Decoder) throws {",
        "        let container = try decoder.container(keyedBy: Keys.self)",
        `        switch try container.decode(String.self, forKey: .${ident(keys.get(shape.tag)!)}) {`,
        ...indented(decoded, "        "),
        "        default:",
        "            self = .unknown",
        "        }",
        "    }",
        ...nested.flatMap((lines) => ["", ...indented(lines)]),
        "}",
      ];
    }
    if (shape.of !== "object") throw new PageShapeError(where.page, where.at, `a ${shape.of} makes no Swift type of its own`);
    if (shape.members.length === 0) throw new PageShapeError(where.page, where.at, "an object with no members");
    const swift = names(where, typedOf(shape.members).map(([member]) => member), "member", MEMBER);
    if (route !== undefined && swift.has("route")) throw new PageShapeError(where.page, "route", "a page answer's member route would hide the page's route in Swift");
    const typed = typedOf(shape.members).map(([member, shaped]) => [member, shaped, this.type(shaped, pascal(member), deeper(where, member), taken, inside, nested)] as const);
    return [
      `public struct ${title}: Decodable, Sendable, Equatable {`,
      ...route === undefined ? [] : [`    public static let route = ${JSON.stringify(route)}`, ""],
      ...indented(typed.map(([member, , type]) => `public let ${ident(swift.get(member)!)}: ${type}`)),
      "",
      ...indented(this.keys(swift)),
      "",
      "    public init(from decoder: Decoder) throws {",
      "        let container = try decoder.container(keyedBy: Keys.self)",
      ...indented(typed.map(([member, shaped, type]) => `self.${ident(swift.get(member)!)} = try ${this.decode(shaped, type, ident(swift.get(member)!))}`), "        "),
      "    }",
      ...nested.flatMap((lines) => ["", ...indented(lines)]),
      "}",
    ];
  }
}

const typedOf = (members: readonly Member[]): readonly Member[] => members.filter(([, shape]) => shape.of !== "kept");

function pageTitles(made: Contract): Map<string, string> {
  const titles = new Map<string, string>();
  for (const page of made.pages) {
    if (!PAGE_NAME.test(page.name)) throw new PageShapeError(page.name, "", "a page's name is a lower-case word, then letters and digits");
    const title = page.name.charAt(0).toUpperCase() + page.name.slice(1);
    if (RESERVED_TYPES.has(title)) throw new PageShapeError(page.name, "", `its Swift type would be named ${title}, which Swift holds`);
    const def = made.defs.find((each) => each.name === title);
    if (def !== undefined) throw new PageShapeError(page.name, "", `its type would be named ${title}, as the shape named at page ${def.page}, member ${def.at}`);
    titles.set(page.name, title);
  }
  for (const def of made.defs) if (RESERVED_TYPES.has(def.name)) throw new PageShapeError(def.page, def.at, `the name ${def.name} is held by Swift`);
  return titles;
}

export function swiftOf(made: Contract): string {
  const titles = pageTitles(made);
  const swift = new Swift(new Set([...made.defs.map((def) => def.name), ...titles.values()]));
  const types = [
    ...made.pages.map((page) => swift.declare(titles.get(page.name)!, { of: "object", members: page.members }, { page: page.name, at: "" }, [], page.route)),
    ...made.defs.map((def) => swift.declare(def.name, def.shape, { page: def.page, at: def.at }, [])),
  ];
  return [
    "import Foundation",
    "",
    "extension HomeLink {",
    "    public enum Pages {",
    ...types.flatMap((lines, index) => [...index === 0 ? [] : [""], ...indented(lines, "        ")]),
    "    }",
    "}",
    "",
  ].join("\n");
}

const unionish = (shape: Described): boolean =>
  shape.of === "nullable" || (shape.of === "enum" && shape.values.length > 1) || (shape.of === "tagged" && shape.cases.length > 1);

function tsObject(members: readonly Member[], indent: string): string {
  return `{\n${members.map(([member, shape]) => `${indent}  ${member}: ${tsType(shape, `${indent}  `)};`).join("\n")}\n${indent}}`;
}

function tsType(shape: Described, indent: string): string {
  switch (shape.of) {
    case "text":
      return "string";
    case "int":
    case "num":
      return "number";
    case "bool":
      return "boolean";
    case "ref":
      return shape.name;
    case "kept":
      return "unknown";
    case "enum":
      return shape.values.map((value) => JSON.stringify(value)).join(" | ");
    case "list":
      return unionish(shape.each) ? `(${tsType(shape.each, indent)})[]` : `${tsType(shape.each, indent)}[]`;
    case "nullable":
      return `${tsType(shape.inner, indent)} | null`;
    case "object":
      return tsObject(shape.members, indent);
    case "tagged":
      return shape.cases.map(([each, members]) => tsObject([[shape.tag, { of: "enum", values: [each] }], ...members], indent)).join(" | ");
  }
}

export function typesOf(made: Contract): string {
  const titles = pageTitles(made);
  const def = (name: string, shape: Described): string => {
    if (shape.of === "object") return `export interface ${name} ${tsObject(shape.members, "")}`;
    if (shape.of === "tagged") return `export type ${name} =\n${shape.cases.map(([each, members]) => `  | ${tsObject([[shape.tag, { of: "enum", values: [each] }], ...members], "  ")}`).join("\n")};`;
    return `export type ${name} = ${tsType(shape, "")};`;
  };
  return [
    ...made.defs.map((each) => def(each.name, each.shape)),
    ...made.pages.map((page) => def(titles.get(page.name)!, { of: "object", members: page.members })),
    `export interface Pages ${tsObject(made.pages.map((page) => [page.name, { of: "ref", name: titles.get(page.name)! }]), "")}`,
  ].join("\n\n").concat("\n");
}

type Index = Readonly<Record<string, readonly SettingsGroup[]>>;

export function settingsSwiftOf(index: Index = SETTINGS_INDEX): string {
  const entry = (each: SettingsEntry) =>
    `Entry(id: ${JSON.stringify(each.id)}, label: ${JSON.stringify(each.label)}, icon: ${JSON.stringify(each.icon)}, host: ${each.host}, answer: .${each.answer}),`;
  const groups = (kind: string, list: readonly SettingsGroup[]) => [
    `public static let ${kind}: [Group] = [`,
    ...list.flatMap((group) => [`    Group(label: ${JSON.stringify(group.label)}, entries: [`, ...group.entries.map((each) => `        ${entry(each)}`), "    ]),"]),
    "]",
  ];
  const body = [
    "public enum Answer: String, Sendable, Equatable {",
    ...SETTINGS_ANSWERS.map((each) => `    case ${each}`),
    "}",
    "",
    "public struct Entry: Sendable, Equatable {",
    "    public let id: String",
    "    public let label: String",
    "    public let icon: String",
    "    public let host: Bool",
    "    public let answer: Answer",
    "}",
    "",
    "public struct Group: Sendable, Equatable {",
    "    public let label: String",
    "    public let entries: [Entry]",
    "}",
    ...Object.entries(index).flatMap(([kind, list]) => ["", ...groups(kind, list)]),
  ];
  return ["import Foundation", "", "extension HomeLink {", "    public enum SettingsIndex {", ...indented(body, "        "), "    }", "}", ""].join("\n");
}

const quoted = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function settingsScriptOf(index: Index = SETTINGS_INDEX): string {
  const entry = (each: SettingsEntry) =>
    `{ id: ${quoted(each.id)}, label: ${quoted(each.label)}, icon: ${quoted(each.icon)}, host: ${each.host}, answer: ${quoted(each.answer)} },`;
  return [
    `/** @typedef {${SETTINGS_ANSWERS.map(quoted).join(" | ")}} SettingsAnswer */`,
    "/** @typedef {{ id: string, label: string, icon: string, host: boolean, answer: SettingsAnswer }} SettingsEntry */",
    "/** @typedef {{ label: string, entries: SettingsEntry[] }} SettingsGroup */",
    "",
    `/** @type {{ ${Object.keys(index).map((kind) => `${kind}: SettingsGroup[]`).join(", ")} }} */`,
    "export const SETTINGS_INDEX = {",
    ...Object.entries(index).flatMap(([kind, list]) => [
      `  ${kind}: [`,
      ...list.flatMap((group) => [`    { label: ${quoted(group.label)}, entries: [`, ...group.entries.map((each) => `      ${entry(each)}`), "    ] },"]),
      "  ],",
    ]),
    "};",
    "",
  ].join("\n");
}

export function generated(pages: Readonly<Record<string, PageContract<unknown>>> = PAGES): Record<string, string> {
  const made = describe(pages);
  return {
    [FILES.swift]: swiftOf(made), [FILES.types]: typesOf(made), [FILES.contract]: contractText(pages),
    [FILES.settingsSwift]: settingsSwiftOf(), [FILES.settingsScript]: settingsScriptOf(),
  };
}

type Json = { readonly [key: string]: unknown };

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function schemaAt(schema: unknown, at: string): Json {
  if (!isObject(schema)) throw new Error(`${at}: a schema is an object`);
  return schema;
}

const nullOf = (schema: Json): unknown | undefined =>
  Array.isArray(schema.anyOf) && schema.anyOf.length === 2 && schema.anyOf.some((each) => isObject(each) && each.type === "null")
    ? schema.anyOf.find((each) => !(isObject(each) && each.type === "null"))
    : undefined;

function kindOf(schema: Json): string {
  if (nullOf(schema) !== undefined) return "a nullable";
  if (Array.isArray(schema.anyOf) && isObject(schema.discriminator)) return "a tagged";
  if (Array.isArray(schema.enum)) return "a oneOf";
  if (schema.type === "object") return "an object";
  if (schema.type === "array") return "a list";
  if (schema.type === "string") return "text";
  if (schema.type === "integer") return "a whole number";
  if (schema.type === "number") return "a number";
  if (schema.type === "boolean") return "true or false";
  return "an unknown shape";
}

const casesOf = (schema: Json, tag: string): Map<string, Json> => new Map((schema.anyOf as unknown[]).filter(isObject).map((each) => {
  const named = isObject(each.properties) && isObject(each.properties[tag]) ? each.properties[tag].enum : undefined;
  return [Array.isArray(named) ? String(named[0]) : "", each] as const;
}));

function shrunk(was: unknown, now: unknown, page: string, at: string, found: string[]): void {
  const here = `page ${page}, ${at === "" ? "its answer" : `member ${at}`}`;
  const old = schemaAt(was, here);
  const fresh = schemaAt(now, here);
  const oldInner = nullOf(old);
  const freshInner = nullOf(fresh);
  if (oldInner !== undefined) {
    shrunk(oldInner, freshInner ?? fresh, page, at, found);
    return;
  }
  if (freshInner !== undefined) {
    found.push(`${here}: may now be null, which it never was`);
    return;
  }
  const kind = kindOf(old);
  if (kindOf(fresh) !== kind) {
    found.push(`${here}: was ${kind}, is ${kindOf(fresh)}`);
    return;
  }
  const member = (name: string): string => (at === "" ? name : `${at}.${name}`);
  switch (kind) {
    case "an object": {
      const before = isObject(old.properties) ? old.properties : {};
      const after = isObject(fresh.properties) ? fresh.properties : {};
      for (const [name, schema] of Object.entries(before)) {
        if (!Object.hasOwn(after, name)) found.push(`page ${page}, member ${member(name)}: removed`);
        else shrunk(schema, after[name], page, member(name), found);
      }
      return;
    }
    case "a list":
      shrunk(old.items, fresh.items, page, `${at}[]`, found);
      return;
    case "a oneOf": {
      const after = new Set(fresh.enum as unknown[]);
      for (const value of old.enum as unknown[]) if (!after.has(value)) found.push(`${here}: the value ${JSON.stringify(value)} is removed`);
      return;
    }
    case "a tagged": {
      const tag = String((old.discriminator as Json).propertyName);
      const freshTag = String((fresh.discriminator as Json).propertyName);
      if (tag !== freshTag) {
        found.push(`${here}: its tag was ${tag}, is ${freshTag}`);
        return;
      }
      const after = casesOf(fresh, tag);
      for (const [each, schema] of casesOf(old, tag)) {
        const held = after.get(each);
        if (held === undefined) found.push(`${here}: the tag ${JSON.stringify(each)} is removed`);
        else shrunk(schema, held, page, `${at}(${each})`, found);
      }
      return;
    }
    case "text":
      if (typeof old.pattern === "string" && old.pattern !== fresh.pattern) found.push(`${here}: was text matching ${old.pattern}, is ${typeof fresh.pattern === "string" ? `text matching ${fresh.pattern}` : "any text"}`);
      return;
    default:
      return;
  }
}

function parsedContract(text: string, what: string): Json {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what}: contract/pages.json is no JSON`);
  }
  if (!isObject(json) || !isObject(json.pages)) throw new Error(`${what}: contract/pages.json holds no pages`);
  return json.pages;
}

export function shrinks(was: string, now: string): string[] {
  const before = parsedContract(was, "the release's");
  const after = parsedContract(now, "this tree's");
  const found: string[] = [];
  for (const [page, held] of Object.entries(before)) {
    const fresh = after[page];
    if (!isObject(held)) continue;
    if (!isObject(fresh)) {
      found.push(`page ${page}: removed`);
      continue;
    }
    if (held.route !== fresh.route) found.push(`page ${page}: its route was ${String(held.route)}, is ${String(fresh.route)}`);
    shrunk(held.schema, fresh.schema, page, "", found);
  }
  return found;
}

export interface Release {
  readonly tag: string;
  readonly version: string | null;
  readonly contract: string | null;
}

const git = (root: string, args: readonly string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

export function versionOf(project: string): string | null {
  return /CFBundleShortVersionString:\s*["']?(\d+(?:\.\d+)*)["']?/u.exec(project)?.[1] ?? null;
}

export function releasesOf(root: string): Release[] {
  const listed = git(root, ["tag", "--list", "phone-*"]);
  if (listed.status !== 0) throw new Error(`git tag --list: ${listed.stderr.trim()}`);
  return listed.stdout.split("\n").filter((tag) => tag !== "").sort().map((tag) => {
    const project = git(root, ["show", `${tag}:${PROJECT}`]);
    const contract = git(root, ["show", `${tag}:${FILES.contract}`]);
    return { tag, version: project.status === 0 ? versionOf(project.stdout) : null, contract: contract.status === 0 ? contract.stdout : null };
  });
}

export function againstReleases(now: string, releases: readonly Release[], floor: string): string[] {
  return releases.flatMap((release) => {
    if (release.version === null) return [`${release.tag}: no app version in its ${PROJECT}`];
    if (compareVersions(release.version, floor) < 0 || release.contract === null) return [];
    try {
      return shrinks(release.contract, now).map((line) => `${release.tag} (${release.version}) has ${line}; a removal waits for floors.phone in ${RELEASE} to pass every release that has it`);
    } catch (error) {
      return [`${release.tag}: ${(error as Error).message}`];
    }
  });
}

export function phoneFloor(root: string): string {
  const floors = (JSON.parse(readFileSync(join(root, RELEASE), "utf8")) as { floors?: { phone?: unknown } }).floors;
  if (typeof floors?.phone !== "string") throw new Error(`${RELEASE} names no floors.phone`);
  return floors.phone;
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  let made: Record<string, string>;
  try {
    made = generated();
  } catch (error) {
    if (!(error instanceof PageShapeError)) throw error;
    process.stderr.write(`pages: ${error.message}\n`);
    return 1;
  }
  const faults: string[] = [];
  for (const [file, text] of Object.entries(made)) {
    const path = join(ROOT, file);
    if ((existsSync(path) ? readFileSync(path, "utf8") : null) === text) continue;
    if (check) faults.push(`${file} is not what PAGES makes`);
    else writeFileSync(path, text);
  }
  faults.push(...againstReleases(made[FILES.contract]!, releasesOf(ROOT), phoneFloor(ROOT)));
  for (const line of faults) process.stderr.write(`pages: ${line}\n`);
  if (faults.some((line) => line.endsWith("is not what PAGES makes"))) process.stderr.write("pages: run npx tsx tools/pages.ts\n");
  if (faults.length > 0) return 1;
  if (!check) process.stdout.write("pages: wrote the page contract\n");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
