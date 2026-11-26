import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FULL } from "../vitest.config.mjs";
import { BY_HAND, commandsOf, given, holding, hungIn, keys, label, lines, mainReds, overran, plan, readUiClasses, reds, redSince, swiftDurations, swiftJobs, uncached, unended, units, unreported, waitsFor } from "./check.js";

function planned(paths: readonly string[], options: Parameters<typeof plan>[1] = {}, by = false): string[] {
  const printed = lines(plan(paths, options));
  return by ? printed : printed.map((line) => line.slice(0, line.indexOf("  ← ")));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL_PROJECTS = "vitest core,connect,families,model,privacy,home,runner,tools,extension,worker";
const TYPESCRIPT = ["static", "extension", "mcp", "dashboard", ALL_PROJECTS];

describe("the path table", () => {
  it.each([
    ["packages/core/records.ts", ["static", "mcp", "dashboard", "homelink", ALL_PROJECTS]],
    ["packages/core/sealed.ts", ["static", "mcp", "dashboard", "devicefiles", "homelink", ALL_PROJECTS]],
    ["packages/core/sealed-vectors/mac/mac-file-0.bin", ["static", "mcp", "dashboard", "devicefiles", "homelink", ALL_PROJECTS]],
    ["packages/connect/messages/whatsapp/acquire.ts", ["static", "mcp", "dashboard", "vitest core,connect,families,home,tools"]],
    ["packages/connect/macos-app/screen.ts", ["static", "mcp", "dashboard", "vitest core,connect,families,home,tools", "macos-app"]],
    ["packages/connect/ai/session-log.ts", ["static", "mcp", "dashboard", "vitest core,connect,families,home,tools", "macos-app"]],
    ["packages/connect/photos/apple/library.ts", ["static", "mcp", "dashboard", "vitest core,connect,families,home,tools", "macos-app"]],
    ...["messages/imessage", "calls/apple", "notes/apple", "browser/chrome", "browser/safari", "voice/wispr-flow", "calendar/apple", "calendar/apple-reminders"].map((provider): [string, string[]] => [`packages/connect/${provider}/test/changes-bundle.zip`, ["static", "mcp", "dashboard", "vitest core,connect,families,home,tools", "macos-app"]]),
    ["packages/connect/photos/google/takeout.ts", ["static", "mcp", "dashboard", "vitest core,connect,families,home,tools"]],
    ["packages/families/physical/where.ts", ["static", "mcp", "dashboard", "vitest core,families,home,tools"]],
    ["packages/model/ledger.ts", ["static", "mcp", "dashboard", "vitest core,model,home,runner,tools"]],
    ["packages/runner/serve.ts", ["static", "vitest core,home,runner,tools"]],
    ["packages/privacy/hider.ts", ["static", "mcp", "dashboard", "vitest core,privacy,home,tools"]],
    ["packages/home/door.ts", ["static", "mcp", "dashboard", "homelink", "vitest core,home,tools,extension"]],
    ["tools/geography.ts", ["static", "vitest tools"]],
    ["worker/index.ts", ["static", "vitest worker"]],
    ["extension/station.ts", ["static", "extension", "vitest extension"]],
    ["dashboard/public/app.js", ["static", "extension", "dashboard"]],
    ["dashboard/lib/http.mjs", ["static", "extension", "dashboard", "macos-app"]],
    ["packages/families/test/day-page/day.json", ["static", "mcp", "dashboard", "vitest core,families,home,tools", "ios app-hosted"]],
    ["mcp/server.mjs", ["static", "mcp"]],
    ["design/tokens.json", ["static +design", "extension", "dashboard", "vitest extension", "macos-app", "ios app-hosted"]],
    ["design/icons.json", ["static +design", "extension", "dashboard", "vitest home,extension", "macos-app", "ios app-hosted"]],
    ["design/principles.md", ["static +design"]],
    ["homelink/Tests/Fixtures/report.json", ["static", "dashboard", "homelink", "vitest home", "macos-app", "ios app-hosted"]],
    ["docs/DESIGN.md", ["static", "vitest home"]],
    ["tools/design.ts", ["static +design", "vitest tools"]],
    ["homelink/Sources/HomeLink/Pairing.swift", ["static", "homelink", "macos-app", "ios app-hosted"]],
    ["design/swift/Sources/Cockpit/Components/AskTrace.swift", ["static +design", "extension", "dashboard", "cockpit", "macos-app", "ios app-hosted"]],
    ["photolibrary/Sources/PhotoLibrary/Pass.swift", ["static", "photolibrary", "macos-app", "ios app-hosted"]],
    ["devicefiles/Sources/DeviceFiles/Log.swift", ["static", "devicefiles"]],
    ["macos-app/Sources/Recorder.swift", ["static", "macos-app"]],
    ["faces/Sources/Scan.swift", ["static", "faces"]],
    ["ios-app/Sources/Core/Spool.swift", ["static", "ios app-hosted"]],
    ["ios-app/LifestreamCaptureTests/AppSmokeTests.swift", ["static", "ios app-hosted"]],
    ["docs/OPERATING.md", ["static", "vitest home"]],
    ["docs/operating/reading.md", ["static", "vitest home"]],
  ])("%s", (path, suites) => {
    expect(planned([path])).toEqual(suites);
  });

  it("runs Cockpit's tests from the design package's Swift folder, on a change in it or in the Chat timelines it shares with the web, and on no other design file", () => {
    expect(commandsOf(given(["cockpit"]), "cockpit")).toEqual([["swift", "test", "--parallel", "--num-workers", "3", "--package-path", "design/swift"]]);
    expect(planned(["design/css/kit.css"])).not.toContain("cockpit");
    expect(planned(["design/ask-trace.json"])).toEqual(expect.arrayContaining(["dashboard", "cockpit"]));
  });

  it("runs static alone for a path no row names: a doc, a page, the website", () => {
    expect(planned(["docs/testing.md", "README.md", "website/index.html", "docs/README.md"])).toEqual(["static"]);
  });

  it("runs nothing when nothing changed", () => {
    expect(planned([])).toEqual([]);
  });

  it("names the first path that chose each suite, and joins the projects of every path", () => {
    expect(planned(["docs/testing.md", "packages/home/door.ts", "packages/core/records.ts", "mcp/server.mjs"], {}, true)).toEqual([
      "static  ← docs/testing.md",
      "mcp  ← packages/home/door.ts",
      "dashboard  ← packages/home/door.ts",
      "homelink  ← packages/home/door.ts",
      `${ALL_PROJECTS}  ← packages/home/door.ts`,
    ]);
  });
});

describe("the machinery", () => {
  it.each([
    "package.json", "package-lock.json", "tsconfig.json", ".nvmrc", "vitest.config.mts", "vitest.full.config.mts",
    "testing/run.mts", "testing/process.mjs", "tools/check.ts", "tools/check.test.ts", "tools/test-lock.sh", "tools/lstest.sh", "testing/mac-only.txt", "testing/quarantine.txt",
  ])("%s chooses every TypeScript suite and no Swift one", (path) => {
    expect(planned([path])).toEqual(TYPESCRIPT);
  });

  it("takes every check tool as test machinery", () => {
    for (const path of ["tools/check-docs.ts", "tools/check-layers.ts", "tools/check-tests.ts"]) expect(planned([path])).toEqual(TYPESCRIPT);
  });

  it("takes a folder's own package.json and tsconfig as that folder's", () => {
    expect(planned(["dashboard/package.json", "mcp/tsconfig.json"])).toEqual(["static", "extension", "mcp", "dashboard"]);
  });
});

describe("pages", () => {
  it("runs static alone for a page no test reads: a README, the owed page, a family's page", () => {
    expect(planned(["packages/core/README.md", "docs/owed.md", "packages/families/photos/photos.md", "packages/connect/README.md",
      "dashboard/README.md", "extension/README.md", "ios-app/README.md", "macos-app/README.md", "mcp/README.md"])).toEqual(["static"]);
  });

  it("runs the test that reads a page: the home's for the connect skill's list", () => {
    expect(planned(["packages/connect/SKILL.md"])).toEqual(["static", "vitest home"]);
  });

  it("runs static alone for a Mac module's README.md: the Mac's test only finds it", () => {
    expect(planned(["macos-app/Sources/Spool/README.md"])).toEqual(["static"]);
  });

  it("runs static alone for a script that only ships or installs the iPhone's build", () => {
    for (const name of ["testflight.py", "upload-testflight.sh", "install-phone.sh"]) expect(planned([`ios-app/${name}`])).toEqual(["static"]);
    expect(planned(["ios-app/check.sh"])).toEqual(["static", "ios app-hosted"]);
  });

  it("runs the home for a connector's page, which its conformance test holds each declaration to", () => {
    for (const path of ["packages/connect/messages/whatsapp/whatsapp.md", "packages/connect/ai/ai.md"]) expect(planned([path])).toEqual(["static", "vitest home"]);
  });

  it("runs static alone for a page of the design system: its principles, its README", () => {
    expect(planned(["design/principles.md", "design/README.md", "design/swift/README.md"])).toEqual(["static +design"]);
  });

  it("takes a prompt, or a fixture, for code: the code reads it", () => {
    expect(planned(["packages/families/ai/prompts/ai-turn-v1.md"])).toEqual(planned(["packages/families/ai/family.ts"]));
    expect(planned(["packages/connect/health/whoop/test/notes.md"])).toEqual(planned(["packages/connect/health/whoop/test/fixtures.ts"]));
  });
});

describe("a change in comments alone", () => {
  it("runs static alone for the file, and the rest of the change as it would", () => {
    const comments = new Set(["packages/home/test/harness-root.ts", "design/swift/Sources/Cockpit/Components/DayParts.swift"]);
    const chosen = plan([...comments, "packages/core/time.ts"], { comments });
    expect(chosen.suites.map(({ suite }) => suite)).toEqual(plan(["packages/core/time.ts"]).suites.map(({ suite }) => suite));
    expect(chosen.design).toBe(true);
    expect(plan([...comments], { comments }).suites.map(({ suite }) => suite)).toEqual(["static"]);
  });
});

describe("test files", () => {
  it.each([
    ["packages/families/physical/e2e.test.ts", "vitest families"],
    ["packages/core/durable.test.ts", "vitest core"],
    ["packages/home/connectors.e2e.test.ts", "vitest home"],
    ["packages/connect/messages/whatsapp/e2e.test.ts", "vitest connect"],
  ])("%s runs its own project alone", (path, suite) => {
    expect(planned([path])).toEqual(["static", suite]);
  });

  it("takes a test's helper for code: other tests import it", () => {
    expect(planned(["packages/home/test/harness-root.ts"])).toEqual(planned(["packages/home/door.ts"]));
  });
});

describe("the extension's project", () => {
  it.each(["dashboard/public/ui/kit/button.js", "dashboard/public/lib/html.js", "dashboard/public/loader-still.svg", "design/css/kit.css", "design/tokens.json"])(
    "runs for %s, which the extension's code imports or its build copies",
    (path) => expect(planned([path]).find((line) => line.startsWith("vitest "))?.split(/[ ,]/u)).toContain("extension"),
  );

  it("runs for no other path of the dashboard or the design system", () => {
    for (const path of ["dashboard/public/app.js", "dashboard/lib/door.mjs", "design/principles.md", "design/swift/Sources/Cockpit/Tokens.swift"]) {
      expect(planned([path]).filter((line) => line.startsWith("vitest"))).toEqual([]);
    }
  });

  it("runs for every file outside the extension that its code imports", () => {
    const code = execFileSync("git", ["ls-files", "extension"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((file) => file.endsWith(".ts"));
    expect([...walk(code)].filter((file) => !file.startsWith("extension/") && !plan([file]).projects.includes("extension"))).toEqual([]);
  });
});

function walk(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[mc]?[jt]s$/u.test(file)) continue;
    const source = readFileSync(join(ROOT, file), "utf8");
    const specs = [
      ...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[\w*{}\s,]*?\s*from\s+["']([^"']+)["']/gmu),
      ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gmu),
      ...source.matchAll(/new URL\(\s*["']([^"']+\.[mc]?[jt]s)["']\s*,\s*import\.meta\.url\s*\)/gu),
    ].map(([, spec]) => spec!);
    for (const spec of specs.filter((each) => each.startsWith("."))) {
      const next = resolved(file, spec);
      if (next !== undefined) stack.push(next);
    }
  }
  return seen;
}

