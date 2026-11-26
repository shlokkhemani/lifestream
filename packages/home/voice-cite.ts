import type { ExtractRow, RecordRef } from "@lifestreamprotocol/core";
import { CALLAUDIO_FAMILY, MESSAGES_FAMILY, partAudioOf, recordingAudioOf, VOICE_FAMILY, voiceNoteOf, type ChatDay } from "@lifestreamprotocol/families";
import { makeRef } from "./refs.js";
import type { Voice } from "./search-contract.js";

interface Heard {
  blob: string;
  seconds?: number;
  mine: boolean;
  from_s?: number;
}

export interface Cited {
  record: RecordRef;
  item: string | null;
  at_ms: number | null;
}

const HEARD = new Map<string, (extract: ExtractRow, cited: Cited) => Heard | undefined>([
  [MESSAGES_FAMILY, (extract, { record }) => {
    const message = (extract.content as unknown as ChatDay).messages.find((each) => each.source === record.source && each.key === record.key);
    const note = message === undefined ? null : voiceNoteOf(message);
    return note === null ? undefined : { ...note, mine: message!.from.kind === "me" };
  }],
  [VOICE_FAMILY, (extract) => {
    const audio = recordingAudioOf(extract);
    return audio === null ? undefined : { ...audio, mine: true };
  }],
  [CALLAUDIO_FAMILY, (extract, { item, at_ms }) => partAudioOf(extract, item, at_ms) ?? undefined],
]);

export function voiced(family: string): boolean {
  return HEARD.has(family);
}

export function voiceOf(extract: ExtractRow, cited: Cited, speaker: () => string | undefined): Voice | undefined {
  const heard = HEARD.get(extract.family)?.(extract, cited);
  if (heard === undefined) return undefined;
  const from = heard.mine ? undefined : speaker();
  return {
    audio: heard.blob, record: makeRef("record", cited.record),
    ...(heard.seconds === undefined ? {} : { seconds: heard.seconds }),
    ...(heard.from_s === undefined || heard.from_s === 0 ? {} : { from_s: heard.from_s }),
    ...(heard.mine ? { mine: true as const } : {}), ...(from === undefined ? {} : { from }),
  };
}
