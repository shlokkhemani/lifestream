import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as shapes from "../packages/home/search-contract.js";
import {
  bool, contractText, day, int, list, month, named, nullable, num, object, oneOf, PAGES, tagged, text, When, type Move, type PageContract, type PageShape, type Settled,
} from "../packages/home/pages.js";
import { againstReleases, FILES, generated, phoneFloor, releasesOf, settingsScriptOf, settingsSwiftOf, shrinks, type Release } from "./pages.js";
import { SETTINGS_ANSWERS, SETTINGS_INDEX } from "../packages/home/page-settings.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Members = Readonly<Record<string, PageShape<unknown>>>;

const demo = (members: Members, flags: { route?: string; moves?: readonly Move[]; today?: boolean; settled?: Settled | null } = {}): PageContract<unknown> => ({
  route: flags.route ?? "/v1/page/demo",
  shape: object({ position: text(), today: day, ...members }) as PageShape<unknown>,
  today: flags.today ?? false,
  device: false,
  moves: flags.moves ?? [],
  settled: flags.settled ?? null,
  models: false,
});

const refusal = (pages: Readonly<Record<string, PageContract<unknown>>>): string => {
  try {
    generated(pages);
  } catch (error) {
    return (error as Error).message;
  }
  return "no refusal";
};

const outside = (shape: shapes.Shape<unknown>): PageShape<unknown> => shape as PageShape<unknown>;

describe("tools/pages.ts writes", () => {
  it("the five files as they are in the tree", () => {
    for (const [file, made] of Object.entries(generated())) expect(readFileSync(join(ROOT, file), "utf8"), file).toBe(made);
  });

  it("byte-equal files from the same PAGES", () => {
    expect(generated(PAGES)).toEqual(generated(PAGES));
    expect(Object.keys(generated())).toEqual([FILES.swift, FILES.types, FILES.contract, FILES.settingsSwift, FILES.settingsScript]);
  });

  it("the Settings skeleton into both apps, every entry of every kind in order", async () => {
    const script = join(mkdtempSync(join(tmpdir(), "settings-index-")), "settings-index.mjs");
    roots.push(dirname(script));
    writeFileSync(script, settingsScriptOf());
    expect((await import(script) as { SETTINGS_INDEX: unknown }).SETTINGS_INDEX).toEqual(SETTINGS_INDEX);
    const swift = settingsSwiftOf();
    for (const [kind, groups] of Object.entries(SETTINGS_INDEX)) {
      let at = swift.indexOf(`public static let ${kind}: [Group] = [`);
      expect(at, kind).toBeGreaterThan(0);
      for (const each of groups.flatMap((group) => group.entries)) {
        const next = swift.indexOf(`Entry(id: ${JSON.stringify(each.id)}, label: ${JSON.stringify(each.label)}, icon: ${JSON.stringify(each.icon)}, host: ${each.host}, answer: .${each.answer})`, at);
        expect(next, `${kind} ${each.id}`).toBeGreaterThan(at);
        at = next;
      }
    }
  });

  it("the answers' cases into both apps from SETTINGS_ANSWERS, one each", () => {
    const swift = settingsSwiftOf();
    const script = settingsScriptOf();
    for (const answer of SETTINGS_ANSWERS) {
      expect(swift.split("\n").filter((line) => line.trim() === `case ${answer}`), answer).toHaveLength(1);
      expect(script, answer).toContain(`'${answer}'`);
    }
    expect(script.split("\n")[0]).toBe(`/** @typedef {${SETTINGS_ANSWERS.map((each) => `'${each}'`).join(" | ")}} SettingsAnswer */`);
  });

  it("each page's schema in the contract as its parser's own, the hiding leaves left out", () => {
    const contract = JSON.parse(generated()[FILES.contract]!) as { pages: Record<string, { schema: unknown }> };
    for (const [name, each] of Object.entries(PAGES)) {
      const parser = JSON.parse(JSON.stringify(each.shape.schema, (key, value: unknown) => (key === "leaf" && typeof value === "string" ? undefined : value)));
      expect(contract.pages[name]!.schema, name).toEqual(parser);
    }
  });

  it("an Optional for a nullable, an unknown case for each oneOf and tagged", () => {
    const swift = generated({ demo: demo({ at: nullable(When), state: oneOf("on", "not_asked"), chip: tagged("kind", { none: {}, words: { words: text(), seen_ms: int() } }) }) })[FILES.swift]!;
    expect(swift).toContain("public let at: When?");
    expect(swift).toContain("self.at = try container.decodeNil(forKey: .at) ? nil : container.decode(When.self, forKey: .at)");
    expect(swift).toContain("case notAsked = \"not_asked\"\n                case unknown");
    expect(swift).toContain("self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown");
    expect(swift).toContain("case none\n                case words(words: String, seenMs: Int)\n                case unknown");
    expect(swift).toContain("default:\n                        self = .unknown");
    expect(swift).toContain("case at(atMs: Int)");
  });

  it("the same shapes as TypeScript, a tagged as a union on its tag", () => {
    const types = generated({ demo: demo({ at: nullable(When), states: list(oneOf("on", "off")) }) })[FILES.types]!;
    expect(types).toContain('export type When =\n  | {\n    kind: "day";\n    day: string;\n  }');
    expect(types).toContain("  at: When | null;\n");
    expect(types).toContain('  states: ("on" | "off")[];\n');
    expect(types).toContain("export interface Pages {\n  demo: Demo;\n}");
  });
});

