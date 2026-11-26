import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { open, rename, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { flushed, tryLock, type FileLock } from "@lifestreamprotocol/core";


export interface Artifact {
  url: string;
  bytes: number;
  sha256: string;
}

export class ArtifactError extends Error {
  override name = "ArtifactError";
  constructor(readonly reason: "offline" | "refused" | "hash" | "full" | "disk", message: string, readonly status?: number, options?: { cause?: unknown }) {
    super(message, options);
  }
}

interface EnsureOptions {
  signal?: AbortSignal;
  progress?: (bytes: number) => void;
}

const REDIRECTS = 5;
const HELD_MS = 250;

export async function removeArtifact(file: string, signal?: AbortSignal): Promise<void> {
  if (!existsSync(dirname(file))) return;
  await oneWriter(`${file}.lock`, signal, async () => disk(() => {
    rmSync(file, { force: true });
    rmSync(partialOf(file), { force: true });
  }));
}

export async function ensureArtifact(artifact: Artifact, file: string, options: EnsureOptions = {}): Promise<void> {
  const url = allowed(artifact.url);
  options.signal?.throwIfAborted();
  disk(() => mkdirSync(dirname(file), { recursive: true }));
  await oneWriter(`${file}.lock`, options.signal, () => fetchInto(url, artifact, file, options));
}

async function fetchInto(url: URL, artifact: Artifact, file: string, { signal, progress }: EnsureOptions): Promise<void> {
  if (await holdsArtifact(artifact, file, signal)) return;
  const partial = partialOf(file);
  let have = sizeOf(partial);
  if (have > artifact.bytes) {
    disk(() => rmSync(partial, { force: true }));
    have = 0;
  }
  if (have === artifact.bytes) {
    if (await sha256Of(partial, signal) === artifact.sha256) {
      await disk(() => flushed(partial));
      return publish(partial, file);
    }
    disk(() => rmSync(partial, { force: true }));
    have = 0;
  }
  have = Math.max(have, 0);
  let response = await request(url, have, signal);
  if (have > 0 && !(response.status === 206 && (response.headers.get("content-range") ?? "").startsWith(`bytes ${have}-`))) {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      response = await request(url, 0, signal);
    }
    have = 0;
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new ArtifactError("refused", `${artifact.url} answered HTTP ${response.status}`, response.status);
  }
  const handle = await disk(() => open(partial, have > 0 ? "a" : "w"));
  let landed = have;
  try {
    await readBody(response, signal, () => `${artifact.url} ended after ${landed} of ${artifact.bytes} bytes`, async (chunk) => {
      if (landed + chunk.byteLength > artifact.bytes) {
        await handle.close();
        disk(() => rmSync(partial, { force: true }));
        throw new ArtifactError("hash", `${artifact.url} sent more than its ${artifact.bytes} bytes`);
      }
      await write(handle, chunk);
      landed += chunk.byteLength;
      progress?.(landed);
    });
    await disk(() => handle.sync());
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (landed < artifact.bytes) throw new ArtifactError("offline", `${artifact.url} ended after ${landed} of ${artifact.bytes} bytes`);
  if (await sha256Of(partial, signal) !== artifact.sha256) {
    disk(() => rmSync(partial, { force: true }));
    throw new ArtifactError("hash", `${artifact.url} is not the artifact published: its SHA-256 differs`);
  }
  await publish(partial, file);
}

export async function fetchDocument(address: string, options: { readonly accept: string; readonly most_bytes: number; readonly deadline_ms: number; readonly signal?: AbortSignal }): Promise<Buffer> {
  const deadline = AbortSignal.timeout(options.deadline_ms);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  const chunks: Uint8Array[] = [];
  let landed = 0;
  try {
    const response = await request(allowed(address), 0, signal, options.accept);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new ArtifactError("refused", `${address} answered HTTP ${response.status}`, response.status);
    }
    await readBody(response, signal, () => `${address} ended after ${landed} bytes`, (chunk) => {
      landed += chunk.byteLength;
      if (landed > options.most_bytes) throw new ArtifactError("refused", `${address} sent more than ${options.most_bytes} bytes`);
      chunks.push(chunk);
    });
  } catch (error) {
    if (options.signal?.aborted !== true && deadline.aborted) throw new ArtifactError("offline", `${address} did not answer whole within ${options.deadline_ms} ms`, undefined, { cause: error });
    throw error;
  }
  return Buffer.concat(chunks);
}

