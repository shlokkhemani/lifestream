import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkDocs, NO_LIVE, NO_NEXT, NO_PLACE, PRIVATE_ENTRY, PRIVATE_IN_GIT, PRIVATE_LINKED, SPEC_CITED, type Break } from "./check-docs.js";

const roots: string[] = [];
const artifact: Record<string, Break[]> = {};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  writeFileSync(join(tmpdir(), "check-docs.json"), `${JSON.stringify(artifact, null, 2)}\n`);
});

function repo(files: Record<string, string>, linked: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "check-docs-"));
  roots.push(root);
  const links = linked.map((page) => `- [${page}](./${page})`).join("\n");
  const all = { ...files, "README.md": `${files["README.md"] ?? "# Readme\n"}\n${links}\n` };
  for (const [path, text] of Object.entries(all)) write(root, path, text);
  git(root, "init", "-q");
  git(root, "add", "-A");
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.email=person-a@example.com", "-c", "user.name=person-a", ...args], { stdio: "ignore" });
}

function check(name: string, root: string): string[] {
  const breaks = checkDocs(root);
  artifact[name] = breaks;
  return breaks.map((entry) => `${entry.file}:${entry.line}: ${entry.what}`);
}

describe("links", () => {
  it("names a link to a file that is not there, and passes one that is", () => {
    const root = repo({
      "docs/operating/a.md": "# A\n\nSee [b](./b.md) and [gone](./gone.md).\n",
      "docs/operating/b.md": "# B\n",
    }, ["docs/operating/a.md"]);
    expect(check("missing link", root)).toEqual(["docs/operating/a.md:3: link ./gone.md: no docs/operating/gone.md"]);
  });

  it("holds an anchor to GitHub's slug of a heading, repeated headings and punctuation included", () => {
    const root = repo({
      "docs/operating/a.md": [
        "# A", "",
        "[1](./b.md#confighomejson) [2](./b.md#reading-homedb-by-hand) [3](./b.md#notes-1)",
        "[4](./b.md#install-deploy-and-roll-back) [5](#a) [6](./b.md#nope) [7](#nope)", "",
      ].join("\n"),
      "docs/operating/b.md": "# B\n\n## config/home.json\n\n## Reading `home.db` by hand\n\n## Notes\n\n## Notes\n\n## Install, deploy and roll back\n",
    }, ["docs/operating/a.md", "docs/operating/b.md"]);
    expect(check("anchors", root)).toEqual([
      "docs/operating/a.md:4: link ./b.md#nope: docs/operating/b.md has no heading #nope",
      "docs/operating/a.md:4: link #nope: docs/operating/a.md has no heading #nope",
    ]);
  });

  it("reads no link inside a code block or inline code, and none to another site", () => {
    const root = repo({
      "docs/operating/a.md": "# A\n\n```\n[x](./nope.md)\n```\n\n`[y](./nope.md)` [site](https://example.com/x) [mail](mailto:person-a@example.com)\n",
    }, ["docs/operating/a.md"]);
    expect(check("code and sites", root)).toEqual([]);
  });
});

describe("inline-code paths", () => {
  it("names a repository path that is not there", () => {
    const root = repo({
      "docs/operating/a.md": "# A\n\n`packages/core/gone.ts` and `packages/core/here.ts`.\n",
      "packages/core/here.ts": "export {};\n",
    }, ["docs/operating/a.md"]);
    expect(check("missing path", root)).toEqual(["docs/operating/a.md:3: path packages/core/gone.ts does not exist (one not built yet is marked (planned))"]);
  });

  it("holds a path written from inside the packages to the package it names", () => {
    const root = repo({
      "docs/operating/a.md": "# A\n\n`home/README.md`, `home/gone.ts` and `verbs/args.ts`.\n",
      "packages/home/README.md": "# home\n",
    }, ["docs/operating/a.md", "packages/home/README.md"]);
    expect(check("package paths", root)).toEqual(["docs/operating/a.md:3: path packages/home/gone.ts does not exist (one not built yet is marked (planned))"]);
  });

  it("leaves a path marked removed, an ignored build output, a placeholder, and a path relative to a package", () => {
    const root = repo({
      ".gitignore": "**/.build/\n",
      "docs/operating/a.md": [
        "# A", "",
        "`packages/core/old.ts` (removed); `packages/core/.build/out.js`; `packages/<name>/x.ts`;",
        "`packages/core/*.ts`; `verbs/args.ts`; `packages/core/` the folder.", "",
      ].join("\n"),
      "packages/core/here.ts": "export {};\n",
    }, ["docs/operating/a.md"]);
    expect(check("paths left alone", root)).toEqual([]);
  });

  it("leaves a path marked planned until it exists, then asks for the mark to go", () => {
    const root = repo({
      "docs/operating/a.md": "# A\n\n`packages/core/next.ts` (planned) and `packages/core/here.ts` (planned).\n",
      "packages/core/here.ts": "export {};\n",
    }, ["docs/operating/a.md"]);
    expect(check("planned paths", root)).toEqual(["docs/operating/a.md:3: path packages/core/here.ts exists: drop its (planned)"]);
  });
});

