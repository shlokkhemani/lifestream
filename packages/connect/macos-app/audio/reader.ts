import { basicInstant, each, instantMs, instantOf, isObject, parseLine, refuse, span, unitOf, utf8, type Guard, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const MIC_RECORDING = "mic-recording";
export const SOUND_RECORDING = "sound-recording";

const STEM = /^(\d{8}T\d{6}\.\d{3}Z)\.(mic|sound)(?:-([1-9]\d*))?$/u;
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ENDINGS = new Set(["holders_gone", "part_limit", "recorder_stopped", "stopped", "withheld", "setting_off", "device_changed", "failed", "interrupted"]);
const REQUIRED = ["type", "until", "track", "detected_at", "part", "ended_by", "room", "camera", "audio"];
const OPTIONAL = ["latency_ms", "device", "session", "loudness"];
const AUDIO = ["bit_rate", "bytes", "channels", "codec", "duration_ms", "file", "media_type", "sample_rate", "sha256"];

function recording(track: "mic" | "sound"): Guard {
  return (content) => {
    if (!isObject(content)) return ["content must be an object"];
    const problems: string[] = [];
    for (const member of REQUIRED) if (!(member in content)) problems.push(`${member} is missing`);
    for (const member of Object.keys(content)) {
      if (!REQUIRED.includes(member) && !OPTIONAL.includes(member)) problems.push(`${member} is not a sidecar member`);
    }
    if (content.type !== "audio.recording") problems.push("type must be audio.recording");
    if (content.track !== track) problems.push(`track must be ${track}`);
    for (const member of ["until", "detected_at"]) if (!utcMs(content[member])) problems.push(`${member} must be an RFC 3339 UTC instant with milliseconds`);
    if (content.latency_ms !== undefined && !whole(content.latency_ms, 0)) problems.push("latency_ms must be a non-negative integer");
    if (!whole(content.part, 1)) problems.push("part must be a positive integer");
    if (typeof content.ended_by !== "string" || !ENDINGS.has(content.ended_by)) problems.push(`ended_by ${JSON.stringify(content.ended_by ?? null)} is outside the closed list`);
    const device = content.device;
    if (track === "sound") {
      if (device !== undefined) problems.push("a sound recording states no device");
    } else if (!isObject(device) || !exact(device, ["uid", "transport", "chosen"], ["name"]) || typeof device.uid !== "string" || device.uid === "" ||
      typeof device.transport !== "string" || (device.chosen !== "holder" && device.chosen !== "default") ||
      (device.name !== undefined && typeof device.name !== "string")) {
      problems.push("device must state uid, transport, chosen (holder or default) and an optional name");
    }
    const room = content.room;
    if (!Array.isArray(room) || room.length === 0) problems.push("room must be a non-empty array");
    else {
      for (const [index, entry] of room.entries()) {
        if (!isObject(entry) || !exact(entry, ["at", "holders", "players"], ["output", "input"]) || !utcMs(entry.at) ||
          !apps(entry.holders) || (entry.holders as unknown[]).length === 0 || !apps(entry.players) ||
          !level(entry.output) || !level(entry.input)) {
          problems.push(`room[${index}] must state at, holders, players and the optional output and input levels`);
        }
      }
    }
    if (!Array.isArray(content.camera)) problems.push("camera must be an array");
    else {
      for (const [index, entry] of content.camera.entries()) {
        if (!isObject(entry) || !exact(entry, ["at", "until", "device"], []) || !utcMs(entry.at) || !utcMs(entry.until) ||
          instantMs(entry.until as string)! <= instantMs(entry.at as string)! || typeof entry.device !== "string") {
          problems.push(`camera[${index}] must state at, a later until and device`);
        }
      }
    }
    const audio = content.audio;
    if (!isObject(audio) || !exact(audio, AUDIO, [])) problems.push("audio members must be exactly bit_rate, bytes, channels, codec, duration_ms, file, media_type, sample_rate, sha256");
    else {
      if (typeof audio.file !== "string" || !audio.file.endsWith(".m4a") || audio.file.includes("/")) problems.push("audio file must name an .m4a beside the sidecar");
      if (audio.media_type !== "audio/mp4") problems.push("audio media_type must be audio/mp4");
      if (typeof audio.codec !== "string") problems.push("audio codec must be a string");
      for (const member of ["sample_rate", "channels", "bit_rate"]) if (!whole(audio[member], 1)) problems.push(`audio ${member} must be a positive integer`);
      for (const member of ["duration_ms", "bytes"]) if (!whole(audio[member], 0)) problems.push(`audio ${member} must be a non-negative integer`);
      if (typeof audio.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(audio.sha256)) problems.push("audio sha256 must be 64 lowercase hex digits");
    }
    if (content.session !== undefined) {
      const stem = typeof content.session === "string" ? STEM.exec(content.session) : null;
      if (stem === null || stem[2] !== track) problems.push("session must be the stem of a recording of the same track");
    }
    const loudness = content.loudness;
    if (loudness !== undefined) {
      if (!isObject(loudness) || !exact(loudness, ["every_ms", "rms_dbfs", "peak_dbfs"], []) || !whole(loudness.every_ms, 1) ||
        !dbfs(loudness.rms_dbfs) || !dbfs(loudness.peak_dbfs) || (loudness.rms_dbfs as unknown[]).length !== (loudness.peak_dbfs as unknown[]).length) {
        problems.push("loudness must state every_ms and equal lists rms_dbfs and peak_dbfs of whole dBFS from -96 to 0");
      }
    }
    return problems;
  };
}

export const audioRecordings: Reader = {
  name: "audio-recording",
  kinds: { [MIC_RECORDING]: recording("mic"), [SOUND_RECORDING]: recording("sound") },
  async *read(delivery, files) {
    const device = unitOf(delivery.source);
    const byPath = new Map(delivery.files.map((file) => [file.path, file]));
    const sidecars = delivery.files
      .map((file) => ({ file, stem: STEM.exec(file.path.endsWith(".json") ? file.path.slice(0, -5) : "") }))
      .filter((entry): entry is { file: typeof entry.file; stem: RegExpExecArray } => entry.stem !== null)
      .sort((a, b) => (a.stem[0] < b.stem[0] ? -1 : a.stem[0] > b.stem[0] ? 1 : 0));
    yield* each(sidecars, ({ file }) => file.path, ({ file, stem }): ReaderOutput[] => {
      const locator = file.path;
      const value = parseLine(utf8(files.bytes(file.blob), locator), locator);
      const { at, ...rest } = value;
      if (typeof at !== "string" || !UTC_MS.test(at)) refuse(`${locator} at must be an RFC 3339 UTC instant with milliseconds`);
      const start = instantOf(at, "rfc3339", locator);
      const audio = rest.audio;
      const named = isObject(audio) && typeof audio.file === "string" ? byPath.get(audio.file) : undefined;
      if (named === undefined) refuse(`${locator} names audio the delivery does not carry`);
      if (!isObject(audio) || named.blob !== `sha256:${String(audio.sha256)}` || named.size !== audio.bytes) {
        refuse(`${named.path} is not the audio ${locator} states: its hash or size differs`);
      }
      const until = rest.until;
      const end = typeof until === "string" && UTC_MS.test(until) ? instantOf(until, "rfc3339", locator) : undefined;
      const rank = stem[3] === undefined ? 0 : Number(stem[3]) - 1;
      const base = basicInstant(start.start_ms);
      const content: JsonObject = { type: "audio.recording", ...rest };
      return [{
        kind: stem[2] === "mic" ? MIC_RECORDING : SOUND_RECORDING,
        key: rank === 0 ? base : `${base}:${rank}`,
        content,
        time: end !== undefined && end.start_ms > start.start_ms ? span(start, end) : start,
        blobs: audioBlobs(content),
        device,
        locator,
      }];
    });
  },
};

export function audioBlobs(content: Json): string[] {
  const audio = isObject(content) ? content.audio : undefined;
  return isObject(audio) && typeof audio.sha256 === "string" ? [`sha256:${audio.sha256}`] : [];
}

function utcMs(value: unknown): boolean {
  return typeof value === "string" && UTC_MS.test(value) && instantMs(value) !== undefined;
}

function whole(value: unknown, least: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= least;
}

function exact(value: JsonObject, required: string[], optional: string[]): boolean {
  return required.every((member) => member in value) && Object.keys(value).every((member) => required.includes(member) || optional.includes(member));
}

function apps(value: unknown): boolean {
  return Array.isArray(value) && value.every((app) => typeof app === "string" && app.length > 0);
}

function level(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value) || !exact(value, [], ["device", "volume", "muted"])) return false;
  const device = value.device;
  if (device !== undefined && (!isObject(device) || !exact(device, ["uid", "transport"], ["name"]) || typeof device.uid !== "string" ||
    typeof device.transport !== "string" || (device.name !== undefined && typeof device.name !== "string"))) return false;
  if (value.volume !== undefined && !(typeof value.volume === "number" && value.volume >= 0 && value.volume <= 1)) return false;
  return value.muted === undefined || typeof value.muted === "boolean";
}

function dbfs(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isInteger(item) && item >= -96 && item <= 0);
}