function resolved(from: string, spec: string): string | undefined {
  const base = normalize(join(dirname(from), spec));
  return [base, base.replace(/\.js$/u, ".ts"), base.replace(/\.mjs$/u, ".mts"), `${base}.ts`, join(base, "index.ts")]
    .find((file) => existsSync(join(ROOT, file)) && statSync(join(ROOT, file)).isFile());
}

describe("the Mac's own files", () => {
  const listed = ["packages/home/release.e2e.test.ts", "extension/window.e2e.test.ts", "dashboard/test/onboarding-connect.mjs"];

  it("runs on the Mac each file whose suite or vitest project the plan chose, and no other", () => {
    expect(planned(["packages/model/ledger.ts"], { listed })).toEqual(["static", "mcp", "dashboard", "vitest core,model,home,runner,tools", "mac-only packages/home/release.e2e.test.ts,dashboard/test/onboarding-connect.mjs"]);
    expect(planned(["extension/station.ts"], { listed }, true)).toEqual(["static  ← extension/station.ts", "extension  ← extension/station.ts", "vitest extension  ← extension/station.ts", "mac-only extension/window.e2e.test.ts  ← extension/station.ts"]);
    expect(planned(["mcp/server.mjs", "tools/geography.ts"], { listed })).toEqual(["static", "mcp", "vitest tools"]);
    expect(planned(["testing/mac-only.txt"], { listed }).at(-1)).toBe(`mac-only ${listed.join(",")}`);
  });

  it("runs a file that follows a Swift package on that package's change, keys it by the package's paths, and builds the package first", () => {
    const engine = "packages/home/engine-pictures-mac.e2e.test.ts";
    expect(planned(["faces/Sources/face-engine/Read.swift"], { listed: [...listed, engine] })).toEqual(["static", "faces", `mac-only ${engine}`]);
    const tree = new Map([["faces/Sources/face-engine/Read.swift", "a1"], ["packages/home/door.ts", "b1"]]);
    const units = [`mac-only:${engine}`, "mac-only:packages/home/release.e2e.test.ts"];
    const before = keys(tree, units);
    const after = keys(new Map([...tree, ["faces/Sources/face-engine/Read.swift", "a2"]]), units);
    expect(after.get(`mac-only:${engine}`)).not.toBe(before.get(`mac-only:${engine}`));
    expect(after.get("mac-only:packages/home/release.e2e.test.ts")).toBe(before.get("mac-only:packages/home/release.e2e.test.ts"));
    expect(commandsOf(given([`mac-only:${engine}`]), "mac-only")[0]).toEqual(["swift", "build", "--package-path", "faces"]);
    expect(commandsOf(given(["mac-only:dashboard/test/video-door.mjs"]), "mac-only")[0]).toEqual(["swift", "build", "--package-path", "faces"]);
  });

  it("starts mac-only once the faces suite ends, whose package's build folder its files build and run from", () => {
    expect(waitsFor("mac-only", ["faces", "macos-app", "mac-only", "ios"])).toEqual(["faces"]);
    expect(waitsFor("mac-only", ["macos-app", "mac-only"])).toEqual([]);
    expect(waitsFor("faces", ["faces", "mac-only"])).toEqual([]);
  });

  it("carries vitest's projects and mac-only's files through --run", () => {
    const chosen = given(["mcp", "vitest:home,tools", "mac-only:packages/home/release.e2e.test.ts,dashboard/test/onboarding-connect.mjs"]);
    expect(chosen.suites.map(({ suite }) => label(chosen, suite))).toEqual(["mcp", "vitest home,tools", "mac-only packages/home/release.e2e.test.ts,dashboard/test/onboarding-connect.mjs"]);
    expect(() => given(["swift"])).toThrow(/^--run swift: no such suite/u);
  });
});

