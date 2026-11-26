import type { Adapter, InputRecord } from "./adapter.js";

/** Which side of a call a part recorded. */
export type CallTrack =
  /** The microphone: the person, and anyone in the room with them. */
  | "mic"
  /** What the machine played: the other side. */
  | "sound";

/** How loud a part was, one root-mean-square level for each interval of its audio from its start. */
export interface CallLoudness {
  /** How long each interval runs, in milliseconds. */
  every_ms: number;
  /** Each interval's root-mean-square level in whole dBFS, from -96 to 0, in order from the part's start. */
  rms_dbfs: readonly number[];
}

/** One output device the room played to from a moment of a part on, until the next or the part's end. */
export interface CallOutput {
  /** When the room was seen playing to it, in milliseconds since the epoch. */
  at_ms: number;
  /** The device's unique id, left out when the room stated no output device. */
  uid?: string;
  /** How the device is connected, such as `built_in` or `bluetooth`, left out when the room stated no output device. */
  transport?: string;
}

/** One recording file of one side of a call, at most ten minutes, as its sidecar stated it, with no threshold applied. */
export interface CallAudioPart {
  /** The side it recorded: `mic` the microphone, `sound` what the machine played. */
  track: CallTrack;
  /** When it began, in milliseconds since the epoch. */
  start_ms: number;
  /** When it ended, in milliseconds since the epoch. */
  end_ms: number;
  /** The SHA-256 of its audio file in lower-case hex, by which the home holds its bytes. */
  sha256: string;
  /** Its audio's media type. */
  media_type: string;
  /** How long its audio runs, in milliseconds. */
  ms: number;
  /** The recording session it belongs to, left out when its sidecar states none, which makes it a session of its own. */
  session?: string;
  /** Its place in its session, from 1. */
  part: number;
  /** Why it ended, as its sidecar states it. */
  ended_by: string;
  /** Every app that held the microphone while it recorded, each once, in the order first seen. */
  holders: readonly string[];
  /** Whether a camera was on while it recorded. */
  camera: boolean;
  /** How loud it was, or null for a part whose sidecar states no loudness, such as one sealed after a crash. */
  loudness: CallLoudness | null;
  /** The output devices the room played to while it recorded, in order. */
  outputs: readonly CallOutput[];
}

/** How a recorder's records become the two sides of calls. */
export interface CallAudioAdapter extends Adapter {
  /** One record read as its part, or null for one that states no readable recording. */
  part(record: InputRecord): CallAudioPart | null;
}
