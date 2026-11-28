import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Call =
  | "Data(contentsOf:" | "String(contentsOf:" | ".write(to:" | ".write(toFile:" | "FileHandle(" | "fopen(" | "Darwin.open("
  | "open(" | "sqlite3_open" | "createFile" | "copyItem" | "fileSizeKey" | "attributesOfItem" | "temporaryDirectory"
  | "NSTemporaryDirectory" | "st_size" | "truncate(" | "DeviceFiles(.plain)" | "contents(atPath:" | "InputStream("
  | "OutputStream(" | "replaceItemAt";

export interface Entry {
  readonly file: string;
  readonly reason: string;
}

export interface Allowed extends Entry {
  readonly calls: readonly Call[];
}

export interface Lists {
  readonly allowed: readonly Allowed[];
  readonly plainDefaults: readonly string[];
}

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: "refused" | "allowed entry finds nothing";
  readonly detail: string;
}

const CALLS: readonly (readonly [Call, RegExp])[] = [
  ["Data(contentsOf:", /\bData\(contentsOf:/gu],
  ["String(contentsOf:", /\bString\(contentsOf:/gu],
  [".write(to:", /\.write\(to:/gu],
  [".write(toFile:", /\.write\(toFile:/gu],
  ["FileHandle(", /\bFileHandle\(/gu],
  ["fopen(", /\bfopen\(/gu],
  ["Darwin.open(", /\bDarwin\.open\(/gu],
  ["open(", /(?<![\w.])open\((?=[^\n]*\bO_[A-Z])/gu],
  ["sqlite3_open", /\bsqlite3_open/gu],
  ["createFile", /\bcreateFile\(/gu],
  ["copyItem", /\bcopyItem\(/gu],
  ["fileSizeKey", /\bfileSizeKey\b/gu],
  ["attributesOfItem", /\battributesOfItem\(/gu],
  ["temporaryDirectory", /\btemporaryDirectory\b/gu],
  ["NSTemporaryDirectory", /\bNSTemporaryDirectory\(/gu],
  ["st_size", /\bst_size\b/gu],
  ["truncate(", /\bDarwin\.f?truncate\(|(?<![\w.?])f?truncate\(|\.truncate\(atOffset:/gu],
  ["DeviceFiles(.plain)", /\bDeviceFiles\(\.plain\)/gu],
  ["contents(atPath:", /\.contents\(atPath:/gu],
  ["InputStream(", /\bInputStream\((?!data:)/gu],
  ["OutputStream(", /\bOutputStream\((?!toMemory)/gu],
  ["replaceItemAt", /\breplaceItemAt\(/gu],
];

const PLAIN_DEFAULT = /(?::\s*DeviceFiles\s*=|\bfiles\s*\?\?)\s*$/u;

const READ: readonly (readonly [string, readonly Call[] | "all"])[] = [
  ["macos-app/Sources", "all"],
  ["homelink/Sources", "all"],
  ["photolibrary/Sources", ["temporaryDirectory"]],
];

const MAC = "macos-app/Sources/";

const allow = (file: string, calls: readonly Call[], reason: string): Allowed => ({ file: `${MAC}${file}`, calls, reason });

export const ALLOWED: readonly Allowed[] = [
  allow("Spool/CaptureStore.swift", ["Darwin.open("], "opens the empty writer lock file that flock holds; it carries no byte"),
  allow("Lifestream/Commands/DiagnosticCommands.swift", ["temporaryDirectory"], "the default folder of a diagnostics report the person asks for"),
  allow("Lifestream/Dashboard/BundledPage.swift", ["Data(contentsOf:"], "reads the dashboard's pages from the app bundle's resources"),
  allow("Lifestream/Needs/RecoveryKeyFile.swift", [".write(to:"], "writes the recovery key to the file the person picked, outside the two folders"),
  allow("Lifestream/Setup/AppPlacement.swift", ["copyItem", "attributesOfItem", "replaceItemAt"], "copies the app bundle into Applications, puts it over the app already there and reads its size"),
  allow("Lifestream/Setup/BundledRelease.swift", ["temporaryDirectory", ".write(to:", "FileHandle(", "Data(contentsOf:"], "unpacks the release the app bundle carries, code and no record, into its output"),
  allow("Lifestream/Setup/HomeAgents.swift", [".write(to:", "String(contentsOf:"], "writes the launchd jobs' plists in ~/Library/LaunchAgents and reads dashboard-from, the checkout a developer names for the dashboard job"),
  allow("Lifestream/Setup/SetupStart.swift", ["FileHandle("], "reads the tail of the home's and the door's logs, files the home writes"),
  allow("Lifestream/Setup/SetupWorld.swift", ["Data(contentsOf:"], "reads the home's HOME.json, a file the home writes"),
  allow("Lifestream/Setup/Uninstall.swift", ["temporaryDirectory", ".write(to:"], "the uninstall script must outlive the folders it deletes"),
  allow("Lifestream/Shipping/ReachDiagnosis.swift", ["String(contentsOf:", "FileHandle("], "reads the home's pointer and the home's own log, files the home writes"),
  allow("Passwords/HomeKeys.swift", ["Data(contentsOf:", "String(contentsOf:"], "reads the home's vault description and its id, files the home writes"),
  allow("Lifestream/Setup/MacFiles.swift", ["DeviceFiles(.plain)"], "the one place that decides the form: a Mac with no mac-files.json opens plain, and mac-files.json is written through the fixed plain instance"),
  allow("Lifestream/Setup/MacProcess.swift", ["DeviceFiles(.plain)"], "the process's wiring: its fixed plain instance for the plain list, and the instance a refused Mac holds unwritten until Allow switches it keyed"),
  allow("Lifestream/Commands/SpoolCommands.swift", [".write(to:", "FileHandle("], "writes the PNG to the path the person names and reads the metadata packet they name, outside the two folders"),
  allow("Lifestream/Connectors/Detection.swift", ["Data(contentsOf:", "copyItem", "sqlite3_open"], "reads a browser's Local State and copies its History, another app's files, into the process's scratch to open SQLite on the copy"),
  allow("Evidence/OwnerOnly.swift", ["Darwin.open("], "opens an append descriptor at 0600 for the jobs' logs in ~/Library/Logs and the plain resource lines; it writes no record"),
  allow("Passwords/HomeSocket.swift", ["String(contentsOf:", "Data(contentsOf:"], "reads the home's pointer and HOME.json, files the home writes"),
  allow("PhoneBackup/BackupFolder.swift", ["Data(contentsOf:"], "reads a backup Finder made, another program's files"),
  allow("PhoneBackup/Keybag.swift", ["FileHandle("], "reads a backup Finder made, another program's files"),
  allow("PhoneBackup/OpenBackup.swift", [".write(to:", "sqlite3_open", "FileHandle(", "createFile", "replaceItemAt"], "reads a backup Finder made, another program's files, and writes its decrypted files only into the caller's scratch, each over its partial copy there"),
  allow("PhoneBackup/BackupPull.swift", ["sqlite3_open"], "folds and reads a store pulled out into scratch, before it is placed into carried/ through DeviceFiles"),
  allow("PhoneBackupFixture/SyntheticBackup.swift", [".write(to:", "temporaryDirectory", "Data(contentsOf:", "sqlite3_open"], "the synthetic stores of a test backup"),
  allow("Recorder/Control/RecorderControlServer.swift", ["Darwin.open("], "takes the control socket's lock, an empty file in /tmp, outside the two folders"),
  allow("ResourceWatch/AppProcess.swift", ["Data(contentsOf:"], "reads another app's Info.plist"),
  allow("ResourceWatch/PowerLogCopy.swift", ["open(", "sqlite3_open"], "inflates macOS's power log into the watcher's scratch and opens SQLite on that copy"),
  allow("Shipping/Bundle/Hashing.swift", ["FileHandle(", "open("], "OpenedFile reads another app's file or a copy in scratch; a kept file is read through DeviceFiles"),
  allow("Shipping/Domains/Differences.swift", ["st_size"], "the stated_file's size: another app's file, outside the two folders"),
  allow("Shipping/Domains/HashCache.swift", ["st_size"], "FileFacts, the stat helper the domains use on other apps' files; a kept file's size goes through size(of:)"),
  allow("Shipping/Domains/SQLiteHeldCopy.swift", ["st_size", "Darwin.open("], "the stamp of another app's store, and its copy made in the run's scratch folder"),
  allow("Shipping/Domains/SessionLogs.swift", ["st_size", "createFile", "FileHandle(", "truncate("], "an agent's session log, another app's file: its size, and its parts copied into the run's work folder in scratch and cut there"),
  allow("Shipping/Domains/UploadDomain.swift", ["copyItem"], "drop copies a file the person chose into their Lifestream Drop folder, outside the two folders"),
  allow("Shipping/Imports/ImportListing.swift", ["FileHandle("], "lists an archive the person handed over, outside the two folders; a pulled backup's store is a folder, only listed"),
  allow("Shipping/Imports/ImportShipping.swift", ["fileSizeKey"], "the stamp of a file the person handed over, outside the two folders; a pulled store's members are sized through size(of:)"),
  allow("Shipping/Domains/ShippingDomains.swift", ["open("], "opens macOS's TCC store to learn whether Full Disk Access is granted, reading nothing"),
  allow("Shipping/Domains/SQLite.swift", ["sqlite3_open"], "opens SQLite on another app's store or a scratch copy of it"),
  allow("Shipping/Domains/StoreMemory.swift", ["st_size"], "the stamp of another app's store: its size, outside the two folders"),
  allow("Shipping/Stores/BiomeEngine.swift", [".write(to:", "st_size"], "a Biome segment, another app's file: its size counted by month, and a settled copy written into the run's scratch folder"),
  allow("Shipping/Stores/StoreAccounts.swift", ["Data(contentsOf:"], "reads macOS's list of the Apple accounts signed in, another program's file"),
  allow("Shipping/Stores/StoreFiles.swift", ["Darwin.open("], "opens another app's store to read it"),
  allow("Shipping/Stores/StoreSQL.swift", ["sqlite3_open"], "an in-memory SQLite, no file"),
  { file: "photolibrary/Sources/PhotoLibrary/Pass.swift", calls: ["temporaryDirectory"], reason: "PhotoPass.init's default export folder, which only the phone takes" },
  { file: "homelink/Sources/HomeLink/HomeLink.swift", calls: ["DeviceFiles(.plain)", "temporaryDirectory"], reason: "reads another app's unkept file from an offset when staging it, and holds a DeviceFiles-written temporary gzip bundle outside the shipping folder until the upload ends" },
];

export const PLAIN_DEFAULTS: readonly string[] = ["homelink/Sources/"];

export const LISTS: Lists = { allowed: ALLOWED, plainDefaults: PLAIN_DEFAULTS };

function swiftFiles(root: string, folder: string): string[] {
  const top = join(root, folder);
  if (!existsSync(top)) return [];
  const found: string[] = [];
  const walk = (relativeFolder: string): void => {
    for (const entry of readdirSync(join(root, relativeFolder), { withFileTypes: true })) {
      const path = `${relativeFolder}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".swift")) found.push(path);
    }
  };
  walk(folder);
  return found.sort();
}

interface Use {
  readonly file: string;
  readonly line: number;
  readonly call: Call;
}

export function usesIn(file: string, source: string, read: readonly Call[] | "all", plainDefaults: readonly string[]): Use[] {
  const uses: Use[] = [];
  const defaultsAllowed = plainDefaults.some((folder) => file.startsWith(folder));
  for (const [call, pattern] of CALLS) {
    if (read !== "all" && !read.includes(call)) continue;
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(source.lastIndexOf("\n", match.index) + 1, match.index);
      if (call === "DeviceFiles(.plain)" && defaultsAllowed && PLAIN_DEFAULT.test(before)) continue;
      uses.push({ file, line: source.slice(0, match.index).split("\n").length, call });
    }
  }
  return uses.sort((left, right) => left.line - right.line);
}

export function usesUnder(root: string, plainDefaults: readonly string[] = PLAIN_DEFAULTS): Use[] {
  return READ.flatMap(([folder, read]) => swiftFiles(root, folder).flatMap((file) => usesIn(file, readFileSync(join(root, file), "utf8"), read, plainDefaults)));
}

export function checkDeviceFiles(root: string, lists: Lists = LISTS): Finding[] {
  const uses = usesUnder(resolve(root), lists.plainDefaults);
  const findings: Finding[] = [];
  for (const use of uses) {
    if (lists.allowed.some((entry) => entry.file === use.file && entry.calls.includes(use.call))) continue;
    findings.push({ file: use.file, line: use.line, rule: "refused", detail: `${use.call}: only DeviceFiles touches the bytes of a file the Mac keeps; go through it, or name the file and why on the allowed list` });
  }
  for (const entry of lists.allowed) {
    for (const call of entry.calls) {
      if (!uses.some((use) => use.file === entry.file && use.call === call)) findings.push({ file: entry.file, line: 0, rule: "allowed entry finds nothing", detail: `${call}: delete it from the allowed list` });
    }
  }
  return findings;
}

export function runDeviceFilesCheck(
  root: string,
  output: (text: string) => void = (text) => process.stdout.write(text),
  error: (text: string) => void = (text) => process.stderr.write(text),
): 0 | 1 {
  const findings = checkDeviceFiles(root);
  if (findings.length === 0) {
    output("device files check: clean\n");
    return 0;
  }
  for (const finding of findings) error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.detail}\n`);
  error(`device files check: ${findings.length} finding(s)\n`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runDeviceFilesCheck(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
