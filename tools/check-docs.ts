import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Break {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

const CODE = /\.(?:ts|mts|mjs|js|sql|swift|sh|py)$/u;
const BY_NUMBER = /([\w./-]*?[\w-]+)(\.md)?(?:\]\([^)\s]*\))? §(\d+(?:\.\d+)*)/gu;
const BY_HEADING = /([\w./-]*?[\w-]+\.md)(?:\]\([^)\s]*\))?(?: §\d+(?:\.\d+)*)?,? \\?"([^"\\\n]{1,80})\\?"/gu;
const LINK = /\[(?:[^\]\n]|\][^(\n])*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
const INLINE_CODE = /`([^`\n]+)`/gu;
const NOT_A_PAGE = /(?:^|\/)(?:prompts|fixtures?|test|golden)\//u;
const HOME_SPAN = /^home ([a-z<-][\w<>-]*)/u;
const HOME_TYPED = /^\s*(?:\$ |usage: )home ([a-z<-][\w<>-]*)/u;
const HOME_LINE = /^\s*home ([a-z][\w-]*)(?![\w-])/u;
const HOME_ARGUED = /\bhome ([a-z][\w-]*) (?=--|<)/gu;
const HOME_NAMED = /`home`(?:'s)? (?:command|CLI)\b|`home` is the [\w' ]*command\b/gu;
const HOME_CODE_SPAN = /`home ([a-z<][\w<>-]*)[^`$\n]*`/gu;
const HOME_STRING = /(?:["'`]|usage: |\$ |\brun )home ([a-z][\w-]*)(?![\w-])/gu;

export const PLACES = [
  "README.md", "SECURITY.md", "CONTRIBUTING.md",
  "<part>/README.md", "<part>/SKILL.md",
  "<code>/README.md",
  "packages/**/<folder>/<folder>.md", "packages/families/day-file.md",
  "**/prompts/**", "**/prompt-parts/**",
  "docs/README.md", "docs/DESIGN.md", "docs/OPERATING.md", "docs/releasing.md", "docs/vision.md",
  "docs/operating/*.md", "docs/contributing/*.md", "docs/writing/**", "docs/user/**",
  "design/principles.md", "design/writing.md", "faces/MODEL-NOTICES.md",
] as const;

export const NO_PLACE = "no page lives here: a README or SKILL of the root or a part, a README beside its code, "
  + "a page named for its folder, a prompt, a docs/ page PLACES names, or a private page .gitignore lists";

export const NO_NEXT = "no NEXT.md: owed work is an entry in docs/owed.md, one page for every part";

export const NO_LIVE = "no [live] entry in docs/owed.md: a check only the live home, a device or a provider account can make is no owed work";

const NEXT = /(?:^|\/)NEXT\.md$/u;
const OWED = "docs/owed.md";
const LIVE_TAG = /\[live\]\s*$/u;

export const PRIVATE_IN_GIT = "a private page is kept out of git (.gitignore, \"Private pages\"): git rm --cached it";

export const PRIVATE_LINKED = "is a private page, kept out of git (.gitignore, \"Private pages\"): a clone holds none, so a page in git never links one";

export const PRIVATE_ENTRY = "a private page's entry is one /path: no comment, glob, trailing slash, . or .. in it, and no blank line inside the list, "
  + "so tools/private.sh reads the list as this check does";

export const SPEC_CITED = "code cites a spec: a spec is private and ends with its change, so code names the page that owns the rule, or says it itself";

const PRIVATE_HEADER = /^# Private pages\b/u;
const PRIVATE_ENTRY_LINE = /^\/[\w.-]+(?:\/[\w.-]+)*$/u;

export function privatePathsOf(root: string): { paths: string[]; breaks: Break[] } {
  const lines = read(root, ".gitignore").split("\n");
  const paths: string[] = [];
  const breaks: Break[] = [];
  for (let index = lines.findIndex((line) => PRIVATE_HEADER.test(line)) + 1; index > 0 && index < lines.length && lines[index] !== ""; index++) {
    const line = lines[index]!;
    if (PRIVATE_ENTRY_LINE.test(line) && !line.split("/").some((part) => part === "." || part === "..")) paths.push(line.slice(1));
    else breaks.push({ file: ".gitignore", line: index + 1, what: PRIVATE_ENTRY });
  }
  return { paths, breaks };
}

function isPrivate(file: string, paths: readonly string[]): boolean {
  return paths.some((path) => file === path || file.startsWith(`${path}/`));
}

const SPEC_PATH = /(?<![\w/.-])(?:docs\/specs\b[\w./-]*|specs\/[\w-]+\.md\b)|[\w-]+-spec\.md\b/u;

function specPattern(specNames: readonly string[]): RegExp {
  const names = ["spec", "[\\w-]+-spec", ...specNames].join("|");
  return new RegExp(`(?<![\\w/.-])(?:${names})(?:\\.md)? §\\d`, "u");
}

function specCitation(text: string, pattern: RegExp): string | undefined {
  if (!text.includes("spec") && !text.includes("§")) return undefined;
  return SPEC_PATH.exec(text)?.[0] ?? pattern.exec(text)?.[0];
}

const PART = "(?:packages/[^/]+|macos-app/Sources/[^/]+|[^/]+)";

function placeOf(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*\*\//gu, "(?:.+/)?")
    .replace(/\/\*\*$/u, "/.+")
    .replace(/\*/gu, "[^/]+")
    .replace("<part>", PART)
    .replace("<code>", "(?<code>.+)")
    .replace("<folder>/<folder>", "([^/]+)/\\1");
  return new RegExp(`^${source}$`, "u");
}

const PLACE_TESTS = PLACES.map(placeOf);

function hasPlace(file: string, codeFolders: ReadonlySet<string>): boolean {
  return PLACE_TESTS.some((place) => {
    const match = place.exec(file);
    if (match === null) return false;
    const code = match.groups?.code;
    return code === undefined || codeFolders.has(code);
  });
}

function codeFoldersOf(files: readonly string[]): Set<string> {
  const folders = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".md")) continue;
    for (let dir = dirname(file); dir !== "."; dir = dirname(dir)) folders.add(dir);
  }
  return folders;
}

