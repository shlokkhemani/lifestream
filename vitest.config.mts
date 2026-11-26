import { availableParallelism, homedir, platform } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { chromeForTesting, googleChrome, leftOut, quarantined } from "./testing/files.mjs";
import { forksNamingDeath, Slow } from "./testing/run.mjs";


export const FULL = ["**/home-full.e2e.test.ts", "**/land-cost.e2e.test.ts", "**/upload.e2e.test.ts", "**/extract-cost.e2e.test.ts", "**/blobs-full.e2e.test.ts", "**/zip-full.e2e.test.ts", "**/gmail-full.e2e.test.ts", "**/memory-full.e2e.test.ts"];

const said = ((globalThis as { lifestreamSaid?: Set<string> }).lifestreamSaid ??= new Set<string>());
function say(line: string): void {
  if (!said.has(line)) process.stderr.write(`vitest.config.mts: ${line}\n`);
  said.add(line);
}
const NAMED = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const NAMED_FULL = process.argv.some((arg) => arg.includes("vitest.full.config")) ? [] : NAMED
  .filter((arg) => FULL.some((pattern) => basename(arg).startsWith(basename(pattern).replace(/\.test\.ts$/u, ""))));
if (NAMED_FULL.length > 0) {
  say(`${NAMED_FULL.join(", ")} ${NAMED_FULL.length === 1 ? "is" : "are"} the full tier, which this run leaves out: npx vitest run --config vitest.full.config.mts ${NAMED_FULL.join(" ")}`);
}

export const PROJECTS = [
  "packages/core", "packages/connect", "packages/families", "packages/model", "packages/privacy", "packages/home", "packages/runner", "tools", "extension", "worker",
];
const ISOLATED: Readonly<Record<string, readonly string[]>> = {
  "packages/connect": ["shared/members.e2e.test.ts", "templates/folder/e2e.test.ts"],
  "packages/families": ["screen/screen.e2e.test.ts"],
  "packages/home": [
    "knock.e2e.test.ts", "read-pager.test.ts", "read-places.test.ts", "copier.e2e.test.ts", "folder-proof.e2e.test.ts",
    "kept-files.test.ts", "keyed-door.e2e.test.ts", "keyed-start.e2e.test.ts", "feedback.e2e.test.ts",
  ],
};
const PRIORITY = [
  "packages/home/connectors.e2e.test.ts", "packages/home/conformance-acquirers.e2e.test.ts", "packages/home/walk.e2e.test.ts",
  "packages/home/search-scan.e2e.test.ts", "packages/home/agents.e2e.test.ts", "packages/home/door.e2e.test.ts",
  "packages/home/derived.e2e.test.ts", "packages/home/home-folder.e2e.test.ts", "packages/home/imports.e2e.test.ts",
  "packages/home/stored.e2e.test.ts", "packages/home/stations.e2e.test.ts", "packages/home/folders.e2e.test.ts",
  "packages/connect/labelers/faces/e2e.test.ts", "extension/e2e.test.ts", "packages/home/owner-act.e2e.test.ts",
  "packages/home/people.e2e.test.ts", "packages/home/folder-proof.e2e.test.ts", "packages/home/processing.e2e.test.ts",
  "tools/volume.e2e.test.ts", "packages/home/poll-state.e2e.test.ts", "packages/home/signin.e2e.test.ts",
  "packages/connect/health/whoop/e2e.test.ts", "packages/home/erase-crash.e2e.test.ts", "packages/core/stored.e2e.test.ts",
  "tools/gate-home.test.ts", "packages/home/reads.e2e.test.ts", "packages/model/artifacts.e2e.test.ts",
  "packages/home/screen-vectors.test.ts", "packages/home/custody.e2e.test.ts", "packages/model/model.e2e.test.ts",
  "packages/home/import-kinds.e2e.test.ts", "packages/families/physical/e2e.test.ts", "packages/home/migration-rules.e2e.test.ts",
  "packages/home/count-words.e2e.test.ts", "packages/home/runners.e2e.test.ts", "packages/home/faces.e2e.test.ts",
  "packages/home/vault.e2e.test.ts", "packages/home/pausing.e2e.test.ts", "packages/home/way-out.e2e.test.ts",
  "packages/home/count-tallies.e2e.test.ts", "packages/home/drain.e2e.test.ts", "packages/core/blobs-keyed.e2e.test.ts",
  "packages/home/passwords.e2e.test.ts", "packages/home/photos.e2e.test.ts", "packages/home/repair.e2e.test.ts",
];
const rankOf = (moduleId: string): number => {
  const normalized = moduleId.replace(/\\/gu, "/");
  const at = PRIORITY.findIndex((path) => normalized.endsWith(`/${path}`));
  return at === -1 ? PRIORITY.length : at;
};
class SlowestFirst extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    return [...sorted].sort((a, b) => rankOf(a.moduleId) - rankOf(b.moduleId));
  }
}

