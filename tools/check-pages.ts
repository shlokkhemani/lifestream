import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { PAGES } from "../packages/home/pages.js";

export const LANES = ["people", "days", "places", "search", "streams", "faces", "floor"] as const;
export type Lane = (typeof LANES)[number];

export interface Allowed {
  readonly route: string;
  readonly reason: string;
}

export interface Owed {
  readonly file: string;
  readonly route: string;
  readonly lane: Lane;
}

export interface StandIn {
  readonly file: string;
  readonly reason: string;
}

export type RelayKind = "swift" | "server" | "client";

export interface Relay {
  readonly path: string;
  readonly kind: RelayKind;
  readonly reason: string;
  readonly module?: true;
}

export interface Lists {
  readonly pages: readonly string[];
  readonly allowed: readonly Allowed[];
  readonly owed: readonly Owed[];
  readonly standIns: readonly StandIn[];
  readonly relays: readonly Relay[];
}

export interface Read {
  readonly file: string;
  readonly line: number;
  readonly route: string;
  readonly via?: string;
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: "refused" | "owed elsewhere" | "entry finds nothing";
  readonly detail: string;
}

export const READ: readonly string[] = ["homelink/Sources", "ios-app", "macos-app/Sources", "dashboard/lib", "dashboard/public"];

const SKIPPED: ReadonlySet<string> = new Set([
  "ios-app/LifestreamCaptureTests",
  "ios-app/LifestreamCaptureUITests",
  "ios-app/Tests",
  "dashboard/public/vendor",
]);

const CODE = /\.(?:swift|js|mjs|ts|html)$/u;