describe("section citations", () => {
  it("holds a section number to a numbered heading, in a page and in a code comment", () => {
    const root = repo({
      "docs/operating/spec.md": "# Spec\n\n## 4. Storage\n\n### 4.2 Records\n\n## 5. Modules\n",
      "docs/operating/a.md": "# A\n\nspec.md §4.2, [spec.md](./spec.md) §5, spec §9.\n",
      "packages/core/x.ts": "// docs/operating/spec.md §4.3 says so.\nexport {};\n",
    }, ["docs/operating/a.md", "docs/operating/spec.md"]);
    expect(check("section numbers", root)).toEqual([
      "docs/operating/a.md:3: spec §9: docs/operating/spec.md has no section 9",
      "packages/core/x.ts:1: docs/operating/spec.md §4.3: docs/operating/spec.md has no section 4.3",
    ]);
  });

  it("holds a section cited by number and title to a heading or a bold lead-in of that page", () => {
    const root = repo({
      "docs/operating/spec.md": "# Spec\n\n### 5.7 Home\n\n**Discovery: derived work is computed.** Text.\n\n   **The cost of a run** grows.\n\n## Notes\n",
      "docs/operating/a.md": "# A\n\nspec.md §5.7 \"Discovery\", spec.md §5.7 \"The cost of a run\", spec.md \"Notes\", spec.md §5.7 \"Gone\".\n",
      "packages/home/x.ts": "// docs/operating/spec.md §5.7 \"Sweep\".\nexport {};\n",
    }, ["docs/operating/a.md", "docs/operating/spec.md"]);
    expect(check("titled sections", root)).toEqual([
      "docs/operating/a.md:3: spec.md \"Gone\": docs/operating/spec.md has no such heading",
      "packages/home/x.ts:1: docs/operating/spec.md \"Sweep\": docs/operating/spec.md has no such heading",
    ]);
  });

  it("takes no bold lead-in for a section number", () => {
    const root = repo({
      "docs/operating/spec.md": "# Spec\n\n**4. Storage** is bold, not a heading.\n",
      "docs/operating/a.md": "# A\n\nspec.md §4.\n",
    }, ["docs/operating/a.md", "docs/operating/spec.md"]);
    expect(check("lead-in is no number", root)).toEqual(["docs/operating/a.md:3: spec.md §4: docs/operating/spec.md has no section 4"]);
  });

  it("does not take §4 for §4.2", () => {
    const root = repo({
      "docs/operating/spec.md": "# Spec\n\n### 4.2 Records\n",
      "docs/operating/a.md": "# A\n\nspec.md §4.\n",
    }, ["docs/operating/a.md", "docs/operating/spec.md"]);
    expect(check("section prefix", root)).toEqual(["docs/operating/a.md:3: spec.md §4: docs/operating/spec.md has no section 4"]);
  });

  it("holds a quoted heading to the nearest page of that name, in prose, a link and a code string", () => {
    const root = repo({
      "docs/DESIGN.md": "# Design\n\n## The door\n",
      "packages/families/physical/physical.md": "# physical\n\n## Stays\n\n## Trips and legs\n",
      "packages/families/physical/segment.ts": [
        "/** physical.md, \"Stays\". */",
        "/** physical.md, \"Legs\". */",
        "export const why = \"see DESIGN.md \\\"The door\\\"\";", "",
      ].join("\n"),
      "docs/operating/a.md": "# A\n\n[DESIGN.md](../DESIGN.md) \"The door\", DESIGN.md \"The window\".\n",
    }, ["docs/operating/a.md", "docs/DESIGN.md", "packages/families/physical/physical.md"]);
    expect(check("quoted headings", root)).toEqual([
      "docs/operating/a.md:3: DESIGN.md \"The window\": docs/DESIGN.md has no such heading",
      "packages/families/physical/segment.ts:2: physical.md \"Legs\": packages/families/physical/physical.md has no such heading",
    ]);
  });
});

