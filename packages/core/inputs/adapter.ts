import type { Instant, Json } from "../types.js";
import type { AiAdapter } from "./ai.js";
import type { CalendarAdapter } from "./calendar.js";
import type { CallAudioAdapter } from "./callaudio.js";
import type { CallsAdapter } from "./calls.js";
import type { HealthAdapter } from "./health.js";
import type { LabelsAdapter } from "./labels.js";
import type { LineAdapter } from "./line.js";
import type { ListeningAdapter } from "./listening.js";
import type { MailAdapter } from "./mail.js";
import type { MessagesAdapter } from "./messages.js";
import type { MoneyAdapter } from "./money.js";
import type { NotesAdapter } from "./notes.js";
import type { PhoneAdapter } from "./phone.js";
import type { PhotosAdapter } from "./photos.js";
import type { Witness } from "./physical.js";
import type { ScreenAdapter } from "./screen.js";
import type { VoiceAdapter } from "./voice.js";
import type { WebAdapter } from "./web.js";

/** What every adapter declares, whichever family it feeds. */
export interface Adapter {
  /** The adapter's version, whose change makes the home read the family's records again through it. */
  version: string;
  /** The kinds of its connector's records it reads. */
  kinds: readonly string[];
}

export interface Registered<A extends Adapter = Adapter> {
  readonly product: string;
  readonly adapter: A;
}

/** What an adapter reads of the source a record came from. */
export interface AdapterSource {
  /** The source's id, `<product>:<account>:<copy>`. */
  readonly id: string;
  /** The connector that reads the source. */
  readonly connector: string;
  /** The product the source's id names first. */
  readonly product: string;
  /** The account the source's id names second, `local` when it has none. */
  readonly account: string;
  /** The copy the source's id names last: a device unit, `cloud` or `export`. */
  readonly copy: string;
}

/** What an adapter reads of one version of a record. */
export interface AdapterVersion {
  /** The record's kind. */
  readonly kind: string;
  /** The record's key within its source and kind. */
  readonly key: string;
  /** The record's content as its reader stated it. */
  readonly content: Json;
  /** When the record happened, where its reader stated a time. */
  readonly time?: Instant;
}

/** One record as an adapter is handed it. */
export interface InputRecord {
  /** The source the record came from. */
  source: AdapterSource;
  /** The version of the record being read. */
  version: AdapterVersion;
}

/** A connector's adapters, at most one for each family it feeds, by the family's name. */
export interface Adapters {
  /** How its records become chat lines, chats and the people in them. */
  messages?: MessagesAdapter;
  /** How its records become mail. */
  mail?: MailAdapter;
  /** How its records become conversations with an assistant or a coding agent's sessions. */
  ai?: AiAdapter;
  /** How its records become calls. */
  calls?: CallsAdapter;
  /** How its records become the two sides of calls the machine recorded. */
  callaudio?: CallAudioAdapter;
  /** How its records become events and reminders. */
  calendar?: CalendarAdapter;
  /** How its records become notes and meetings. */
  notes?: NotesAdapter;
  /** How its records become what the person listened to. */
  listening?: ListeningAdapter;
  /** How its records become the body's samples, sleeps, workouts and recoveries and a device's hours of use. */
  health?: HealthAdapter;
  /** How its records become bank statement lines. */
  money?: MoneyAdapter;
  /** How its records become photos. */
  photos?: PhotosAdapter;
  /** How its records become evidence of where the person was and how they moved, and check-ins. */
  physical?: Witness;
  /** How its records become a browser's pages, searches, downloads and tabs. */
  web?: WebAdapter;
  /** How its records become dictations and voice notes. */
  voice?: VoiceAdapter;
  /** How its records become the person's other devices' time in their apps. */
  phone?: PhoneAdapter;
  /** How its records serve as evidence of a machine's screen. */
  screen?: ScreenAdapter;
  /** How its records become address book cards. */
  labels?: LabelsAdapter;
  /** How its records that no other family reads become one plain line each. */
  line?: LineAdapter;
}