const PATH = /(?:(?<=["'`}) ])|(?<=:\/\/[\w.:-]+))\/v1\/[\w./-]*|(?<=["'`])v1\/[\w./-]*/gu;

const API = /(?<=["'`])\/?api\/[\w./-]*/gu;

const allow = (route: string, reason: string): Allowed => ({ route, reason });

export const ALLOWED: readonly Allowed[] = [
  allow("/v1/blobs/", "bytes: a blob's bytes, and the blobs a device holds"),
  allow("/v1/pictures", "bytes: the pictures' recipe"),
  allow("/v1/pictures/", "bytes: a picture at a size"),
  allow("/v1/photos/", "bytes: a photo's files, and the photos the home wants sent"),
  allow("/v1/people/photos", "bytes: a person's photos, hashes in the home's order"),
  allow("/v1/places/photos", "bytes: a place's photos, hashes in the home's order"),
  allow("/v1/clock", "the clock: the home's clock and civil day"),
  allow("/v1/feed", "the clock: the stream of the home's changes"),
  allow("/v1/owner/act", "the owner's word"),
  allow("/v1/act", "the owner's word: an act on a need or an ask"),
  allow("/v1/settings", "the settings"),
  allow("/v1/process", "the settings: what the home processes"),
  allow("/v1/processing/range", "the settings: the range a processing step covers"),
  allow("/v1/start/cost", "the settings: what each history start would store, before it is set"),
  allow("/v1/devices", "the settings: the cameras and devices the owner set up"),
  allow("/v1/account", "the settings: the owner's account"),
  allow("/v1/feedback/", "writes: a person's report, its draft and its screenshot"),
  allow("/v1/refresh", "a connector write: read it again now"),
  allow("/v1/seal", "a connector write: a secret sealed for the home"),
  allow("/v1/signin/", "a connector write: a sign-in's steps"),
  allow("/v1/connectors/", "a connector write"),
  allow("/v1/pair", "the device's own wire: pairing"),
  allow("/v1/exchange", "the device's own wire: the exchange"),
  allow("/v1/bundles/", "the device's own wire: a bundle sent"),
  allow("/v1/acquisitions/", "the device's own wire: an acquisition sent"),
  allow("/v1/files/", "the device's own wire: a file a bundle names, sent on its own"),
  allow("/v1/imports/held", "the device's own wire: the imports the home holds"),
  allow("/v1/restore", "the device's own wire: what a restored device takes back"),
  allow("/v1/home/verify", "the device's own wire: whether this is its home"),
  allow("/v1/status", "the device's own wire: whether the home answers, and its stamp"),
  allow("/v1/ask", "Ask: a question asked, and the models offered"),
  allow("/v1/ask/", "Ask: its chats, files, notes, sign-in and stop"),
  allow("/v1/privacy", "Ask: what left, the privacy view"),
  allow("/v1/privacy/chat/", "Ask: a chat's privacy view"),
  allow("/v1/outbound", "Ask: what left, row by row"),
  allow("/v1/outbound/", "Ask: one text that left"),
  allow("/v1/agents", "access: the agents"),
  allow("/v1/agents/", "access: an agent, its history, its reads and its access"),
  allow("/v1/describe", "citations: what a ref opens"),
  allow("/v1/read", "citations: a ref's text"),
  allow("/v1/record", "citations: a record as the home keeps it"),
  allow("/v1/products", "lookups: a product's name and icon by id"),
  allow("/v1/sources", "lookups: the home's sources, their ids and read-through times"),
  allow("/v1/labels", "lookups: a point's place and a chat's title by key"),
  allow("/v1/places/suggest", "lookups: the names the home suggests for a spot"),
];

const owed = (file: string, routes: readonly string[], lane: Lane): Owed[] => routes.map((route) => ({ file, route, lane }));

const PHONE = "ios-app/LifestreamCapture/";
const WEB = "dashboard/public/";
const PAYOFF = ["/v1/counts", "/v1/records"];

export const OWED: readonly Owed[] = [
  ...owed(`${WEB}lib/held.js`, ["/v1/people"], "people"),
  ...owed(`${WEB}ui/panel.js`, ["/v1/extracts", "/v1/conversation"], "days"),
  ...owed(`${WEB}ui/days/inspector.js`, ["/v1/extracts"], "days"),
  ...owed(`${PHONE}Days/InspectorReads.swift`, ["/v1/extracts"], "days"),
  ...owed(`${PHONE}Days/Viewers/TrackPage.swift`, ["/v1/count"], "days"),
  ...owed(`${PHONE}Days/Viewers/RecordSourceFold.swift`, ["/v1/extracts"], "days"),
  ...owed(`${WEB}lib/held.js`, ["/v1/places"], "places"),
  ...owed(`${WEB}ui/places/section.js`, ["/v1/where"], "days"),
  ...owed("ios-app/Sources/LifestreamCaptureCore/PlacesBook.swift", ["/v1/places"], "places"),
  ...owed(`${WEB}pages/search.js`, ["/v1/count"], "search"),
  ...owed(`${PHONE}People/PeopleBook.swift`, ["/v1/people"], "search"),
  ...owed(`${WEB}ui/connectors/changes.js`, ["/v1/search/state"], "streams"),
  ...owed(`${WEB}pages/faces.js`, ["/v1/people", ...PAYOFF], "faces"),
  ...owed(`${WEB}pages/onboarding.js`, ["/v1/people", ...PAYOFF], "faces"),
  ...owed(`${WEB}pages/organise.js`, ["/v1/people", ...PAYOFF], "faces"),
  ...owed(`${WEB}pages/people.js`, ["/v1/people", ...PAYOFF], "faces"),
  ...owed(`${WEB}ui/places/section.js`, ["/v1/people", ...PAYOFF], "faces"),
];

export const STAND_INS: readonly StandIn[] = [
  { file: "ios-app/LifestreamCapture/Life/CannedHome.swift", reason: "the canned home the phone's UI runs talk to: it serves the door's routes, it reads none" },
  { file: "ios-app/LifestreamCapture/Life/CannedAsk.swift", reason: "the canned home's Ask: it serves the door's Ask routes, it reads none" },
];

export const RELAYS: readonly Relay[] = [
  { path: "homelink/Sources/HomeLink/", kind: "swift", module: true, reason: "HomeLink: the apps' one way to the door; a call of its public methods is the read" },
  { path: "ios-app/LifestreamCapture/Life/LifeReader.swift", kind: "swift", reason: "the phone's reader over HomeLink; a call of its methods is the read" },
  { path: "dashboard/lib/", kind: "server", reason: "the dashboard's server: each /api/ route relays the door; a page's call of the route is the read" },
  { path: "dashboard/public/lib/api.js", kind: "client", reason: "the dashboard page's calls of its server's /api/ routes; a call of its exports is the read" },
];

export const PAGE_ROUTES: readonly string[] = Object.values(PAGES).map((page) => page.route);

export const LISTS: Lists = { pages: PAGE_ROUTES, allowed: ALLOWED, owed: OWED, standIns: STAND_INS, relays: RELAYS };

function codeFiles(root: string, folder: string): string[] {
  if (!existsSync(join(root, folder))) return [];
  const found: string[] = [];
  const walk = (relativeFolder: string): void => {
    for (const entry of readdirSync(join(root, relativeFolder), { withFileTypes: true })) {
      const path = `${relativeFolder}/${entry.name}`;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || SKIPPED.has(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && CODE.test(entry.name)) found.push(path);
    }
  };
  walk(folder);
  return found.sort();
}

function relayFiles(root: string, relay: Relay): string[] {
  if (relay.path.endsWith("/")) return codeFiles(root, relay.path.slice(0, -1));
  return existsSync(join(root, relay.path)) ? [relay.path] : [];
}

const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length;

export function routeOf(path: string): string {
  const trimmed = path.replace(/\.+$/u, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function readsIn(file: string, source: string): Read[] {
  return [...source.matchAll(PATH)].map((match) => ({ file, line: lineAt(source, match.index), route: routeOf(match[0]) }));
}

const routesInText = (text: string): string[] => readsIn("", `"${text}"`).map((read) => read.route);

export interface SwiftParam {
  readonly label: string | null;
  readonly required: boolean;
}

export interface SwiftFunc {
  readonly file: string;
  readonly name: string;
  readonly params: readonly SwiftParam[];
  readonly visibility: "public" | "internal" | "private";
  readonly start: number;
  readonly body: string;
}

export interface Callable {
  readonly name: string;
  readonly params: readonly SwiftParam[];
  readonly routes: ReadonlySet<string>;
  readonly shown: string;
}

function stringEnd(source: string, at: number): number {
  if (source.startsWith('"""', at)) {
    const end = source.indexOf('"""', at + 3);
    return end < 0 ? source.length : end + 3;
  }
  let index = at + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\" && source[index + 1] === "(") {
      const close = closing(source, index + 1);
      index = close < 0 ? source.length : close + 1;
    } else if (char === "\\") index += 2;
    else if (char === '"') return index + 1;
    else if (char === "\n") return index;
    else index += 1;
  }
  return index;
}

const OPENS: Readonly<Record<string, string>> = { "(": ")", "{": "}", "[": "]" };

function closing(source: string, open: number): number {
  const want = OPENS[source[open] ?? ""];
  if (want === undefined) return -1;
  const stack: string[] = [want];
  let index = open + 1;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === '"') {
      index = stringEnd(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    const opened = OPENS[char];
    if (opened !== undefined) stack.push(opened);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index;
    }
    index += 1;
  }
  return -1;
}

function topLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      index = stringEnd(text, index);
      continue;
    }
    if (char === "-" && text[index + 1] === ">") {
      index += 2;
      continue;
    }
    if ("([{<".includes(char)) depth += 1;
    else if (")]}>".includes(char)) depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

export function swiftParams(text: string): SwiftParam[] {
  return topLevel(text, ",").map((part) => {
    const [head = "", ...rest] = topLevel(part, ":");
    const words = head.split(/\s+/u).filter((word) => word !== "");
    const outer = words[0] ?? "";
    const label = outer === "_" ? null : outer.replace(/`/gu, "");
    const after = rest.join(":");
    return { label, required: !/(?<![=!<>])=(?!=)/u.test(after) && !after.includes("...") };
  });
}

export function swiftLabels(text: string): (string | null)[] {
  return topLevel(text, ",").map((part) => /^([A-Za-z_]\w*)\s*:(?!:)/u.exec(part)?.[1] ?? null);
}

export function labelsFit(params: readonly SwiftParam[], labels: readonly (string | null)[], trailing: number): boolean {
  let param = 0;
  for (const label of labels) {
    while (param < params.length && params[param]?.label !== label) {
      if (params[param]?.required === true) return false;
      param += 1;
    }
    if (param === params.length) return false;
    param += 1;
  }
  return params.slice(param).filter((left) => left.required).length <= trailing;
}

const FUNC = /\bfunc\s+(`?)([A-Za-z_]\w*)\1\s*(?:<[^(){}]*>)?\s*\(/gu;

const SIGNATURE_GOES_ON = /^(?:->|where\b|async\b|throws\b|rethrows\b|\{)/u;

export function swiftFuncs(file: string, source: string): SwiftFunc[] {
  const found: SwiftFunc[] = [];
  for (const match of source.matchAll(FUNC)) {
    const open = match.index + match[0].length - 1;
    const close = closing(source, open);
    if (close < 0) continue;
    const lead = source.slice(source.lastIndexOf("\n", match.index) + 1, match.index);
    if (/\b(?:static|class)\b/u.test(lead)) continue;
    let index = close + 1;
    let body = -1;
    while (index < source.length) {
      const char = source[index];
      if (char === "{") {
        body = index;
        break;
      }
      if (char === "}") break;
      if (char === "\n" && !SIGNATURE_GOES_ON.test(source.slice(index + 1).trimStart())) break;
      index += 1;
    }
    if (body < 0) continue;
    const end = closing(source, body);
    found.push({
      file,
      name: match[2] ?? "",
      params: swiftParams(source.slice(open + 1, close)),
      visibility: /\b(?:public|open)\b/u.test(lead) ? "public" : /\b(?:private|fileprivate)\b/u.test(lead) ? "private" : "internal",
      start: body,
      body: source.slice(body, end < 0 ? source.length : end + 1),
    });
  }
  return found;
}

export interface SwiftCall {
  readonly index: number;
  readonly callables: readonly Callable[];
}

const RECEIVER_CHAIN = String.raw`((?:[A-Za-z_$][\w$]*(?:\(\))?[?!]?\s*\.\s*)*)`;

const escaped = (name: string): string => name.replace(/[$]/gu, "\\$");

function hasReceiver(source: string, chain: string, nameAt: number): boolean {
  if (chain !== "") return true;
  if (source[nameAt - 1] !== ".") return false;
  let index = nameAt - 2;
  while (index >= 0 && /\s/u.test(source[index] ?? "")) index -= 1;
  return /[\w)\]?!$]/u.test(source[index] ?? "");
}

const awaited = (source: string, start: number): boolean => {
  const line = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
  const statement = line.slice(Math.max(line.lastIndexOf("{"), line.lastIndexOf("}"), line.lastIndexOf(";")) + 1);
  return /\bawait\b|\basync\s+let\b/u.test(statement);
};

export function swiftCalls(source: string, callables: readonly Callable[], receiver: "required" | "any"): SwiftCall[] {
  const byName = new Map<string, Callable[]>();
  for (const callable of callables) byName.set(callable.name, [...(byName.get(callable.name) ?? []), callable]);
  if (byName.size === 0) return [];
  const pattern = new RegExp(`${RECEIVER_CHAIN}(?<![\\w$])(${[...byName.keys()].map(escaped).join("|")})\\s*\\(`, "gu");
  const calls: SwiftCall[] = [];
  for (const match of source.matchAll(pattern)) {
    const chain = match[1] ?? "";
    const name = match[2] ?? "";
    const nameAt = match.index + chain.length;
    if (!awaited(source, match.index)) continue;
    if (receiver === "required") {
      if (!hasReceiver(source, chain, nameAt)) continue;
      const segments = chain.split(".").map((segment) => segment.trim()).filter((segment) => segment !== "");
      if (/^[A-Z]/u.test(segments[segments.length - 1] ?? "")) continue;
    }
    const open = match.index + match[0].length - 1;
    const close = closing(source, open);
    if (close < 0) continue;
    const labels = swiftLabels(source.slice(open + 1, close));
    const trailing = /^\s*\{/u.test(source.slice(close + 1)) ? 1 : 0;
    const fitting = (byName.get(name) ?? []).filter((callable) => labelsFit(callable.params, labels, trailing));
    if (fitting.length > 0) calls.push({ index: nameAt, callables: fitting });
  }
  return calls;
}

const CONSTANT = /\b(?:let|var)\s+([A-Za-z_]\w*)\s*(?::\s*String\s*)?=\s*("(?:[^"\\\n]|\\.)*")/gu;

export function swiftConstants(source: string, funcs: readonly SwiftFunc[]): ReadonlyMap<string, ReadonlySet<string>> {
  const found = new Map<string, Set<string>>();
  for (const match of source.matchAll(CONSTANT)) {
    if (funcs.some((func) => match.index >= func.start && match.index < func.start + func.body.length)) continue;
    const routes = readsIn("", match[2] ?? "").map((read) => read.route);
    if (routes.length > 0) found.set(match[1] ?? "", new Set([...(found.get(match[1] ?? "") ?? []), ...routes]));
  }
  return found;
}

const shownOf = (func: SwiftFunc): string => `${func.name}(${func.params.map((param) => `${param.label ?? "_"}:`).join("")})`;

export function swiftLayer(funcs: readonly SwiftFunc[], below: readonly Callable[], callable: "public" | "internal", constants: ReadonlyMap<string, ReadonlySet<string>> = new Map()): Callable[] {
  const named = [...constants].map(([name, held]) => [new RegExp(`\\b${name}\\b`, "u"), held] as const);
  const routes = funcs.map((func) => new Set([
    ...readsIn(func.file, func.body).map((read) => read.route),
    ...named.flatMap(([name, held]) => (name.test(func.body) ? [...held] : [])),
  ]));
  for (const [index, func] of funcs.entries()) {
    for (const call of swiftCalls(func.body, below, "required")) for (const callable of call.callables) for (const route of callable.routes) routes[index]?.add(route);
  }
  let grew = true;
  while (grew) {
    grew = false;
    const own: Callable[] = funcs.map((func, index) => ({ name: func.name, params: func.params, routes: routes[index] ?? new Set(), shown: shownOf(func) }));
    for (const [index, func] of funcs.entries()) {
      const held = routes[index];
      if (held === undefined) continue;
      for (const call of swiftCalls(func.body, own, "any")) {
        for (const callable of call.callables) {
          for (const route of callable.routes) {
            if (held.has(route)) continue;
            held.add(route);
            grew = true;
          }
        }
      }
    }
  }
  const callers = (func: SwiftFunc): boolean => func.visibility === "public" || (func.visibility === "internal" && callable === "internal");
  return funcs.flatMap((func, index) => {
    const reached = routes[index] ?? new Set<string>();
    return reached.size > 0 && callers(func) ? [{ name: func.name, params: func.params, routes: reached, shown: shownOf(func) }] : [];
  });
}

export interface ServerRoute {
  readonly api: string;
  readonly routes: ReadonlySet<string>;
}

const inside = (root: string, fileName: string): boolean => {
  const path = relative(root, fileName);
  return !path.startsWith("..") && !path.split(sep).includes("node_modules") && !fileName.endsWith(".d.ts");
};

export function serverRoutes(root: string, files: readonly string[]): ServerRoute[] {
  if (files.length === 0) return [];
  const program = ts.createProgram(files.map((file) => join(root, file)), {
    allowJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const dashboard = join(root, "dashboard");
  const reached = (node: ts.Node): Set<string> => {
    const routes = new Set<string>();
    const seen = new Set<ts.Node>();
    const follow = (symbol: ts.Symbol | undefined): void => {
      if (symbol === undefined) return;
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      for (const declaration of target.declarations ?? []) enter(declaration);
    };
    const enter = (declaration: ts.Node): void => {
      if (seen.has(declaration) || !inside(dashboard, declaration.getSourceFile().fileName)) return;
      seen.add(declaration);
      if (ts.isShorthandPropertyAssignment(declaration)) follow(checker.getShorthandAssignmentValueSymbol(declaration));
      else if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) {
        if (declaration.initializer !== undefined) visit(declaration.initializer);
      } else if (ts.isFunctionLike(declaration) && !ts.isParameter(declaration) && "body" in declaration && declaration.body !== undefined) visit(declaration);
    };
    const visit = (at: ts.Node): void => {
      if (ts.isStringLiteralLike(at) || ts.isTemplateHead(at) || ts.isTemplateMiddle(at) || ts.isTemplateTail(at)) for (const route of routesInText(at.text)) routes.add(route);
      else if (ts.isIdentifier(at)) follow(checker.getSymbolAtLocation(at));
      if (ts.isCallExpression(at)) {
        const declaration = checker.getResolvedSignature(at)?.declaration;
        if (declaration !== undefined && !ts.isJSDocSignature(declaration)) enter(declaration);
      }
      ts.forEachChild(at, visit);
    };
    visit(node);
    return routes;
  };
  const found: ServerRoute[] = [];
  const isApi = (node: ts.Node | undefined): node is ts.StringLiteral => node !== undefined && ts.isStringLiteral(node) && node.text.startsWith("/api/");
  for (const source of program.getSourceFiles()) {
    if (!inside(dashboard, source.fileName)) continue;
    const look = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "path" && isApi(property.initializer)) {
            found.push({ api: property.initializer.text, routes: reached(node) });
          }
        }
      } else if (ts.isCallExpression(node)) {
        const api = node.arguments.find(isApi);
        if (api !== undefined) found.push({ api: api.text, routes: reached(node) });
      }
      ts.forEachChild(node, look);
    };
    look(source);
  }
  return found;
}

export function apiOf(text: string, server: ReadonlyMap<string, ReadonlySet<string>>, bare: boolean): string | null {
  const prefixed = /^\/?api\//u.exec(text);
  if (prefixed === null && !bare) return null;
  const path = text.slice(prefixed?.[0].length ?? (text.startsWith("/") ? 1 : 0)).split("?")[0] ?? "";
  const api = `/api/${path}`;
  return server.has(api) ? api : null;
}

export interface ClientExport {
  readonly name: string;
  readonly apis: readonly string[];
}

const parsed = (root: string, file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

export function clientExports(root: string, file: string, server: ReadonlyMap<string, ReadonlySet<string>>): ClientExport[] {
  const source = parsed(root, file);
  const declared = new Map<string, ts.Node>();
  const exported: string[] = [];
  for (const statement of source.statements) {
    const exports = ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      declared.set(statement.name.text, statement);
      if (exports) exported.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        declared.set(declaration.name.text, declaration);
        if (exports) exported.push(declaration.name.text);
      }
    }
  }
  return exported.map((name) => {
    const apis = new Set<string>();
    const seen = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)) {
        const api = apiOf(node.text, server, true);
        if (api !== null) apis.add(api);
      } else if (ts.isIdentifier(node) && !seen.has(node.text)) {
        const local = declared.get(node.text);
        seen.add(node.text);
        if (local !== undefined) visit(local);
      }
      ts.forEachChild(node, visit);
    };
    seen.add(name);
    const own = declared.get(name);
    if (own !== undefined) visit(own);
    return { name, apis: [...apis].sort() };
  }).filter((entry) => entry.apis.length > 0);
}