describe("the phone", () => {
  it.each([
    "ios-app/LifestreamCapture/Places/List.swift", "ios-app/LifestreamCapture/App/LifeGate.swift", "ios-app/LifestreamCaptureUITests/CheckInUITests.swift",
    "ios-app/LifestreamCaptureUITests/UITestNavigation.swift", "ios-app/LifestreamCaptureUITests/SpeedUITests.swift",
  ])("runs its app-hosted tests alone for %s: the UI classes run after the merge", (path) => {
    expect(planned([path])).toEqual(["static", "ios app-hosted"]);
  });

  it("runs the caller's IOS_UI_TESTS, and never chooses the phone by them alone", () => {
    expect(planned(["ios-app/LifestreamCapture/Places/List.swift"], { uiTests: "CheckInUITests" })).toEqual(["static", "ios CheckInUITests"]);
    expect(planned(["homelink/Sources/HomeLink/Pairing.swift"], { uiTests: "AppShellUITests" })).toEqual(["static", "homelink", "macos-app", "ios AppShellUITests"]);
    expect(planned(["docs/testing.md"], { uiTests: "CheckInUITests" })).toEqual(["static"]);
  });
});

describe("--all", () => {
  const every = ["static +design", "extension", "mcp", "dashboard", "faces", "photolibrary", "devicefiles", "homelink", "cockpit", ALL_PROJECTS, "macos-app"];
  const classes = readUiClasses(ROOT);
  const ui = `ios ${classes.filter((name) => !BY_HAND.includes(name)).join(",")}`;

  it("runs every suite and every UI class on disk but those run by hand, once each, whatever changed", () => {
    expect(classes).toContain("AppShellUITests");
    for (const name of BY_HAND) expect(classes).toContain(name);
    expect(planned([], { all: true, classes })).toEqual([...every, ui]);
    expect(planned(["ios-app/LifestreamCapture/Places/List.swift"], { all: true, classes }, true)).toEqual([...every, ui].map((line) => `${line}  ← --all`));
  });

  it("runs the UI classes the caller names", () => {
    expect(planned([], { all: true, classes, uiTests: "CheckInUITests" })).toEqual([...every, "ios CheckInUITests"]);
  });
});