describe("tools/pages.ts refuses, naming the page and the member", () => {
  const inner = (shape: PageShape<unknown>) => ({ demo: demo({ head: object({ a: shape }) }) });

  it.each([
    ["an either", outside(shapes.either(shapes.int(), shapes.text()))],
    ["a map", outside(shapes.map(shapes.int()))],
    ["a tuple", outside(shapes.tuple(shapes.int(), shapes.int()))],
    ["an endingIn", outside(shapes.endingIn(shapes.int(), shapes.text()))],
    ["an object with optional members", outside(shapes.object({ a: shapes.int() }, { b: shapes.int() }))],
    ["a rule, or a shape pages.ts did not make", outside(shapes.rule(int(), () => null))],
  ])("%s", (what, shape) => {
    expect(refusal(inner(shape))).toBe(`page demo, member head.a: ${what} is not in the page language`);
  });

  it("a search-contract shape inside a page shape", () => {
    expect(refusal(inner(list(outside(shapes.text()))))).toBe("page demo, member head.a[]: a rule, or a shape pages.ts did not make is not in the page language");
  });

  it("a nullable of a nullable", () => {
    expect(refusal(inner(nullable(nullable(int()))))).toBe("page demo, member head.a: a nullable of a nullable");
  });

  it("a tagged case holding its tag", () => {
    expect(refusal(inner(tagged("kind", { day: { kind: text() } })))).toBe("page demo, member head.a(day).kind: a case holds a member named as its tag, kind");
  });

  it("one name given to two shapes", () => {
    expect(refusal({ demo: demo({ a: named("Thing", object({ x: int() })), b: named("Thing", object({ x: int() })) }) })).toBe("page demo, member b: the name Thing is given to two shapes");
  });

  it("a name given to a list", () => {
    expect(refusal(inner(named("Things", list(int()))))).toBe("page demo, member head.a: Things names a list; a name is given to an object, a oneOf or a tagged");
  });

  it("a oneOf naming a value twice", () => {
    expect(refusal(inner(oneOf("on", "on")))).toBe('page demo, member head.a: a oneOf names "on" twice');
  });

  it("a value named unknown", () => {
    expect(refusal(inner(oneOf("on", "unknown")))).toBe('page demo, member head.a: the value "unknown" takes the name unknown, which every oneOf keeps for a value it does not know');
  });

  it("two values that make one Swift name", () => {
    expect(refusal(inner(oneOf("not-asked", "not_asked")))).toBe("page demo, member head.a.not_asked: the values not-asked and not_asked make one Swift name, notAsked");
  });

  it("a member that makes no Swift name", () => {
    expect(refusal({ demo: demo({ atMs: int() }) })).toBe('page demo, member atMs: the member "atMs" makes no Swift name; members are lower-case words joined by _');
  });

  it("two members that make one Swift name", () => {
    expect(refusal({ demo: demo({ x_1: int(), x1: int() }) })).toBe("page demo, member x1: the members x_1 and x1 make one Swift name, x1");
  });

  it("a nested type Swift holds", () => {
    expect(refusal(inner(object({ type: oneOf("one") })))).toBe("page demo, member head.a.type: its Swift type would be named Type, which Swift holds; name the shape");
  });

  it("a nested type that would hide a named shape", () => {
    expect(refusal({ demo: demo({ when: nullable(When), head: object({ when: object({ x: int() }) }) }) })).toBe("page demo, member head.when: its Swift type would be named When, a named shape's or a page's name; name the shape");
  });

  it("an object with no members", () => {
    expect(refusal(inner(object({})))).toBe("page demo, member head.a: an object with no members");
  });

  it("a page whose moves and today disagree", () => {
    expect(refusal({ demo: demo({}, { today: true }) })).toBe("page demo, its answer: it depends on today, so its moves name today");
    expect(refusal({ demo: demo({}, { moves: ["today"] }) })).toBe("page demo, its answer: its moves name today, so it depends on today");
  });

  it("a settled page without counting", () => {
    expect(refusal({ demo: demo({}, { settled: "people", moves: ["people"] }) })).toBe("page demo, member counting: a page with settled carries counting, true or false");
    expect(refusal({ demo: demo({ counting: bool }, { settled: "people" }) })).toBe("page demo, its answer: it is settled by people, so its moves name people");
  });

  it("two pages on one route", () => {
    expect(refusal({ demo: demo({}), other: demo({}) })).toBe("page other, its answer: the route /v1/page/demo is page demo's too");
  });

  it("a page member named route", () => {
    expect(refusal({ demo: demo({ route: text() }) })).toBe("page demo, member route: a page answer's member route would hide the page's route in Swift");
  });
});

