import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { BODY_TOO_LARGE, NOT_NOW, Refusal, RETRY_SOON_S, waitBody } from "./refusal.js";

export async function* moving<T>(body: AsyncIterable<T>, silent_ms: number, letGo: () => void): AsyncGenerator<T> {
  let waiting = setTimeout(letGo, silent_ms);
  try {
    for await (const chunk of body) {
      clearTimeout(waiting);
      yield chunk;
      waiting = setTimeout(letGo, silent_ms);
    }
  } finally {
    clearTimeout(waiting);
  }
}

export class Silent extends Refusal {
  constructor(silent_ms: number) {
    super(503, NOT_NOW, `The request's body was silent ${Math.round(silent_ms / 1_000)} s: its connection was let go.`, RETRY_SOON_S, waitBody("busy"));
  }
}

class CutShort extends Refusal {
  constructor(limit: number) {
    super(413, BODY_TOO_LARGE, `the body passed ${limit} bytes`);
  }
}

const refusing = new WeakSet<Socket>();

export const refusedOn = (socket: Socket): boolean => refusing.has(socket);

export const LINGER_MS = 2_000;

export function refuseCut(request: IncomingMessage, response: ServerResponse, status: number, headers: Record<string, string>, text: string, lingerMs = LINGER_MS): void {
  response.writeHead(status, { ...headers, "content-length": String(Buffer.byteLength(text)), connection: "close" });
  response.write(text);
  const end = (): void => {
    clearTimeout(lingering);
    if (!response.writableEnded) response.end();
  };
  const lingering = setTimeout(end, lingerMs);
  request.once("end", end);
  response.once("close", () => clearTimeout(lingering));
  refusing.add(request.socket);
  request.resume();
}

export async function bodyOf(request: IncomingMessage, limit: number, silent_ms: number, landed?: (bytes: number) => void): Promise<Buffer> {
  const stated = Number(request.headers["content-length"]);
  if (Number.isFinite(stated) && stated > limit) {
    throw new Refusal(413, BODY_TOO_LARGE, `the body states ${stated} bytes; the door reads at most ${limit}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let silent = false;
  const body = request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
  try {
    for await (const chunk of moving(body, silent_ms, () => { silent = true; request.destroy(); })) {
      size += chunk.length;
      landed?.(size);
      if (size > limit) {
        request.pause();
        throw new CutShort(limit);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (silent) throw new Silent(silent_ms);
    throw error;
  }
  if (silent) throw new Silent(silent_ms);
  return Buffer.concat(chunks);
}
