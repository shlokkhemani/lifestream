import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FAKE_OFFER, FAKE_ROUTE, FAKES, REPO, until } from "./test/harness-root.js";
import { editSettings } from "./test/folder.js";
import { cliProgram, doorOn, home, newMachine, printed, removeTemps, temp } from "./test/machines.js";
import { writeArtifact } from "./test/ops-support.js";
import { acquisitionBundle, DEVICE, phoneBundle, photoLine, sha256 } from "./test/support.js";
import { checkoutProgram } from "./programs.js";
import { isReadBeforeKey } from "./settings.js";
import { draftRecovery, VAULT_FD } from "./vault.js";

const MAC_SOURCE = "apple-notes:local:macbook-pro-0001";
const ACCOUNT = "person-a@example.com";
const DAY_MS = Date.UTC(2026, 7, 31, 4, 30, 0);
const SLOT_KEY = "11".repeat(32);
const RECOVERY = draftRecovery(DAY_MS).recovery;
const CANARY = {
  message: "ZQX-CANARY-message-7f3a",
  photo: "ZQX-CANARY-photo-91c2",
  recording: "ZQX-CANARY-recording-4be8",
  upload: "ZQX-CANARY-upload-c03d",
  attachment: "ZQX-CANARY-attachment-5d17",
  account: "zqx-canary-account-2e61@example.com",
} as const;

interface Flag { kind: string; tree: string; path: string; detail: string }
interface Status {
  today: { sources: { source: string; deliveries: number; imports: number }[] };
  works: { connector: string; member: string; shape: string }[];
  running: { lanes: { queued: number; running: number }[]; jobs: unknown[] };
}
interface Report { counts: Record<string, number>; scratch: string[]; flags: Flag[] }

const report: Record<string, unknown> = {};
const children: ChildProcess[] = [];

afterAll(async () => {
  await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  })));
  writeArtifact("inventory", report);
  removeTemps();
});

function serveKeyed(on: { env: NodeJS.ProcessEnv }): { out: () => string; exited: Promise<number | null>; child: ChildProcess } {
  const child = spawn(process.execPath, [...cliProgram(), "serve", "--registry", FAKES], {
    cwd: REPO, env: { ...on.env, [VAULT_FD]: "3" }, stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  children.push(child);
  (child.stdio[3] as NodeJS.WritableStream).end(Buffer.from(SLOT_KEY, "hex"));
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  return { out: () => out, exited: new Promise((resolve) => child.once("exit", (code) => resolve(code))), child };
}

async function minted(on: { env: NodeJS.ProcessEnv }, args: string[]): Promise<string> {
  const answer = await home(on, ["principals", "mint", ...args, "--json"]);
  expect(answer.status, answer.out).toBe(0);
  return (answer.result as { token: string }).token;
}

function runInventory(folder: string, machine: string, blobs: readonly string[]): Promise<{ code: number; report: Report; err: string }> {
  const args = [...checkoutProgram(join(REPO, "tools", "inventory.ts")), "--folder", folder, "--machine", machine,
    ...Object.values(CANARY).flatMap((canary) => ["--canary", canary]), ...blobs.flatMap((blob) => ["--blob", blob])];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      try {
        resolve({ code, report: JSON.parse(stdout) as Report, err: stderr });
      } catch {
        reject(new Error(`the inventory printed no report (exit ${code}): ${stderr}`));
      }
    });
  });
}