export function checkDocs(root: string): Break[] {
  const { paths: privatePaths, breaks: entries } = privatePathsOf(root);
  const { files, inGit } = filesOf(root, privatePaths);
  const tracked = new Set(files);
  const secret = (file: string): boolean => isPrivate(file, privatePaths);
  const isSpec = (page: string): boolean => secret(page) && page.startsWith("docs/specs/");
  const newer = newerElsewhere(root);
  const codeFolders = codeFoldersOf(files);
  const pages = files.filter((file) => file.endsWith(".md") && !NOT_A_PAGE.test(file));
  const headings = new Map<string, Heading[]>();
  const headingsOf = (page: string): Heading[] => {
    let found = headings.get(page);
    if (found === undefined) headings.set(page, (found = readHeadings(read(root, page))));
    return found;
  };
  const byBasename = new Map<string, string[]>();
  for (const page of pages) byBasename.set(basename(page), [...(byBasename.get(basename(page)) ?? []), page]);
  const topLevel = new Set(files.filter((file) => file.includes("/")).map((file) => file.slice(0, file.indexOf("/"))));
  const packages = new Set(files.filter((file) => file.startsWith("packages/")).map((file) => file.split("/")[1]!));

  const verbs = verbsOf(root);
  const specNames = files
    .filter((file) => isSpec(file) && file.endsWith(".md"))
    .map((file) => basename(file, ".md"))
    .filter((name) => /^[\w-]+$/u.test(name) && !pages.some((page) => !secret(page) && basename(page, ".md") === name));
  const nexts = new Set([...files, ...git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "*NEXT.md"]).split("\0")]);
  const breaks: Break[] = files
    .filter((file) => file.endsWith(".md") && !secret(file) && !NEXT.test(file) && !hasPlace(file, codeFolders))
    .map((file) => ({ file, line: 1, what: NO_PLACE }));
  breaks.push(...[...nexts].filter((file) => NEXT.test(file)).map((file) => ({ file, line: 1, what: NO_NEXT })));
  breaks.push(...entries, ...inGit.filter(secret).map((file) => ({ file, line: 1, what: PRIVATE_IN_GIT })));
  const missing: { file: string; line: number; path: string }[] = [];
  const edges = new Map<string, Set<string>>();

  for (const page of pages) {
    const lines = read(root, page).split("\n");
    const out = new Set<string>();
    edges.set(page, out);
    let fence: string | null = null;
    lines.forEach((text, index) => {
      const line = index + 1;
      const opens = /^\s*(`{3,}|~{3,})/u.exec(text);
      if (opens !== null) {
        if (fence === null) fence = opens[1]!;
        else if (text.trim().startsWith(fence)) fence = null;
        return;
      }
      breaks.push(...commandsOnPage(page, line, text, fence !== null, verbs));
      if (fence !== null) return;
      if (page === OWED && LIVE_TAG.test(text)) breaks.push({ file: page, line, what: NO_LIVE });
      const prose = text.replace(INLINE_CODE, (code) => " ".repeat(code.length));
      for (const match of prose.matchAll(LINK)) {
        const target = match[1]!.replace(/^<|>$/gu, "");
        if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
        const [pathPart, anchor] = splitAnchor(target);
        const to = pathPart === "" ? page : normalize(join(dirname(page), decodeURIComponent(pathPart))).replace(/\/$/u, "");
        if (!secret(page) && secret(to)) {
          breaks.push({ file: page, line, what: `link ${target}: ${to} ${PRIVATE_LINKED}` });
          continue;
        }
        const absolute = join(root, to);
        if (pathPart !== "" && !existsSync(absolute)) {
          if (secret(page) && (newer(to) || newer(dirname(to)))) continue;
          breaks.push({ file: page, line, what: `link ${target}: no ${to}` });
          continue;
        }
        const reached = pathPart !== "" && statSync(absolute).isDirectory() ? join(to, "README.md") : to;
        if (tracked.has(reached)) out.add(reached);
        if (anchor !== undefined && reached.endsWith(".md") && existsSync(join(root, reached))) {
          if (!headingsOf(reached).some((heading) => heading.slug === anchor)) {
            breaks.push({ file: page, line, what: `link ${target}: ${reached} has no heading #${anchor}` });
          }
        }
      }
      for (const match of text.matchAll(INLINE_CODE)) {
        const path = repoPath(match[1]!, topLevel, packages);
        if (path === null) continue;
        const after = text.slice(match.index! + match[0].length);
        if (after.startsWith(" (removed)")) continue;
        if (after.startsWith(" (planned)")) {
          if (!isSpec(page) && existsSync(join(root, path))) breaks.push({ file: page, line, what: `path ${path} exists: drop its (planned)` });
          continue;
        }
        if (!existsSync(join(root, path)) && !(secret(page) && newer(path))) missing.push({ file: page, line, path });
      }
      breaks.push(...citations(root, page, line, text, byBasename, headingsOf));
    });
  }

  const specRe = specPattern(specNames);
  for (const file of files) {
    if (!CODE.test(file) || file.startsWith("tools/check-docs")) continue;
    const isSecret = secret(file);
    read(root, file).split("\n").forEach((text, index) => {
      const spec = isSecret ? undefined : specCitation(text, specRe);
      if (spec !== undefined) breaks.push({ file, line: index + 1, what: `${spec}: ${SPEC_CITED}` });
      else if (text.includes("§") || text.includes(".md")) breaks.push(...citations(root, file, index + 1, text, byBasename, headingsOf));
      if (text.includes("home")) breaks.push(...commandsIn(file, index + 1, text, verbs));
    });
  }

  const ignored = ignoredOf(root, missing.map((entry) => entry.path));
  for (const entry of missing) {
    if (!ignored.has(entry.path)) breaks.push({ file: entry.file, line: entry.line, what: `path ${entry.path} does not exist (one not built yet is marked (planned))` });
  }

  const reach = (through: (page: string) => boolean): Set<string> => {
    const reached = new Set<string>();
    const queue = ["README.md", "AGENTS.md"].filter((page) => tracked.has(page) && through(page));
    while (queue.length > 0) {
      const page = queue.pop()!;
      if (reached.has(page)) continue;
      reached.add(page);
      for (const next of edges.get(page) ?? []) if (through(next)) queue.push(next);
    }
    return reached;
  };
  const reachable = reach(() => true);
  const reachableInGit = reach((page) => !secret(page));
  for (const page of pages) {
    if (!reachable.has(page)) breaks.push({ file: page, line: 1, what: "no link reaches this page from README.md or AGENTS.md" });
    else if (!secret(page) && !reachableInGit.has(page)) {
      breaks.push({ file: page, line: 1, what: "only private pages link this page: a clone holds none of them, so link it from README.md or a page it reaches" });
    }
  }
  return breaks.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function named(file: string, line: number, words: string): Break {
  return { file, line, what: `\`${words}\`: the command is \`lifestream\` (packages/home/cli-name.ts)` };
}