const contractOf = (members: Members, route?: string) => contractText({ demo: demo(members, route === undefined ? {} : { route }) });

describe("a page answer changes by adding", () => {
  const Thing = named("Thing", object({ a: int(), b: nullable(text()) }));
  const ReleasedWhen = named("When", tagged("kind", { day: { day }, month: { month }, at: { at_ms: int() } }));
  const before = contractOf({ count: int(), state: oneOf("on", "off"), when: nullable(ReleasedWhen), thing: Thing, things: list(Thing), day });

  it("so members, values and tags may be added, and a nullable may become always present", () => {
    const Wider = named("Thing", object({ a: int(), b: text(), c: bool }));
    const after = contractOf({
      count: int(), state: oneOf("on", "off", "paused"), when: nullable(named("When", tagged("kind", { day: { day }, month: { month }, at: { at_ms: int() }, week: { week: text() } }))),
      thing: Wider, things: list(Wider), day, more: num,
    });
    expect(shrinks(before, after)).toEqual([]);
    expect(shrinks(before, before)).toEqual([]);
    expect(shrinks(before, contractOf({ count: int(), state: oneOf("on", "off"), when: nullable(When), thing: Thing, things: list(Thing), day }))).toEqual([]);
  });

  it("and a member removed, a value or tag removed, or a member retyped is refused", () => {
    const Narrower = named("Thing", object({ b: nullable(int()) }));
    const after = contractOf({
      count: text(), state: oneOf("on"), when: nullable(named("When", tagged("kind", { day: { day }, month: { month } }))), thing: Narrower, things: list(Narrower), day: text(),
    });
    expect(shrinks(before, after)).toEqual([
      "page demo, member count: was a whole number, is text",
      'page demo, member state: the value "off" is removed',
      'page demo, member when: the tag "at" is removed',
      "page demo, member thing.a: removed",
      "page demo, member thing.b: was text, is a whole number",
      "page demo, member things[].a: removed",
      "page demo, member things[].b: was text, is a whole number",
      "page demo, member day: was text matching ^\\d{4}-\\d{2}-\\d{2}$, is any text",
    ]);
  });

  it("and a member that may now be null is refused", () => {
    expect(shrinks(before, contractOf({ count: nullable(int()), state: oneOf("on", "off"), when: nullable(ReleasedWhen), thing: Thing, things: list(Thing), day }))).toEqual(["page demo, member count: may now be null, which it never was"]);
  });

  it("and a page removed or moved is refused", () => {
    expect(shrinks(before, contractText({ other: demo({}) }))).toEqual(["page demo: removed"]);
    expect(shrinks(contractOf({}), contractOf({}, "/v1/page/moved"))).toEqual(["page demo: its route was /v1/page/demo, is /v1/page/moved"]);
  });
});