describe("--without", () => {
  const classes = readUiClasses(ROOT);
  const listed = ["packages/home/release.e2e.test.ts"];

  it("leaves out the suites it names and only those, with --all or a change", () => {
    expect(planned(["homelink/Sources/HomeLink/Pairing.swift"], { without: ["ios"] })).toEqual(["static", "homelink", "macos-app"]);
    expect(planned([], { all: true, classes, without: ["ios"] })).toEqual(["static +design", "extension", "mcp", "dashboard", "faces", "photolibrary", "devicefiles", "homelink", "cockpit", ALL_PROJECTS, "macos-app"]);
    expect(planned(["docs/testing.md"], { without: ["ios"] })).toEqual(["static"]);
  });

  it("takes vitest's projects and mac-only's files with their suite", () => {
    const left = plan(["packages/home/door.ts"], { listed, without: ["vitest"] });
    expect(left.projects).toEqual([]);
    expect(left.macOnly).toEqual([]);
    expect(lines(left).map((line) => line.slice(0, line.indexOf("  ← ")))).toEqual(["static", "mcp", "dashboard", "homelink"]);
    expect(plan(["packages/home/door.ts"], { listed, without: ["mac-only"] }).suites.map(({ suite }) => suite)).not.toContain("mac-only");
    expect(plan(["packages/home/door.ts"], { listed }).macOnly).toEqual(listed);
  });
});