function commandsOnPage(page: string, line: number, text: string, block: boolean, verbs: ReadonlySet<string>): Break[] {
  const found = new Map<number, string>();
  if (block) {
    const typed = HOME_TYPED.exec(text)?.[1];
    const verb = typed ?? HOME_LINE.exec(text)?.[1];
    if (verb !== undefined && (typed !== undefined || verbs.has(verb))) found.set(text.indexOf(`home ${verb}`), verb);
  } else {
    for (const match of text.matchAll(INLINE_CODE)) {
      const verb = HOME_SPAN.exec(match[1]!)?.[1];
      if (verb !== undefined) found.set(match.index!, verb);
    }
  }
  const prose = block ? text : text.replace(INLINE_CODE, (code) => " ".repeat(code.length));
  for (const match of prose.matchAll(HOME_ARGUED)) {
    if (verbs.has(match[1]!) && !found.has(match.index!)) found.set(match.index!, match[1]!);
  }
  const breaks = [...found].sort(([a], [b]) => a - b).map(([, verb]) => named(page, line, `home ${verb}`));
  return [...breaks, ...[...text.matchAll(HOME_NAMED)].map(() => named(page, line, "home"))];
}

function commandsIn(file: string, line: number, text: string, verbs: ReadonlySet<string>): Break[] {
  const found = new Map<number, string>();
  for (const match of text.matchAll(HOME_CODE_SPAN)) found.set(match.index!, match[1]!);
  for (const match of text.matchAll(HOME_STRING)) if (verbs.has(match[1]!) && !found.has(match.index!)) found.set(match.index!, match[1]!);
  const breaks = [...found].sort(([a], [b]) => a - b).map(([, verb]) => named(file, line, `home ${verb}`));
  return [...breaks, ...[...text.matchAll(HOME_NAMED)].map(() => named(file, line, "home"))];
}