export function clientCalls(root: string, file: string, relay: string, exports: ReadonlyMap<string, ClientExport>): { line: number; name: string }[] {
  const source = parsed(root, file);
  const named = new Map<string, string>();
  const spaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (resolve(root, dirname(file), statement.moduleSpecifier.text) !== resolve(root, relay)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) spaces.add(bindings.name.text);
    else if (bindings !== undefined) for (const element of bindings.elements) named.set(element.name.text, (element.propertyName ?? element.name).text);
  }
  if (named.size === 0 && spaces.size === 0) return [];
  const calls: { line: number; name: string }[] = [];
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && spaces.has(node.expression.text) && exports.has(node.name.text)) {
      calls.push({ line: lineOf(node), name: node.name.text });
    } else if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) {
      const name = named.get(node.text);
      if (name !== undefined && exports.has(name)) calls.push({ line: lineOf(node), name });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

export interface Derived {
  readonly swift: readonly Callable[];
  readonly server: ReadonlyMap<string, ReadonlySet<string>>;
  readonly client: ReadonlyMap<string, ClientExport>;
  readonly relayFiles: ReadonlySet<string>;
  readonly attributed: ReadonlyMap<string, ReadonlySet<string>>;
  readonly empty: readonly Relay[];
}

export function derive(root: string, relays: readonly Relay[]): Derived {
  const swift: Callable[] = [];
  const server = new Map<string, Set<string>>();
  const client = new Map<string, ClientExport>();
  const files = new Set<string>();
  const attributed = new Map<string, ReadonlySet<string>>();
  const empty: Relay[] = [];
  const attribute = (own: readonly string[], routes: Iterable<string>): void => {
    const reached = new Set(routes);
    for (const file of own) {
      files.add(file);
      attributed.set(file, reached);
    }
  };
  for (const relay of relays.filter((each) => each.kind === "swift")) {
    const own = relayFiles(root, relay).filter((file) => file.endsWith(".swift"));
    const read = own.map((file) => {
      const source = readFileSync(join(root, file), "utf8");
      return { source, funcs: swiftFuncs(file, source) };
    });
    const funcs = read.flatMap((each) => each.funcs);
    const constants = new Map(read.flatMap((each) => [...swiftConstants(each.source, each.funcs)]));
    const exported = swiftLayer(funcs, swift, relay.module === true ? "public" : "internal", constants);
    attribute(own, exported.flatMap((callable) => [...callable.routes]));
    if (exported.length === 0) empty.push(relay);
    swift.push(...exported);
  }
  for (const relay of relays.filter((each) => each.kind === "server")) {
    const own = relayFiles(root, relay).filter((file) => /\.m?js$/u.test(file));
    const routes = serverRoutes(root, own);
    attribute(own, routes.flatMap((route) => [...route.routes]));
    if (routes.length === 0) empty.push(relay);
    for (const route of routes) server.set(route.api, new Set([...(server.get(route.api) ?? []), ...route.routes]));
  }
  for (const relay of relays.filter((each) => each.kind === "client")) {
    const own = relayFiles(root, relay);
    const exports = own.flatMap((file) => clientExports(root, file, server));
    attribute(own, []);
    if (exports.length === 0) empty.push(relay);
    for (const entry of exports) client.set(entry.name, entry);
  }
  return { swift, server, client, relayFiles: files, attributed, empty };
}

function readsOf(root: string, file: string, source: string, derived: Derived, clientRelays: readonly string[]): Read[] {
  const reads = readsIn(file, source);
  if (file.endsWith(".swift")) {
    for (const call of swiftCalls(source, derived.swift, "required")) {
      const via = [...new Set(call.callables.map((callable) => callable.shown))].join(" or ");
      for (const route of new Set(call.callables.flatMap((callable) => [...callable.routes]))) reads.push({ file, line: lineAt(source, call.index), route, via });
    }
  }
  if (file.startsWith("dashboard/public/")) {
    for (const match of source.matchAll(API)) {
      const api = apiOf(match[0], derived.server, false);
      if (api !== null) for (const route of derived.server.get(api) ?? []) reads.push({ file, line: lineAt(source, match.index), route, via: api });
    }
    for (const relay of /\.m?js$/u.test(file) ? clientRelays : []) {
      for (const call of clientCalls(root, file, relay, derived.client)) {
        for (const api of derived.client.get(call.name)?.apis ?? []) for (const route of derived.server.get(api) ?? []) reads.push({ file, line: call.line, route, via: `${call.name}() → ${api}` });
      }
    }
  }
  return reads.sort((one, other) => one.line - other.line);
}

export function readsUnder(root: string, lists: Pick<Lists, "standIns" | "relays"> = LISTS): { reads: Read[]; relayReads: Read[]; standIns: ReadonlySet<string>; empty: readonly Relay[] } {
  const derived = derive(root, lists.relays);
  const files = READ.flatMap((folder) => codeFiles(root, folder));
  const skipped = new Set(lists.standIns.map((entry) => entry.file));
  const clientRelays = lists.relays.filter((relay) => relay.kind === "client").flatMap((relay) => relayFiles(root, relay));
  const reads: Read[] = [];
  const relayReads: Read[] = [];
  const standIns = new Set<string>();
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    if (skipped.has(file)) {
      if (readsIn(file, source).length > 0) standIns.add(file);
    } else if (derived.relayFiles.has(file)) {
      const held = readsIn(file, source);
      relayReads.push(...held);
      reads.push(...held.filter((read) => !derived.attributed.get(file)?.has(read.route)));
    } else reads.push(...readsOf(root, file, source, derived, clientRelays));
  }
  return { reads, relayReads, standIns, empty: derived.empty };
}