describe("the cache", () => {
  const tree = new Map([
    ["packages/home/door.ts", "a1"], ["packages/core/records.ts", "b1"], ["mcp/server.mjs", "c1"], ["docs/testing.md", "d1"],
    ["ios-app/LifestreamCapture/Days/Day.swift", "e1"], ["testing/quarantine.txt", "f1"], ["packages/home/release.e2e.test.ts", "g1"],
  ]);
  const changed = (path: string, blob: string) => new Map([...tree, [path, blob]]);
  const all = ["static", "mcp", "vitest:home", "vitest:core", "vitest:families", "homelink", "ios:", "mac-only:packages/home/release.e2e.test.ts"];
  const before = keys(tree, all);

  it("splits vitest by project and mac-only by file, and names what the phone and static run", () => {
    const chosen = plan(["packages/home/door.ts", "ios-app/LifestreamCapture/Days/Day.swift", "design/tokens.json"], { listed: ["packages/home/release.e2e.test.ts"], uiTests: "DaysFlowUITests" });
    expect(units(chosen)).toEqual(["static+design", "extension", "mcp", "dashboard", "homelink", "vitest:core", "vitest:home", "vitest:tools", "vitest:extension", "macos-app", "mac-only:packages/home/release.e2e.test.ts", "ios:DaysFlowUITests"]);
  });

  it("changes a unit's key with a path that chooses it, and with no other", () => {
    const after = keys(changed("mcp/server.mjs", "c2"), all);
    expect(after.get("mcp")).not.toBe(before.get("mcp"));
    expect(after.get("static")).not.toBe(before.get("static"));
    for (const unit of ["vitest:home", "vitest:core", "homelink", "ios:"]) expect(after.get(unit)).toBe(before.get(unit));
    const home = keys(changed("packages/home/door.ts", "a2"), all);
    for (const unit of ["mcp", "vitest:home", "vitest:core", "homelink", "mac-only:packages/home/release.e2e.test.ts"]) expect(home.get(unit)).not.toBe(before.get(unit));
    for (const unit of ["vitest:families", "ios:"]) expect(home.get(unit)).toBe(before.get(unit));
  });

  it("changes a unit's key with its own quarantined tests, static's with the list, and a unit's with what it runs", () => {
    const after = keys(changed("testing/quarantine.txt", "f2"), all, ["packages/home/extract-cost.e2e.test.ts", "ios-app/LifestreamCaptureUITests/StartFlowUITests/testA"]);
    for (const unit of ["static", "vitest:home", "ios:"]) expect(after.get(unit)).not.toBe(before.get(unit));
    for (const unit of ["mcp", "vitest:core", "vitest:families", "homelink"]) expect(after.get(unit)).toBe(before.get(unit));
    expect(keys(tree, all, ["macos-app/MacTests/SpoolTests/testB"]).get("homelink")).toBe(before.get("homelink"));
    const cockpit = keys(tree, ["cockpit", "homelink"], ["design/swift/CockpitTests/AskTraceTests/testA"]);
    expect(cockpit.get("cockpit")).not.toBe(keys(tree, ["cockpit"]).get("cockpit"));
    expect(cockpit.get("homelink")).toBe(before.get("homelink"));
    expect(keys(tree, ["ios:DaysFlowUITests"]).get("ios:DaysFlowUITests")).not.toBe(before.get("ios:"));
    expect(keys(tree, ["static+design"]).get("static+design")).not.toBe(before.get("static"));
  });

  it("runs only the units with no pass: a suite dropped, vitest's projects and mac-only's files narrowed", () => {
    const chosen = plan(["packages/home/door.ts"], { listed: ["packages/home/release.e2e.test.ts"] });
    const passed = new Set(["mcp", "vitest:core", "vitest:tools", "mac-only:packages/home/release.e2e.test.ts"]);
    const left = uncached(chosen, (unit) => passed.has(unit));
    expect(lines(left).map((line) => line.slice(0, line.indexOf("  ← ")))).toEqual(["static", "dashboard", "homelink", "vitest home,extension"]);
    expect(uncached(chosen, () => true).suites).toEqual([]);
  });
});

