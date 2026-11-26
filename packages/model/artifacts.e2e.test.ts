import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { tryLock } from "@lifestreamprotocol/core";
import { ArtifactError, ensureArtifact, fetchDocument, removeArtifact, type Artifact } from "./artifacts.js";

const ARTIFACTS = join(tmpdir(), "lifestream-model-e2e");
const BYTES = randomBytes(256 * 1024);
const HALF = BYTES.length / 2;
const report: Record<string, unknown> = {};
const ends: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const end of ends.splice(0).reverse()) await end();
});
afterAll(() => {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, "artifacts.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Mode = "ranges" | "ignore" | "416" | "wrong-range" | "half" | "more" | "other" | "missing" | "stall" | "redirect-http";

interface Served {
  url: string;
  asked: string[];
  encodings: string[];
  mode: Mode;
}

async function serve(mode: Mode): Promise<Served> {
  const served: Served = { url: "", asked: [], encodings: [], mode };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    served.asked.push(request.headers.range ?? "none");
    served.encodings.push(request.headers["accept-encoding"] ?? "none");
    const from = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? 0);
    switch (served.mode) {
      case "ranges":
        if (from > 0) {
          response.writeHead(206, { "content-length": BYTES.length - from, "content-range": `bytes ${from}-${BYTES.length - 1}/${BYTES.length}` });
          return response.end(BYTES.subarray(from));
        }
        response.writeHead(200, { "content-length": BYTES.length });
        return response.end(BYTES);
      case "ignore":
        response.writeHead(200, { "content-length": BYTES.length });
        return response.end(BYTES);
      case "416":
        if (from > 0) return response.writeHead(416).end();
        response.writeHead(200, { "content-length": BYTES.length });
        return response.end(BYTES);
      case "wrong-range":
        if (from > 0) {
          response.writeHead(206, { "content-length": BYTES.length, "content-range": `bytes 0-${BYTES.length - 1}/${BYTES.length}` });
          return response.end(BYTES);
        }
        response.writeHead(200, { "content-length": BYTES.length });
        return response.end(BYTES);
      case "half":
        response.writeHead(200, { "content-length": BYTES.length });
        response.write(BYTES.subarray(0, HALF), () => response.destroy());
        return;
      case "more":
        response.writeHead(200);
        return response.end(Buffer.concat([BYTES, Buffer.from("one byte too many")]));
      case "other": {
        const other = Buffer.from(BYTES);
        other[other.length - 1] = other[other.length - 1]! ^ 0xff;
        response.writeHead(200, { "content-length": other.length });
        return response.end(other);
      }
      case "missing":
        return response.writeHead(404).end("not here");
      case "stall":
        response.writeHead(200, { "content-length": BYTES.length });
        response.write(BYTES.subarray(0, HALF));
        return;
      case "redirect-http":
        return response.writeHead(302, { location: "http://artifacts.example/file.tgz" }).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  served.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.tgz`;
  ends.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return served;
}

function artifactAt(url: string): Artifact {
  return { url, bytes: BYTES.length, sha256: createHash("sha256").update(BYTES).digest("hex") };
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "model-artifacts-"));
  ends.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "programs", "file.tgz");
}

async function refusal(fetching: Promise<void>): Promise<{ reason: string; status?: number } | string> {
  try {
    await fetching;
    return "fetched";
  } catch (error) {
    return error instanceof ArtifactError ? { reason: error.reason, ...(error.status === undefined ? {} : { status: error.status }) } : String(error);
  }
}

describe("artifacts", () => {
  it("a download cut half way keeps its partial and is offline; the next resumes it by Range and publishes the whole", async () => {
    const server = await serve("half");
    const file = scratch();
    const artifact = artifactAt(server.url);
    expect(await refusal(ensureArtifact(artifact, file))).toEqual({ reason: "offline" });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.partial`)).toEqual(BYTES.subarray(0, HALF));
    server.mode = "ranges";
    const landed: number[] = [];
    await ensureArtifact(artifact, file, { progress: (bytes) => landed.push(bytes) });
    expect(readFileSync(file)).toEqual(BYTES);
    expect(existsSync(`${file}.partial`)).toBe(false);
    expect(server.asked).toEqual(["none", `bytes=${HALF}-`]);
    expect(landed.at(-1)).toBe(BYTES.length);
    expect(landed[0]).toBeGreaterThan(HALF);
    report.resumed = server.asked;
  });

  it("a partial is read again from byte 0 when the server ignores Range, answers 416 or a wrong Content-Range", async () => {
    const asked: Record<string, string[]> = {};
    for (const mode of ["ignore", "416", "wrong-range"] as const) {
      const server = await serve(mode);
      const file = scratch();
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(`${file}.partial`, randomBytes(HALF));
      await ensureArtifact(artifactAt(server.url), file);
      expect(readFileSync(file), mode).toEqual(BYTES);
      asked[mode] = server.asked;
    }
    expect(asked).toEqual({ ignore: [`bytes=${HALF}-`], "416": [`bytes=${HALF}-`, "none"], "wrong-range": [`bytes=${HALF}-`, "none"] });
    report.restarted = asked;
  });

  it("a whole partial is published and a file that holds the artifact kept, with no request; a partial too long is removed; a removal takes the file and its partial", async () => {
    const server = await serve("ranges");
    const artifact = artifactAt(server.url);
    const whole = scratch();
    mkdirSync(join(whole, ".."), { recursive: true });
    writeFileSync(`${whole}.partial`, BYTES);
    await ensureArtifact(artifact, whole);
    expect(readFileSync(whole)).toEqual(BYTES);
    await ensureArtifact(artifact, whole);
    expect(readFileSync(whole)).toEqual(BYTES);
    expect(server.asked).toEqual([]);
    const long = scratch();
    mkdirSync(join(long, ".."), { recursive: true });
    writeFileSync(`${long}.partial`, Buffer.concat([BYTES, BYTES.subarray(0, 10)]));
    await ensureArtifact(artifact, long);
    expect(readFileSync(long)).toEqual(BYTES);
    expect(server.asked).toEqual(["none"]);
    writeFileSync(`${long}.partial`, "left");
    await removeArtifact(long);
    expect([existsSync(long), existsSync(`${long}.partial`)]).toEqual([false, false]);
  });

  it("a file whose bytes differ or run over is removed as hash; a missing one is refused with its status", async () => {
    const results: Record<string, unknown> = {};
    for (const mode of ["other", "more", "missing"] as const) {
      const server = await serve(mode);
      const file = scratch();
      results[mode] = await refusal(ensureArtifact(artifactAt(server.url), file));
      expect([existsSync(file), existsSync(`${file}.partial`)], mode).toEqual([false, false]);
    }
    expect(results).toEqual({ other: { reason: "hash" }, more: { reason: "hash" }, missing: { reason: "refused", status: 404 } });
    report.refused = results;
  });

  it("an address neither https nor loopback is never asked, and a redirect away from https is refused", async () => {
    const file = scratch();
    const plain = await refusal(ensureArtifact(artifactAt("http://artifacts.example/file.tgz"), file));
    const server = await serve("redirect-http");
    const redirected = await refusal(ensureArtifact(artifactAt(server.url), file));
    expect({ plain, redirected }).toEqual({ plain: { reason: "refused" }, redirected: { reason: "refused" } });
    expect(server.asked).toEqual(["none"]);
  });

  it("an abort while bytes arrive or while they are hashed ends with its own reason and keeps the partial", async () => {
    const stalled = await serve("stall");
    const later = scratch();
    const stop = new AbortController();
    const reason = new Error("the home is stopping");
    const fetching = ensureArtifact(artifactAt(stalled.url), later, { signal: stop.signal, progress: (bytes) => { if (bytes >= HALF) stop.abort(reason); } });
    await expect(fetching).rejects.toBe(reason);
    expect(readFileSync(`${later}.partial`)).toEqual(BYTES.subarray(0, HALF));
    expect(existsSync(later)).toBe(false);

    const server = await serve("ranges");
    const file = scratch();
    const artifact = artifactAt(server.url);
    const hashing = new AbortController();
    const fetched = ensureArtifact(artifact, file, { signal: hashing.signal, progress: (bytes) => { if (bytes === BYTES.length) hashing.abort(reason); } });
    await expect(fetched).rejects.toBe(reason);
    expect(readFileSync(`${file}.partial`)).toEqual(BYTES);
    expect(existsSync(file)).toBe(false);
    await ensureArtifact(artifact, file);
    expect(readFileSync(file)).toEqual(BYTES);
    expect(server.asked).toEqual(["none"]);
  });

  it("one writer per file: a second fetch waits for the first and finds the file whole; a fetch and a removal wait for another process's writer, a fetch's wait ended by its signal", async () => {
    const server = await serve("ranges");
    const artifact = artifactAt(server.url);
    const file = scratch();
    await Promise.all([ensureArtifact(artifact, file), ensureArtifact(artifact, file)]);
    expect(readFileSync(file)).toEqual(BYTES);
    expect(server.asked).toEqual(["none"]);
    expect([existsSync(`${file}.partial`), existsSync(`${file}.lock`)]).toEqual([false, false]);

    const held = scratch();
    mkdirSync(join(held, ".."), { recursive: true });
    const other = tryLock(`${held}.lock`)!;
    const stop = new AbortController();
    const stopped = ensureArtifact(artifact, held, { signal: stop.signal });
    const waiting = ensureArtifact(artifact, held);
    stop.abort(new Error("the runner is stopping"));
    await expect(stopped).rejects.toThrow("the runner is stopping");
    writeFileSync(held, BYTES);
    rmSync(`${held}.lock`);
    other.release();
    await waiting;
    expect(server.asked).toEqual(["none"]);
    const writer = tryLock(`${held}.lock`)!;
    let removed = false;
    const removing = removeArtifact(held).then(() => { removed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect([removed, existsSync(held)]).toEqual([false, true]);
    rmSync(`${held}.lock`);
    writer.release();
    await removing;
    expect([existsSync(held), existsSync(`${held}.lock`)]).toEqual([false, false]);
    report.one_writer = { asked: server.asked };
  });

  it("a disk with no room is full; a disk that refuses otherwise is disk", async () => {
    const server = await serve("ranges");
    const artifact = artifactAt(server.url);
    const blocked = scratch();
    mkdirSync(`${blocked}.partial`, { recursive: true });
    const refused: Record<string, unknown> = { blocked: await refusal(ensureArtifact(artifact, blocked)) };
    if (existsSync("/dev/full")) {
      const full = scratch();
      mkdirSync(join(full, ".."), { recursive: true });
      symlinkSync("/dev/full", `${full}.partial`);
      refused.full = await refusal(ensureArtifact(artifact, full));
    }
    expect(refused).toEqual({ blocked: { reason: "disk" }, ...(existsSync("/dev/full") ? { full: { reason: "full" } } : {}) });
    report.disk = refused;
  });

  it("a document is read whole under its cap; over the cap or missing it is refused, cut short or silent past its deadline it is offline", async () => {
    const server = await serve("ignore");
    const read = (most_bytes: number, deadline_ms = 30_000) => fetchDocument(server.url, { accept: "application/synthetic+json", most_bytes, deadline_ms });
    expect(await read(BYTES.length)).toEqual(BYTES);
    const outcomes: Record<string, unknown> = { over: await refusal(read(BYTES.length - 1).then(() => undefined)) };
    for (const mode of ["missing", "half", "stall", "redirect-http"] as const) {
      server.mode = mode;
      outcomes[mode] = await refusal(read(BYTES.length, mode === "stall" ? 100 : 30_000).then(() => undefined));
    }
    expect(outcomes).toEqual({ over: { reason: "refused" }, missing: { reason: "refused", status: 404 }, half: { reason: "offline" }, stall: { reason: "offline" }, "redirect-http": { reason: "refused" } });
  });

  it("every request asks for the bytes as they are, never compressed", async () => {
    const server = await serve("half");
    const file = scratch();
    expect(await refusal(ensureArtifact(artifactAt(server.url), file))).toEqual({ reason: "offline" });
    server.mode = "ranges";
    await ensureArtifact(artifactAt(server.url), file);
    expect(server.asked).toEqual(["none", `bytes=${HALF}-`]);
    expect(server.encodings.map((each) => [...new Set(each.split(/,\s*/u))])).toEqual([["identity"], ["identity"]]);
  });
});
