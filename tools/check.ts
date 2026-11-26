import { type ChildProcess, execFileSync, spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { macOnly, quarantined } from "../testing/files.mjs";
import { checked, commentsAlone } from "./check-comments.js";

const SUITES = ["static", "extension", "mcp", "dashboard", "faces", "photolibrary", "devicefiles", "homelink", "cockpit", "vitest", "macos-app", "mac-only", "ios"] as const;
export type Suite = (typeof SUITES)[number];
const LOCK_FREE: ReadonlySet<Suite> = new Set(["static", "extension"]);
const FOLDERS: Partial<Record<Suite, string>> = { cockpit: "design/swift", ios: "ios-app" };
const SERVED: ReadonlySet<Suite> = new Set(["mcp", "dashboard", "vitest"]);
const PHONE: Suite = "ios";

const PROJECTS = ["core", "connect", "families", "model", "privacy", "home", "runner", "tools", "extension", "worker"] as const;

type Row = readonly [match: string | RegExp, suites: readonly Suite[], projects: readonly string[]];

const ROWS: readonly Row[] = [
  ["packages/core/", ["dashboard", "mcp", "homelink"], PROJECTS],
  ...["packages/core/sealed.ts", "packages/core/sealed-vectors/mac/"].map((prefix): Row => [prefix, ["devicefiles"], []]),
  ["packages/connect/", ["dashboard", "mcp"], ["core", "connect", "families", "home", "tools"]],
  ["packages/connect/macos-app/", ["macos-app"], []],
  ["packages/connect/ai/", ["macos-app"], ["families"]],
  ["packages/connect/photos/apple/", ["macos-app"], []],
  ...["messages/imessage", "calls/apple", "notes/apple", "browser/chrome", "browser/safari", "voice/wispr-flow", "calendar/apple", "calendar/apple-reminders"]
    .map((provider): Row => [`packages/connect/${provider}/test/`, ["macos-app"], []]),
  ["packages/families/", ["dashboard", "mcp"], ["core", "families", "home", "tools"]],
  ["packages/model/", ["dashboard", "mcp"], ["core", "model", "home", "runner", "tools"]],
  ["packages/privacy/", ["dashboard", "mcp"], ["core", "privacy", "home", "tools"]],
  ["packages/home/", ["dashboard", "mcp", "homelink"], ["core", "home", "tools", "extension"]],
  ["packages/runner/", [], ["core", "runner", "home", "tools"]],
  ["tools/", [], ["tools"]],
  ["extension/", ["extension"], ["extension"]],
  ["worker/", [], ["worker"]],
  ["dashboard/", ["dashboard", "extension"], []],
  ...["dashboard/public/ui/kit/", "dashboard/public/lib/html.js", "dashboard/public/lib/reach.js", "dashboard/public/loader"].map((prefix): Row => [prefix, [], ["extension"]]),
  ["dashboard/lib/http.mjs", ["macos-app"], []],
  ["packages/families/test/day-page/", ["ios"], []],
  ["mcp/", ["mcp"], []],
  ["design/", ["dashboard", "extension", "macos-app", "ios"], []],
  ["design/swift/", ["cockpit"], []],
  ["design/ask-trace.json", ["cockpit"], []],
  ["design/privacy-view.json", ["cockpit", "mcp"], []],
  ...["design/icons.json", "design/tokens.json", "design/css/"].map((prefix): Row => [prefix, [], ["extension"]]),
  ["design/icons.json", [], ["home"]],
  ["homelink/", ["homelink", "macos-app", "ios"], []],
  ["homelink/Tests/Fixtures/report.json", ["dashboard"], ["home"]],
  ["photolibrary/", ["photolibrary", "macos-app", "ios"], []],
  ["devicefiles/", ["devicefiles"], []],
  ["macos-app/", ["macos-app"], []],
  ["faces/", ["faces"], []],
  [/^ios-app\/(?!(?:testflight|apple-setup)\.py$|(?:upload-testflight|install-phone|link-install|sign-development)\.sh$)/u, ["ios"], []],
];

const PAGE = /^(?!(?:.*\/)?(?:prompts|fixtures?|test|golden)\/).*\.md$/u;
const PAGE_ROWS: readonly Row[] = [
  [/^packages\/connect\/(?:.+\/)?([^/]+)\/\1\.md$/u, [], ["home"]],
  ["packages/connect/SKILL.md", [], ["home"]],
  ["docs/DESIGN.md", [], ["home"]],
  ["docs/OPERATING.md", [], ["home"]],
  ["docs/operating/", [], ["home"]],
];

const TEST_FILE = /^packages\/[^/]+\/.+\.test\.ts$/u;

const MACHINERY = /^(?:package(?:-lock)?\.json|tsconfig[^/]*\.json|\.nvmrc|vitest[^/]*\.mts|testing\/[^/]*\.m[jt]s|testing\/mac-only\.txt|testing\/quarantine\.txt|tools\/check[^/]*\.ts|tools\/test-lock\.sh|tools\/lstest\.sh)$/u;
const TYPESCRIPT: readonly Suite[] = ["extension", "mcp", "dashboard", "vitest"];

export const BY_HAND = ["SpeedUITests", "ScreenTourUITests", "AppDiscoveryUITests"];
const UI_TESTS = "ios-app/LifestreamCaptureUITests";

export interface Plan {
  readonly suites: readonly { readonly suite: Suite; readonly by: string }[];
  readonly projects: readonly string[];
  readonly design: boolean;
  readonly uiTests: string;
  readonly macOnly: readonly string[];
}

const FOLLOWS: ReadonlyMap<string, Suite> = new Map([["packages/home/engine-pictures-mac.e2e.test.ts", "faces"], ["packages/home/pictures-mac.e2e.test.ts", "faces"], ["packages/home/video.e2e.test.ts", "faces"], ["dashboard/test/video-door.mjs", "faces"]]);

export function waitsFor(suite: Suite, suites: readonly Suite[]): Suite[] {
  return suite === "mac-only" ? [...new Set(FOLLOWS.values())].filter((built) => suites.includes(built)) : [];
}

export function plan(
  paths: readonly string[],
  options: {
    all?: boolean | undefined;
    uiTests?: string | undefined;
    classes?: readonly string[] | undefined;
    listed?: readonly string[] | undefined;
    without?: readonly Suite[] | undefined;
    comments?: ReadonlySet<string> | undefined;
  } = {},
): Plan {
  const chosen = new Map<Suite, string>();
  const projects = new Set<string>();
  let design = false;
  const choose = (suite: Suite, by: string): void => {
    if (!chosen.has(suite)) chosen.set(suite, by);
  };
  if (options.all === true) {
    for (const suite of SUITES) if (suite !== "mac-only") choose(suite, "--all");
    for (const project of PROJECTS) projects.add(project);
    design = true;
  } else {
    for (const path of paths) {
      choose("static", path);
      if (path.startsWith("design/") || path === "tools/design.ts") design = true;
      if (options.comments?.has(path) === true) continue;
      if (MACHINERY.test(path)) {
        for (const suite of TYPESCRIPT) choose(suite, path);
        for (const project of PROJECTS) projects.add(project);
      }
      const own = TEST_FILE.test(path) ? ownerOf(path).project : undefined;
      if (own !== undefined) {
        choose("vitest", path);
        projects.add(own);
        continue;
      }
      for (const [match, suites, named] of PAGE.test(path) ? PAGE_ROWS : ROWS) {
        if (typeof match === "string" ? !path.startsWith(match) : !match.test(path)) continue;
        for (const suite of suites) choose(suite, path);
        if (named.length > 0) choose("vitest", path);
        for (const project of named) projects.add(project);
      }
    }
  }
  const without = new Set(options.without ?? []);
  for (const suite of without) chosen.delete(suite);
  if (!chosen.has("vitest")) projects.clear();
  const chooser = (path: string): string | undefined => {
    const { suite, project } = ownerOf(path);
    const follows = FOLLOWS.get(path);
    if (suite !== undefined && chosen.has(suite) && (project === undefined || projects.has(project))) return chosen.get(suite);
    return follows === undefined ? undefined : chosen.get(follows);
  };
  const listed = without.has("mac-only") ? [] : (options.listed ?? []).filter((path) => chooser(path) !== undefined);
  if (listed.length > 0) choose("mac-only", chooser(listed[0]!)!);
  return {
    suites: SUITES.filter((suite) => chosen.has(suite)).map((suite) => ({ suite, by: chosen.get(suite)! })),
    projects: PROJECTS.filter((project) => projects.has(project)),
    design,
    uiTests: options.uiTests !== undefined && options.uiTests !== ""
      ? options.uiTests
      : options.all === true ? (options.classes ?? []).filter((name) => !BY_HAND.includes(name)).join(",") : "",
    macOnly: listed,
  };
}

export function units(plan: Plan): string[] {
  return plan.suites.flatMap(({ suite }) => {
    if (suite === "vitest") return plan.projects.map((project) => `vitest:${project}`);
    if (suite === "mac-only") return plan.macOnly.map((file) => `mac-only:${file}`);
    if (suite === "ios") return [`ios:${plan.uiTests}`];
    if (suite === "static") return [plan.design ? "static+design" : "static"];
    return [suite];
  });
}

function blobs(): Map<string, string> {
  const folder = mkdtempSync(join(tmpdir(), "check-index-"));
  try {
    const index = join(folder, "index");
    const own = execFileSync("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-path", "index"], { encoding: "utf8" }).trim();
    if (existsSync(own)) copyFileSync(own, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    execFileSync("git", ["-C", ROOT, "add", "-A"], { env, stdio: "ignore" });
    const listed = execFileSync("git", ["-C", ROOT, "ls-files", "-s", "-z"], { env, encoding: "utf8", maxBuffer: 1 << 28 });
    return new Map(listed.split("\0").filter(Boolean).map((entry) => {
      const [meta, path] = entry.split("\t") as [string, string];
      return [path, meta.split(" ")[1]!];
    }));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function keys(found: ReadonlyMap<string, string>, wanted: readonly string[], quarantine: readonly string[] = []): Map<string, string> {
  const inputs = new Map<string, string[]>();
  const add = (unit: string, line: string): void => {
    const list = inputs.get(unit);
    if (list === undefined) inputs.set(unit, [line]);
    else list.push(line);
  };
  for (const [path, blob] of found) {
    if (path === "testing/quarantine.txt") {
      add("static", `${blob} ${path}`);
      continue;
    }
    const chosen = plan([path]);
    for (const { suite } of chosen.suites) if (suite !== "vitest") add(suite, `${blob} ${path}`);
    for (const project of chosen.projects) add(`vitest:${project}`, `${blob} ${path}`);
  }
  for (const path of quarantine) {
    const of = ownerOf(path);
    add(of.project !== undefined ? `vitest:${of.project}` : (of.suite ?? SUITES.find((suite) => path.startsWith(`${folderOf(suite)}/`)) ?? path.split("/")[0]!), `quarantined ${path}`);
  }
  const common = [process.version, process.env.DEVELOPER_DIR ?? ""];
  return new Map(wanted.map((unit) => {
    const [suite, rest = ""] = unit.split(":") as [string, string?];
    const of = suite === "mac-only" ? ownerOf(rest) : undefined;
    const owner = of !== undefined ? (of.project === undefined ? of.suite : `vitest:${of.project}`) : suite === "vitest" ? unit : suite.replace("+design", "");
    const follows = suite === "mac-only" ? FOLLOWS.get(rest) : undefined;
    const hash = createHash("sha256").update([unit, ...common, ...(inputs.get(owner ?? "") ?? []), ...(follows === undefined ? [] : (inputs.get(follows) ?? []))].join("\n"));
    return [unit, hash.digest("hex").slice(0, 32)];
  }));
}

function cacheFolder(): string {
  const main = dirname(execFileSync("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  const folder = join(main, ".build/check-cache");
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function uncached(chosen: Plan, passed: (unit: string) => boolean): Plan {
  const projects = chosen.projects.filter((project) => !passed(`vitest:${project}`));
  const macOnly = chosen.macOnly.filter((file) => !passed(`mac-only:${file}`));
  const suites = chosen.suites.filter(({ suite }) => {
    if (suite === "vitest") return projects.length > 0;
    if (suite === "mac-only") return macOnly.length > 0;
    return !units({ ...chosen, suites: [{ suite, by: "" }] }).every(passed);
  });
  return { ...chosen, suites, projects, macOnly };
}

function ownerOf(path: string): { suite?: Suite; project?: string } {
  if (path.startsWith("dashboard/")) return { suite: "dashboard" };
  if (path.startsWith("mcp/")) return { suite: "mcp" };
  const project = PROJECTS.find((name) => path.startsWith(`${name === "tools" || name === "extension" || name === "worker" ? name : `packages/${name}`}/`));
  return project === undefined ? {} : { suite: "vitest", project };
}

export function label(plan: Plan, suite: Suite): string {
  if (suite === "vitest") return `vitest ${plan.projects.join(",")}`;
  if (suite === "ios") return `ios ${plan.uiTests === "" ? "app-hosted" : plan.uiTests}`;
  if (suite === "mac-only") return `mac-only ${plan.macOnly.join(",")}`;
  if (suite === "static" && plan.design) return "static +design";
  return suite;
}

export function lines(plan: Plan): string[] {
  return plan.suites.map(({ suite, by }) => `${label(plan, suite)}  ← ${by}`);
}

export function readUiClasses(root: string): string[] {
  const folder = join(root, UI_TESTS);
  return readdirSync(folder).filter((file) => file.endsWith(".swift"))
    .flatMap((file) => [...readFileSync(join(folder, file), "utf8").matchAll(/\bclass\s+(\w+UITests)\b/gu)].map((match) => match[1]!))
    .sort();
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, ".build/check");
const TAIL = 60;
const bin = (name: string): string => `node_modules/.bin/${name}`;
const say = (text: string): void => {
  writeSync(1, text);
};

export function commandsOf(plan: Plan, suite: Suite): string[][] {
  switch (suite) {
    case "static":
      return [
        [bin("tsx"), "tools/check-layers.ts"],
        [bin("tsx"), "tools/check-device-files.ts"],
        [bin("tsx"), "tools/check-pages.ts"],
        [bin("tsx"), "tools/check-docs.ts"],
        [bin("tsx"), "tools/check-css.ts"],
        [bin("tsx"), "tools/check-tests.ts"],
        [bin("tsx"), "tools/check-comments.ts"],
        [bin("tsx"), "tools/check-prompts.ts"],
        [bin("tsc"), "--project", "tsconfig.json"],
        [bin("tsc"), "--project", "worker/tsconfig.json", "--noEmit"],
        [bin("tsx"), "tools/connectors.ts", "--check"],
        [bin("tsx"), "tools/pages.ts", "--check"],
        ...(plan.design ? [[bin("tsx"), "tools/design.ts", "--check"]] : []),
      ];
    case "extension":
    case "dashboard":
    case "mcp":
      return [["npm", "run", "check", "--prefix", suite]];
    case "vitest":
      return [[bin("vitest"), "run", ...plan.projects.flatMap((project) => project === "core" || project === "connect" || project === "home" ? ["--project", project, "--project", `${project}_isolated`] : ["--project", project])]];
    case "ios":
      return [["ios-app/check.sh", "--whole"]];
    case "mac-only": {
      const own = (folder: string): string[] => plan.macOnly.filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1));
      const vitest = plan.macOnly.filter((path) => ownerOf(path).suite === "vitest");
      const packages = [...new Set(plan.macOnly.flatMap((path) => FOLLOWS.get(path) ?? []))];
      return [
        ...packages.map((folder) => ["swift", "build", "--package-path", folder]),
        ...(vitest.length > 0 ? [[bin("vitest"), "run", ...vitest]] : []),
        ...(["dashboard", "mcp"] as const).filter((folder) => own(folder).length > 0).map((folder) => ["npm", "test", "--prefix", folder, "--", ...own(folder)]),
      ];
    }
    case "macos-app":
      return [["swift", "test", "--parallel", "--num-workers", "3", "--package-path", suite, ...skipped(suite), "-Xswiftc", "-warnings-as-errors"]];
    case "faces":
    case "photolibrary":
    case "devicefiles":
    case "homelink":
    case "cockpit":
      return [["swift", "test", "--parallel", "--num-workers", "3", "--package-path", folderOf(suite), ...skipped(folderOf(suite))]];
  }
}

function folderOf(suite: Suite): string {
  return FOLDERS[suite] ?? suite;
}

function skipped(folder: string): string[] {
  return quarantined(ROOT).flatMap(({ path }) => {
    const id = new RegExp(`^${folder}/(\\w+)/(\\w+)/(\\w+)$`, "u").exec(path);
    return id === null ? [] : ["--skip", `^${id[1]}\\.${id[2]}/${id[3]}$`];
  });
}

interface Ended {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
  readonly left?: boolean;
}

const stoppable = new Set<ChildProcess>();
let stopped = false;

function stop(): void {
  stopped = true;
  for (const child of stoppable) child.kill("SIGTERM");
}

function ended(command: readonly string[], options: SpawnOptions, stoppableRun = false): Promise<Ended> {
  return new Promise((done) => {
    if (stoppableRun && stopped) return done({ status: null, signal: "SIGTERM" });
    const child = spawn(command[0]!, command.slice(1), options);
    if (stoppableRun) {
      stoppable.add(child);
      child.on("close", () => stoppable.delete(child));
    }
    child.on("error", (error) => done({ status: null, signal: null, error }));
    child.on("close", (status, signal) => done({ status, signal }));
  });
}

const SWIFT: ReadonlySet<Suite> = new Set(["faces", "photolibrary", "devicefiles", "homelink", "cockpit", "macos-app"]);
const IDLE_S = 30;
const TARGET_S = 600;

export function overran(seen: Map<number, number>, children: readonly number[], now: number, limit = TARGET_S): number[] {
  for (const pid of [...seen.keys()]) if (!children.includes(pid)) seen.delete(pid);
  for (const pid of children) if (!seen.has(pid)) seen.set(pid, now);
  return children.filter((pid) => now - seen.get(pid)! >= limit);
}

export function swiftEnded(command: readonly string[], options: SpawnOptions, log: string, fd: number): Promise<Ended> {
  return new Promise((done) => {
    const child = spawn(command[0]!, command.slice(1), options);
    let built = false;
    let idle = 0;
    let left = false;
    const seen = new Map<number, number>();
    const overrun: string[] = [];
    const nameOverrun = (): void => {
      if (overrun.length === 0) return;
      const text = readFileSync(log, "utf8");
      writeSync(fd, `\nerror: a test target's process ran ${TARGET_S} s, so a test in it hung, and was killed: `
        + `${overrun.map((line) => hungIn(packageOf(command), line, text)).join("; ")}\n`);
    };
    const watch = setInterval(() => {
      const pid = child.pid;
      if (pid === undefined) return;
      built ||= readFileSync(log, "utf8").includes("Build complete!");
      if (!built) return;
      const children = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
      const hung = overran(seen, children, Date.now() / 1000);
      if (hung.length > 0) {
        left = true;
        overrun.push(...spawnSync("ps", ["-o", "pid=,command=", "-p", hung.join(",")], { encoding: "utf8" }).stdout.trim().split("\n").map((line) => line.trim()));
        for (const each of hung) {
          seen.delete(each);
          try {
            process.kill(each, "SIGKILL");
          } catch {
          }
        }
      }
      idle = children.length > 0 ? 0 : idle + 1;
      if (idle < IDLE_S) return;
      idle = 0;
      left = true;
      const holders = holding(pid);
      const killed = holders.length > 0 ? holders : [pid];
      const named = spawnSync("ps", ["-o", "pid=,command=", "-p", killed.join(",")], { encoding: "utf8" }).stdout.trim().split("\n");
      writeSync(fd, `\nerror: swift test ran a test target's cases, then did not go on for ${IDLE_S} s; `
        + `${holders.length > 0 ? "what held its output open" : "nothing held its output open, so swift test itself"}, now killed: `
        + `${named.map((line) => line.trim().slice(0, 120)).join("; ")}\n`);
      for (const each of killed) {
        try {
          process.kill(each, "SIGKILL");
        } catch {
        }
      }
    }, 1000);
    child.on("error", (error) => {
      clearInterval(watch);
      nameOverrun();
      done({ status: null, signal: null, error, left });
    });
    child.on("close", (status, signal) => {
      clearInterval(watch);
      nameOverrun();
      done({ status, signal, left });
    });
  });
}

function packageOf(command: readonly string[]): string {
  return command[command.indexOf("--package-path") + 1] ?? "";
}

const CASE = /Test Case '-\[(\w+)\.(\w+) (\w+)\]' (started|passed|failed|skipped)/u;
const ENDED = /(\w+) (\w+)\]' (?:passed|failed|skipped)/u;
const ENDED_TAIL = /^(\w{4,})\]' (?:passed|failed|skipped)/u;

export function unended(log: string): string[] {
  const open = new Set<string>();
  for (const line of log.replace(/\x1b\[[0-9;]*m/gu, "").split("\n")) {
    const at = CASE.exec(line);
    if (at !== null) {
      const id = `${at[1]}/${at[2]}/${at[3]}`;
      if (at[4] === "started") open.add(id);
      else open.delete(id);
      continue;
    }
    const cut = ENDED.exec(line);
    const tail = cut === null ? ENDED_TAIL.exec(line)?.[1] : `/${cut[1]}/${cut[2]}`;
    if (tail === undefined) continue;
    for (const id of open) if (id.endsWith(tail)) open.delete(id);
  }
  return [...open];
}

export function hungIn(folder: string, ps: string, log: string): string {
  const pid = /^\d+/u.exec(ps)?.[0] ?? "?";
  const bundle = /([^\s/]+)\.xctest(?:\s|$)/u.exec(ps)?.[1];
  const open = unended(log).filter((id) => bundle === undefined || id.startsWith(`${bundle}/`));
  const where = bundle === undefined ? `process ${pid}` : `${bundle}.xctest (process ${pid})`;
  return open.length > 0
    ? `${where}, whose case started and never ended: ${open.map((id) => `${folder}/${id}`).join(", ")}`
    : `${where}, whose output names no case started and never ended`;
}

export function holding(pid: number, listed = spawnSync("lsof", ["-n", "-P", "-F", "pfdn"], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? ""): number[] {
  const ends: { pid: number; device: string; peer: string }[] = [];
  let owner = 0;
  let device = "";
  for (const line of listed.split("\n")) {
    if (line.startsWith("p")) owner = Number(line.slice(1));
    else if (line.startsWith("f")) device = "";
    else if (line.startsWith("d")) device = line.slice(1);
    else if (line.startsWith("n->")) ends.push({ pid: owner, device, peer: line.slice(3) });
  }
  const own = ends.filter((end) => end.pid === pid);
  return [...new Set(ends.filter((end) => end.pid !== pid && own.some((mine) => mine.peer === end.device || mine.device === end.peer)).map((end) => end.pid))];
}

async function run(plan: Plan, suites: readonly Suite[], stoppableRun = false): Promise<Suite[]> {
  mkdirSync(LOGS, { recursive: true });
  const runs = new Map<Suite, Promise<Suite[]>>();
  const after = (suite: Suite): Promise<Suite[]> => {
    const had = runs.get(suite);
    if (had !== undefined) return had;
    const ran = Promise.all(waitsFor(suite, suites).map(after)).then(() => runSuite(plan, suite, stoppableRun));
    runs.set(suite, ran);
    return ran;
  };
  return (await Promise.all(suites.map(after))).flat();
}

interface Underway {
  readonly plan: Plan;
  readonly started: number;
  readonly log: string;
  command: readonly string[];
}

const underway = new Map<Suite, Underway>();
const CUT = ".test-lock-cut";

function cut(): never {
  const capped = process.env.LIFESTREAM_TEST_RUN !== undefined && existsSync(join(process.env.LIFESTREAM_TEST_RUN, CUT));
  for (const [suite, { plan, started, log, command }] of capped ? underway : []) {
    writeFileSync(join(LOGS, `${suite}.status`), "fail\n");
    const text = readFileSync(log, "utf8");
    const never = [...new Set([...reds(suite, text), ...unreported(command, text)])].sort();
    say(`cut  ${label(plan, suite)}  ${Math.round((Date.now() - started) / 1000)} s  ${relative(ROOT, log)}\n`
      + `the run was cut while it ran: $ ${command.join(" ").slice(0, 300)}\n`
      + (never.length > 0 ? never.map((id) => `  red: ${id}\n`).join("") : `${tail(text.replace(/\x1b\[[0-9;]*m/gu, ""), 30)}\n`));
  }
  process.exit(143);
}

const SHOWN_FILE = /^\s*(?:✓|❯|×|↓|FAIL)\s+(\w+)\s+(\S+?\.test\.m?ts)\b/u;

export function unreported(command: readonly string[], log: string): string[] {
  if (!/(?:^|\/)vitest$/u.test(command[0] ?? "") || command[1] !== "run") return [];
  const shown = new Set<string>();
  for (const line of log.replace(/\x1b\[[0-9;]*m/gu, "").split("\n")) {
    const at = SHOWN_FILE.exec(line);
    if (at !== null && ROOTS[at[1]!] !== undefined) shown.add(vitestPath(at[1]!, at[2]!));
  }
  return command.slice(2).filter((arg) => /\.test\.m?ts$/u.test(arg) && !shown.has(arg));
}

const SWIFT_TEST_LINE = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\/([A-Za-z0-9_]+)$/u;

export interface SwiftJob {
  readonly bundle: string;
  readonly selectors: readonly string[];
  readonly count: number;
  readonly weight: number;
}

export function swiftDurations(log: string): Map<string, number> {
  const byClass = new Map<string, number>();
  for (const match of log.matchAll(/Test Case '-\[(\w+\.\w+) \w+\]' (?:passed|failed) \(([\d.]+) seconds\)/gu)) {
    const cls = match[1]!;
    byClass.set(cls, (byClass.get(cls) ?? 0) + Number(match[2]!));
  }
  return byClass;
}

export function swiftJobs(
  listed: string,
  binPath: string,
  quarantinedTests: ReadonlySet<string> = new Set(),
  maxPerJob = 35,
  hasBundle: (path: string) => boolean = existsSync,
  durations: ReadonlyMap<string, number> = new Map(),
): SwiftJob[] | null {
  const byTarget = new Map<string, Map<string, { kept: string[]; skipped: boolean }>>();
  for (const raw of listed.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const match = SWIFT_TEST_LINE.exec(line);
    if (match === null) return null;
    const target = match[1]!;
    const cls = `${target}.${match[2]!}`;
    const id = `${cls}/${match[3]!}`;
    let classes = byTarget.get(target);
    if (classes === undefined) {
      classes = new Map();
      byTarget.set(target, classes);
    }
    let entry = classes.get(cls);
    if (entry === undefined) {
      entry = { kept: [], skipped: false };
      classes.set(cls, entry);
    }
    if (quarantinedTests.has(id)) entry.skipped = true;
    else entry.kept.push(id);
  }
  if (byTarget.size === 0) return null;
  const jobs: SwiftJob[] = [];
  for (const [target, classes] of byTarget) {
    const bundle = join(binPath, `${target}.xctest`);
    if (!hasBundle(bundle)) return null;
    const items = [...classes.entries()]
      .filter(([, entry]) => entry.kept.length > 0)
      .map(([cls, entry]) => ({
        selectors: entry.skipped ? entry.kept : [cls],
        count: entry.kept.length,
        weight: durations.get(cls) ?? entry.kept.length * 0.05,
        cls,
      }))
      .sort((left, right) => right.weight - left.weight || right.count - left.count || (left.cls < right.cls ? -1 : 1));
    const chunks: { selectors: string[]; count: number; weight: number }[] = [];
    for (const item of items) {
      const fit = item.count < maxPerJob && item.weight < 2
        ? chunks.find((chunk) => chunk.count + item.count <= maxPerJob && chunk.weight + item.weight <= 2.5)
        : undefined;
      if (fit !== undefined) {
        fit.selectors.push(...item.selectors);
        fit.count += item.count;
        fit.weight += item.weight;
      } else {
        chunks.push({ selectors: [...item.selectors], count: item.count, weight: item.weight });
      }
    }
    for (const chunk of chunks) jobs.push({ bundle, selectors: chunk.selectors, count: chunk.count, weight: chunk.weight });
  }
  jobs.sort((left, right) => right.weight - left.weight || right.count - left.count || (left.bundle < right.bundle ? -1 : left.bundle > right.bundle ? 1 : 0));
  return jobs;
}

function quarantinedIds(folder: string): Set<string> {
  return new Set(quarantined(ROOT).flatMap(({ path }) => {
    const id = new RegExp(`^${folder}/(\\w+)/(\\w+)/(\\w+)$`, "u").exec(path);
    return id === null ? [] : [`${id[1]}.${id[2]}/${id[3]}`];
  }));
}

function xctestEnded(folder: string, command: readonly string[], options: SpawnOptions, log: string, fd: number): Promise<Ended> {
  return new Promise((done) => {
    const child = spawn(command[0]!, command.slice(1), options);
    let left = false;
    const seen = new Map<number, number>();
    const overrun: string[] = [];
    const nameOverrun = (): void => {
      if (overrun.length === 0) return;
      const text = readFileSync(log, "utf8");
      writeSync(fd, `\nerror: a test target's process ran ${TARGET_S} s, so a test in it hung, and was killed: `
        + `${overrun.map((line) => hungIn(folder, line, text)).join("; ")}\n`);
    };
    const watch = setInterval(() => {
      const pid = child.pid;
      if (pid === undefined) return;
      const hung = overran(seen, [pid], Date.now() / 1000);
      if (hung.length === 0) return;
      left = true;
      overrun.push(`${pid} ${command.join(" ")}`);
      seen.delete(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
      }
    }, 1000);
    child.on("error", (error) => {
      clearInterval(watch);
      nameOverrun();
      done({ status: null, signal: null, error, left });
    });
    child.on("close", (status, signal) => {
      clearInterval(watch);
      nameOverrun();
      done({ status, signal, left });
    });
  });
}

async function runSuite(plan: Plan, suite: Suite, stoppableRun: boolean): Promise<Suite[]> {
  const started = Date.now();
  const log = join(LOGS, `${suite}.log`);
  const prior = SWIFT.has(suite) && existsSync(log) ? swiftDurations(readFileSync(log, "utf8")) : new Map<string, number>();
  const env = { ...process.env, NSUnbufferedIO: "YES", ...(suite === "ios" ? { IOS_UI_TESTS: plan.uiTests, IOS_UNIT_TESTS: undefined } : {}) };
  const fd = openSync(log, "w");
  let ok = true;
  const awake = suite === "macos-app" && process.platform === "darwin" ? spawn("caffeinate", ["-d", "-w", String(process.pid)], { stdio: "ignore" }) : undefined;
  const now: Underway = { plan, started, log, command: [] };
  underway.set(suite, now);
  const commands = commandsOf(plan, suite);
  if (suite === "static" && commands.length > 1) {
    now.command = commands[0]!;
    const workers = Math.max(1, Math.floor(availableParallelism() / 4));
    const results: ({ result: Awaited<ReturnType<typeof ended>>; part: string } | undefined)[] = new Array(commands.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= commands.length) return;
        const command = commands[index]!;
        const part = join(LOGS, `${suite}.${index}.log`);
        const partFd = openSync(part, "w");
        writeSync(partFd, `$ ${command.join(" ")}\n`);
        const result = await ended(command, { cwd: ROOT, env, stdio: ["ignore", partFd, partFd] }, stoppableRun);
        if (result.error !== undefined) writeSync(partFd, `${result.error.message}\n`);
        closeSync(partFd);
        results[index] = { result, part };
      }
    };
    await Promise.all(Array.from({ length: Math.min(workers, commands.length) }, worker));
    for (const item of results) {
      if (item === undefined) continue;
      writeSync(fd, readFileSync(item.part));
      rmSync(item.part, { force: true });
      if (item.result.status !== 0 || item.result.left === true) ok = false;
    }
  } else if (SWIFT.has(suite) && process.platform === "darwin") {
    const folder = folderOf(suite);
    const build = ["swift", "build", "--build-tests", "--package-path", folder, ...(suite === "macos-app" ? ["-Xswiftc", "-warnings-as-errors"] : [])];
    now.command = build;
    writeSync(fd, `$ ${build.join(" ")}\n`);
    const built = await ended(build, { cwd: ROOT, env, stdio: ["ignore", fd, fd] }, stoppableRun);
    if (built.error !== undefined) writeSync(fd, `${built.error.message}\n`);
    if (built.status !== 0 || built.left === true) {
      ok = false;
    } else {
      const xctest = spawnSync("xcrun", ["--find", "xctest"], { cwd: ROOT, env, encoding: "utf8" });
      const xctestBin = xctest.status === 0 ? xctest.stdout.trim() : "";
      const debugDir = join(ROOT, folder, ".build/debug");
      const binPath = existsSync(debugDir)
        ? realpathSync(debugDir)
        : (() => {
            const shown = spawnSync("swift", ["build", "--show-bin-path", "--package-path", folder], { cwd: ROOT, env, encoding: "utf8" });
            return shown.status === 0 ? shown.stdout.trim() : "";
          })();
      const skippedTests = quarantinedIds(folder);
      const bundles = binPath !== "" && existsSync(binPath)
        ? readdirSync(binPath).filter((name) => name.endsWith(".xctest")).sort().map((name) => join(binPath, name))
        : [];
      let jobs: SwiftJob[] | null = null;
      if (xctestBin !== "" && binPath !== "") {
        if (skippedTests.size === 0 && bundles.length >= 1 && bundles.length <= 3) {
          jobs = bundles.map((bundle) => ({ bundle, selectors: [], count: 1, weight: 1 }));
        } else {
          const listed = spawnSync("swift", ["test", "list", "--skip-build", "--package-path", folder], { cwd: ROOT, env, encoding: "utf8" });
          if (listed.status === 0) jobs = swiftJobs(listed.stdout, binPath, skippedTests, 35, existsSync, prior);
        }
      }
      if (jobs === null) {
        for (const command of commands) {
          now.command = command;
          writeSync(fd, `$ ${command.join(" ")}\n`);
          const options: SpawnOptions = { cwd: ROOT, env, stdio: ["ignore", fd, fd] };
          const result = await swiftEnded(command, options, log, fd);
          if (result.error !== undefined) writeSync(fd, `${result.error.message}\n`);
          if (result.status !== 0 || result.left === true) ok = false;
        }
      } else {
        const results: ({ result: Ended; part: string } | undefined)[] = new Array(jobs.length);
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const index = next++;
            if (index >= jobs.length) return;
            const job = jobs[index]!;
            const command = job.selectors.length > 0 ? [xctestBin, "-XCTest", job.selectors.join(","), job.bundle] : [xctestBin, job.bundle];
            now.command = command;
            const part = join(LOGS, `${suite}.${index}.log`);
            const partFd = openSync(part, "w");
            writeSync(partFd, `$ ${command.join(" ")}\n`);
            const result = await xctestEnded(folder, command, { cwd: ROOT, env, stdio: ["ignore", partFd, partFd] }, part, partFd);
            if (result.error !== undefined) writeSync(partFd, `${result.error.message}\n`);
            closeSync(partFd);
            results[index] = { result, part };
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
        for (const item of results) {
          if (item === undefined) continue;
          writeSync(fd, readFileSync(item.part));
          rmSync(item.part, { force: true });
          if (item.result.status !== 0 || item.result.left === true) ok = false;
        }
      }
    }
  } else {
    for (const command of commands) {
      now.command = command;
      writeSync(fd, `$ ${command.join(" ")}\n`);
      const options: SpawnOptions = { cwd: ROOT, env, stdio: ["ignore", fd, fd] };
      const result = SWIFT.has(suite) ? await swiftEnded(command, options, log, fd) : await ended(command, options, stoppableRun);
      if (result.error !== undefined) writeSync(fd, `${result.error.message}\n`);
      if (result.status !== 0 || result.left === true) ok = false;
    }
  }
  awake?.kill();
  closeSync(fd);
  underway.delete(suite);
  writeFileSync(join(LOGS, `${suite}.status`), ok ? "ok\n" : "fail\n");
  const seconds = `${Math.round((Date.now() - started) / 1000)} s`;
  if (stoppableRun && stopped) say(`stop ${label(plan, suite)}  ${seconds}\n`);
  else if (ok) say(`ok   ${label(plan, suite)}  ${seconds}\n`);
  else say(`FAIL ${label(plan, suite)}  ${seconds}  ${relative(ROOT, log)}\n${redLines(suite, readFileSync(log, "utf8"))}\n`);
  return ok ? [] : [suite];
}

function tail(log: string, count = TAIL): string {
  return log.trimEnd().split("\n").slice(-count).join("\n");
}

const ROOTS: Readonly<Record<string, string>> = { all: "", isolated: "", core: "packages/core", core_isolated: "packages/core", connect: "packages/connect", connect_isolated: "packages/connect", families: "packages/families", model: "packages/model", privacy: "packages/privacy", home: "packages/home", home_isolated: "packages/home", runner: "packages/runner", tools: "tools", extension: "extension", worker: "worker" };
const vitestPath = (project: string, file: string): string => (ROOTS[project] === "" ? file : `${ROOTS[project]}/${file}`);
const RED = /^\s*(?:FAIL\s|×|✗|not ok |error: |\s*error: '|AssertionError|Error: |Test [Cc]ase '.*' failed|\*\* (?:TEST|BUILD) FAILED|.*: error: |never came in|worker died )/u;
const WORKER_DIED = /^worker died running (.+): (?:signal|exit code) \S+$/u;
const SHOWN = 25;

function redLines(suite: Suite, log: string): string {
  const text = log.replace(/\x1b\[[0-9;]*m/gu, "");
  const red = [...new Set(text.split("\n").filter((line) => RED.test(line)).map((line) => line.trimEnd().slice(0, 300)))];
  const shown = red.length > 0 ? red.slice(0, SHOWN).join("\n") + (red.length > SHOWN ? `\n… ${red.length - SHOWN} more in the log` : "") : tail(text, 30);
  const ids = reds(suite, text);
  if (ids.length === 0 && red.length > 0) return `${shown}\nno red test named; the log ends:\n${tail(text, 30)}\n`;
  return `${shown}\n${ids.map((id) => `  red: ${id}\n`).join("")}`;
}

export function reds(suite: Suite, log: string): string[] {
  const found = new Set<string>();
  let folder = suite === "dashboard" || suite === "mcp" ? suite : "";
  let failed = false;
  const swiftId = (match: RegExpExecArray): string => `${folderOf(suite)}/${match[1]}/${match[2]}/${match[3]}`;
  for (const line of log.replace(/\x1b\[[0-9;]*m/gu, "").split("\n")) {
    const prefix = /npm (?:run check|test) --prefix (dashboard|mcp)/u.exec(line);
    if (prefix !== null) folder = prefix[1]!;
    const vitest = /^\s*FAIL\s+(\w+)\s+(\S+?\.test\.m?ts)\b/u.exec(line);
    if (vitest !== null && ROOTS[vitest[1]!] !== undefined) found.add(vitestPath(vitest[1]!, vitest[2]!));
    const died = WORKER_DIED.exec(line);
    if (died !== null) for (const file of died[1]!.split(", ")) found.add(file);
    if (/^not ok /u.test(line)) failed = true;
    else if (/^ok /u.test(line)) failed = false;
    const at = /^\s*location: '.*\/(dashboard|mcp)\/(test\/[\w./-]+\.mjs):\d+/u.exec(line);
    if (failed && at !== null) found.add(`${at[1]}/${at[2]}`);
    else if (failed && folder !== "" && /^\s*location: '.*\/(test\/[\w./-]+\.mjs):/u.test(line)) found.add(`${folder}/${/(test\/[\w./-]+\.mjs):/u.exec(line)![1]}`);
    const swift = /Test Case '-\[(\w+)\.(\w+) (\w+)\]' failed/u.exec(line);
    if (swift !== null) found.add(swiftId(swift));
    const parallel = /^Test case '(\w+)[./](\w+)\(\)' failed on '.* - (\S+) \(\d+\)'/u.exec(line);
    if (parallel !== null) found.add(`${folderOf(suite)}/${bundleOf(parallel[3]!)}/${parallel[1]}/${parallel[2]}`);
  }
  for (const id of unended(log)) found.add(`${folderOf(suite)}/${id}`);
  return [...found].sort();
}

const RUNNER = "-Runner";
const bundleOf = (runner: string): string => (runner.endsWith(RUNNER) ? runner.slice(0, -RUNNER.length) : "LifestreamCaptureTests");

function changedPaths(): string[] {
  const git = (...args: string[]): string[] => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).split("\n").filter(Boolean);
  const base = git("merge-base", "HEAD", "main")[0]!;
  return [...new Set([...git("diff", "--name-only", "--no-renames", base), ...git("ls-files", "--others", "--exclude-standard")])].sort();
}

function commentPaths(paths: readonly string[]): Set<string> {
  const code = paths.filter((path) => checked(path) && !path.includes("\n") && existsSync(join(ROOT, path)));
  if (code.length === 0) return new Set();
  const base = execFileSync("git", ["-C", ROOT, "merge-base", "HEAD", "main"], { encoding: "utf8" }).trim();
  const batch = execFileSync("git", ["-C", ROOT, "cat-file", "--batch"], { input: code.map((path) => `${base}:${path}\n`).join(""), maxBuffer: 1 << 30 });
  const alone = new Set<string>();
  let at = 0;
  for (const path of code) {
    const end = batch.indexOf(10, at);
    const head = batch.subarray(at, end).toString("utf8");
    at = end + 1;
    const size = /^\S+ blob (\d+)$/u.exec(head)?.[1];
    if (size === undefined) continue;
    const before = batch.subarray(at, at + Number(size)).toString("utf8");
    at += Number(size) + 1;
    if (commentsAlone(path, before, readFileSync(join(ROOT, path), "utf8"))) alone.add(path);
  }
  return alone;
}

const MAIN_RED = "check: main's own run is red";

export function mainReds(log: readonly string[]): string[] {
  return [...new Set(log.filter((line) => line.startsWith("  red: ")))];
}

export function redSince(runs: readonly { readonly commit: string; readonly log: readonly string[] }[]): Map<string, string> {
  const [latest, ...before] = runs;
  const since = new Map<string, string>();
  for (const red of latest === undefined ? [] : mainReds(latest.log)) {
    const back = before.findIndex((run) => !run.log.includes(red));
    since.set(red, runs[back === -1 ? runs.length - 1 : back]!.commit);
  }
  return since;
}

function mainRun(): string {
  const main = dirname(execFileSync("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
  const latest = join(main, ".build/main-run/latest");
  if (!existsSync(latest)) return "";
  const log = readFileSync(latest, "utf8").split("\n");
  const said = log.filter((line) => line.startsWith("main-run: ")).at(-1);
  if (said === undefined || said.startsWith("main-run: PASS")) return "";
  const folder = dirname(realpathSync(latest));
  const runs = readdirSync(folder)
    .filter((name) => /^[0-9a-f]{40}\.log$/u.test(name))
    .map((name) => ({ commit: name.slice(0, 40), at: statSync(join(folder, name)).mtimeMs, log: readFileSync(join(folder, name), "utf8").split("\n") }))
    .filter((run) => run.log.some((line) => line.startsWith("main-run: ")))
    .sort((a, b) => b.at - a.at);
  const red = [...redSince(runs)].map(([line, commit]) => `${line}  since ${subject(main, commit)}`);
  return `${[`${MAIN_RED}, and a red this feature's own merge made is fixed on main now: ${said} ${realpathSync(latest)}`, ...red].join("\n")}\n`;
}

function subject(main: string, commit: string): string {
  const { status, stdout } = spawnSync("git", ["-C", main, "log", "-1", "--format=%h %s", commit], { encoding: "utf8" });
  return status === 0 ? stdout.trim().slice(0, 100) : commit;
}

export function given(specs: readonly string[]): Plan {
  let projects: readonly string[] = [];
  let macOnly: readonly string[] = [];
  const suites = specs.map((spec) => {
    const [suite, list] = spec.split(":") as [Suite, string | undefined];
    if (!SUITES.includes(suite)) throw new Error(`--run ${spec}: no such suite`);
    if (suite === "vitest") projects = list?.split(",") ?? PROJECTS;
    if (suite === "mac-only") macOnly = list?.split(",") ?? [];
    return { suite, by: "--run" };
  });
  return { suites, projects, design: false, uiTests: process.env.IOS_UI_TESTS ?? "", macOnly };
}

function spec(plan: Plan, suite: Suite): string {
  if (suite === "vitest") return `vitest:${plan.projects.join(",")}`;
  if (suite === "mac-only") return `mac-only:${plan.macOnly.join(",")}`;
  return suite;
}

async function main(args: readonly string[]): Promise<number> {
  if (args[0] === "--run") {
    process.on("SIGTERM", cut);
    const chosen = given(args.slice(1));
    const suites = chosen.suites.map(({ suite }) => suite);
    if (suites.every((suite) => SERVED.has(suite))) {
      let failed = 0;
      for (const suite of suites) failed += (await run(chosen, [suite])).length;
      return failed > 0 ? 1 : 0;
    }
    const last = (process.env.LIFESTREAM_CHECK_LAST ?? "").split(",").filter(Boolean);
    let failed = (await run(chosen, suites.filter((suite) => !last.includes(suite)))).length;
    for (const name of last) failed += (await run(chosen, suites.filter((suite) => suite === name))).length;
    return failed > 0 ? 1 : 0;
  }
  const at = args.indexOf("--without");
  const without = at === -1 ? [] : (args[at + 1] ?? "").split(",").filter(Boolean) as Suite[];
  const unknown = args.filter((arg, index) => arg !== "--all" && arg !== "--plan" && (at === -1 || (index !== at && index !== at + 1)));
  if (unknown.length > 0 || (at !== -1 && without.length === 0)) {
    throw new Error(`unknown ${unknown.join(" ") || "--without"}; usage: tsx tools/check.ts [--all] [--plan] [--without <suite,…>]`);
  }
  for (const suite of without) if (!SUITES.includes(suite)) throw new Error(`--without ${suite}: no such suite`);
  const all = args.includes("--all");
  const paths = all ? [] : changedPaths();
  const options = { all, comments: all ? undefined : commentPaths(paths), uiTests: process.env.IOS_UI_TESTS, classes: all ? readUiClasses(ROOT) : undefined, listed: macOnly(ROOT).map((entry) => entry.path) };
  const chosen = plan(paths, { ...options, without });
  const suites = chosen.suites.map(({ suite }) => suite);
  if (!all) say(mainRun());
  const left = plan(paths, options).suites.filter(({ suite }) => !suites.includes(suite));
  if (left.length > 0) say(`check: left out by --without: ${left.map(({ suite }) => suite).join(", ")}\n`);
  const branch = all ? "" : execFileSync("git", ["-C", ROOT, "branch", "--show-current"], { encoding: "utf8" }).trim();
  if (branch === "main") say(`check: on main, this checks only the checkout's uncommitted files (${paths.length}), never a merge already made: a lane's check runs in its worktree before its merge\n`);
  if (suites.length === 0) {
    say("check: nothing changed since main, nothing to run (a lane merged already has nothing left to check: main's own run, tools/main-run.sh, checks main)\n");
    return 0;
  }
  if (!all) say(`check: ${paths.length} changed path${paths.length === 1 ? "" : "s"} since main\n`);
  for (const line of lines(chosen)) say(`plan: ${line}\n`);
  if (args.includes("--plan")) return 0;

  const started = Date.now();
  const seconds = (): string => `${Math.round((Date.now() - started) / 1000)} s`;
  const cache = cacheFolder();
  const found = blobs();
  const wanted = [...units(chosen), ...(suites.includes(PHONE) ? ["ios:"] : []), ...(chosen.design ? ["static"] : [])];
  const key = keys(found, wanted, quarantined(ROOT).map((entry) => entry.path));
  const passed = (unit: string): boolean => existsSync(join(cache, key.get(unit) ?? "none"));
  const todo = uncached(chosen, passed);
  for (const { suite } of chosen.suites) {
    const left = todo.suites.find((each) => each.suite === suite);
    if (left === undefined) say(`cached ${label(chosen, suite)}\n`);
    else if (label(todo, suite) !== label(chosen, suite)) say(`cached part of ${label(chosen, suite)}: runs ${label(todo, suite)}\n`);
  }
  const running = todo.suites.map(({ suite }) => suite);
  if (running.length === 0) {
    say(`check: ok, every suite cached, ${seconds()}\n`);
    return 0;
  }
  for (const suite of running) for (const kept of ["status", "log"]) rmSync(join(LOGS, `${suite}.${kept}`), { force: true });
  const general = running.filter((suite) => !LOCK_FREE.has(suite) && suite !== PHONE);
  let served = general.filter((suite) => SERVED.has(suite));
  let mac = general.filter((suite) => !SERVED.has(suite));
  if (served.length > 0) {
    const where = spawnSync("tools/test-lock.sh", ["--where", ...half(todo, served)], { cwd: ROOT, encoding: "utf8" });
    if (where.stdout.trim() !== "server") {
      mac = general.filter((suite) => suite !== "mac-only");
      served = [];
      const why = where.stderr.trim();
      if (why !== "") say(`check: ${process.env.LIFESTREAM_TEST_SERVER ?? "lstest"} did not answer (${why}): its half runs here\n`);
    }
  }
  const halves = await Promise.all([
    run(todo, running.filter((suite) => suite === "static")).then((failed) => {
      if (failed.length === 0) return false;
      if (all) return true;
      if (stoppable.size > 0) say("check: static is red, so the other suites stop: fix it and run the check again\n");
      stop();
      return true;
    }),
    run(todo, running.filter((suite) => LOCK_FREE.has(suite) && suite !== "static")).then((failed) => failed.length > 0),
    served.length > 0 ? lockedHalf(todo, served, {}) : false,
    mac.length > 0 ? lockedHalf(todo, mac, { LIFESTREAM_TEST_HERE: "1" }) : false,
    running.includes(PHONE) ? run(todo, [PHONE], true).then((failed) => failed.length > 0) : false,
  ]);
  const stamp = `${new Date().toISOString()} ${ROOT}\n`;
  for (const suite of running) {
    const status = join(LOGS, `${suite}.status`);
    if (!existsSync(status) || readFileSync(status, "utf8").trim() !== "ok") continue;
    const done = [...units({ ...todo, suites: [{ suite, by: "" }] }), ...(suite === PHONE ? ["ios:"] : []), ...(suite === "static" && todo.design ? ["static"] : [])];
    for (const unit of done) {
      const hash = key.get(unit);
      if (hash !== undefined) writeFileSync(join(cache, hash), `${unit} ${stamp}`);
    }
  }
  const failed = halves.includes(true);
  say(`check: ${failed ? "FAILED (each FAIL above names its log and its red tests)" : "ok"}, ${seconds()}\n`);
  return failed ? 1 : 0;
}

function half(plan: Plan, suites: readonly Suite[]): string[] {
  return [bin("tsx"), "tools/check.ts", "--run", ...suites.map((suite) => spec(plan, suite))];
}

async function lockedHalf(plan: Plan, suites: readonly Suite[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const inner = await ended(["tools/test-lock.sh", ...half(plan, suites)], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" }, true);
  if (stopped) return true;
  if (inner.error !== undefined) say(`check: the locked run did not start: ${inner.error.message}\n`);
  else if (inner.signal !== null) say(`check: the locked run ended on ${inner.signal}\n`);
  else if (inner.status !== 0 && inner.status !== 1) say(`check: the locked run ${inner.status === 143 ? "was cut (exit 143)" : `exited ${inner.status}`}\n`);
  const unread = inner.status === 0 ? [] : suites.filter((suite) => !existsSync(join(LOGS, `${suite}.status`)));
  for (const suite of unread) say(`cut  ${label(plan, suite)}  no verdict came back: nothing is known of it but ${relative(ROOT, join(LOGS, `${suite}.log`))}, where that exists\n`);
  return inner.status !== 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`check: ${(error as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
