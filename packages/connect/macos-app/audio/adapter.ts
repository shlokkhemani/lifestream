import { instantMs, isObject, type CallAudioAdapter, type CallAudioPart, type CallOutput, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import { MIC_RECORDING, SOUND_RECORDING } from "./reader.js";

export const audioCallAudio: CallAudioAdapter = {
  version: "1",
  kinds: [MIC_RECORDING, SOUND_RECORDING],
  part: ({ version }) => {
    const track = version.kind === MIC_RECORDING ? "mic" : version.kind === SOUND_RECORDING ? "sound" : null;
    const content = version.content;
    if (track === null || version.time === undefined || !isObject(content) || content.track !== track) return null;
    return partOf(track, version.time.start_ms, version.time.end_ms, content);
  },
};

function partOf(track: "mic" | "sound", start_ms: number, stated_end_ms: number | undefined, content: JsonObject): CallAudioPart | null {
  const audio = content.audio;
  if (!isObject(audio) || typeof audio.sha256 !== "string" || typeof audio.media_type !== "string" || typeof audio.duration_ms !== "number") return null;
  if (typeof content.part !== "number" || typeof content.ended_by !== "string") return null;
  const room = Array.isArray(content.room) ? content.room.filter(isObject) : [];
  const holders: string[] = [];
  for (const entry of room) {
    for (const holder of Array.isArray(entry.holders) ? entry.holders : []) {
      if (typeof holder === "string" && !holders.includes(holder)) holders.push(holder);
    }
  }
  const part: CallAudioPart = {
    track,
    start_ms,
    end_ms: stated_end_ms ?? start_ms + audio.duration_ms,
    sha256: audio.sha256,
    media_type: audio.media_type,
    ms: audio.duration_ms,
    part: content.part,
    ended_by: content.ended_by,
    holders,
    camera: Array.isArray(content.camera) && content.camera.length > 0,
    loudness: loudnessOf(content.loudness),
    outputs: room.flatMap((entry) => outputOf(entry)),
  };
  return typeof content.session === "string" ? { ...part, session: content.session } : part;
}

function loudnessOf(value: unknown): CallAudioPart["loudness"] {
  if (!isObject(value) || typeof value.every_ms !== "number" || !Array.isArray(value.rms_dbfs)) return null;
  return { every_ms: value.every_ms, rms_dbfs: value.rms_dbfs.filter((level): level is number => typeof level === "number") };
}

function outputOf(entry: JsonObject): CallOutput[] {
  const at_ms = typeof entry.at === "string" ? instantMs(entry.at) : undefined;
  if (at_ms === undefined) return [];
  const device = isObject(entry.output) ? entry.output.device : undefined;
  if (!isObject(device) || typeof device.uid !== "string" || typeof device.transport !== "string") return [{ at_ms }];
  return [{ at_ms, uid: device.uid, transport: device.transport }];
}