describe("the command's name", () => {
  const cli = {
    "packages/home/verbs/index.ts": "export const VERBS: Readonly<Record<string, Verb>> = {\n  status, settings, pause,\n  connectors,\n};\n",
    "packages/home/cli.ts": "const COMMANDS = {\n  serve: \"serve\",\n  \"self-check\": \"self-check [--root <root>]\",\n} as const;\n",
  };

  it("names a verb after home in a page's code span, and passes home in prose and paths", () => {
    const root = repo({
      ...cli,
      "docs/operating/a.md": [
        "# A", "",
        "Run `home status` or `home connectors install <id>`; `home <verb>` too; `home rekey` was a verb once; `home --help`.",
        "A home connector, the home's door, `home.db`, `packages/home/cli.ts`, `lifestream status` and `home` alone.", "",
      ].join("\n"),
    }, ["docs/operating/a.md"]);
    expect(check("command in a page", root)).toEqual([
      "docs/operating/a.md:3: `home status`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:3: `home connectors`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:3: `home <verb>`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:3: `home rekey`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:3: `home --help`: the command is `lifestream` (packages/home/cli-name.ts)",
    ]);
  });

  it("names a command typed or printed in a code block, and passes a block's prose", () => {
    const root = repo({
      ...cli,
      "docs/operating/a.md": [
        "# A", "", "```", "$ home status --root /tmp/x", "usage: home self-check [--root <root>]", "home pause lane:7",
        "home answers every request", "$ lifestream status", "```", "",
      ].join("\n"),
    }, ["docs/operating/a.md"]);
    expect(check("command in a block", root)).toEqual([
      "docs/operating/a.md:4: `home status`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:5: `home self-check`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:6: `home pause`: the command is `lifestream` (packages/home/cli-name.ts)",
    ]);
  });

  it("names the command called home, in a page and in code, and passes home as a word in code", () => {
    const root = repo({
      ...cli,
      "docs/operating/a.md": "# A\n\n`home` is the operator's command. The `home` CLI and its verbs. A stay is `home` or `place`.\n",
      "macos-app/X.swift": "/// The release and its `home` command.\nlet target = \"home\"\n",
    }, ["docs/operating/a.md"]);
    expect(check("the command called home", root)).toEqual([
      "docs/operating/a.md:3: `home`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:3: `home`: the command is `lifestream` (packages/home/cli-name.ts)",
      "macos-app/X.swift:1: `home`: the command is `lifestream` (packages/home/cli-name.ts)",
    ]);
  });

  it("names a verb after home in prose when an argument follows it", () => {
    const root = repo({
      ...cli,
      "docs/operating/a.md": "# A\n\n\"this machine holds no home: home status --root <root>\" and the home settings <x> page.\n\n```\nit holds none (home serve <x> makes one)\n```\n\nThe home status line; the home pause.\n",
    }, ["docs/operating/a.md"]);
    expect(check("command in prose", root)).toEqual([
      "docs/operating/a.md:3: `home status`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:3: `home settings`: the command is `lifestream` (packages/home/cli-name.ts)",
      "docs/operating/a.md:6: `home serve`: the command is `lifestream` (packages/home/cli-name.ts)",
    ]);
  });

  it("names a verb after home in a code file's string or code span, and passes home before any other word", () => {
    const root = repo({
      ...cli,
      "packages/core/x.ts": [
        "/** Ends with `home stop`. */",
        "const a = \"run home status --root <root>\";",
        "const b = 'home settings set';",
        "const c = `usage: home serve`;",
        "const d = 'home paused';",
        "const e = `home busy (${n} bursts)`;",
        "const f = \"one JSON object of home settings, refused\";",
        "const g = 'the home machine';", "",
      ].join("\n"),
    });
    expect(check("command in code", root)).toEqual([
      "packages/core/x.ts:1: `home stop`: the command is `lifestream` (packages/home/cli-name.ts)",
      "packages/core/x.ts:2: `home status`: the command is `lifestream` (packages/home/cli-name.ts)",
      "packages/core/x.ts:3: `home settings`: the command is `lifestream` (packages/home/cli-name.ts)",
      "packages/core/x.ts:4: `home serve`: the command is `lifestream` (packages/home/cli-name.ts)",
    ]);
  });
});