describe("the comparison with phone releases", () => {
  const was = contractOf({ count: int(), line: text() });
  const now = contractOf({ count: int() });
  const release = (tag: string, version: string | null, contract: string | null): Release => ({ tag, version, contract });

  it("holds every release at or above floors.phone, and none below it or without the file", () => {
    expect(againstReleases(now, [release("phone-1", "0.2.0", was), release("phone-2", "0.3.0", null), release("phone-3", "0.3.0", was), release("phone-4", "0.4.0", now)], "0.3.0")).toEqual([
      `phone-3 (0.3.0) has page demo, member line: removed; a removal waits for floors.phone in packages/home/release.json to pass every release that has it`,
    ]);
  });

  it("refuses a release whose app version it cannot read", () => {
    expect(againstReleases(now, [release("phone-9", null, was)], "0.3.0")).toEqual(["phone-9: no app version in its ios-app/project.yml"]);
  });

  it("reads each phone tag's version and contract from git", () => {
    const root = mkdtempSync(join(tmpdir(), "pages-history-"));
    roots.push(root);
    const run = (...args: string[]) => {
      const done = spawnSync("git", ["-C", root, "-c", "user.name=Builder", "-c", "user.email=person-a@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
      expect(done.status, done.stderr).toBe(0);
    };
    const put = (path: string, body: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    };
    const project = (version: string) => `targets:\n  App:\n    info:\n      properties:\n        CFBundleShortVersionString: "${version}"\n`;
    run("init", "--quiet");
    put("ios-app/project.yml", project("0.2.0"));
    put(FILES.contract, was);
    run("add", "-A");
    run("commit", "--quiet", "-m", "one");
    run("tag", "phone-1");
    put("ios-app/project.yml", project("0.3.0"));
    rmSync(join(root, FILES.contract));
    run("add", "-A");
    run("commit", "--quiet", "-m", "two");
    run("tag", "phone-2");
    put("ios-app/project.yml", project("0.4.0"));
    put(FILES.contract, was);
    run("add", "-A");
    run("commit", "--quiet", "-m", "three");
    run("tag", "phone-3");
    run("tag", "mac-3");
    const releases = releasesOf(root);
    expect(releases.map(({ tag, version, contract }) => [tag, version, contract === null ? null : contract === was])).toEqual([["phone-1", "0.2.0", true], ["phone-2", "0.3.0", null], ["phone-3", "0.4.0", true]]);
    expect(againstReleases(now, releases, "0.3.0")).toEqual([
      `phone-3 (0.4.0) has page demo, member line: removed; a removal waits for floors.phone in packages/home/release.json to pass every release that has it`,
    ]);
    expect(againstReleases(was, releases, "0.3.0")).toEqual([]);
  });

  it("passes this tree against its own phone tags", () => {
    expect(againstReleases(contractText(), releasesOf(ROOT), phoneFloor(ROOT))).toEqual([]);
  });
});