export function covers(entry: string, route: string): boolean {
  return entry === route || (entry.endsWith("/") && route.startsWith(entry));
}

const through = (read: Read): string => read.via === undefined ? "" : ` (through ${read.via})`;

export function checkPages(root: string, lists: Lists = LISTS): Finding[] {
  const { reads, relayReads, standIns, empty } = readsUnder(resolve(root), lists);
  const pages = new Set(lists.pages);
  const findings: Finding[] = [];
  const said = new Set<string>();
  for (const read of reads) {
    if (pages.has(read.route)) continue;
    if (lists.owed.some((entry) => entry.file === read.file && entry.route === read.route)) continue;
    if (!lists.owed.some((entry) => entry.route === read.route) && lists.allowed.some((entry) => covers(entry.route, read.route))) continue;
    const key = `${read.file}:${read.line}:${read.route}`;
    if (said.has(key)) continue;
    said.add(key);
    const elsewhere = lists.owed.find((entry) => entry.route === read.route);
    if (elsewhere !== undefined) {
      findings.push({ file: read.file, line: read.line, rule: "owed elsewhere", detail: `${read.route}${through(read)}: a raw read lane ${elsewhere.lane} still owes a page for; read the page answer, never a second reader of the raw route` });
      continue;
    }
    findings.push({ file: read.file, line: read.line, rule: "refused", detail: `${read.route}${through(read)}: an app reads page answers (PAGES, packages/home/pages.ts); add the page to the home, or name the route and why on the allowed list` });
  }
  for (const entry of lists.owed) {
    if (!reads.some((read) => read.file === entry.file && read.route === entry.route)) findings.push({ file: entry.file, line: 0, rule: "entry finds nothing", detail: `${entry.route} (owed, ${entry.lane}): delete it from the owed list` });
  }
  const everyRead = [...reads, ...relayReads];
  for (const entry of lists.allowed) {
    if (!everyRead.some((read) => covers(entry.route, read.route))) findings.push({ file: entry.route, line: 0, rule: "entry finds nothing", detail: `allowed: delete it from the allowed list` });
  }
  for (const entry of lists.standIns) {
    if (!standIns.has(entry.file)) findings.push({ file: entry.file, line: 0, rule: "entry finds nothing", detail: "stand-in: it holds no door path; delete it from the stand-ins" });
  }
  for (const relay of empty) findings.push({ file: relay.path, line: 0, rule: "entry finds nothing", detail: "relay: no read derived from it; delete it from the relays" });
  return findings;
}

export function owedByLane(owedList: readonly Owed[] = OWED): Readonly<Record<Lane, number>> {
  const counts = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  for (const entry of owedList) counts[entry.lane] += 1;
  return counts;
}

export function owedLine(owedList: readonly Owed[] = OWED): string {
  const counts = owedByLane(owedList);
  return `owed reads by lane: ${LANES.map((lane) => `${lane} ${counts[lane]}`).join(", ")} (${owedList.length} in all)`;
}

export function runPagesCheck(
  root: string,
  output: (text: string) => void = (text) => process.stdout.write(text),
  error: (text: string) => void = (text) => process.stderr.write(text),
  lists: Lists = LISTS,
): 0 | 1 {
  const findings = checkPages(root, lists);
  output(`${owedLine(lists.owed)}\n`);
  if (findings.length === 0) {
    output("pages check: clean\n");
    return 0;
  }
  for (const finding of findings) error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.detail}\n`);
  error(`pages check: ${findings.length} finding(s)\n`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runPagesCheck(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