function verbsOf(root: string): Set<string> {
  const verbs = new Set(["help"]);
  const declared = /export const VERBS\b[^=]*=\s*\{([^}]*)\}/u.exec(read(root, "packages/home/verbs/index.ts"))?.[1] ?? "";
  for (const name of declared.split(/[\s,]+/u)) if (/^[a-z][\w-]*$/u.test(name)) verbs.add(name);
  const commands = /\bconst COMMANDS = \{\n([\s\S]*?)\n\}/u.exec(read(root, "packages/home/cli.ts"))?.[1] ?? "";
  for (const match of commands.matchAll(/^\s*"?([a-z][\w-]*)"?:/gmu)) verbs.add(match[1]!);
  return verbs;
}

interface Heading {
  readonly text: string;
  readonly slug: string | null;
}

function readHeadings(text: string): Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const opens = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (opens !== null) {
      if (fence === null) fence = opens[1]!;
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const lead = /^\s*(?:[-*]\s+|\d+\.\s+)?\*\*([^*]+)\*\*/u.exec(line);
    if (lead !== null) {
      headings.push({ text: lead[1]!.split(/[.:]/u)[0]!.replace(/`/gu, "").trim(), slug: null });
      continue;
    }
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
    if (match === null) continue;
    const heading = match[1]!.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
    const base = heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/gu, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ text: heading.replace(/`/gu, "").trim(), slug: count === 0 ? base : `${base}-${count}` });
  }
  return headings;
}