describe("reachability", () => {
  it("names a page no link reaches from README.md, and reaches a folder's README through a link to the folder", () => {
    const root = repo({
      "docs/README.md": "# Docs\n\n[a](./operating/a.md)\n",
      "docs/operating/a.md": "# A\n",
      "docs/operating/orphan.md": "# Orphan\n",
      "ios-app/README.md": "# App\n",
      "README.md": "# Lifestream\n\n[docs](./docs/) [app](./ios-app/)\n",
    });
    expect(check("orphans", root)).toEqual(["docs/operating/orphan.md:1: no link reaches this page from README.md or AGENTS.md"]);
  });

  it("holds no prompt or test page to the link and path rules", () => {
    const root = repo({
      "packages/families/screen/prompts/core-v2.md": "Read `packages/gone.ts` and [x](./nope.md).\n",
      "packages/home/test/proof/example-log/example-log.md": "[x](./nope.md)\n",
    });
    expect(check("not pages", root)).toEqual([]);
  });
});

describe("where a page lives", () => {
  it("passes a page in each place: the root, a part, a README beside code, a page named for its folder, a prompt, docs/", () => {
    const pages = [
      "README.md", "SECURITY.md", "CONTRIBUTING.md",
      "dashboard/README.md", "macos-app/Sources/Spool/README.md", "mcp/SKILL.md",
      "tools/vm/README.md",
      "packages/connect/messages/whatsapp/whatsapp.md", "packages/families/day-file.md",
      "docs/README.md", "docs/DESIGN.md", "docs/vision.md", "docs/operating/door.md", "docs/contributing/develop.md",
      "docs/user/connectors/gmail.md", "docs/writing/templates/guide.md",
      "design/principles.md", "faces/MODEL-NOTICES.md",
    ];
    const root = repo({
      ...Object.fromEntries(pages.map((page) => [page, "# Page\n"])),
      "tools/vm/cli.ts": "export {};\n",
      "packages/home/test/proof/example-bank/example-bank.md": "# Bank\n",
      "packages/families/screen/prompts/parts/core.md": "Read the screen.\n",
      "packages/families/shared/prompt-parts/covered.md": "Covered.\n",
    }, [...pages, "packages/families/shared/prompt-parts/covered.md"]);
    expect(check("pages in place", root)).toEqual([]);
  });

  it("refuses a page anywhere else: notes, research, a part's own spec, a plan, a README with no code beside it", () => {
    const pages = [
      "docs/notes.md", "docs/research/x.md", "docs/archive/old-spec.md", "docs/research/README.md", "docs/operating/deep/x.md",
      "ios-app/SPEC.md", "macos-app/research/a.md", "macos-app/benchmarks/fixture/VARIED.md", "packages/home/plan.md", "packages/home/AGENTS.md",
      "packages/connect/messages/whatsapp/notes.md", "website/notes/README.md",
    ];
    const root = repo(Object.fromEntries(pages.map((page) => [page, "# Page\n"])), pages);
    expect(check("pages out of place", root)).toEqual([...pages].sort((a, b) => a.localeCompare(b)).map((page) => `${page}:1: ${NO_PLACE}`));
  });
});

describe("where owed work lives", () => {
  it("refuses a NEXT.md in git or on disk, in a part or at the root, and sends it to docs/owed.md", () => {
    const pages = ["NEXT.md", "dashboard/NEXT.md", "packages/home/NEXT.md"];
    const root = repo(Object.fromEntries(pages.map((page) => [page, "# Owed\n\n- Split the view. [ready]\n"])), pages);
    write(root, "tools/NEXT.md", "# Owed\n");
    expect(check("NEXT refused", root)).toEqual([
      `dashboard/NEXT.md:1: ${NO_NEXT}`, `NEXT.md:1: ${NO_NEXT}`, `packages/home/NEXT.md:1: ${NO_NEXT}`, `tools/NEXT.md:1: ${NO_NEXT}`,
    ]);
  });

  it("refuses an entry tagged [live] in docs/owed.md, and passes the other tags and a [live] in a code block", () => {
    const root = repo({
      ".gitignore": "# Private pages: kept out of git\n/AGENTS.md\n/docs/owed.md\n",
      "AGENTS.md": "# Agents\n\n[owed](./docs/owed.md)\n",
      "docs/owed.md": [
        "# Owed", "", "## dashboard", "",
        "- Read a day of frames after the install. [live]", "  Count the gaps.",
        "- Split the view. [ready]", "- Pick a colour. [ruling]", "- Move the door. [big]", "",
        "```", "- An example. [live]", "```", "",
      ].join("\n"),
    });
    expect(check("live refused", root)).toEqual([`docs/owed.md:5: ${NO_LIVE}`]);
  });
});