describe("the red tests a log names", () => {
  it("names vitest's files from their project's folder", () => {
    const log = " \x1b[31mFAIL\x1b[39m   home  door.e2e.test.ts > a door killed after its seal\n FAIL   extension  window.e2e.test.ts > the station's window\n FAIL   home  door.e2e.test.ts > again";
    expect(reds("vitest", log)).toEqual(["extension/window.e2e.test.ts", "packages/home/door.e2e.test.ts"]);
  });

  it("names node --test's failed files, and none that passed", () => {
    const log = ["$ npm test --prefix dashboard", "not ok 1 - test/days.mjs", "  ---", "  location: '/home/tests/runs/abc/dashboard/test/days.mjs:1:1'", "ok 2 - test/people.mjs", "  location: '/home/tests/runs/abc/dashboard/test/people.mjs:1:1'"].join("\n");
    expect(reds("dashboard", log)).toEqual(["dashboard/test/days.mjs"]);
    expect(reds("mac-only", log)).toEqual(["dashboard/test/days.mjs"]);
  });

  it("names a Swift test by its package, target, class and name", () => {
    expect(reds("ios", "Test Case '-[LifestreamCaptureUITests.PeopleFlowUITests testQuietGroups]' failed (3.1 seconds).")).toEqual(["ios-app/LifestreamCaptureUITests/PeopleFlowUITests/testQuietGroups"]);
    expect(reds("macos-app", "Test Case '-[ShippingTests.MacSettingsTests testARefresh]' failed (0.1 seconds).\nTest Case '-[ShippingTests.MacSettingsTests testB]' passed")).toEqual(["macos-app/ShippingTests/MacSettingsTests/testARefresh"]);
  });

  it("names a phone test red in a parallel run, by the bundle its runner holds, and none that passed", () => {
    const log = [
      "Test case 'PhotoViewerLinksUITests.testJourneyLinks()' failed on 'Clone 2 of iPhone 16 Pro tests - LifestreamCaptureUITests-Runner (71658)' (13.332 seconds)",
      "Test case 'ShippingTests.testA5xx()' failed on 'Clone 2 of iPhone 16 Pro tests - Lifestream (69458)' (0.1 seconds)",
      "Test case 'ShippingTests.testA401()' passed on 'Clone 2 of iPhone 16 Pro tests - Lifestream (69458)' (0.1 seconds)",
      "Failing tests:",
      "\tPhotoViewerLinksUITests.testJourneyLinks()",
    ].join("\n");
    expect(reds("ios", log)).toEqual(["ios-app/LifestreamCaptureTests/ShippingTests/testA5xx", "ios-app/LifestreamCaptureUITests/PhotoViewerLinksUITests/testJourneyLinks"]);
  });

  it("names a Swift case that started and never ended, before the next target or at the log's end, and none that ended", () => {
    const log = [
      "Test Case '-[HomeLinkTests.TurnTests testA]' started.",
      "Test Case '-[HomeLinkTests.TurnTests testA]' passed (0.003 seconds).",
      "Test Case '-[HomeLinkTests.TurnTests testB]' started.",
      "Test Case '-[HomeLinkTests.TurnTests testB]' skipped (0.001 seconds).",
      "Test Case '-[HomeLinkTests.TurnTests testHung]' started.",
      "Test Suite 'Selected tests' started at 2026-11-14 22:05:02.261.",
      "Test Case '-[HomeLinkE2ETests.WiFiTests testC]' started.",
      "Test Case '-[HomeLinkE2ETests.WiFiTests testC]' passed (3.888 seconds).",
      "Test Case '-[HomeLinkE2ETests.WiFiTests testLast]' started.",
    ].join("\n");
    expect(reds("homelink", log)).toEqual(["homelink/HomeLinkE2ETests/WiFiTests/testLast", "homelink/HomeLinkTests/TurnTests/testHung"]);
    expect(reds("cockpit", "Test Case '-[CockpitTests.AskTraceTests testHung]' started.")).toEqual(["design/swift/CockpitTests/AskTraceTests/testHung"]);
  });
});