describe("a keyed home's inventory", () => {
  it("a keyed home fed a day with canaries holds no plain byte of it outside scratch, and scratch is empty", async () => {
    const here = newMachine("inventory");
    const folder = join(temp("inventory-parent"), "home");
    const homeId = randomUUID();
    const keys = `${JSON.stringify({ home_id: homeId, slot_key: SLOT_KEY, recovery: RECOVERY })}\n`;

    const adopted = await home(here, ["adopt", folder, "--keyed"], [], { input: async () => keys });
    expect(adopted.status, `adopt --keyed makes the keyed home this inventory reads; it answered: ${adopted.out.trim()}`).toBe(0);

    editSettings(folder, {
      "model.defaults.pictures": FAKE_ROUTE, "model.defaults.audio": FAKE_ROUTE, "model.defaults.text": FAKE_ROUTE,
      "model.transports.fake": { delay_ms: 100, models: [FAKE_OFFER] },
      "families.photos": {}, "families.voice": {}, "connectors.apple-photos": { "llm.range": "all" }, "connectors.voice-notes": { "llm.range": "all" },
    });
    const running = serveKeyed(here);
    await printed(running, "the keyed home started", '"home":"started"');
    const reader = await minted(here, ["--unit", "dashboard", "--scope", "read"]);
    const added = await home(here, ["source", "add", MAC_SOURCE, "--connector", "fake-rows"]);
    expect(added.status, added.out).toBe(0);
    const account = await home(here, ["connectors", "set", "gmail", "account", CANARY.account]);
    expect(account.status, account.out).toBe(0);
    const mac = await minted(here, ["--unit", "macbook-pro-0001", "--scope", "read", "--scope", "deliver", "--source", MAC_SOURCE]);
    const { door, port, logs } = await doorOn(here, { key: Buffer.from(SLOT_KEY, "hex"), why: null });
    const url = `http://127.0.0.1:${port}`;
    const put = async (path: string, pass: string, headers: Record<string, string>, body: Buffer) => {
      const response = await fetch(`${url}${path}`, { method: "PUT", headers: { authorization: `Bearer ${pass}`, ...headers }, body });
      return `${response.status} ${response.status === 201 ? "" : await response.text()}`.trim();
    };

    const shown = await home(here, ["pair", "--account", ACCOUNT, "--json"]);
    expect(shown.status, shown.out).toBe(0);
    const phone = randomBytes(32).toString("base64url");
    const paired = await fetch(`${url}/v1/pair`, {
      method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" },
      body: JSON.stringify({ code: (shown.result as { code: string }).code, pass: phone, kind: "phone", model: "Synthetic iPhone", account: ACCOUNT, new: true }),
    });
    expect(paired.status, await paired.clone().text()).toBe(200);
    const { unit } = await paired.json() as { unit: string };

    const message = acquisitionBundle({
      source: MAC_SOURCE, feeder: "fake-rows", fetched_ms: DAY_MS,
      files: [["rows.ndjson", Buffer.from(`${JSON.stringify({ kind: "note", key: "note-1", content: { text: `a note that says ${CANARY.message}`, at: DAY_MS }, at: DAY_MS })}\n`)]],
    });
    expect(await put(message.path, mac, DEVICE.mac, message.bytes), "the message delivered").toBe("201");

    const photo = Buffer.from(`synthetic jpeg bytes ${CANARY.photo}`);
    const recording = Buffer.from(`synthetic m4a bytes ${CANARY.recording}`);
    const voice = {
      schema_version: 1, domain: "voice", kind: "voice_note", sequence: 1, observed_at: "2026-08-31T04:30:00.125Z",
      captured: { wall_rfc3339: "2026-08-31T10:00:00.125+05:30", wall_unix_seconds: DAY_MS / 1000 + 0.125, elapsed_seconds: 1000.5 },
      process_instance_id: "00000000-0000-4000-8000-0000000000c1",
      payload: { duration_s: 4.5, blob: { hash: `sha256:${sha256(recording)}`, bytes: recording.length, type: "audio/mp4", role: "voice_note" } },
    };
    const sealed = (...sources: string[]) => Object.fromEntries(sources.map((source) => [source, { seal: 1 }]));
    const day = phoneBundle({
      entries: { "photos.jsonl": [photoLine(1, photo)], "voice.jsonl": [voice] }, blobs: [photo, recording],
      custody: sealed(`apple-photos:${ACCOUNT}:${unit}`, `voice-notes:local:${unit}`),
    });
    expect(await put(`/v1/bundles/${day.id}`, phone, DEVICE.phone, day.bytes), "the photo and the recording delivered").toBe("201");

    const cut = Buffer.from(`synthetic jpeg bytes ${CANARY.upload}`);
    const big = phoneBundle({ entries: { "photos.jsonl": [photoLine(2, cut)] }, blobs: [cut], second: 2, custody: sealed(`apple-photos:${ACCOUNT}:${unit}`) });
    const half = Math.floor(big.bytes.length / 2);
    const controller = new AbortController();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent) return new Promise<void>(() => undefined);
        sent = true;
        stream.enqueue(big.bytes.subarray(0, half));
        return undefined;
      },
    });
    const uploads = () => { try { return readdirSync(join(folder, "door", "uploads")).length; } catch { return 0; } };
    const inFlight = fetch(`${url}/v1/bundles/${big.id}`, {
      method: "PUT", headers: { authorization: `Bearer ${phone}`, ...DEVICE.phone, "content-length": String(big.bytes.length) },
      body, duplex: "half", signal: controller.signal,
    } as RequestInit).then(() => "answered", () => "cut");
    await until("the cut upload under way", () => uploads() > 0);
    controller.abort();
    expect(await inFlight).toBe("cut");

    const attachment = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`a synthetic photo for Ask ${CANARY.attachment}`)]);
    const asked = await fetch(`${url}/v1/ask/files`, {
      method: "POST", headers: { authorization: `Bearer ${phone}`, ...DEVICE.phone, "content-type": "image/jpeg" }, body: attachment,
    });
    expect(`${asked.status} ${await asked.text()}`, "the photo attached to Ask").toMatch(/^200 /u);

    const status = async () => {
      const response = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${reader}` } });
      return response.status === 200 ? await response.json() as Status : null;
    };
    await until("the day imported and every job done, the photo's caption called through the fake transport", async () => {
      const now = await status();
      report.status = now;
      const imported = (source: string) => now?.today.sources.some((each) => each.source === source && each.imports === each.deliveries) === true;
      return now !== null && [MAC_SOURCE, `apple-photos:${ACCOUNT}:${unit}`, `voice-notes:local:${unit}`].every(imported)
        && now.works.every((work) => work.shape !== "running") && now.running.jobs.length === 0
        && now.running.lanes.every((lane) => lane.queued === 0 && lane.running === 0);
    }).catch((error: Error) => { throw new Error(`${error.message}; the last status: ${JSON.stringify(report.status)}; the home said: ${running.out().slice(-4000)}; the door said: ${logs.filter((line) => /error|fail|refus/u.test(line)).join("\n").slice(-4000)}`); });
    await door.close();
    running.child.kill("SIGTERM");
    expect(await running.exited).not.toBeNull();

    const plain = Object.keys(JSON.parse(readFileSync(join(folder, "config", "settings.json"), "utf8")) as Record<string, unknown>);
    expect(plain.filter((key) => !isReadBeforeKey(key)), "the plain settings hold only what is read before a key").toEqual([]);

    const blobs = [photo, recording, cut, attachment].map((bytes) => sha256(bytes));
    const { code, report: inventory, err } = await runInventory(folder, here.dir, blobs);
    report.inventory = { code, counts: inventory.counts, flags: inventory.flags, scratch: inventory.scratch };
    expect({ flags: inventory.flags, scratch: inventory.scratch, code }, err).toEqual({ flags: [], scratch: [], code: 0 });
  });
});