async function readBody(response: Response, signal: AbortSignal | undefined, ended: () => string, take: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
  if (response.body === null) throw new ArtifactError("offline", `${ended()}: no body`);
  const reader = response.body.getReader();
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await stoppable(reader.read(), signal);
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      if (signal?.aborted) throw signal.reason;
      throw new ArtifactError("offline", `${ended()}: ${causeText(error)}`, undefined, { cause: error });
    }
    if (chunk.done) return;
    try {
      await take(chunk.value);
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }
}

export async function oneWriter<T>(lock: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  let held: FileLock | null = null;
  while (held === null) {
    signal?.throwIfAborted();
    const before = inodeOf(lock);
    const taken = disk(() => tryLock(lock));
    if (taken === null) await pause(HELD_MS, signal);
    else if (before !== null && inodeOf(lock) === before) held = taken;
    else taken.release();
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
    held.release();
  }
}

function inodeOf(file: string): number | null {
  try {
    return statSync(file).ino;
  } catch {
    return null;
  }
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

export async function holdsArtifact(artifact: Artifact, file: string, signal?: AbortSignal): Promise<boolean> {
  if (sizeOf(file) !== artifact.bytes) return false;
  return await sha256Of(file, signal) === artifact.sha256;
}

function partialOf(file: string): string {
  return `${file}.partial`;
}

function stoppable<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return read;
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function publish(partial: string, file: string): Promise<void> {
  await disk(async () => {
    await rename(partial, file);
    await flushed(dirname(file));
  });
}

async function request(url: URL, from: number, signal: AbortSignal | undefined, accept?: string): Promise<Response> {
  let at = url;
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetch(at, { redirect: "manual", headers: { "accept-encoding": "identity", ...from > 0 ? { range: `bytes=${from}-` } : {}, ...accept === undefined ? {} : { accept } }, ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new ArtifactError("offline", `${url.href} could not be reached: ${causeText(error)}`, undefined, { cause: error });
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, at);
    if (next.protocol !== "https:") throw new ArtifactError("refused", `${url.href} redirects to ${next.protocol} ${next.host}: a redirect is followed only to https`);
    if (hop >= REDIRECTS) throw new ArtifactError("refused", `${url.href} redirects more than ${REDIRECTS} times`);
    at = next;
  }
}

function allowed(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ArtifactError("refused", `${address} is not an address`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url;
  throw new ArtifactError("refused", `${address} is neither https nor loopback: no fetch is made`);
}

async function write(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.byteLength;) {
    const { bytesWritten } = await disk(() => handle.write(bytes, at, bytes.byteLength - at));
    at += bytesWritten;
  }
}

async function sha256Of(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file, signal === undefined ? {} : { signal })) hash.update(chunk as Buffer);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new ArtifactError("disk", `${file} could not be read: ${causeText(error)}`, undefined, { cause: error });
  }
  return hash.digest("hex");
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return -1;
    throw new ArtifactError("disk", `${file} could not be read: ${causeText(error)}`, undefined, { cause: error });
  }
}

function disk<T>(step: () => T): T {
  try {
    const result = step();
    return result instanceof Promise ? result.catch((error: unknown) => { throw diskError(error); }) as T : result;
  } catch (error) {
    throw diskError(error);
  }
}

function diskError(error: unknown): unknown {
  if (error instanceof ArtifactError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return new ArtifactError(code === "ENOSPC" || code === "EDQUOT" ? "full" : "disk", `the disk refused: ${causeText(error)}`, undefined, { cause: error });
}

function causeText(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return cause instanceof Error ? cause.message : String(cause);
}