function citations(
  root: string, file: string, line: number, text: string,
  byBasename: ReadonlyMap<string, readonly string[]>, headingsOf: (page: string) => Heading[],
): Break[] {
  const breaks: Break[] = [];
  for (const match of text.matchAll(BY_NUMBER)) {
    const page = pageOf(root, file, `${match[1]!}.md`, byBasename);
    if (page === null) continue;
    const number = match[3]!;
    const heads = new RegExp(`^(?:§\\s*)?${number.replace(/\./gu, "\\.")}(?:\\.(?!\\d)|\\s|$)`, "u");
    if (!headingsOf(page).some((heading) => heading.slug !== null && heads.test(heading.text))) {
      breaks.push({ file, line, what: `${match[0]}: ${page} has no section ${number}` });
    }
  }
  for (const match of text.matchAll(BY_HEADING)) {
    const page = pageOf(root, file, match[1]!, byBasename);
    if (page === null) continue;
    const wanted = match[2]!.replace(/`/gu, "").trim();
    if (!headingsOf(page).some((heading) => heading.text === wanted)) {
      breaks.push({ file, line, what: `${match[1]!} "${wanted}": ${page} has no such heading` });
    }
  }
  return breaks;
}

function pageOf(root: string, from: string, name: string, byBasename: ReadonlyMap<string, readonly string[]>): string | null {
  if (name.includes("/")) {
    for (const candidate of [normalize(join(dirname(from), name)), normalize(name)]) {
      if (!candidate.startsWith("..") && existsSync(join(root, candidate))) return candidate;
    }
    return null;
  }
  const named = byBasename.get(name) ?? [];
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const here = named.find((page) => dirname(page) === dir);
    if (here !== undefined) return here;
    if (dir === "." || dir === "") break;
  }
  return named.find((page) => dirname(page) === "docs") ?? (named.length === 1 ? named[0]! : null);
}

function repoPath(code: string, topLevel: ReadonlySet<string>, packages: ReadonlySet<string>): string | null {
  const path = code.replace(/[#:][\w.-]*$/u, "");
  if (!/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/u.test(path)) return null;
  if (!/\.[a-z]+$/iu.test(path) && !path.endsWith("/")) return null;
  const first = path.slice(0, path.indexOf("/"));
  const full = topLevel.has(first) ? path : packages.has(first) ? `packages/${path}` : null;
  return full?.replace(/\/$/u, "") ?? null;
}

function splitAnchor(target: string): [string, string | undefined] {
  const at = target.indexOf("#");
  return at < 0 ? [target, undefined] : [target.slice(0, at), target.slice(at + 1)];
}

function read(root: string, file: string): string {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return "";
  }
}

function git(root: string, args: readonly string[], input?: string): string {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, maxBuffer: 64 << 20 });
  } catch (error) {
    const out = (error as { stdout?: string }).stdout;
    if (args[0] === "check-ignore" && typeof out === "string") return out;
    throw error;
  }
}

function mainOf(lane: string): string | null {
  const main = /^worktree (.*)$/mu.exec(git(lane, ["worktree", "list", "--porcelain"]))?.[1];
  return main === undefined || realpathSync(main) === realpathSync(lane) ? null : main;
}

function newerElsewhere(root: string): (path: string) => boolean {
  const main = mainOf(root);
  const base = main === null ? null : git(root, ["merge-base", "HEAD", git(main, ["rev-parse", "HEAD"]).trim()]).trim();
  const newerInMain = (path: string): boolean => main !== null && base !== null && existsSync(join(main, path)) && git(root, ["ls-tree", "--name-only", base, "--", path]) === "";
  const born = git(root, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/heads"]) !== "";
  const onAnotherBranch = (path: string): boolean => born && git(root, ["log", "-1", "--format=%H", "HEAD", "--", path]) === "" && git(root, ["log", "-1", "--format=%H", "--branches", "--not", "HEAD", "--", path]) !== "";
  return (path) => newerInMain(path) || onAnotherBranch(path);
}

function filesOf(root: string, privatePaths: readonly string[]): { files: string[]; inGit: string[] } {
  const inGit = git(root, ["ls-files", "-z"]).split("\0").filter((file) => file !== "");
  const listed = [...inGit];
  if (mainOf(root) !== null) listed.push(...git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0"));
  for (const path of privatePaths) {
    const at = join(root, path);
    if (!existsSync(at)) continue;
    if (!statSync(at).isDirectory()) listed.push(path);
    else for (const entry of readdirSync(at, { recursive: true, encoding: "utf8" })) listed.push(join(path, entry));
  }
  const files = [...new Set(listed.filter((file) => file !== "" && existsSync(join(root, file)) && statSync(join(root, file)).isFile()))].sort();
  return { files, inGit };
}

function ignoredOf(root: string, paths: readonly string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const asked = [...new Set(paths)].flatMap((path) => [path, `${path}/`]);
  const out = git(root, ["check-ignore", "--no-index", "--stdin"], `${asked.join("\n")}\n`);
  return new Set(out.split("\n").filter((path) => path !== "").map((path) => path.replace(/\/$/u, "")));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const breaks = checkDocs(root);
  for (const entry of breaks) process.stdout.write(`${relative(root, join(root, entry.file))}:${entry.line}: ${entry.what}\n`);
  if (breaks.length > 0) {
    process.stdout.write(`check-docs: ${breaks.length} broken (tools/check-docs.ts says what each rule holds)\n`);
    process.exit(1);
  }
}