describe("a vitest run the cap cut", () => {
  const files = ["packages/home/connecting.e2e.test.ts", "packages/home/move.e2e.test.ts", "packages/home/video.e2e.test.ts", "tools/vm/find-text.e2e.test.ts"];
  const log = [
    " \x1b[32m✓\x1b[39m \x1b[30m\x1b[45m home \x1b[49m\x1b[39m connecting.e2e.test.ts \x1b[2m(3 tests)\x1b[22m\x1b[33m 68331ms\x1b[39m",
    " ❯  home  move.e2e.test.ts (10 tests | 1 failed) 74963ms",
    "     ❯ test/harness-root.ts:163:37",
    " ✓  tools  vm/find-text.e2e.test.ts (2 tests) 11832ms",
  ].join("\n");

  it("names each file it named and never reported, from its project's folder", () => {
    expect(unreported(["node_modules/.bin/vitest", "run", ...files], log)).toEqual(["packages/home/video.e2e.test.ts"]);
  });

  it("names none for a run of whole projects, or a command not vitest's", () => {
    expect(unreported(["node_modules/.bin/vitest", "run", "--project", "home"], "")).toEqual([]);
    expect(unreported(["npm", "test", "--prefix", "dashboard", "--", "test/video-door.mjs"], "")).toEqual([]);
  });
});

describe("a test target's process that runs too long", () => {
  it("is named once it has run the limit, and forgotten once it ends", () => {
    const seen = new Map<number, number>();
    expect(overran(seen, [200], 1000, 600)).toEqual([]);
    expect(overran(seen, [200, 201], 1599, 600)).toEqual([]);
    expect(overran(seen, [200, 201], 1600, 600)).toEqual([200]);
    expect(overran(seen, [201], 2201, 600)).toEqual([201]);
    expect(overran(seen, [], 2202, 600)).toEqual([]);
    expect(seen.size).toBe(0);
    expect(overran(seen, [200], 2203, 600)).toEqual([]);
  });
});

describe("the case a killed test process hung in", () => {
  const ps = "4242 /Applications/Xcode.app/Contents/Developer/usr/bin/xctest -XCTest HomeLinkE2ETests.WiFiTests/testFirstListed,HomeLinkTests.ReadsTests/testA,HomeLinkTests.ReadsTests/testHung /tmp/homelink/.build/debug/HomeLinkTests.xctest";
  const log = [
    "Test Suite 'Selected tests' started at 2026-11-17 13:53:55.974.",
    "Test Suite 'HomeLinkTests.xctest' started at 2026-11-17 13:53:55.976.",
    "Test Case '-[HomeLinkTests.ReadsTests testA]' started.",
    "Test Case '-[HomeLinkTests.ReadsTests testA]' passed (0.010 seconds).",
    "Test Case '-[HomeLinkTests.ReadsTests testFailed]' started.",
    "Test Case '-[HomeLinkTests.ReadsTests testFailed]' failed (0.020 seconds).",
    "Test Case '-[HomeLinkTests.ReadsTests testHung]' started.",
  ].join("\n");

  it("names the case that started and never ended, in full, and its bundle, never the first test the command lists", () => {
    expect(hungIn("homelink", ps, log)).toBe("HomeLinkTests.xctest (process 4242), whose case started and never ended: homelink/HomeLinkTests/ReadsTests/testHung");
  });

  it("names only the killed bundle's open case when another process's case is open beside it", () => {
    const beside = `${log}\nTest Case '-[HomeLinkE2ETests.WiFiTests testRunning]' started.`;
    expect(unended(beside)).toEqual(["HomeLinkTests/ReadsTests/testHung", "HomeLinkE2ETests/WiFiTests/testRunning"]);
    expect(hungIn("homelink", ps, beside)).toBe("HomeLinkTests.xctest (process 4242), whose case started and never ended: homelink/HomeLinkTests/ReadsTests/testHung");
  });

  it("closes a case whose ended line an app's log line cut in two", () => {
    const cut = [
      "Test Case '-[LifestreamCaptureTests.LifeReaderTests testAVideo]' started.",
      "Test Case '-[LifestreamCaptureTest2026-11-17 11:56:25.061370+0530 Lifestream[63726:148028172] [Default] NSURLConnection finished with error - code -1002",
      "s.LifeReaderTests testAVideo]' passed (0.007 seconds).",
      "Test Case '-[LifestreamCaptureTests.LifeReaderTests testHung]' started.",
    ].join("\n");
    expect(unended(cut)).toEqual(["LifestreamCaptureTests/LifeReaderTests/testHung"]);
  });

  it("closes a case whose own name an app's log line cut in two", () => {
    const cut = [
      "Test Case '-[LifestreamCaptureTests.PersistenceFailureTests testStartingAgain]' started.",
      "Test Case '-[LifestreamCaptureTests.PersistenceFailureTests testStar2026-11-24 12:54:40.154003+0530 Lifestream[14628:27284186] [logging] a line of the app's",
      "tingAgain]' passed (0.012 seconds).",
      "Test Case '-[LifestreamCaptureTests.PersistenceFailureTests testHung]' started.",
    ].join("\n");
    expect(unended(cut)).toEqual(["LifestreamCaptureTests/PersistenceFailureTests/testHung"]);
  });

  it("says so when the output names no open case", () => {
    expect(hungIn("homelink", ps, log.split("\n").slice(0, 4).join("\n"))).toBe("HomeLinkTests.xctest (process 4242), whose output names no case started and never ended");
  });
});

