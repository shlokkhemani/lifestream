import { instant, isObject, type Adapters, type Call, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import { canonicalJid } from "@lifestreamprotocol/core";

export const whatsappCalls: NonNullable<Adapters["calls"]> = {
  version: "2",
  kinds: ["call"],
  services: { "whatsapp-voice": "WhatsApp voice call", "whatsapp-video": "WhatsApp video call" },
  call: ({ version }) => readCall(version.content),
};

const ANSWERED_ELSEWHERE = 5;

function readCall(content: Json): Call | null {
  if (!isObject(content) || content.type !== "whatsapp.call" || !isObject(content.call) || !isObject(content.aggregate) || !Array.isArray(content.participants)) return null;
  const { call, aggregate } = content;
  if (typeof call.ZDATE !== "number") return null;
  let start_ms: number;
  try {
    start_ms = instant(call.ZDATE, "apple-s").start_ms;
  } catch {
    return null;
  }
  const seconds = typeof call.ZDURATION === "number" && call.ZDURATION > 0 ? call.ZDURATION : 0;
  const end = start_ms + Math.round(seconds * 1000);
  const direction = aggregate.ZINCOMING === 1 ? "incoming" : "outgoing";
  const group = text(call.ZGROUPJIDSTRING);
  const answeredElsewhere = direction === "incoming" && call.ZOUTCOME === ANSWERED_ELSEWHERE && aggregate.ZMISSED !== 1;
  return {
    service: aggregate.ZVIDEO === 1 ? "whatsapp-video" : "whatsapp-voice",
    direction,
    outcome: seconds > 0 || answeredElsewhere ? "connected" : direction === "incoming" && aggregate.ZMISSED === 1 ? "missed" : "not-connected",
    start_ms,
    end_ms: end > start_ms ? end : null,
    parties: [...new Set(content.participants.flatMap((value: Json) => {
      const jid = isObject(value) ? text((value as JsonObject).ZJIDSTRING) : null;
      return jid === null ? [] : [canonicalJid(jid) ?? jid];
    }))].sort(compare).map((id) => ({ id, kind: "jid" as const })),
    ...(group === null ? {} : { group: canonicalJid(group) ?? group }),
  };
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
