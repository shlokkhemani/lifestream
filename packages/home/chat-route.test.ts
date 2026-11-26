import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { chatRoute, MOVED_WORDS, type Reached } from "./chat-route.js";
import { Refusal } from "./refusal.js";

const MODEL = "address:local-model";
const HERE: Reached = { url: "http://127.0.0.1:11434/v1/chat/completions", headers: {}, effort: "reasoning_effort", model: "local-model", leaves: null };
const AWAY: Reached = { url: "http://192.0.2.7:11434/v1/chat/completions", headers: {}, effort: "reasoning_effort", model: "local-model", leaves: "192.0.2.7" };
const TURN = { model: MODEL, stream: true, messages: [{ role: "user", content: "a synthetic question" }] };

function address(at: { live: Reached; stored: string | null }) {
  const sent: string[] = [];
  let reached = 0;
  const route = chatRoute({
    clock: () => 0,
    reach: async () => {
      reached++;
      return at.live;
    },
    leavesOf: async () => at.stored,
    fetch: (async (url: string | URL) => {
      sent.push(String(url));
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  const response = { once: () => undefined, writeHead: () => undefined, write: () => true, end: () => undefined } as unknown as ServerResponse;
  const turn = () => route(TURN, {} as IncomingMessage, response, () => undefined);
  return { sent, turn, reaches: () => reached };
}

describe("Chat's relay sends a turn only where its hidden copy was made for", () => {
  it("an address moved off this Mac between the hide and the send: the turn hidden as staying is refused, asking again, and nothing is sent", async () => {
    const at = { live: AWAY, stored: null };
    const { sent, turn } = address(at);
    const refused = await turn().then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Refusal);
    expect([(refused as Refusal).status, (refused as Refusal).code, (refused as Refusal).words]).toEqual([409, "NOT_READY", MOVED_WORDS]);
    expect(sent).toEqual([]);
  });

  it("a reach kept from before the address moved is dropped and asked again, so the turn goes where it was hidden for", async () => {
    const at = { live: HERE, stored: null as string | null };
    const { sent, turn, reaches } = address(at);
    await turn();
    expect([sent, reaches()]).toEqual([[HERE.url], 1]);
    await turn();
    expect(reaches(), "the same place: the kept reach").toBe(1);
    Object.assign(at, { live: AWAY, stored: AWAY.leaves });
    await turn();
    expect([sent, reaches()]).toEqual([[HERE.url, HERE.url, AWAY.url], 2]);
  });
});