describe("what holds swift test's output open", () => {
  const listed = [
    "p100", "f1", "n/tmp/macos-app.log", "f7", "d0xaaa1", "n->0xbbb1", "f8", "d0xccc1", "n->0xccc2", "f9", "d0xccc2", "n->0xccc1",
    "p300", "f0", "n/dev/null", "f1", "d0xbbb1", "n->0xaaa1", "f2", "d0xbbb1", "n->0xaaa1",
    "p400", "f1", "d0xddd1", "n->0xeee1",
    "p500", "f0", "d0xeee1", "n->0xddd1",
  ].join("\n");

  it("names the process holding the other end of one of its pipes, once, and no other", () => {
    expect(holding(100, listed)).toEqual([300]);
  });

  it("names nothing when none holds one", () => {
    expect(holding(100, listed.split("\np300")[0]!)).toEqual([]);
  });
});

describe("main's own reds", () => {
  it("names each red of the run once", () => {
    const log = ["plan: vitest", "  red: packages/home/now.e2e.test.ts", "  red: packages/home/now.e2e.test.ts", "main-run: FAIL b5cc"];
    expect(mainReds(log)).toEqual(["  red: packages/home/now.e2e.test.ts"]);
  });

  it("stand since the oldest run of the unbroken row that names them", () => {
    const run = (commit: string, ...names: string[]): { commit: string; log: string[] } => ({ commit, log: names.map((name) => `  red: ${name}`) });
    const since = redSince([run("d", "old", "new"), run("c", "old"), run("b", "old"), run("a"), run("z", "new")]);
    expect([...since]).toEqual([["  red: old", "b"], ["  red: new", "d"]]);
    expect([...redSince([run("a", "kept")])]).toEqual([["  red: kept", "a"]]);
    expect([...redSince([])]).toEqual([]);
  });
});

describe("the full tier", () => {
  it("runs its own files and no other, and the ordinary run none of them", () => {
    const listed = (...args: string[]): string[] => execFileSync(join(ROOT, "node_modules/.bin/vitest"), ["list", "--filesOnly", ...args], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter(Boolean).map((line) => line.slice(line.lastIndexOf(" ") + 1)).sort();
    const full = listed("--config", "vitest.full.config.mts");
    expect(full.map((file) => `**/${basename(file)}`).sort()).toEqual([...FULL].sort());
    expect(listed().filter((file) => full.includes(file))).toEqual([]);
  });
});

describe("swift xctest jobs", () => {
  it("packs small classes within a bundle, puts heavy classes first, and drops quarantined tests", () => {
    const listed = [
      "ShippingTests.FastA/testOne",
      "ShippingTests.FastA/testTwo",
      "ShippingTests.FastB/testOne",
      "ShippingTests.Heavy/testBig",
      "ShippingTests.Quarantined/testKeep",
      "ShippingTests.Quarantined/testSkip",
    ].join("\n");
    const durations = swiftDurations([
      "Test Case '-[ShippingTests.Heavy testBig]' passed (9.500 seconds).",
      "Test Case '-[ShippingTests.FastA testOne]' passed (0.010 seconds).",
    ].join("\n"));
    expect(durations.get("ShippingTests.Heavy")).toBeCloseTo(9.5, 3);
    const jobs = swiftJobs(listed, "/bin", new Set(["ShippingTests.Quarantined/testSkip"]), 35, () => true, durations);
    expect(jobs).not.toBeNull();
    expect(jobs![0]!.selectors).toEqual(["ShippingTests.Heavy"]);
    const rest = jobs!.slice(1).flatMap((job) => job.selectors);
    expect(rest).toContain("ShippingTests.FastA");
    expect(rest).toContain("ShippingTests.FastB");
    expect(rest).toContain("ShippingTests.Quarantined/testKeep");
    expect(rest).not.toContain("ShippingTests.Quarantined/testSkip");
  });

  it("returns null when a bundle is missing or a listed line is unrecognized", () => {
    expect(swiftJobs("ShippingTests.A/testOne", "/bin", new Set(), 35, () => false)).toBeNull();
    expect(swiftJobs("not a test line", "/bin", new Set(), 35, () => true)).toBeNull();
  });
});