const NAMED_QUARANTINED = new Set(quarantined().map((entry) => entry.path)
  .filter((path) => NAMED.some((arg) => arg === path || arg.endsWith(`/${path}`) || path.endsWith(`/${arg.replace(/^\.\//u, "")}`))));
if (NAMED_QUARANTINED.size > 0) {
  say(`${[...NAMED_QUARANTINED].join(", ")} ${NAMED_QUARANTINED.size === 1 ? "is" : "are"} quarantined (testing/quarantine.txt) and named, so ${NAMED_QUARANTINED.size === 1 ? "it runs" : "they run"}: a red in a case its line names is that line's`);
}
const LEFT_OUT = leftOut().filter((path) => !NAMED_QUARANTINED.has(path));
const PROCESS = fileURLToPath(new URL("./testing/process.mjs", import.meta.url));
const SORTS = fileURLToPath(new URL("./packages/core/test/process-sorts.ts", import.meta.url));
const RUN = fileURLToPath(new URL("./testing/run.mts", import.meta.url));
const COMPILE_CACHE = process.env.NODE_COMPILE_CACHE ?? fileURLToPath(new URL("./.build/compile-cache", import.meta.url));
const FS_CACHE = join(homedir(), ...(platform() === "darwin" ? ["Library", "Caches"] : [".cache"]), "lifestream-tests", "vitest");
const HAS_PROJECT = process.argv.some((arg) => arg === "--project" || arg.startsWith("--project="));
const ALL_INCLUDE = PROJECTS.flatMap((path) => configDefaults.include.map((pattern) => `${path}/${pattern}`));
const ALL_ISOLATED = Object.entries(ISOLATED).flatMap(([path, files]) => files.map((file) => `${path}/${file}`));

declare module "vitest" {
  export interface ProvidedContext {
    googleChrome: string;
    chromeForTesting: string | null;
  }
}
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: forksNamingDeath,
    maxWorkers: Number(process.env.LIFESTREAM_TEST_WORKERS) || Math.max(1, Math.floor(availableParallelism() / 4)),
    exclude: [...configDefaults.exclude, ...FULL],
    passWithNoTests: !NAMED.some((arg) => /\.test\.m?ts$/u.test(arg)),
    provide: { googleChrome: googleChrome(), chromeForTesting: chromeForTesting() },
    globalSetup: [RUN, fileURLToPath(new URL("./packages/home/test/bundle.ts", import.meta.url))],
    setupFiles: [SORTS],
    reporters: ["default", new Slow(15)],
    sequence: { sequencer: SlowestFirst },
    experimental: { fsModuleCache: true, fsModuleCachePath: FS_CACHE },
    env: {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${PROCESS}`.trim(),
      NODE_COMPILE_CACHE: COMPILE_CACHE,
    },
    projects: HAS_PROJECT
      ? PROJECTS.flatMap((path) => {
        const excluded = LEFT_OUT.filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1));
        const isolated = ISOLATED[path] ?? [];
        return [
          { extends: true, root: path, test: { name: basename(path), isolate: false, exclude: [...excluded, ...isolated] } },
          ...(isolated.length === 0 ? [] : [{ extends: true as const, root: path, test: { name: `${basename(path)}_isolated`, isolate: true, include: [...isolated], exclude: excluded } }]),
        ];
      })
      : [
        { extends: true, test: { name: "all", isolate: false, include: ALL_INCLUDE, exclude: [...configDefaults.exclude, ...FULL, ...LEFT_OUT, ...ALL_ISOLATED] } },
        { extends: true, test: { name: "isolated", isolate: true, include: ALL_ISOLATED, exclude: [...configDefaults.exclude, ...FULL, ...LEFT_OUT] } },
      ],
  },
});