describe("private pages", () => {
  const ignored = "**/.build/\n\n# Private pages: kept out of git\n/AGENTS.md\n/docs/testing.md\n/docs/specs\n\n/learning/\n";

  it("reads the private pages on disk, its links checked, and links between them", () => {
    const root = repo({
      ".gitignore": ignored,
      "README.md": "# Lifestream\n\n[docs](./docs/README.md)\n",
      "docs/README.md": "# Docs\n",
      "AGENTS.md": "# Agents\n\n[docs](./docs/README.md) [tests](./docs/testing.md) [specs](./docs/specs/README.md)\n",
      "docs/testing.md": "# Testing\n\n[agents](../AGENTS.md#nope)\n",
      "docs/specs/README.md": "# Specs\n\n[plans](./plans.md)\n",
      "docs/specs/plans.md": "# Plans\n",
      "docs/specs/orphan.md": "# Orphan\n",
    });
    expect(check("private pages read", root)).toEqual([
      "docs/specs/orphan.md:1: no link reaches this page from README.md or AGENTS.md",
      "docs/testing.md:3: link ../AGENTS.md#nope: AGENTS.md has no heading #nope",
    ]);
  });

  it("leaves a spec's path marked planned whether or not this checkout has built it: one spec serves every lane", () => {
    const root = repo({
      ".gitignore": ignored,
      "AGENTS.md": "# Agents\n\n[specs](./docs/specs/README.md)\n",
      "docs/specs/README.md": "# Specs\n\n`packages/core/next.ts` (planned), `packages/core/here.ts` (planned) and `packages/core/gone.ts`.\n",
      "packages/core/here.ts": "export {};\n",
    });
    expect(check("planned in a spec", root)).toEqual([
      "docs/specs/README.md:3: path packages/core/gone.ts does not exist (one not built yet is marked (planned))",
    ]);
  });

  it("in a lane, leaves a private page's path that main gained since the lane was cut, and names one the lane deleted", () => {
    const main = repo({ ".gitignore": ignored, "packages/core/here.ts": "export {};\n", "packages/core/old.ts": "export {};\n" });
    git(main, "commit", "-qm", "one");
    const lane = `${main}-lane`;
    roots.push(lane);
    git(main, "worktree", "add", "-q", lane);
    write(main, "packages/core/new.ts", "export {};\n");
    git(main, "add", "-A");
    git(main, "commit", "-qm", "two");
    write(lane, "AGENTS.md", "# Agents\n\n`packages/core/new.ts`, [new](./packages/core/new.ts), `packages/core/old.ts` and `packages/core/never.ts`.\n");
    git(lane, "rm", "-q", "packages/core/old.ts");
    expect(check("a lane older than a private page", lane)).toEqual([
      "AGENTS.md:3: path packages/core/old.ts does not exist (one not built yet is marked (planned))",
      "AGENTS.md:3: path packages/core/never.ts does not exist (one not built yet is marked (planned))",
    ]);
  });

  it("leaves a private page's path that only another branch holds, in main too, and names one main deleted", () => {
    const main = repo({ ".gitignore": ignored, "packages/core/here.ts": "export {};\n", "packages/core/old.ts": "export {};\n" });
    git(main, "commit", "-qm", "one");
    const lane = `${main}-lane`;
    roots.push(lane);
    git(main, "worktree", "add", "-q", "-b", "wp-lane", lane);
    write(lane, "packages/core/built.ts", "export {};\n");
    git(lane, "add", "-A");
    git(lane, "commit", "-qm", "two");
    git(main, "rm", "-q", "packages/core/old.ts");
    git(main, "commit", "-qm", "three");
    write(main, "AGENTS.md", "# Agents\n\n`packages/core/built.ts`, `packages/core/old.ts` and `packages/core/never.ts`.\n");
    expect(check("a private page ahead of main", main)).toEqual([
      "AGENTS.md:3: path packages/core/old.ts does not exist (one not built yet is marked (planned))",
      "AGENTS.md:3: path packages/core/never.ts does not exist (one not built yet is marked (planned))",
    ]);
  });

  it("refuses a link from a page in git to a private page, there or not, and a page in git only private pages link", () => {
    const root = repo({
      ".gitignore": ignored,
      "README.md": "# Lifestream\n\n[docs](./docs/README.md)\n",
      "docs/README.md": "# Docs\n\n[tests](./testing.md) [agents](../AGENTS.md#tests) [specs](./specs/) [plans](./specs/plans.md)\n",
      "AGENTS.md": "# Agents\n\n## Tests\n\n[ops](./docs/operating/a.md)\n",
      "docs/operating/a.md": "# A\n",
    });
    expect(check("private pages linked", root)).toEqual([
      "docs/operating/a.md:1: only private pages link this page: a clone holds none of them, so link it from README.md or a page it reaches",
      `docs/README.md:3: link ./testing.md: docs/testing.md ${PRIVATE_LINKED}`,
      `docs/README.md:3: link ../AGENTS.md#tests: AGENTS.md ${PRIVATE_LINKED}`,
      `docs/README.md:3: link ./specs/: docs/specs ${PRIVATE_LINKED}`,
      `docs/README.md:3: link ./specs/plans.md: docs/specs/plans.md ${PRIVATE_LINKED}`,
    ]);
  });

  it("refuses a private page in git", () => {
    const root = repo({ ".gitignore": ignored, "docs/testing.md": "# Testing\n", "AGENTS.md": "# Agents\n\n[tests](./docs/testing.md)\n" });
    git(root, "add", "-f", "docs/testing.md");
    expect(check("private page in git", root)).toEqual([`docs/testing.md:1: ${PRIVATE_IN_GIT}`]);
  });

  it("refuses code that cites a spec by a path or by a section, never by a bare name, and passes the same words in a private page", () => {
    const root = repo({
      ".gitignore": ignored,
      "AGENTS.md": "# Agents\n\n[plans](./docs/specs/plans.md)\n",
      "docs/specs/plans.md": "# Plans\n\n`docs/specs/plans.md`, plans.md §2, the plans spec §3.\n\n## 2. Two\n\n## 3. Three\n",
      "packages/core/x.ts": [
        "export const a = \"docs/specs/plans.md\";",
        "export const b = \"specs/plans.md\";",
        "export const c = \"agent-tools-spec.md\";",
        "export const d = \"see plans §4.1\";",
        "export const e = \"plans.md §2\";",
        "export const f = \"(spec §3.6)\";",
        "export const g = \"(agent-tools-spec §4.1)\";",
        "export const plans = [\"see plans.md\", \"the plans spec\", \"specs/\", \"test/specs/plans.md\", \"my-plans §1\", \"§5 3\"];", "",
      ].join("\n"),
    });
    expect(check("spec cited", root)).toEqual([
      `packages/core/x.ts:1: docs/specs/plans.md: ${SPEC_CITED}`,
      `packages/core/x.ts:2: specs/plans.md: ${SPEC_CITED}`,
      `packages/core/x.ts:3: agent-tools-spec.md: ${SPEC_CITED}`,
      `packages/core/x.ts:4: plans §4: ${SPEC_CITED}`,
      `packages/core/x.ts:5: plans.md §2: ${SPEC_CITED}`,
      `packages/core/x.ts:6: spec §3: ${SPEC_CITED}`,
      `packages/core/x.ts:7: agent-tools-spec §4: ${SPEC_CITED}`,
    ]);
  });

  it("refuses an entry of the list the scripts read otherwise: a comment, a glob, a trailing slash, a .., a line not a /path", () => {
    const root = repo({
      ".gitignore": "# Private pages: kept out of git\n/AGENTS.md\n# a note\n/docs/*.md\n/docs/specs/\n/docs/../x.md\nAGENTS.md\n/ok.md\n\n# Other\n/learning/\n",
      "AGENTS.md": "# Agents\n",
    });
    expect(check("private entries", root)).toEqual([3, 4, 5, 6, 7].map((line) => `.gitignore:${line}: ${PRIVATE_ENTRY}`));
  });

});

describe("which files it reads", () => {
  it("reads untracked pages in a lane's worktree, and not in the main checkout", () => {
    const main = repo({ "docs/README.md": "# Docs\n" }, ["docs/README.md"]);
    git(main, "commit", "-qm", "start");
    write(main, "docs/operating/wip.md", "# Work in progress\n\n[x](./nope.md)\n");
    expect(check("main checkout", main)).toEqual([]);

    const lane = `${main}-lane`;
    roots.push(lane);
    git(main, "worktree", "add", "-q", "-b", "wp-lane", lane);
    write(lane, "docs/operating/new.md", "# New\n\n[x](./nope.md)\n");
    expect(check("lane worktree", lane)).toEqual([
      "docs/operating/new.md:1: no link reaches this page from README.md or AGENTS.md",
      "docs/operating/new.md:3: link ./nope.md: no docs/operating/nope.md",
    ]);
  });
});
