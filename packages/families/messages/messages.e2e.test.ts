import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  accountOf, addDays, digest, openHome, openHomeFolder, profileFault, type Ask, type BlobReader, type DaySettings, type EnrichmentRow, type ExtractRow, type Guard, type HomeDb, type Json, type OpenView, type ReaderOutput, type Reply, type Version,
} from "@lifestreamprotocol/core";
import { renderDay, type DayDocument, type DayReader, type LabelUnits, tableUnits } from "../days.js";
import type { Change } from "../family.js";
import { nameId, type Party } from "../shared/cast.js";
import { LABELS_CODE, readLabels, resolvedChat, resolvedName } from "../shared/labels.js";
import {
  CAPTION_PROMPT, MESSAGES_FAMILY, MESSAGES_PROMPTS, messagesFamily, parseMessagesUnit, QUIET_TITLE, TRANSCRIPT_PROMPT, transcriptIdentity,
} from "./family.js";
import { isGroupChat, networksOf } from "./networks.js";
import { FED, NETWORKED } from "../test/fed.js";
import { EVERY_DAY, quiet, type Span } from "./groups.js";
import { readMessage } from "./read.js";
import { chatDayPart, peopleOf, type GroupSettings, type PeopleAnswer, type PersonDetail, type StatedDetails } from "./people.js";
import { ownHandles } from "../shared/labels.js";
import { cardParts, readCard, type Card, type RecordState } from "../shared/people.js";
import type { MailDayPart } from "./people.js";
import { SYNTHETIC_VENDOR, inputHash, recordTexts, replyOf, worked } from "../test/drive.js";
import { pin } from "../test/pin.js";
import { conforming } from "../test/units.js";

const GOLDEN = new URL("./test/messages.golden.json", import.meta.url);
const LEDGER = new URL("./test/ledger-reuse.golden.json", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const GROUP_RULES: Readonly<Record<string, GroupSettings>> = {
  whatsapp: { archived: true, after_days: 90, talk: "joined" },
  imessage: { archived: false, after_days: 90, talk: "joined" },
};
const messages = messagesFamily({ books: FED.labels })(FED.messages);
const NETWORKS = networksOf(FED.messages);
const APPLE_EPOCH_S = 978_307_200;
const HOUR = 3_600_000;


const WA_MAC = "whatsapp:15550000000:macbook-pro-0001";
const WA_PHONE = "whatsapp:15550000000:iphone-aa01";
const IM_MAC = "imessage:person-me@example.com:macbook-pro-0001";
const IM_PHONE = "imessage:person-me@example.com:iphone-aa01";
const CONTACTS = "apple-contacts:person-a@example.com:iphone-aa01";
const FACES = "faces:local:macbook-pro-0001";
const PEOPLE_HOME = "people:local:mac-mini-bb03";
const SOURCES = [WA_MAC, WA_PHONE, IM_MAC, IM_PHONE, CONTACTS, FACES, PEOPLE_HOME];

const B = "15550000002@s.whatsapp.net";
const A_PHONE = "15550000001@s.whatsapp.net";
const A_LID = "900000000001@lid";
const C = "15550000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const blob = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const IMG1 = blob(0x11);
const IMG2 = blob(0x12);
const IMG3 = blob(0x13);
const VOICE1 = blob(0x21);
const VOICE2 = blob(0x22);
const VOICE3 = blob(0x23);
const VOICE4 = blob(0x24);
const THUMB = blob(0x31);
const T1 = Date.parse("2026-10-02T20:00:00Z");
const T2 = T1 + HOUR;
const T3 = T2 + HOUR;
const at = (clock: string) => Date.parse(`2026-10-02T${clock}:00Z`);

interface WaMessage {
  chat: string;
  stanza: string;
  at: number;
  fromMe?: boolean;
  from?: string;
  member?: string;
  text?: string | null;
  type?: number;
  event?: number;
  parent?: string;
  flags?: number;
  status?: number;
  file?: string;
  media?: Record<string, Json>;
  session?: string;
}

const MEDIA_COLUMNS = ["ZFILESIZE", "ZMEDIAORIGIN", "ZMOVIEDURATION", "ZASPECTRATIO", "ZHACCURACY", "ZLATITUDE", "ZLONGITUDE",
  "ZMEDIAURLDATE", "ZAUTHORNAME", "ZCOLLECTIONNAME", "ZMEDIAURL", "ZTITLE", "ZVCARDNAME", "ZVCARDSTRING", "ZMEDIAKEY"];

function wa(message: WaMessage): ReaderOutput {
  const date = message.at / 1000 - APPLE_EPOCH_S;
  const media = message.media === undefined && message.file === undefined ? null
    : Object.fromEntries(MEDIA_COLUMNS.map((column) => [column, message.media?.[column] ?? null]));
  const content = {
    type: "whatsapp.msg",
    message: {
      ZSTANZAID: message.stanza, ZTEXT: message.text ?? null, ZFROMJID: message.fromMe === true ? null : message.from ?? message.chat,
      ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date, ZMESSAGETYPE: message.type ?? 0,
      ZGROUPEVENTTYPE: message.event ?? null, ZFLAGS: message.flags ?? 0, ZMESSAGESTATUS: message.status ?? 1,
      ZMESSAGEERRORSTATUS: 0, ZISFROMME: message.fromMe === true ? 1 : 0, ZSTARRED: 0, ZMEDIASECTIONID: null, ZPHASH: null,
      ZENCRETRYCOUNT: 0, ZFILTEREDRECIPIENTCOUNT: 0, ZCHILDMESSAGESDELIVEREDCOUNT: 0, ZCHILDMESSAGESPLAYEDCOUNT: 0,
      ZCHILDMESSAGESREADCOUNT: 0, ZDATAITEMVERSION: 1,
    },
    session_jid: message.session ?? message.chat,
    parent_stanza_id: message.parent ?? null,
    media_item: media,
    group_member_jid: message.member ?? null,
    blobs: message.file === undefined ? [] : [{ hash: message.file, bytes: 1000, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
  };
  return {
    kind: "msg", key: `${message.chat}:${message.stanza}`, content: content as Json,
    time: { start_ms: message.at, precision: "ms" }, ...(message.file === undefined ? {} : { blobs: [message.file] }),
  };
}

function waChat(key: string, facts: { jid?: string | null; identifier?: string | null; partner: string | null; group?: boolean }): ReaderOutput {
  const chat = Object.fromEntries(["ZCONTACTJID", "ZCONTACTIDENTIFIER", "ZPARTNERNAME", "ZSESSIONTYPE", "ZFLAGS", "ZARCHIVED", "ZHIDDEN",
    "ZREMOVED", "ZMESSAGECOUNTER", "ZUNREADCOUNT", "ZIDENTITYVERIFICATIONSTATE", "ZIDENTITYVERIFICATIONEPOCH", "ZLASTMESSAGEDATE",
    "ZLASTMESSAGETEXT", "ZLOCATIONSHARINGENDDATE", "ZETAG", "ZSAVEDINPUT"].map((column) => [column, 0])) as Record<string, Json>;
  Object.assign(chat, { ZCONTACTJID: facts.jid ?? key, ZCONTACTIDENTIFIER: facts.identifier ?? null, ZPARTNERNAME: facts.partner,
    ZLASTMESSAGETEXT: "synthetic", ZETAG: null, ZSAVEDINPUT: null, ZSESSIONTYPE: facts.group === true ? 1 : 0 });
  const group_info = facts.group === true
    ? { ZSTATE: 0, ZCREATIONDATE: 800000000, ZSUBJECTTIMESTAMP: 800000000, ZCREATORJID: C, ZOWNERJID: C, ZSUBJECTOWNERJID: C, ZSOURCEJID: null, ZPICTUREID: "p1" }
    : null;
  return { kind: "chat", key, content: { type: "whatsapp.chat", chat, group_info } };
}

const pushname = (jid: string, name: string): ReaderOutput => ({ kind: "pushname", key: jid, content: { type: "whatsapp.pushname", ZJID: jid, ZPUSHNAME: name } });

interface ImMessage {
  guid: string;
  at: number;
  fromMe?: boolean;
  sender?: [string, "phone" | "email" | "raw"];
  recipients: [string, "phone" | "email" | "raw"][];
  text?: string | null;
  body?: string;
  associated?: [number, string];
  edited?: boolean;
  retracted?: boolean;
  attachments?: { hash: string | null; mime: string | null; name: string | null }[];
}

function im(message: ImMessage): ReaderOutput {
  const handle = ([value, kind]: [string, string]) => ({ raw: value, canonical: value, kind });
  const nanos = (BigInt(message.at) - BigInt(APPLE_EPOCH_S) * 1000n) * 1_000_000n;
  const content = {
    type: "imessage.msg", guid: message.guid,
    sender: message.fromMe === true || message.sender === undefined ? null : handle(message.sender),
    recipients: message.recipients.map(handle),
    text: message.text ?? null,
    attributedBody: message.body === undefined ? null : { $bytes64: Buffer.from(attributedBody(message.body)).toString("base64") },
    date: nanos.toString(), service: "iMessage",
    flags: { is_from_me: message.fromMe === true ? 1 : 0, is_delivered: 1, is_sent: message.fromMe === true ? 1 : 0, was_delivered_quietly: 0, did_notify_recipient: 0 },
    associated_message_type: message.associated?.[0] ?? 0, associated_message_guid: message.associated?.[1] ?? null,
    message_summary_info: null,
    date_edited: message.edited === true ? (nanos + 60_000_000_000n).toString() : 0,
    date_retracted: message.retracted === true ? (nanos + 60_000_000_000n).toString() : 0,
    attachments: (message.attachments ?? []).map((file) => ({ hash: file.hash, bytes: file.hash === null ? null : 2000, mime_type: file.mime, transfer_name: file.name })),
  };
  const files = (message.attachments ?? []).flatMap((file) => file.hash === null ? [] : [file.hash]);
  return { kind: "msg", key: message.guid, content: content as Json, time: { start_ms: message.at, precision: "ms" }, ...(files.length === 0 ? {} : { blobs: files }) };
}

function attributedBody(text: string): Uint8Array {
  const NEW = 0x84;
  const NIL = 0x85;
  const END = 0x86;
  const encode = (value: string) => [...new TextEncoder().encode(value)];
  const unshared = (bytes: number[]) => [bytes.length, ...bytes];
  const shared = (value: string) => [NEW, ...unshared(encode(value))];
  const classes = (chain: [string, number][]) => [...chain.flatMap(([name, version]) => [NEW, ...shared(name), version]), NIL];
  return Uint8Array.from([
    4, 11, ...encode("streamtyped"), 0x81, 0xe8, 0x03,
    ...shared("@"), NEW, ...classes([["NSMutableAttributedString", 0], ["NSObject", 0]]),
    0x92, NEW, ...classes([["NSMutableString", 1], ["NSString", 1], ["NSObject", 0]]),
    ...shared("+"), ...unshared(encode(text)), END, END,
  ]);
}

const card = (key: string, name: string, lines: string[]): ReaderOutput =>
  ({ kind: "contact", key, content: { card: ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`, ...lines, "END:VCARD"].join("\r\n") } });

const D: [string, "phone"] = ["+15550000004", "phone"];
const D_MAIL: [string, "email"] = ["person-d@example.com", "email"];
const E: [string, "email"] = ["person-e@example.com", "email"];

const b = {
  b1: { chat: B, stanza: "B1", at: at("03:00"), text: "message one" },
  b2: { chat: B, stanza: "B2", at: at("03:05"), fromMe: true, text: "message two" },
  b3: { chat: B, stanza: "B3", at: at("12:00"), type: 1, text: "look", file: IMG1 },
  b4: { chat: B, stanza: "B4", at: at("12:01"), fromMe: true, type: 3, file: VOICE1, media: { ZMOVIEDURATION: 7 } },
  b5: { chat: B, stanza: "B5", at: at("12:02"), text: "reply text", parent: "B2" },
  b6: { chat: B, stanza: "B6", at: at("12:30"), type: 1, file: IMG2, flags: 256 },
} satisfies Record<string, WaMessage>;
const g = {
  g1: { chat: GROUP, stanza: "G1", at: at("14:00"), from: GROUP, member: C, text: "group hello" },
  g2: { chat: GROUP, stanza: "G2", at: at("14:01"), from: GROUP, member: A_LID, type: 1, file: IMG2 },
  g3: { chat: GROUP, stanza: "G3", at: at("14:02"), from: GROUP, type: 6, event: 1 },
} satisfies Record<string, WaMessage>;
const i = {
  i1: { guid: "GUID-I1", at: at("15:00"), sender: D, recipients: [], text: "imessage one" },
  i2: { guid: "GUID-I2", at: at("15:01"), fromMe: true, recipients: [D], body: "￼", attachments: [{ hash: VOICE2, mime: null, name: "Audio Message.caf" }] },
  i3: { guid: "GUID-I3", at: at("15:02"), sender: D, recipients: [], associated: [2000, "p:0/GUID-I2"] },
  i4: { guid: "GUID-I4", at: at("16:00"), sender: E, recipients: [D], text: "￼", attachments: [{ hash: IMG3, mime: "image/heic", name: "IMG_0001.HEIC" }] },
  i5: { guid: "GUID-I5", at: at("16:01"), fromMe: true, recipients: [D, E], body: "edited text", edited: true },
  i6: { guid: "GUID-I6", at: at("16:02"), fromMe: true, recipients: [D, E], text: "gone soon", retracted: true },
} satisfies Record<string, ImMessage>;

function withoutFile({ file: _file, ...message }: WaMessage): WaMessage {
  return message;
}

interface Delivery {
  name: string;
  source: string;
  stated_ms: number;
  rows: ReaderOutput[];
}

const DELIVERIES: Record<string, Delivery> = {
  contacts: {
    name: "contacts", source: CONTACTS, stated_ms: T1,
    rows: [card("contact-b", "Person B", ["TEL:+15550000002"]), card("contact-d", "Person D", ["TEL:+1 555 000 0004", `EMAIL:${D_MAIL[0]}`])],
  },
  mac1: {
    name: "mac1", source: WA_MAC, stated_ms: T1,
    rows: [
      wa(b.b1), wa(b.b2),
      wa({ chat: A_LID, stanza: "A1", at: at("13:00"), from: A_PHONE, text: "hello from a" }),
      ...Object.values(g).map(wa),
      wa({ chat: "status@broadcast", stanza: "S1", at: at("13:30"), from: B, text: "a status post", session: "status@broadcast" }),
      waChat(A_LID, { jid: A_PHONE, identifier: A_LID, partner: "Person A" }),
      waChat(B, { partner: "+1 555-000-0002" }),
      waChat(GROUP, { partner: "Group Alpha", group: true }),
      pushname(C, "Person C"),
    ],
  },
  imMac: { name: "imMac", source: IM_MAC, stated_ms: T1, rows: Object.values(i).map(im) },
  phone: {
    name: "phone", source: WA_PHONE, stated_ms: T2,
    rows: [
      wa(b.b1), wa(b.b2), wa(b.b3), wa(withoutFile(b.b4)), wa(b.b5),
      wa({ chat: A_PHONE, stanza: "A1", at: at("13:00"), text: "hello from a" }),
      wa(g.g1),
      waChat(A_PHONE, { partner: "Person A" }),
    ],
  },
  imPhone: {
    name: "imPhone", source: IM_PHONE, stated_ms: T2,
    rows: [im({ ...i.i1, sender: D_MAIL }), im(i.i4)],
  },
  mac2: {
    name: "mac2", source: WA_MAC, stated_ms: T3,
    rows: [wa({ ...b.b2, status: 2 }), wa(b.b3), wa(b.b4), wa(b.b5), wa(b.b6),
      wa({ chat: A_LID, stanza: "A2", at: at("13:05"), fromMe: true, text: "hello back" })],
  },
};

const MESSAGE_COUNT = 6 + 2 + 3 + 6;

const ORDERS: Record<string, string[]> = {
  "mac first": ["contacts", "mac1", "imMac", "phone", "imPhone", "mac2"],
  "phone first": ["phone", "imPhone", "mac2", "contacts", "imMac", "mac1"],
  "newest delta first": ["mac2", "imPhone", "contacts", "phone", "mac1", "imMac"],
};


const anyObject: Guard = (content) => typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["not an object"];
const GUARDS: Record<string, Guard> = {
  msg: anyObject, chat: anyObject, pushname: anyObject, business: anyObject, contact: anyObject, person: anyObject, scan: anyObject, faces: anyObject, "model-image": anyObject, face: anyObject,
};

interface Synced {
  touched: string[];
  wrote: string[];
  deleted: string[];
}

class Home {
  readonly db: HomeDb;
  #cursor = 0;
  #clock = 0;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = openHome(openHomeFolder(dir), "migrate");
    this.db.commit((tx) => {
      for (const id of SOURCES) tx.tables.sources.add({ id, vendor: SYNTHETIC_VENDOR, connector: id.split(":")[0]!, added_ms: 0 });
    });
  }

  deliver(delivery: Delivery): Synced {
    this.db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: delivery.source, started_ms: delivery.stated_ms });
      const landed = tx.records.land(run, { id: `${delivery.name}@${delivery.stated_ms}`, source: delivery.source, stated_ms: delivery.stated_ms }, delivery.rows, GUARDS, { has: () => true });
      if (landed.refused > 0) throw new Error(`refused: ${JSON.stringify(landed.refusals)}`);
      tx.tables.sources.advance(delivery.source, delivery.stated_ms);
      tx.tables.runs.end(run, { ended_ms: delivery.stated_ms, outcome: "ok" });
    });
    return this.sync();
  }

  sync(): Synced {
    const work = this.read((view) => {
      const changes: Change[] = [];
      for (const statement of view.statements(this.#cursor)) {
        if (statement.late) continue;
        const record = { source: statement.source, kind: statement.kind, key: statement.key };
        const earlier = view.history(record).filter((row) => row.seq < statement.seq && !row.late).at(-1);
        const before = version(view, earlier?.version);
        const after = version(view, statement.version);
        changes.push({ record, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
      }
      const touched = [...new Set(messages.touched(changes, view).map(({ unit }) => unit))].sort();
      return { through: view.through, touched, built: touched.map((unit) => ({ unit, row: build(view, unit) })) };
    });
    this.#cursor = work.through;
    return this.db.commit((tx) => {
      const synced: Synced = { touched: work.touched, wrote: [], deleted: [] };
      for (const { unit, row } of work.built) {
        if (row === null) {
          if (tx.derived.extracts.delete(MESSAGES_FAMILY, unit) !== undefined) synced.deleted.push(unit);
        } else if (tx.derived.extracts.put(row)) synced.wrote.push(unit);
      }
      return synced;
    });
  }

  answer(): { asks: Ask[]; second: Ask[] } {
    const { asks, rows, second } = this.read((view) => {
      const extracts = [...view.extracts(MESSAGES_FAMILY)];
      const asks = extracts.flatMap((extract) => planAsks(extract, new Map()));
      const replies = new Map(asks.map((ask): [string, Reply] => [ask.item, reply(ask)]));
      const prompts = new Map(asks.map((ask) => [ask.item, ask.prompt]));
      const rows: EnrichmentRow[] = [];
      const second: Ask[] = [];
      for (const extract of extracts) {
        const plan = messages.plan!(extract, replies);
        second.push(...plan.asks);
        if ((plan.refusals ?? []).length > 0) throw new Error(`refused: ${JSON.stringify(plan.refusals)}`);
        for (const { item, content } of plan.answers ?? []) {
          rows.push({ family: MESSAGES_FAMILY, item, prompt: prompts.get(item)!, input_hash: `fake:${item}`, reply_key: `reply:${item}`,
            reused_from: null, content, state: "done" });
        }
      }
      return { asks, rows, second };
    });
    this.db.commit((tx) => { for (const row of rows) tx.derived.enrichments.put(row); });
    return { asks, second };
  }

  asks(): Ask[] {
    return this.read((view) => [...view.extracts(MESSAGES_FAMILY)].flatMap((extract) => planAsks(extract, new Map())));
  }

  extracts(): ExtractRow[] {
    return this.read((view) => [...view.extracts(MESSAGES_FAMILY)].sort((left, right) => left.unit < right.unit ? -1 : 1));
  }

  rebuilt(): { unit: string; reading: string; content: Json; days: string[] }[] {
    return this.read((view) => {
      const units = new Set<string>();
      for (const source of [WA_MAC, WA_PHONE, IM_MAC, IM_PHONE]) {
        for (const { head, version: found } of view.records(source, "msg")) {
          const source = view.source(head.source)!;
          const read = readMessage(NETWORKS.of(source.product)!, source, found);
          if (read !== null) units.add(`${read.day}:${read.network}:${read.chat}`);
        }
      }
      return [...units].sort().flatMap((unit) => {
        const row = build(view, unit);
        return row === null ? [] : [{ unit, reading: row.reading, content: row.content, days: row.days }];
      });
    });
  }

  render(reader?: (view: OpenView) => DayReader): Map<string, ReturnType<typeof renderDay>> {
    return this.read((view) => {
      const labels = readLabels(view, null, NETWORKED);
      const days = new Set<string>();
      for (const extract of view.extracts(MESSAGES_FAMILY)) for (const day of extract.days) days.add(day);
      const out = new Map<string, ReturnType<typeof renderDay>>();
      for (const day of [...days].sort()) out.set(day, conforming(renderDay(day, [messages], (reader ?? dayReader)(view), SETTINGS, tableUnits(labels))));
      return out;
    });
  }

  read<T>(work: (view: OpenView) => T): T {
    const view = this.db.view();
    try {
      return work(view);
    } finally {
      view.close();
    }
  }

  close(): void {
    this.db.close();
  }

  next(): number {
    return T1 + 24 * HOUR + HOUR * ++this.#clock;
  }

  stateThrough(): void {
    const stated = this.next();
    this.db.commit((tx) => { for (const id of SOURCES) tx.tables.sources.advance(id, stated); });
  }
}

function version(view: OpenView, id: string | undefined): Version | undefined {
  return id === undefined || id === "gone" ? undefined : view.version(id);
}

function build(view: OpenView, unit: string): ExtractRow | null {
  const extracted = messages.extract(unit, view, FILES);
  if (extracted === null) return null;
  const row: ExtractRow = { family: MESSAGES_FAMILY, unit, code: messages.code, ...extracted, days: [], seq: view.through };
  return { ...row, days: messages.days(row, SETTINGS) };
}

function planAsks(extract: ExtractRow, answered: ReadonlyMap<string, Reply>): Ask[] {
  return messages.plan!(extract, answered).asks.map((ask) => worked(messages, ask));
}

function reply(ask: Ask): Reply {
  const text = ask.prompt === CAPTION_PROMPT ? `A synthetic picture, item ${ask.item.slice(-2)}.` : `synthetic spoken words ${ask.item.slice(-2)}`;
  return { ...replyOf(MESSAGES_PROMPTS[ask.prompt]!, `reply:${ask.item}`, "synthetic-model", text)!, at_ms: T3 };
}

const FILES: BlobReader = (() => {
  const bytes = new Map<string, Buffer>([
    [IMG1, Buffer.from("synthetic image 1")],
    [IMG2, Buffer.from("synthetic image 2")],
    [IMG3, Buffer.from("synthetic image 3")],
    [VOICE1, Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60)])],
    [VOICE2, Buffer.concat([Buffer.from("caff"), Buffer.alloc(60)])],
    [VOICE3, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60)])],
    [VOICE4, Buffer.from("#!AMR\n0000000000")],
  ]);
  const get = (hash: string) => {
    const found = bytes.get(hash);
    if (found === undefined) throw new Error(`no blob ${hash}`);
    return found;
  };
  return {
    has: (hash) => bytes.has(hash),
    bytes: get,
    text: (hash) => get(hash).toString("utf8"),
    prefix: (hash, bytes) => get(hash).subarray(0, bytes),
    materialise: () => { throw new Error("not used"); },
  };
})();

const dayReader = (view: OpenView): DayReader => ({
  extractsOn: (family, day) => [...view.extracts(family)].filter((extract) => extract.days.includes(day)),
  enrichment: (family, item, prompt) => view.enrichment(family, item, prompt),
  sources: (match) => view.sources(match),
  since: (source, kinds) => view.since(source, kinds),
});

function askKey(ask: Ask): Json {
  return {
    item: ask.item, prompt: ask.prompt, identity: ask.identity ?? null,
    input_hash: inputHash(ask), attachments: (ask.attachments ?? []).map((file) => ({ ...file })),
  };
}

function uniqueAsks(asks: readonly Ask[]): Json[] {
  const byItem = new Map<string, string>();
  for (const ask of asks) {
    const key = JSON.stringify(askKey(ask));
    const known = byItem.get(ask.item);
    if (known !== undefined && known !== key) throw new Error(`item ${ask.item} is asked two ways`);
    byItem.set(ask.item, key);
  }
  return [...byItem.keys()].sort().map((item) => JSON.parse(byItem.get(item)!) as Json);
}

function flip(content: Json, path: string): Json | null {
  const copy = structuredClone(content) as Record<string, Json>;
  if (path === "blobs+thumbnail") {
    if (!Array.isArray(copy.blobs)) return null;
    copy.blobs = [...copy.blobs, { hash: THUMB, bytes: 10, role: "ZWAMEDIAITEM.ZXMPPTHUMBPATH" }];
    return copy;
  }
  const names = path.split(".");
  let parent: Record<string, Json> = copy;
  for (const name of names.slice(0, -1)) {
    const next = parent[name];
    if (typeof next !== "object" || next === null || Array.isArray(next)) return null;
    parent = next;
  }
  const last = names.at(-1)!;
  if (!(last in parent)) return null;
  const value = parent[last]!;
  parent[last] = last === "ZFLAGS" && typeof value === "number" ? value | 4
    : typeof value === "number" ? value + 1
    : typeof value === "string" ? `${value}-ticked`
    : value === null ? (last === "message_summary_info" ? { $bytes64: "AQID" } : 1)
    : null;
  return copy;
}


const root = mkdtempSync(join(tmpdir(), "families-messages-"));
const homes: Home[] = [];
afterAll(() => {
  for (const home of homes) home.close();
  if (KEEP) console.log(`messages artifacts kept: ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

function world(name: string, order = ORDERS["mac first"]!): Home {
  const home = new Home(join(root, name));
  homes.push(home);
  for (const delivery of order) home.deliver(DELIVERIES[delivery]!);
  return home;
}

function write(home: Home, name: string, value: unknown): void {
  writeFileSync(join(home.dir, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function writeDays(home: Home, days: Map<string, ReturnType<typeof renderDay>>): void {
  mkdirSync(join(home.dir, "days"), { recursive: true });
  for (const [day, files] of days) {
    writeFileSync(join(home.dir, "days", `${day}.day.txt`), files.txt);
    writeFileSync(join(home.dir, "days", `${day}.day.json`), files.json);
    writeFileSync(join(home.dir, "days", `${day}.day.lines.json`), files.lines);
  }
}

const WA_MSG_TICKS = [
  "message.ZMESSAGESTATUS", "message.ZMESSAGEERRORSTATUS", "message.ZSTARRED", "message.ZENCRETRYCOUNT",
  "message.ZFILTEREDRECIPIENTCOUNT", "message.ZCHILDMESSAGESDELIVEREDCOUNT", "message.ZCHILDMESSAGESPLAYEDCOUNT",
  "message.ZCHILDMESSAGESREADCOUNT", "message.ZDATAITEMVERSION", "message.ZMEDIASECTIONID", "message.ZPHASH",
  "message.ZSENTDATE", "message.ZPUSHNAME", "message.ZTOJID", "message.ZFLAGS", "media_item.ZMEDIAURLDATE",
  "media_item.ZMEDIAURL", "media_item.ZMEDIAKEY", "media_item.ZMEDIAORIGIN", "media_item.ZFILESIZE", "media_item.ZASPECTRATIO",
  "blobs+thumbnail",
];
const WA_CHAT_TICKS = [
  "chat.ZUNREADCOUNT", "chat.ZMESSAGECOUNTER", "chat.ZLASTMESSAGEDATE", "chat.ZLASTMESSAGETEXT", "chat.ZHIDDEN",
  "chat.ZETAG", "chat.ZSAVEDINPUT", "chat.ZFLAGS", "chat.ZIDENTITYVERIFICATIONSTATE", "chat.ZIDENTITYVERIFICATIONEPOCH",
  "chat.ZLOCATIONSHARINGENDDATE", "group_info.ZPICTUREID", "group_info.ZSTATE",
];
const IM_MSG_TICKS = [
  "flags.is_delivered", "flags.is_sent", "flags.was_delivered_quietly", "flags.did_notify_recipient", "message_summary_info", "service",
];

describe("messages family", () => {
  it("the owner's own chat prints as the provider's self label, or as anything but the user", () => {
    const OWN = "15550000000@s.whatsapp.net";
    const OWN_LID = "900000000000@lid";
    const SELF = "\u200eYou";
    const home = new Home(join(root, "owner"));
    homes.push(home);
    home.deliver({ name: "self", source: WA_MAC, stated_ms: T1, rows: [
      waChat(OWN_LID, { jid: OWN_LID, identifier: OWN, partner: SELF }),
      pushname(OWN_LID, "Person Me Pushed"),
      wa({ chat: OWN_LID, stanza: "M1", at: at("17:00"), from: OWN_LID, text: "a note to self" }),
      wa({ chat: GROUP, stanza: "M2", at: at("17:05"), from: GROUP, member: OWN_LID, text: "from the other device" }),
      waChat(GROUP, { partner: "Group Alpha", group: true }),
      waChat(B, { partner: "Person B Shell" }),
      pushname(B, "Person B Pushed"),
      wa({ chat: B, stanza: "M3", at: at("17:10"), from: B, text: "hello" }),
    ] });
    const day = () => [...home.render().values()].map((files) => files.txt).join("\n");
    const pushed = day();
    expect(pushed).not.toContain(SELF);
    expect(pushed).not.toContain("Person Me Pushed");
    expect(pushed).toContain("the user · the user: a note to self");
    expect(pushed).toContain("Group Alpha · the user: from the other device");
    expect(pushed).toContain("Person B Shell: hello");
    const REGISTRY = "people:local:macbook-pro-0001";
    home.db.commit((tx) => tx.tables.sources.add({ id: REGISTRY, vendor: SYNTHETIC_VENDOR, connector: "people", added_ms: 0 }));
    home.deliver({ name: "registry", source: REGISTRY, stated_ms: T2, rows: [{ kind: "person", key: "person-me", content: {
      type: "people.person", slug: "person-me", name: "Person Me", merged_into: null, excluded: [],
      handles: [{ kind: "name", value: "Person Me", by: "subject", since: "2026-10-01T00:00:00Z" }, { kind: "phone", value: "+15550000000", by: "subject", since: "2026-10-01T00:00:00Z" }],
    } }] });
    const registered = day();
    expect(registered).not.toContain(SELF);
    expect(registered).not.toContain("Person Me");
    expect(registered).toContain("the user · the user: a note to self");
    expect(registered).toContain("Group Alpha · the user: from the other device");
    expect(registered).toContain("Person B Shell: hello");
    write(home, "owner.txt", registered);
  });

  it("a message from another number of You, or a chat with yourself, names the owner by name or the chat by its id", () => {
    const SECOND = "15550000009@s.whatsapp.net";
    const you = (me: boolean): ReaderOutput => ({ kind: "person", key: "sam", content: {
      type: "people.person", slug: "sam", name: "Sam", full_name: "Sam Example", show: "name", entity: "person", relationship: null, hidden: false, me,
      anchor: { kind: "phone", value: "+15550000009" }, handles: [], excluded: [], dismissed: [], merged_into: null,
    } });
    const home = new Home(join(root, "you"));
    homes.push(home);
    home.deliver({ name: "you", source: PEOPLE_HOME, stated_ms: T1, rows: [you(false)] });
    home.deliver({ name: "second", source: WA_MAC, stated_ms: T1, rows: [
      waChat(GROUP, { partner: "Group Alpha", group: true }),
      wa({ chat: GROUP, stanza: "Y1", at: at("13:12"), from: GROUP, member: SECOND, text: "running late" }),
      waChat(SECOND, { partner: null }),
      wa({ chat: SECOND, stanza: "Y2", at: at("14:00"), from: SECOND, text: "a note from the other phone" }),
      wa({ chat: SECOND, stanza: "Y3", at: at("14:05"), from: SECOND, text: "and another" }),
    ] });
    const day = () => [...home.render().values()].map((files) => files.txt).join("\n");
    const before = day();
    expect(before).toContain("09:12 Group Alpha · Sam: running late");
    expect(before).toContain("10:00–10:05 Sam (2)\n");
    home.deliver({ name: "marked", source: PEOPLE_HOME, stated_ms: T2, rows: [you(true)] });
    const after = day();
    expect(after).toContain("09:12 Group Alpha · the user: running late");
    expect(after).toContain("10:00–10:05 the user (2)\n");
    expect(after).toContain("  10:00 the user: a note from the other phone");
    expect(after).not.toContain("Sam");
    write(home, "you.txt", { before, after });
  });

  it("an extract is written when only an unread field ticked", () => {
    const home = world("ticks");
    home.answer();
    home.stateThrough();
    const asksBefore = uniqueAsks(home.asks());
    const daysBefore = home.render();
    const record: Record<string, Synced & { rows: number }> = {};
    const tick = (source: string, kind: string, path: string) => {
      const rows = home.read((view) => [...view.records(source, kind)].flatMap(({ head, version: current }) => {
        const content = flip(current.content, path);
        const time = current.time;
        return content === null ? [] : [{ kind, key: head.key, content, ...(time === undefined ? {} : { time }) } as ReaderOutput];
      }));
      const synced = home.deliver({ name: `tick ${path}`, source, stated_ms: home.next(), rows });
      record[`${source} ${kind} ${path}`] = { ...synced, rows: rows.length };
      expect(rows.length, `${path} flips something on ${source}`).toBeGreaterThan(0);
      expect(synced.wrote, `${path} on ${source} wrote extracts`).toEqual([]);
      expect(synced.deleted, `${path} on ${source} deleted extracts`).toEqual([]);
      if (kind === "msg") expect(synced.touched.length, `${path} on ${source} was read`).toBeGreaterThan(0);
      else expect(synced.touched, `${path} on ${source} touched a unit`).toEqual([]);
    };
    for (const path of WA_MSG_TICKS) for (const source of [WA_MAC, WA_PHONE]) tick(source, "msg", path);
    for (const path of WA_CHAT_TICKS) for (const source of [WA_MAC, WA_PHONE]) {
      if (path.startsWith("group_info") && source === WA_PHONE) continue;
      tick(source, "chat", path);
    }
    for (const path of IM_MSG_TICKS) for (const source of [IM_MAC, IM_PHONE]) tick(source, "msg", path);
    write(home, "ticks.json", record);

    const daysAfter = home.render();
    expect([...daysAfter.keys()]).toEqual([...daysBefore.keys()]);
    for (const [day, files] of daysAfter) expect(files.inputs, day).toBe(daysBefore.get(day)!.inputs);
    expect(uniqueAsks(home.asks())).toEqual(asksBefore);
    const edited = home.deliver({ name: "real edit", source: WA_PHONE, stated_ms: home.next(), rows: [wa({ ...b.b1, text: "message one, corrected" })] });
    expect(edited.wrote).toEqual([`2026-10-02:whatsapp:${B}`]);
  });

  it("units or extracts differ when the same data arrives in another order", () => {
    const results = Object.entries(ORDERS).map(([name, order]) => {
      const home = world(`order ${name}`, order);
      const extracts = home.extracts().map(({ unit, reading, code, content, days, start_ms, end_ms }) => ({ unit, reading, code, content, days, start_ms, end_ms }));
      write(home, "extracts.json", extracts);
      return { name, home, extracts };
    });
    const [first, ...others] = results;
    for (const other of others) expect(other.extracts, `${other.name} against ${first!.name}`).toEqual(first!.extracts);
    for (const { name, home, extracts } of results) {
      expect(home.rebuilt(), name).toEqual(extracts.map(({ unit, reading, content, days }) => ({ unit, reading, content, days })));
    }
    expect(first!.extracts.map((extract) => extract.unit)).toEqual([
      "2026-10-02:imessage:+15550000004",
      "2026-10-02:imessage:+15550000004,person-e@example.com",
      "2026-10-02:imessage:person-d@example.com",
      `2026-10-02:whatsapp:${GROUP}`,
      `2026-10-02:whatsapp:${A_PHONE}`,
      `2026-10-02:whatsapp:${B}`,
      `2026-10-02:whatsapp:${A_LID}`,
    ]);
  });

  it("an answered item is asked again", () => {
    const home = world("answered");
    const { asks, second } = home.answer();
    const unique = uniqueAsks(asks);
    expect(unique.map((ask) => (ask as { item: string }).item)).toEqual([IMG1, IMG2, VOICE1, IMG3, VOICE2].sort());
    expect(second).toEqual([]);
    expect(home.asks().length > 0, "an extract with no replies still asks").toBe(true);
    const answered = new Map(asks.map((ask): [string, Reply] => [ask.item, reply(ask)]));
    for (const extract of home.extracts()) {
      const plan = messages.plan!(extract, answered);
      expect(plan.asks, extract.unit).toEqual([]);
      expect(plan.refusals, extract.unit).toEqual([]);
      expect(plan.answers?.map(({ item }) => item).sort(), extract.unit).toEqual(messages.items!(extract).map(({ item }) => item).sort());
    }
    const withEmpty = new Map(answered);
    withEmpty.set(IMG1, { ...answered.get(IMG1)!, text: "  ", value: "  " });
    const unitB = home.extracts().find((extract) => extract.unit.endsWith(B))!;
    const refused = messages.plan!(unitB, withEmpty);
    expect(refused.refusals).toEqual([{ item: IMG1, reason: "the reply is empty" }]);
    expect(refused.answers?.map(({ item }) => item)).not.toContain(IMG1);
    expect(refused.asks).toEqual([]);
    home.deliver({ ...DELIVERIES.mac2!, name: "mac2 replay" });
    home.deliver({ name: "later", source: WA_MAC, stated_ms: home.next(), rows: [wa({ chat: B, stanza: "B7", at: at("18:00"), text: "later words" })] });
    expect(uniqueAsks(home.asks())).toEqual(unique);
    write(home, "asks.json", unique);
  });

  it("the name the labels resolve for an id differs from the name a day prints for that party", () => {
    const home = world("names");
    home.answer();
    home.stateThrough();
    const days = home.render();
    const labels = home.read((view) => readLabels(view, null, NETWORKED));
    const known = new Set(labels.table.people.map(([, handle]) => handle));
    for (const [unit, label] of labels.table.providers) for (const each of [unit.slice(unit.indexOf(":") + 1), ...(label.aliases ?? [])]) known.add(each);
    const resolved = new Map([...known].map((id) => [id, resolvedName(id, labels, NETWORKS)]));
    const checked: Record<string, string> = {};
    for (const extract of home.extracts()) {
      const { day, messages: shown } = extract.content as { day: string; messages: { from: { id: string; kind: Party["kind"] } }[] };
      const txt = days.get(day)?.txt ?? "";
      for (const { from } of shown) {
        const named = nameId(from.id, labels, from.kind);
        if (from.kind !== "me" && from.kind !== "system") {
          const served = resolvedName(from.id, labels, NETWORKS);
          expect(served, from.id).toEqual([from.id, named.name, named.by, named.person]);
          if (resolved.has(from.id)) expect(resolved.get(from.id)).toEqual(served);
        }
        expect(txt, `${day} ${from.id}`).toContain(`${named.name}: `);
        checked[from.id] = named.name;
      }
    }
    expect(Object.keys(checked).length).toBeGreaterThan(2);
    expect(new Set([...resolved.values()].map(([, , by]) => by))).toEqual(new Set(["contact", "provider", "push-name", "none", "me"]));
    expect(resolved.get(GROUP)).toEqual([GROUP, GROUP, "none", null]);
    write(home, "names.json", { checked, resolved: [...resolved] });
  });

  it("a chat's served title or group differs from its day's block: the title the day prints, and the group rule that title was chosen by", () => {
    const home = world("chats");
    home.answer();
    home.stateThrough();
    const days = home.render();
    const labels = home.read((view) => readLabels(view, null, NETWORKED));
    const checked: Record<string, [string, boolean]> = {};
    for (const [day, files] of days) {
      const atoms = (JSON.parse(files.json) as { atoms: { block?: { key: string; title: string } }[] }).atoms;
      for (const { block } of atoms) {
        if (block === undefined) continue;
        const colon = block.key.indexOf(":");
        const group = isGroupChat(NETWORKS, block.key.slice(0, colon), block.key.slice(colon + 1));
        expect(resolvedChat(block.key, labels, NETWORKS), `${day} ${block.key}`).toEqual([block.key, block.title, group]);
        checked[block.key] = [block.title, group];
      }
    }
    expect(checked).toMatchObject({
      [`whatsapp:${GROUP}`]: ["Group Alpha", true], [`whatsapp:${B}`]: [expect.any(String), false],
      "imessage:+15550000004,person-e@example.com": [expect.any(String), true], "imessage:person-d@example.com": [expect.any(String), false],
    });
    expect(resolvedChat("whatsapp:120363000000000099@g.us", labels, NETWORKS)).toEqual(["whatsapp:120363000000000099@g.us", "120363000000000099@g.us", true]);
    expect(resolvedChat("sms:+15550000001", labels, NETWORKS)).toBeNull();
    write(home, "chats.json", checked);
  });

  it("a renamed contact re-asks or re-extracts anything", () => {
    const home = world("rename");
    home.answer();
    home.stateThrough();
    const asks = uniqueAsks(home.asks());
    const extracts = home.extracts();
    const before = home.render();
    const renamed = [
      home.deliver({ name: "rename contact", source: CONTACTS, stated_ms: home.next(), rows: [card("contact-b", "Person B Renamed", ["TEL:+15550000002"])] }),
      home.deliver({ name: "rename group", source: WA_MAC, stated_ms: home.next(), rows: [waChat(GROUP, { partner: "Group Beta", group: true }), pushname(C, "Person C Renamed")] }),
      home.deliver({ name: "rename partner", source: WA_PHONE, stated_ms: home.next(), rows: [waChat(A_PHONE, { partner: "Person A Renamed" })] }),
    ];
    for (const synced of renamed) expect(synced).toEqual({ touched: [], wrote: [], deleted: [] });
    expect(home.extracts()).toEqual(extracts);
    expect(uniqueAsks(home.asks())).toEqual(asks);
    const after = home.render();
    const day = after.get("2026-10-02")!;
    expect(day.inputs).not.toBe(before.get("2026-10-02")!.inputs);
    expect(day.txt).toContain("Person B Renamed");
    expect(day.txt).toContain("Group Beta");
    expect(day.txt).toContain("Person C Renamed: group hello");
    expect(day.txt).toContain("Person A Renamed");
    expect(day.txt).not.toMatch(/Person B[^ ]|Person B$|Group Alpha/mu);
    write(home, "renamed.day.txt", day.txt);
  });

  it("renderDay reads outside days()", () => {
    const home = world("days");
    home.answer();
    const days = home.render();
    expect([...days.keys()]).toEqual(["2026-10-01", "2026-10-02"]);
    for (const extract of home.extracts()) expect(extract.days).toEqual(messages.days(extract, SETTINGS));
    const placed = [...days.values()].flatMap((files) => (JSON.parse(files.json) as { atoms: { record: { key: string } }[] }).atoms);
    expect(placed.length).toBe(MESSAGE_COUNT);
    const leaky = (view: OpenView): DayReader => ({
      ...dayReader(view),
      extractsOn: (family, day) => day === "2026-10-01" ? [...view.extracts(family)].map((extract) => ({ ...extract, days: [...extract.days, day] })) : [],
    });
    expect(home.render(leaky).get("2026-10-01")!.json).toBe(days.get("2026-10-01")!.json);
  });

  it("a replica message is printed twice", () => {
    const home = world("replicas");
    home.answer();
    const days = home.render();
    const atoms = [...days.values()].flatMap((files) => (JSON.parse(files.json) as { atoms: { text: string; record: { source: string; key: string }; block: { key: string } }[] }).atoms);
    const things = atoms.map(({ record }) => record.key.replace(/^[^:]*@(?:lid|s\.whatsapp\.net):/u, "chat:"));
    expect(new Set(things).size, things.join(" ")).toBe(atoms.length);
    const a = atoms.filter((atom) => /:A[12]$/u.test(atom.record.key));
    expect(a.length).toBe(2);
    expect(new Set(a.map((atom) => atom.block.key))).toEqual(new Set([`whatsapp:${A_LID}`]));
    expect(atoms.filter((atom) => atom.record.key === "GUID-I1").length).toBe(1);
    expect(atoms.find((atom) => atom.record.key === `${B}:B4`)!.record.source).toBe(WA_MAC);
    write(home, "atoms.json", atoms);
  });

  it("a call's entry in a chat prints a chat line", () => {
    const home = new Home(join(root, "call-log"));
    homes.push(home);
    home.deliver({ name: "mac", source: WA_MAC, stated_ms: T1, rows: [
      wa({ chat: B, stanza: "C1", at: at("15:00"), text: null, type: 59 }),
      wa({ chat: B, stanza: "C2", at: at("15:10"), text: "after the call" }),
    ] });
    const days = home.render();
    const atoms = [...days.values()].flatMap((files) => (JSON.parse(files.json) as { atoms: { record: { key: string } }[] }).atoms);
    expect(atoms.map((atom) => atom.record.key)).toEqual([`${B}:C2`]);
    const printed = [...days.values()].map((files) => files.txt).join("\n");
    expect(printed).not.toMatch(/\[call\]|system event/u);
    write(home, "call-log.txt", printed);
  });

  it("a WhatsApp kind the family does not know: a notice with no words and no media prints no chat line; one with media prints it; one with words prints them", () => {
    const home = new Home(join(root, "unknown-kinds"));
    homes.push(home);
    home.deliver({ name: "mac", source: WA_MAC, stated_ms: T1, rows: [
      wa({ chat: B, stanza: "N1", at: at("15:00"), text: null, type: 19 }),
      wa({ chat: B, stanza: "N2", at: at("15:01"), text: null, type: 10, event: 38 }),
      wa({ chat: B, stanza: "N3", at: at("15:02"), text: null, type: 11, media: { ZVCARDSTRING: "video/mp4", ZMOVIEDURATION: 1 }, file: IMG1 }),
      wa({ chat: B, stanza: "N4", at: at("15:03"), text: null, type: 54, media: { ZVCARDSTRING: "video/mp4", ZMOVIEDURATION: 18 } }),
      wa({ chat: B, stanza: "N5", at: at("15:04"), text: "deals of the day", type: 41 }),
    ] });
    const days = home.render();
    const atoms = [...days.values()].flatMap((files) =>
      (JSON.parse(files.json) as { atoms: { text: string, record: { key: string } }[] }).atoms);
    expect(atoms.map((atom) => atom.record.key)).toEqual([`${B}:N3`, `${B}:N4`, `${B}:N5`]);
    const printed = [...days.values()].map((files) => files.txt).join("\n");
    expect(printed).not.toMatch(/system event/u);
    expect(atoms[0]!.text).toMatch(/\[video\b/u);
    expect(atoms[1]!.text).toMatch(/\[video\b/u);
    expect(atoms[2]!.text).toMatch(/deals of the day$/u);
    write(home, "unknown-kinds.txt", printed);
  });

  it("a contact card prints the numbers its vCard states, not its name alone", () => {
    const home = new Home(join(root, "contact-card"));
    homes.push(home);
    const card = ["BEGIN:VCARD", "VERSION:3.0", "N:Example;Person;;;", "FN:Person Example", "item1.TEL;waid=15550000077:+1 555 000 0077",
      "item1.X-ABLabel:Mobile", "TEL;TYPE=WORK:+1 555 000 0078", "END:VCARD"].join("\n");
    home.deliver({ name: "mac", source: WA_MAC, stated_ms: T1, rows: [
      wa({ chat: B, stanza: "V1", at: at("15:00"), text: null, type: 4, media: { ZVCARDNAME: "Person Example", ZVCARDSTRING: card } }),
      wa({ chat: B, stanza: "V2", at: at("15:01"), text: null, type: 4, media: { ZVCARDNAME: "Person Without Number", ZVCARDSTRING: "BEGIN:VCARD\nFN:Person Without Number\nEND:VCARD" } }),
      wa({ chat: B, stanza: "V3", at: at("15:02"), text: null, type: 4, media: { ZVCARDNAME: "Desk Example", ZVCARDSTRING: "BEGIN:VCARD\nFN:Desk Example\nTEL;X-LABEL=\"Desk:west\":+15550000077\nEND:VCARD" } }),
    ] });
    const atoms = [...home.render().values()].flatMap((files) => (JSON.parse(files.json) as { atoms: { text: string, record: { key: string } }[] }).atoms);
    expect(atoms.find((atom) => atom.record.key === `${B}:V1`)!.text).toMatch(/\[contact card: Person Example, \+1 555 000 0077, \+1 555 000 0078\]/u);
    expect(atoms.find((atom) => atom.record.key === `${B}:V2`)!.text).toMatch(/\[contact card: Person Without Number\]/u);
    expect(atoms.find((atom) => atom.record.key === `${B}:V3`)!.text).toMatch(/\[contact card: Desk Example, \+15550000077\]/u);
  });

  it("a message one copy states unsent or deleted still prints the words another copy holds", () => {
    const home = new Home(join(root, "withdrawn"));
    homes.push(home);
    const unsent: ImMessage = { guid: "GUID-W1", at: at("15:00"), sender: D, recipients: [], text: "words withdrawn later" };
    const deleted: WaMessage = { chat: B, stanza: "W2", at: at("15:05"), text: "words deleted later" };
    home.deliver({ name: "macWords", source: IM_MAC, stated_ms: T1, rows: [im(unsent)] });
    home.deliver({ name: "macWa", source: WA_MAC, stated_ms: T1, rows: [wa(deleted)] });
    home.deliver({ name: "phoneUnsent", source: IM_PHONE, stated_ms: T2, rows: [im({ ...unsent, text: null, retracted: true })] });
    home.deliver({ name: "phoneDeleted", source: WA_PHONE, stated_ms: T2, rows: [wa({ ...deleted, type: 14 })] });
    const printed = [...home.render().values()].map((files) => files.txt).join("\n");
    expect(printed).not.toMatch(/withdrawn later|deleted later/u);
    expect(printed).toMatch(/message unsent/u);
    expect(printed).toMatch(/message deleted/u);
    write(home, "withdrawn.txt", printed);
  });

  it("a voice note's transcript, version 2, in Latin letters, keeps version 1's as they are: a note transcribed before is not asked again", () => {
    const prompt = MESSAGES_PROMPTS[TRANSCRIPT_PROMPT]!;
    expect([prompt.version, prompt.type, prompt.keeps, prompt.converters]).toEqual([2, "text", [{ version: 1, type: "text" }], undefined]);
    expect(prompt.text).toMatch(/Hindi and Hinglish in Latin letters/u);
  });

  it("a voice note or an image with bytes has no ask", () => {
    const home = world("asks");
    const asks = home.asks();
    const items = new Set(asks.map((ask) => ask.item));
    for (const extract of home.extracts()) {
      const listed = new Set(messages.items!(extract).map(({ item }) => item));
      for (const message of (extract.content as { messages: { parts?: { what: string; blob?: string }[] }[] }).messages) {
        for (const part of message.parts ?? []) {
          if (part.blob === undefined || !/^(?:photo|voice note)/u.test(part.what)) continue;
          expect(items.has(part.blob), `${extract.unit} ${part.what} ${part.blob}`).toBe(true);
          expect(listed.has(part.blob), `${extract.unit} lists ${part.blob}`).toBe(true);
        }
      }
    }
    expect([...items].sort()).toEqual([IMG1, IMG2, IMG3, VOICE1, VOICE2].sort());
    const byItem = new Map(asks.map((ask) => [ask.item, ask]));
    expect(byItem.get(IMG3)!.attachments).toEqual([{ blob: IMG3, media_type: "image/heic" }]);
    expect(byItem.get(VOICE2)!.attachments).toEqual([{ blob: VOICE2, media_type: "audio/x-caf" }]);
    expect(byItem.get(VOICE2)!.identity).toEqual(transcriptIdentity(VOICE2, "m4a"));
    expect(byItem.get(VOICE1)!.identity).toEqual(transcriptIdentity(VOICE1, "ogg"));
    for (const ask of asks) expect(ask.input).toEqual([]);
    for (const extract of home.extracts()) {
      const facts = (extract.content as { messages: { source: string; parts?: { blob?: string }[] }[] }).messages;
      for (const ask of messages.plan!(extract, new Map()).asks) {
        const first = facts.find((fact) => fact.parts?.some((part) => part.blob === ask.item))!;
        expect([ask.work, ask.source], ask.item).toEqual([ask.prompt === CAPTION_PROMPT ? "photos" : "voice", first.source]);
      }
    }
    expect([...new Set(asks.map((ask) => ask.source!.slice(0, ask.source!.indexOf(":"))))].sort()).toEqual(["imessage", "whatsapp"]);

    home.deliver({ name: "odd audio", source: WA_MAC, stated_ms: home.next(), rows: [wa({ chat: B, stanza: "B8", at: at("19:00"), type: 3, file: VOICE3 })] });
    home.deliver({ name: "odd audio", source: IM_MAC, stated_ms: home.next(), rows: [im({ guid: "GUID-I7", at: at("19:01"), sender: D, recipients: [],
      attachments: [{ hash: VOICE4, mime: "audio/amr", name: "note.amr" }] })] });
    const later = new Map(home.asks().map((ask) => [ask.item, ask]));
    expect(later.get(VOICE3)!.attachments).toEqual([{ blob: VOICE3, media_type: "audio/mpeg" }]);
    expect(later.get(VOICE3)!.identity).toEqual(transcriptIdentity(VOICE3, "mp3"));
    expect(later.has(VOICE4)).toBe(false);
    expect(home.render().get("2026-10-02")!.txt).toContain("Person D: [voice note]");
  });

  it("an erasure of a message misses one of its replicas or the caption that describes it", () => {
    const home = new Home(join(root, "erase"));
    homes.push(home);
    home.deliver({ name: "mac", source: WA_MAC, stated_ms: T1, rows: [wa(b.b1), wa(b.b3)] });
    home.deliver({ name: "mac imessage", source: IM_MAC, stated_ms: T1, rows: [im(i.i1)] });
    home.deliver({ name: "phone", source: WA_PHONE, stated_ms: T2, rows: [wa({ ...b.b3, text: "look again" })] });
    home.deliver({ name: "phone gone", source: WA_PHONE, stated_ms: T3, rows: [{ ...wa(b.b3), gone: true }] });
    const erased = home.read((view) => {
      const labels = readLabels(view, null, NETWORKED);
      return {
        photo: messages.replicas!(`${B}:B3`, view, labels),
        text: messages.replicas!(`${B}:B1`, view, labels),
        imessage: messages.replicas!("GUID-I1", view, labels),
        none: messages.replicas!(`${B}:B9`, view, labels),
      };
    });
    expect(erased.photo).toEqual({ records: [{ source: WA_MAC, kind: "msg", key: `${B}:B3` }, { source: WA_PHONE, kind: "msg", key: `${B}:B3` }].sort((left, right) => left.source < right.source ? -1 : 1), items: [IMG1] });
    expect(erased.text).toEqual({ records: [{ source: WA_MAC, kind: "msg", key: `${B}:B1` }], items: [] });
    expect(erased.imessage).toEqual({ records: [{ source: IM_MAC, kind: "msg", key: "GUID-I1" }], items: [] });
    expect(erased.none).toEqual({ records: [], items: [] });

    const hex = IMG1.slice("sha256:".length);
    const faceRecords = [
      { source: FACES, kind: "scan", key: hex },
      { source: PEOPLE_HOME, kind: "face", key: `${hex}:1,2,3,4` },
    ];
    home.deliver({ name: "faces", source: FACES, stated_ms: T3, rows: [{ kind: "scan", key: hex, content: { status: "ok" } }] });
    home.deliver({ name: "statements", source: PEOPLE_HOME, stated_ms: T3, rows: [{ kind: "face", key: `${hex}:1,2,3,4`, content: { is: "person-a" } }, { kind: "face", key: `${"9".repeat(64)}:1,2,3,4`, content: { ignore: true } }] });
    const withFaces = home.read((view) => messages.replicas!(`${B}:B3`, view, readLabels(view, null, NETWORKED)));
    expect(withFaces).toEqual({ records: [...erased.photo.records, ...faceRecords], items: [IMG1] });
    home.deliver({ name: "again", source: WA_MAC, stated_ms: T3 + HOUR, rows: [wa({ chat: B, stanza: "B7", at: at("13:00"), type: 1, file: IMG1 })] });
    const shared = home.read((view) => messages.replicas!(`${B}:B3`, view, readLabels(view, null, NETWORKED)));
    expect(shared).toEqual(erased.photo);
    write(home, "erase.json", { ...erased, withFaces, shared });
  });

  it("an erasure of a message misses the copy a source keys by the chat's other WhatsApp id", () => {
    const home = new Home(join(root, "erase-alias"));
    homes.push(home);
    home.deliver({ name: "mac", source: WA_MAC, stated_ms: T1, rows: [
      wa({ chat: A_LID, stanza: "A1", at: at("13:00"), from: A_PHONE, text: "hello from a" }),
      wa({ chat: A_LID, stanza: "A2", at: at("13:05"), fromMe: true, text: "hello back" }),
      waChat(A_LID, { jid: A_PHONE, identifier: A_LID, partner: "Person A" }),
    ] });
    home.deliver({ name: "phone", source: WA_PHONE, stated_ms: T2, rows: [wa({ chat: A_PHONE, stanza: "A1", at: at("13:00"), text: "hello from a" })] });
    const erased = home.read((view) => {
      const labels = readLabels(view, null, NETWORKED);
      return {
        byPhone: messages.replicas!(`${A_PHONE}:A1`, view, labels),
        byLid: messages.replicas!(`${A_LID}:A1`, view, labels),
        other: messages.replicas!(`${A_PHONE}:A2`, view, labels),
      };
    });
    expect(home.render().get("2026-10-02")!.txt.match(/hello from a/gu)).toHaveLength(1);
    const both = { records: [{ source: WA_PHONE, kind: "msg", key: `${A_PHONE}:A1` }, { source: WA_MAC, kind: "msg", key: `${A_LID}:A1` }], items: [] };
    expect(erased.byPhone).toEqual(both);
    expect(erased.byLid).toEqual(both);
    expect(erased.other).toEqual({ records: [{ source: WA_MAC, kind: "msg", key: `${A_LID}:A2` }], items: [] });
    write(home, "erase-alias.json", erased);
  });

  it("the chat voice-note ask's identity differs from the ledger's stored transcripts", () => {
    const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as {
      identities: { audio: string; format: string; identity: string }[];
    };
    for (const { audio, format, identity } of ledger.identities) expect(digest(transcriptIdentity(audio, format))).toBe(identity);
  });

  it("a message's search text holds what no person wrote, misses the words or the people in it, or answers a record with no words", () => {
    const home = world("texts");
    const person = (slug: string, name: string, full_name: string | null, handles: [string, string][], merged_into: string | null = null): ReaderOutput => ({
      kind: "person", key: slug,
      content: {
        type: "people.person", slug, name, full_name, show: "name", entity: "person", relationship: null, hidden: false, me: false,
        anchor: { kind: handles[0]![0], value: handles[0]![1] }, handles: handles.slice(1).map(([kind, value]) => ({ kind, value })),
        excluded: [{ kind: "phone", value: "+15550000009" }], dismissed: [], merged_into,
      },
    });
    const long = `${"word ".repeat(13_107)}😀 past the cut`;
    const { time: _time, ...timeless } = wa({ chat: B, stanza: "B9", at: at("12:42"), text: "a message stating no time" });
    home.deliver({
      name: "more", source: WA_MAC, stated_ms: home.next(),
      rows: [wa({ chat: B, stanza: "B7", at: at("12:40"), text: "" }), wa({ chat: B, stanza: "B8", at: at("12:41"), text: long }), timeless,
        wa({ chat: GROUP, stanza: "G4", at: at("14:03"), from: GROUP, member: A_LID, text: "group words from a lid" }),
        wa({ chat: GROUP, stanza: "G5", at: at("14:04"), from: C, text: "group words, older shape" })],
    });
    home.deliver({
      name: "people", source: PEOPLE_HOME, stated_ms: home.next(),
      rows: [person("person-b", "Person B", "Bee", [["phone", "+15550000002"], ["jid", A_LID]]),
        person("person-b-old", "Person B (old)", null, [["phone", "+15550000002"]], "person-b")],
    });
    const texts = new Map(home.read((view) => recordTexts(view, messages, FILES)).map(({ record, text }) => [record, text]));
    const cut = texts.get(`${WA_MAC} msg ${B}:B8`)!;
    expect(Buffer.byteLength(cut.text, "utf8")).toBe(65_536 - 1);
    expect(cut.text).toBe("word ".repeat(13_107));
    texts.delete(`${WA_MAC} msg ${B}:B8`);
    const b = ["15550000002@s.whatsapp.net", "+15550000002"];
    const a = ["15550000001@s.whatsapp.net", "+15550000001"];
    const c = ["15550000003@s.whatsapp.net", "+15550000003"];
    expect(Object.fromEntries(texts)).toEqual({
      [`${CONTACTS} contact contact-b`]: { title: "Person B", text: "", who: ["+15550000002"] },
      [`${CONTACTS} contact contact-d`]: { title: "Person D", text: "", who: ["+15550000004", "person-d@example.com"] },
      [`${IM_PHONE} msg GUID-I1`]: { text: "imessage one", who: ["person-d@example.com"] },
      [`${IM_PHONE} msg GUID-I4`]: null,
      [`${IM_MAC} msg GUID-I1`]: { text: "imessage one", who: ["+15550000004"] },
      [`${IM_MAC} msg GUID-I2`]: null,
      [`${IM_MAC} msg GUID-I3`]: null,
      [`${IM_MAC} msg GUID-I4`]: null,
      [`${IM_MAC} msg GUID-I5`]: { text: "edited text", who: ["+15550000004", "person-e@example.com"] },
      [`${IM_MAC} msg GUID-I6`]: null,
      [`${PEOPLE_HOME} person person-b`]: { title: "Person B", text: "Bee", who: ["+15550000002", A_LID] },
      [`${PEOPLE_HOME} person person-b-old`]: null,
      [`${WA_PHONE} chat ${A_PHONE}`]: { title: "Person A", text: "", who: a },
      [`${WA_PHONE} msg ${GROUP}:G1`]: { text: "group hello", who: c },
      [`${WA_PHONE} msg ${A_PHONE}:A1`]: { text: "hello from a", who: a },
      [`${WA_PHONE} msg ${B}:B1`]: { text: "message one", who: b },
      [`${WA_PHONE} msg ${B}:B2`]: { text: "message two", who: b },
      [`${WA_PHONE} msg ${B}:B3`]: { text: "look", who: b },
      [`${WA_PHONE} msg ${B}:B4`]: null,
      [`${WA_PHONE} msg ${B}:B5`]: { text: "reply text", who: b },
      [`${WA_MAC} chat ${GROUP}`]: { title: "Group Alpha", text: "" },
      [`${WA_MAC} chat ${B}`]: { title: "+1 555-000-0002", text: "", who: b },
      [`${WA_MAC} chat ${A_LID}`]: { title: "Person A", text: "", who: [...a, A_LID] },
      [`${WA_MAC} msg ${GROUP}:G1`]: { text: "group hello", who: c },
      [`${WA_MAC} msg ${GROUP}:G4`]: { text: "group words from a lid", who: [A_LID] },
      [`${WA_MAC} msg ${GROUP}:G5`]: { text: "group words, older shape", who: c },
      [`${WA_MAC} msg ${GROUP}:G2`]: null,
      [`${WA_MAC} msg ${GROUP}:G3`]: null,
      [`${WA_MAC} msg ${B}:B1`]: { text: "message one", who: b },
      [`${WA_MAC} msg ${B}:B2`]: { text: "message two", who: b },
      [`${WA_MAC} msg ${B}:B3`]: { text: "look", who: b },
      [`${WA_MAC} msg ${B}:B4`]: null,
      [`${WA_MAC} msg ${B}:B5`]: { text: "reply text", who: b },
      [`${WA_MAC} msg ${B}:B6`]: null,
      [`${WA_MAC} msg ${B}:B7`]: null,
      [`${WA_MAC} msg ${B}:B9`]: { text: "a message stating no time", who: b },
      [`${WA_MAC} msg ${A_LID}:A1`]: { text: "hello from a", who: [...a, A_LID] },
      [`${WA_MAC} msg ${A_LID}:A2`]: { text: "hello back", who: [A_LID] },
      [`${WA_MAC} msg status@broadcast:S1`]: null,
      [`${WA_MAC} pushname ${C}`]: { title: "Person C", text: "", who: c },
    });
    write(home, "texts.json", [...texts]);
  });

  it("the golden: extracts, asks and day files of the first order", () => {
    const home = world("golden");
    const asks = uniqueAsks(home.asks());
    home.answer();
    const days = home.render();
    writeDays(home, days);
    const extracts = home.extracts().map(({ unit, reading, days: on, content }) => ({ unit, reading, days: on, content }));
    write(home, "extracts.json", extracts);
    write(home, "asks.json", asks);
    const golden = {
      extracts,
      asks,
      units: extracts.map(({ unit }) => parseMessagesUnit(unit)),
      days: Object.fromEntries([...days].map(([day, files]) => [day, files.txt.split("\n")])),
    };
    const text = `${JSON.stringify(golden, null, 2)}\n`;
    write(home, "messages.golden.json", text);
    if (UPDATE) writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, "utf8"));
    pin(messages, { messages: FED.messages }, home.extracts());
  });
});

describe("People's work, birthday and profiles", () => {
  const ON = "T16:00:00Z";
  const wish = (chat: string, stanza: string, day: string, text = "Happy birthday!!", more: Partial<WaMessage> = {}) => wa({ chat, stanza, at: Date.parse(`${day}${ON}`), fromMe: true, text, ...more });
  const jid = (n: number) => `1555000${String(n).padStart(4, "0")}@s.whatsapp.net`;
  const phone = (n: number) => `+1555000${String(n).padStart(4, "0")}`;
  const fold = (home: Home, details: StatedDetails[] = []): Map<string, PersonDetail> => home.read((view) => {
    const chats = [...view.extracts(MESSAGES_FAMILY)].map((row) => chatDayPart(row.content, SETTINGS, NETWORKS)).filter((part) => part.total > 0);
    const cards = [...view.records(CONTACTS, "contact")].flatMap(({ head, version: found }): Card[] => {
      const parts = cardParts(found.content);
      return parts === null ? [] : [readCard(head, head.since_ms, parts)];
    });
    const answer = peopleOf({
      networks: NETWORKS, chats, mail: [], labels: readLabels(view, null, NETWORKED), cards, records: [], providers: new Map(), country: "1", own: ownHandles(view, NETWORKED.own, NETWORKS), faces: null, photos: [], details, day: SETTINGS,
      groups: { words: new Map(), rules: GROUP_RULES },
    });
    return new Map(answer.persons.map((person) => [person.id, person]));
  });
  const offered = (person: PersonDetail | undefined, kind: string) => (person?.suggestions ?? []).filter((each) => each.kind === kind).map(({ value, reasons, ticked }) => ({ value, reasons, ticked }));

  it("a wish in a group, the other party's, or one year's suggests a birthday; a late wish, a tie or a day always wished on time is read otherwise", () => {
    const home = new Home(join(root, "wishes"));
    homes.push(home);
    home.deliver({ name: "cards", source: CONTACTS, stated_ms: T1, rows: [
      card("card-w1", "Person W One", [`TEL:${phone(71)}`]), card("card-w2", "Person W Two", [`TEL:${phone(72)}`]), card("card-w3", "Person W Three", [`TEL:${phone(73)}`]),
      card("card-w4", "Person W Four", [`TEL:${phone(74)}`, "BDAY:--1102"]), card("card-c", "Person C", [`TEL:${phone(3)}`]), card("card-w5", "Person W Five", [`TEL:${phone(75)}`]),
    ] });
    home.deliver({ name: "wishes", source: WA_MAC, stated_ms: T2, rows: [
      wish(jid(71), "W1A", "2024-08-14"), wish(jid(71), "W1B", "2025-08-15", "Happy b’day 🎉"),
      wa({ chat: jid(71), stanza: "W1C", at: Date.parse(`2023-08-14${ON}`), text: "Happy birthday to you too" }),
      wish(jid(72), "W2A", "2025-03-03", "hbd"),
      wish(jid(73), "W3A", "2024-02-10"), wish(jid(73), "W3B", "2025-02-10"), wish(jid(73), "W3C", "2024-06-20", "MANY HAPPY RETURNS"), wish(jid(73), "W3D", "2025-06-20"),
      wish(jid(74), "W4A", "2024-11-02"), wish(jid(74), "W4B", "2025-11-02", "happiest birthday"),
      wish(GROUP, "WGA", "2024-05-05", "Happy birthday Person C!", { from: GROUP }), wish(GROUP, "WGB", "2025-05-05", "Happy birthday Person C!", { from: GROUP }),
      wa({ chat: GROUP, stanza: "WGC", at: Date.parse(`2025-05-05${ON}`), from: GROUP, member: C, text: "thank you all" }),
      wish(jid(75), "W5A", "2024-07-07", "birthday party on friday?"), wish(jid(75), "W5B", "2025-07-07", "happy day, birth of a plan"),
      waChat(GROUP, { partner: "Group Alpha", group: true }),
    ] });
    const people = fold(home);
    const w1 = offered(people.get(`phone:${phone(71)}`), "birthday");
    expect(w1).toEqual([{ value: "08-14", reasons: { wished: 2 }, ticked: false }]);
    expect(offered(people.get(`phone:${phone(72)}`), "birthday")).toEqual([]);
    expect(offered(people.get(`phone:${phone(73)}`), "birthday")).toEqual([]);
    expect(offered(people.get(`phone:${phone(74)}`), "birthday")).toEqual([{ value: "11-02", reasons: { cards: 1, wished: 2 }, ticked: true }]);
    expect(offered(people.get(`phone:${phone(3)}`), "birthday")).toEqual([]);
    expect(offered(people.get(`phone:${phone(75)}`), "birthday")).toEqual([]);
    const parts = home.read((view) => [...view.extracts(MESSAGES_FAMILY)].map((row) => chatDayPart(row.content, SETTINGS, NETWORKS)));
    expect(parts.filter((part) => part.wished.length > 0).map((part) => [part.chat, part.wished]).sort()).toEqual([
      [jid(71), ["2024-08-14"]], [jid(71), ["2025-08-15"]], [jid(72), ["2025-03-03"]], [jid(73), ["2024-02-10"]], [jid(73), ["2024-06-20"]], [jid(73), ["2025-02-10"]],
      [jid(73), ["2025-06-20"]], [jid(74), ["2024-11-02"]], [jid(74), ["2025-11-02"]],
    ].sort());
    const said = fold(home, [{ key: `phone:${phone(71)}`, stated_ms: T3, details: { work: null, birthday: { month: 8, day: 14, year: null }, profiles: [] } }]);
    expect(offered(said.get(`phone:${phone(71)}`), "birthday")).toEqual([]);
    expect(said.get(`phone:${phone(71)}`)?.details).toEqual({ work: null, birthday: { month: 8, day: 14, year: null }, profiles: [] });
    write(home, "wishes.json", Object.fromEntries([71, 72, 73, 74, 3, 75].map((n) => [phone(n), people.get(`phone:${phone(n)}`)?.suggestions ?? []])));
  });

  it("a card's 1604 year read as a year, a business's ORG as its work, a link kept with its query or capitals, a second work or birthday offered, a profile the guard refuses, or a suggestion the details say offered", () => {
    const home = new Home(join(root, "cards"));
    homes.push(home);
    home.deliver({ name: "cards", source: CONTACTS, stated_ms: T1, rows: [
      card("card-k", "Person K Synthetic", ["N:Synthetic;Person K;;;", `TEL:${phone(81)}`, "TITLE:Product designer", "ORG:Synthetic Labs;Design",
        "BDAY;X-APPLE-OMIT-YEAR=1604:1604-08-14", "URL;type=pref:https://www.instagram.com/Person.K/?hl=en", "item1.URL:http\\://person-k.example.com/about/?ref=card",
        "X-SOCIALPROFILE;type=twitter:https://twitter.com/Person_K", "X-SOCIALPROFILE;type=linkedin;x-user=person-k-synthetic:x-apple:person-k-synthetic"]),
      card("card-l", "Person L Synthetic", ["N:Synthetic;Person L;;;", `TEL:${phone(82)}`, "BDAY:1604-03-05", "ORG:Synthetic Studio"]),
      card("card-m", "Person M Synthetic", ["N:Synthetic;Person M;;;", `TEL:${phone(83)}`, "BDAY:19900305", "TITLE:Engineer"]),
      card("card-bakery", "Synthetic Bakery", ["ORG:Synthetic Bakery", "TITLE:Owner", `TEL:${phone(84)}`]),
      card("card-n1", "Person N Synthetic", ["N:Synthetic;Person N;;;", `TEL:${phone(85)}`, "TITLE:Engineer", "ORG:Synthetic Works", "BDAY:1990-03-05"]),
      card("card-n2", "Person N Synthetic", ["N:Synthetic;Person N;;;", `TEL:${phone(85)}`, "TITLE:Engineer", "ORG:Synthetic Works", "BDAY:1990-03-05"]),
      card("card-n3", "Person N Synthetic", ["N:Synthetic;Person N;;;", `TEL:${phone(85)}`, "TITLE:Founder", "ORG:Another Synthetic", "BDAY:--0306"]),
      card("card-o", "Person O Synthetic", ["N:Synthetic;Person O;;;", `TEL:${phone(86)}`, "URL:https://www.linkedin.com/in/j%C3%B6rg-synthetic/",
        "URL:https://Person-O.Example.com/About/Me/", "URL:https://github.com/Person-O", "URL:https://person-o.example.org/go/https://elsewhere.example.com",
        `URL:https://person-o.example.net/${"a".repeat(200)}`]),
    ] });
    const people = fold(home);
    const k = people.get(`phone:${phone(81)}`);
    expect(offered(k, "work")).toEqual([{ value: "Product designer, Synthetic Labs", reasons: { cards: 1 }, ticked: true }]);
    expect(offered(k, "birthday")).toEqual([{ value: "08-14", reasons: { cards: 1 }, ticked: true }]);
    expect(offered(k, "profile")).toEqual([
      { value: "instagram:person.k", reasons: { cards: 1 }, ticked: true }, { value: "linkedin:person-k-synthetic", reasons: { cards: 1 }, ticked: true },
      { value: "site:person-k.example.com/about", reasons: { cards: 1 }, ticked: true }, { value: "x:person_k", reasons: { cards: 1 }, ticked: true },
    ]);
    expect(offered(people.get(`phone:${phone(82)}`), "birthday").map((each) => each.value)).toEqual(["03-05"]);
    expect(offered(people.get(`phone:${phone(82)}`), "work").map((each) => each.value)).toEqual(["Synthetic Studio"]);
    expect(offered(people.get(`phone:${phone(83)}`), "birthday").map((each) => each.value)).toEqual(["1990-03-05"]);
    expect(offered(people.get(`phone:${phone(83)}`), "work").map((each) => each.value)).toEqual(["Engineer"]);
    expect(offered(people.get(`phone:${phone(84)}`), "work")).toEqual([]);
    expect(offered(people.get(`phone:${phone(85)}`), "work")).toEqual([{ value: "Engineer, Synthetic Works", reasons: { cards: 2 }, ticked: true }]);
    expect(offered(people.get(`phone:${phone(85)}`), "birthday")).toEqual([{ value: "1990-03-05", reasons: { cards: 2 }, ticked: true }]);
    expect(offered(people.get(`phone:${phone(86)}`), "profile")).toEqual([
      { value: "github:person-o", reasons: { cards: 1 }, ticked: true }, { value: "linkedin:jörg-synthetic", reasons: { cards: 1 }, ticked: true },
      { value: "site:person-o.example.com/About/Me", reasons: { cards: 1 }, ticked: true },
      { value: "site:person-o.example.org/go/https://elsewhere.example.com", reasons: { cards: 1 }, ticked: false },
    ]);
    const profiles = [...people.values()].flatMap((person) => offered(person, "profile")).map(({ value }) => {
      const colon = value.indexOf(":");
      return { network: value.slice(0, colon), value: value.slice(colon + 1) };
    });
    expect(profiles.filter((profile) => profileFault(profile) !== undefined)).toEqual([]);
    const said = fold(home, [{ key: `phone:${phone(81)}`, stated_ms: T3, details: {
      work: "product designer, synthetic labs", birthday: { month: 8, day: 14, year: 1990 }, profiles: [{ network: "instagram", value: "person.k" }] } }]);
    const stated = said.get(`phone:${phone(81)}`);
    expect([offered(stated, "work"), offered(stated, "birthday")]).toEqual([[], []]);
    expect(offered(stated, "profile").map((each) => each.value)).toEqual(["linkedin:person-k-synthetic", "site:person-k.example.com/about", "x:person_k"]);
    expect(stated?.work).toBe("product designer, synthetic labs");
    expect(people.get(`phone:${phone(81)}`)).not.toHaveProperty("work");
    write(home, "cards.json", Object.fromEntries([81, 82, 83, 84, 85, 86].map((n) => [phone(n), people.get(`phone:${phone(n)}`)?.suggestions ?? []])));
  });
});

describe("groups the owner is quiet in", () => {
  const FRIENDS = "120363000000000011@g.us";
  const SHOP = "120363000000000012@g.us";
  const LEFT = "120363000000000013@g.us";
  const BARE = "120363000000000014@g.us";
  const NIGHT = "120363000000000015@g.us";
  const EDGE = "120363000000000016@g.us";
  const F = "15550000021@s.whatsapp.net";
  const S = "15550000022@s.whatsapp.net";
  const key = (chat: string) => `whatsapp:${chat}`;
  const utc = (day: string, clock = "16:00") => Date.parse(`${day}T${clock}:00Z`);
  let stanza = 0;
  const mine = (chat: string, when: number) => wa({ chat, stanza: `Q${++stanza}`, at: when, fromMe: true, text: "synthetic own words" });
  const from = (chat: string, member: string, when: number) => wa({ chat, stanza: `Q${++stanza}`, at: when, from: chat, member, text: "synthetic words" });
  const shell = (chat: string, partner: string, archived = false): ReaderOutput => {
    const row = waChat(chat, { partner, group: chat.endsWith("@g.us") });
    if (archived) ((row.content as { chat: Record<string, Json> }).chat).ZARCHIVED = 1;
    return row;
  };
  const range = (first: string, last: string, step = 1) => {
    const out: string[] = [];
    for (let day = first; day <= last; day = addDays(day, step)) out.push(day);
    return out;
  };
  const fold = (home: Home, rules: Partial<Record<string, Partial<GroupSettings>>> = {}, words: ReadonlyMap<string, boolean> = new Map()): PeopleAnswer => home.read((view) => {
    const labels = readLabels(view, null, NETWORKED);
    const chats = [...view.extracts(MESSAGES_FAMILY)].map((row) => chatDayPart(row.content, SETTINGS, NETWORKS)).filter((part) => part.total > 0);
    return peopleOf({
      networks: NETWORKS, chats, mail: [], labels, cards: [], records: [], providers: new Map(labels.table.providers), country: "1", own: ownHandles(view, NETWORKED.own, NETWORKS), faces: null, photos: [], details: [], day: SETTINGS,
      groups: { words, rules: { whatsapp: { ...GROUP_RULES.whatsapp!, ...rules.whatsapp }, imessage: { ...GROUP_RULES.imessage!, ...rules.imessage } } },
    });
  });
  const chatOf = (answer: PeopleAnswer, chat: string) => answer.list.chats.find((each) => each.key === key(chat));
  const personOf = (answer: PeopleAnswer, jid: string) => answer.persons.find((person) => person.id === `phone:+${jid.split("@")[0]}`);
  const fresh = (name: string) => {
    const home = new Home(join(root, name));
    homes.push(home);
    return home;
  };
  const month = (yours: readonly Span[], which: string): Span[] => {
    const first = `${which}-01`;
    const last = addDays(`${which === "2026-12" ? "2027-01" : `${which.slice(0, 5)}${String(Number(which.slice(5)) + 1).padStart(2, "0")}`}-01`, -1);
    return yours.flatMap(([from, to]): Span[] => to < first || from > last ? [] : [[from < first ? first : from, to > last ? last : to]]);
  };

  it("writing today changes a verdict before today, or writing every few days moves a past month", () => {
    const home = fresh("groups-today");
    home.deliver({ name: "talk", source: WA_MAC, stated_ms: T1, rows: [
      shell(FRIENDS, "Group Friends"), shell(LEFT, "Group Left"),
      ...range("2026-09-01", "2026-09-30", 5).map((day) => mine(FRIENDS, utc(day))),
      mine(LEFT, utc("2026-06-01")),
      ...range("2026-06-01", "2026-10-01").flatMap((day) => [from(FRIENDS, F, utc(day, "12:00")), from(LEFT, F, utc(day, "12:00"))]),
    ] });
    const before = fold(home);
    home.deliver({ name: "today", source: WA_MAC, stated_ms: T2, rows: [mine(FRIENDS, utc("2026-10-02")), mine(LEFT, utc("2026-10-02"))] });
    const after = fold(home);
    for (const chat of [FRIENDS, LEFT]) {
      const was = before.groups.get(key(chat))!.yours;
      const is = after.groups.get(key(chat))!.yours;
      for (const day of range("2026-06-01", "2026-10-01")) expect(quiet(is, day), `${chat} ${day}`).toBe(quiet(was, day));
      expect(quiet(is, "2026-10-02"), chat).toBe(false);
    }
    expect(before.groups.get(key(LEFT))!.yours).toEqual([["2026-06-01", "2026-08-29"]]);
    expect(chatOf(before, LEFT)?.quiet).toEqual({ why: "silent", last_day: "2026-06-01" });
    expect(chatOf(after, LEFT)?.quiet).toBeNull();
    expect(before.groups.get(key(FRIENDS))!.yours).toEqual([["2026-09-01", addDays("2026-09-26", 89)]]);
    for (const which of ["2026-09", "2026-10"]) expect(month(after.groups.get(key(FRIENDS))!.yours, which), which).toEqual(month(before.groups.get(key(FRIENDS))!.yours, which));
    write(home, "today.json", { before: Object.fromEntries(before.groups), after: Object.fromEntries(after.groups) });
  });

  it("a group archived on the Mac but not on an older phone backup reads as archived, or never stops archived and the word", () => {
    const home = fresh("groups-archived");
    home.deliver({ name: "mac", source: WA_MAC, stated_ms: T1, rows: [shell(SHOP, "Group Shop", true), mine(SHOP, utc("2026-10-02")), from(SHOP, S, utc("2026-10-02", "17:00"))] });
    home.deliver({ name: "phone", source: WA_PHONE, stated_ms: T2, rows: [shell(SHOP, "Group Shop")] });
    expect(chatOf(fold(home), SHOP)?.quiet).toBeNull();
    home.deliver({ name: "phone archives", source: WA_PHONE, stated_ms: T3, rows: [shell(SHOP, "Group Shop", true)] });
    const archived = fold(home);
    expect(chatOf(archived, SHOP)?.quiet).toEqual({ why: "archived", last_day: "2026-10-02" });
    expect(archived.groups.get(key(SHOP))!.yours).toEqual([]);
    expect(archived.quiet).toEqual({ whatsapp: 1, imessage: 0 });
    expect(chatOf(fold(home, { whatsapp: { archived: false } }), SHOP)?.quiet).toBeNull();
    expect(chatOf(fold(home, {}, new Map([[key(SHOP), false]])), SHOP)).toMatchObject({ quiet: null, word: false });
    expect(fold(home, {}, new Map([[key(SHOP), false]])).groups.get(key(SHOP))!.yours).toEqual([EVERY_DAY]);
    expect(chatOf(fold(home, { whatsapp: { archived: false } }, new Map([[key(SHOP), true]])), SHOP)).toMatchObject({ quiet: { why: "owner" }, word: true });
    expect(chatOf(fold(home, { whatsapp: { after_days: null } }), SHOP)?.quiet).toEqual({ why: "archived", last_day: "2026-10-02" });
  });

  it("an archived one-to-one chat has a verdict, or a group with no chat record is archived", () => {
    const home = fresh("groups-bare");
    home.deliver({ name: "talk", source: WA_MAC, stated_ms: T1, rows: [
      shell(B, "Person B", true), mine(B, utc("2026-06-01")), from(B, B, utc("2026-10-02")),
      mine(BARE, utc("2026-06-01")), from(BARE, F, utc("2026-10-02")),
    ] });
    const answer = fold(home);
    const b = chatOf(answer, B)!;
    expect(b.group).toBe(false);
    expect(b).not.toHaveProperty("quiet");
    expect(answer.groups.has(key(B))).toBe(false);
    expect(chatOf(answer, BARE)?.quiet).toEqual({ why: "silent", last_day: "2026-06-01" });
    expect(chatOf(fold(home, { whatsapp: { after_days: null } }), BARE)?.quiet).toBeNull();
  });

  it("a friend's group messages count on days the stream does not count, or as one-to-one, where the AI test sees them", () => {
    const home = fresh("groups-friend");
    const rounds = Array.from({ length: 25 }, (_, round) => {
      const asked = utc("2026-10-02", "16:00") + round * 10 * 60_000;
      return [wa({ chat: FRIENDS, stanza: `R${round}m`, at: asked, fromMe: true, text: "synthetic question" }),
        wa({ chat: FRIENDS, stanza: `R${round}a`, at: asked + 5_000, from: FRIENDS, member: F, text: "synthetic answer" }),
        wa({ chat: FRIENDS, stanza: `R${round}b`, at: asked + 6_000, from: FRIENDS, member: F, text: "synthetic answer" })];
    }).flat();
    home.deliver({ name: "talk", source: WA_MAC, stated_ms: T1, rows: [shell(FRIENDS, "Group Friends"), ...rounds,
      ...Array.from({ length: 7 }, (_, n) => from(FRIENDS, F, utc("2026-10-01", "16:0" + n)))] });
    const counted = (talk: GroupSettings["talk"]) => {
      const person = personOf(fold(home, { whatsapp: { talk } }), F);
      return { received: person?.received ?? 0, days: person?.days ?? {}, ai: (person?.suggestions ?? []).filter((each) => each.kind === "entity").map((each) => each.value) };
    };
    const joined = counted("joined");
    expect(joined).toEqual({ received: 50, days: { "2026-10-02": 50 }, ai: [] });
    expect(counted("all")).toEqual({ received: 57, days: { "2026-10-01": 7, "2026-10-02": 50 }, ai: [] });
    expect(counted("none")).toMatchObject({ received: 0, ai: [] });
    write(home, "friend.json", { joined, all: counted("all"), none: counted("none") });
  });

  it("a message at 01:00 UTC or 03:59 misses its civil day, or a group falls quiet late because now is one chat's", () => {
    const home = fresh("groups-civil");
    home.deliver({ name: "talk", source: WA_MAC, stated_ms: T1, rows: [
      from(NIGHT, F, utc("2026-10-02", "16:00")), mine(NIGHT, utc("2026-10-03", "01:00")),
      mine(EDGE, utc("2026-10-05", "07:59")), from(EDGE, F, utc("2026-10-05", "07:00")),
      mine(LEFT, utc("2026-06-01")), mine(FRIENDS, utc("2026-06-01")), from(FRIENDS, F, utc("2026-12-01")),
    ] });
    const answer = fold(home);
    expect(answer.groups.get(key(NIGHT))).toEqual({ yours: [["2026-10-02", addDays("2026-10-02", 89)]], first_day: "2026-10-02", last_day: "2026-10-02" });
    expect(answer.groups.get(key(EDGE))).toEqual({ yours: [["2026-10-04", addDays("2026-10-04", 89)]], first_day: "2026-10-04", last_day: "2026-10-04" });
    expect(Object.fromEntries([LEFT, FRIENDS, NIGHT, EDGE].map((chat) => [chat, chatOf(answer, chat)?.quiet ?? null]))).toEqual({
      [LEFT]: { why: "silent", last_day: "2026-06-01" }, [FRIENDS]: { why: "silent", last_day: "2026-06-01" }, [NIGHT]: null, [EDGE]: null,
    });
    expect(answer.quiet).toEqual({ whatsapp: 2, imessage: 0 });
    expect(personOf(answer, F)?.last_30).toBe(0);
    expect(answer.list.chats.map((chat) => chat.key)).toEqual([key(EDGE), key(NIGHT), key(FRIENDS), key(LEFT)]);
  });

  it("a group moves keys, a one-to-one chat under two keys has a verdict, or a group has no row", () => {
    const answer = fold(world("groups-keys"));
    expect([...answer.groups.keys()]).toEqual(["imessage:+15550000004,person-e@example.com", `whatsapp:${GROUP}`]);
    expect(Object.fromEntries(answer.list.chats.filter((chat) => chat.group).map((chat) => [chat.key, chat.quiet]))).toEqual({
      "imessage:+15550000004,person-e@example.com": null, [`whatsapp:${GROUP}`]: { why: "silent", last_day: null },
    });
    for (const chat of answer.list.chats.filter((each) => !each.group)) expect(chat, chat.key).not.toHaveProperty("quiet");
  });

  it("a quiet group prints its messages, a yours or missing month does not, or the fold counts messages outside the day", () => {
    const home = world("groups-lines");
    home.deliver({ name: "early", source: WA_MAC, stated_ms: T3, rows: [from(GROUP, C, utc("2026-10-02", "05:00"))] });
    const unit = `group:whatsapp:${GROUP}:2026-10`;
    const render = (yours: Span[] | undefined) => home.read((view) => {
      const base = tableUnits(readLabels(view, null, NETWORKED));
      const units: LabelUnits = (asked) => asked === unit && yours !== undefined ? { reading: `month:${JSON.stringify(yours)}`, code: LABELS_CODE, content: { yours } as unknown as Json } : base(asked);
      return new Map(["2026-10-01", "2026-10-02"].map((day) => [day, renderDay(day, [messages], dayReader(view), SETTINGS, units)]));
    });
    const missing = render(undefined);
    const yours = render([["2026-10-01", "2026-10-31"]]);
    const silent = render([]);
    const only2nd = render([["2026-10-01", "2026-10-01"]]);
    for (const day of ["2026-10-01", "2026-10-02"]) expect(yours.get(day)!.txt, day).toBe(missing.get(day)!.txt);
    expect(missing.get("2026-10-02")!.txt).toContain("group hello");
    const quietDay = silent.get("2026-10-02")!.txt;
    expect(quietDay).not.toContain("group hello");
    expect(quietDay).toContain(`${QUIET_TITLE}\n  Group Alpha · 3 messages`);
    expect(silent.get("2026-10-01")!.txt).toContain(`${QUIET_TITLE}\n  Group Alpha · 1 message`);
    expect(only2nd.get("2026-10-01")!.txt).toBe(missing.get("2026-10-01")!.txt);
    expect(only2nd.get("2026-10-02")!.txt).toBe(quietDay);
    const atoms = (JSON.parse(silent.get("2026-10-02")!.json) as { atoms: { text: string; block?: { key: string; title: string }; record?: unknown; section?: string }[] }).atoms
      .filter((atom) => atom.block?.title === QUIET_TITLE);
    expect(atoms.map(({ text, block, record }) => ({ text, block, record }))).toEqual([{ text: "Group Alpha · 3 messages", block: { key: `whatsapp:${GROUP}`, title: QUIET_TITLE }, record: undefined }]);
    write(home, "quiet-day.txt", quietDay);
  });

  it("a quiet group whose messages come from two accounts' copies states one of them", () => {
    const home = world("groups-accounts");
    const other = "whatsapp:15550000009:macbook-pro-0001";
    home.db.commit((tx) => tx.tables.sources.add({ id: other, vendor: SYNTHETIC_VENDOR, connector: "whatsapp", added_ms: 0 }));
    home.deliver({ name: "other", source: other, stated_ms: T3, rows: [waChat(GROUP, { partner: "Group Alpha", group: true }), from(GROUP, C, utc("2026-10-02", "18:00"))] });
    const unit = `group:whatsapp:${GROUP}:2026-10`;
    const day = home.read((view) => {
      const base = tableUnits(readLabels(view, null, NETWORKED));
      const units: LabelUnits = (asked) => asked === unit ? { reading: "month:[]", code: LABELS_CODE, content: { yours: [] } as unknown as Json } : base(asked);
      return conforming(renderDay("2026-10-02", [messages], dayReader(view), SETTINGS, units));
    });
    const atoms = (JSON.parse(day.json) as DayDocument).atoms.filter((atom) => atom.block?.title === QUIET_TITLE);
    expect(atoms.map(({ text, accounts }) => ({ text, accounts }))).toEqual([{ text: "Group Alpha · 4 messages", accounts: [accountOf(WA_MAC), accountOf(other)] }]);
  });

  it("a reply that names its parent from another account's copy states only its own account", () => {
    const home = fresh("reply-accounts");
    const other = "whatsapp:15550000009:macbook-pro-0001";
    home.db.commit((tx) => tx.tables.sources.add({ id: other, vendor: SYNTHETIC_VENDOR, connector: "whatsapp", added_ms: 0 }));
    home.deliver({ name: "parent", source: other, stated_ms: T3, rows: [wa({ chat: B, stanza: "P1", at: utc("2026-10-02", "18:00"), text: "synthetic parent" })] });
    home.deliver({ name: "reply", source: WA_MAC, stated_ms: T3, rows: [wa({ chat: B, stanza: "P2", at: utc("2026-10-02", "18:01"), fromMe: true, text: "synthetic reply", parent: "P1" })] });
    const day = home.read((view) => conforming(renderDay("2026-10-02", [messages], dayReader(view), SETTINGS, tableUnits(readLabels(view, null, NETWORKED)))));
    const atoms = (JSON.parse(day.json) as DayDocument).atoms.filter((atom) => atom.family === MESSAGES_FAMILY);
    expect(atoms.map(({ text, accounts }) => [text.includes("reply to"), accounts])).toEqual([[false, undefined], [true, [accountOf(WA_MAC), accountOf(other)]]]);
  });
});

describe("what People judges someone to be", () => {
  const SHOP = "15550000051@s.whatsapp.net";
  const SHOP_LID = "90000000000051@lid";
  const FRIEND = "15550000052@s.whatsapp.net";
  const LISTED_ONLY = "15550000053@s.whatsapp.net";
  const DAY = "2026-10-02";
  const business = (lid: string, phone: string | null, level: number): ReaderOutput => ({
    kind: "business", key: lid, content: { type: "whatsapp.business", ZJID: lid, ZPHONENUMBERJID: phone, ZNAME: "Synthetic Business", ZVERIFICATIONLEVEL: level },
  });
  let stanza = 0;
  const mine = (chat: string) => wa({ chat, stanza: `J${++stanza}`, at: T1 + stanza * 60_000, fromMe: true, text: "synthetic own words" });
  const address = (address: string, names: string[], counts: { from?: number; to?: number; machine?: number }) => ({
    address, from: counts.from === undefined ? {} : { [DAY]: counts.from }, to: counts.to === undefined ? {} : { [DAY]: counts.to }, machine: counts.machine ?? 0,
    names: { from: names, to: [] }, first_ms: T1, last_ms: T1,
  });
  const MAIL: MailDayPart = { addresses: [
    address("alerts-noreply@bank.example.com", ["Example Bank"], { from: 4 }),
    address("hello@shop.example.com", ["Alpha at Shop", "Bravo from Shop", "Charlie Shop"], { from: 3 }),
    address("person-l@example.com", ["Person L"], { machine: 5 }),
    address("person-m@example.com", ["Person M"], { from: 2 }),
    address("no-reply@calendar.example.com", ["Person M (via Calendar)"], { from: 1 }),
    address("orders-noreply@shop51.example.com", ["Synthetic Business"], { from: 2 }),
  ] };
  const folded = (home: Home, records: RecordState[] = [], cards: Card[] = [], mail: MailDayPart = MAIL) => home.read((view) => {
    const labels = readLabels(view, null, NETWORKED);
    const chats = [...view.extracts(MESSAGES_FAMILY)].map((row) => chatDayPart(row.content, SETTINGS, NETWORKS)).filter((part) => part.total > 0);
    return peopleOf({
      networks: NETWORKS, chats, mail: [mail], labels, cards, records, providers: new Map(labels.table.providers), country: "1", own: ownHandles(view, NETWORKED.own, NETWORKS),
      faces: null, photos: [], details: [], day: SETTINGS, groups: { words: new Map(), rules: GROUP_RULES },
    });
  });
  const fold = (home: Home, records: RecordState[] = [], cards: Card[] = [], mail: MailDayPart = MAIL): Map<string, PersonDetail> =>
    new Map(folded(home, records, cards, mail).persons.map((person) => [person.id, person]));
  const entityOf = (people: Map<string, PersonDetail>, id: string) => [people.get(id)?.entity, (people.get(id)?.suggestions ?? []).filter((each) => each.kind === "entity").map(({ value, reasons, ticked }) => ({ value, reasons, ticked }))];

  it("a business, a friend on WhatsApp's business app, an id no one met, or the owner's word judged otherwise", () => {
    const home = new Home(join(root, "judged-whatsapp"));
    homes.push(home);
    home.deliver({ name: "talk", source: WA_MAC, stated_ms: T1, rows: [
      ...[1, 2, 3].flatMap(() => [mine(SHOP), mine(FRIEND)]),
      business(SHOP_LID, SHOP, 3), business("90000000000052@lid", FRIEND, 1), business("90000000000053@lid", LISTED_ONLY, 3),
      business("90000000000050@lid", "15550000000@s.whatsapp.net", 3),
    ] });
    const people = fold(home);
    expect(entityOf(people, "phone:+15550000000")).toEqual(["person", []]);
    expect(entityOf(people, "phone:+15550000051")).toEqual(["business", []]);
    expect(entityOf(people, "phone:+15550000052")).toEqual(["person", [{ value: "business", reasons: { whatsapp: 1 }, ticked: false }]]);
    expect([...people.keys()].filter((id) => id.includes("15550000053") || id.includes("90000000000053"))).toEqual([]);
    const record = (slug: string, anchor: string): RecordState => ({
      record: { slug, name: "Person S", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false, anchor: { kind: "phone", value: anchor }, handles: [], excluded: [], dismissed: [], merged_into: null, also_called: [] },
      since: new Map([[`phone:${anchor}`, 1]]), me_since: null, merged_since: null,
    });
    expect(fold(home, [record("person-s", "+15550000051")]).get("person:person-s")?.entity).toBe("person");
    expect(folded(home).list.organise.businesses).toEqual([{ id: "phone:+15550000052", reasons: { whatsapp: 1 } }]);
    const saidPerson = folded(home, [record("person-f", "+15550000052")]);
    expect(entityOf(new Map(saidPerson.persons.map((person) => [person.id, person])), "person:person-f")).toEqual(["person", []]);
    expect(saidPerson.list.organise.businesses).toEqual([]);
    const offer = folded(home).persons.find((person) => person.id === "phone:+15550000052")!.suggestions.find((each) => each.kind === "entity")!.id;
    const declined = folded(home, [{ ...record("person-f", "+15550000052"), record: { ...record("person-f", "+15550000052").record, entity: null, dismissed: [offer] } }]);
    expect(entityOf(new Map(declined.persons.map((person) => [person.id, person])), "person:person-f")).toEqual(["person", []]);
    expect(declined.list.organise.businesses).toEqual([]);
    const card = (key: string, body: string) => readCard({ source: CONTACTS, key }, 1, cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\n${body}\r\nEND:VCARD\r\n` })!);
    const own = fold(home, [], [card("card-d", "FN:Person D\r\nTEL:+15550000051\r\nEMAIL:person-d@example.com")]);
    const doctor = [...own.values()].find((person) => person.name === "Person D")!.id;
    expect(entityOf(own, doctor)).toEqual(["person", [{ value: "business", reasons: { whatsapp: 3 }, ticked: false }]]);
    const orders = fold(home, [], [card("card-o", "FN:Synthetic Business\r\nTEL:+15550000051\r\nEMAIL:orders-noreply@shop51.example.com")]);
    expect(entityOf(orders, [...orders.values()].find((person) => person.name === "Synthetic Business")!.id)).toEqual(["business", []]);
  });

  it("a no-reply sender left a person, a relay judged a business, or a person posting to a list or with a no-reply address beside their own judged none", () => {
    const home = new Home(join(root, "judged-mail"));
    homes.push(home);
    const people = fold(home);
    expect(people.get("email:alerts-noreply@bank.example.com")?.entity).toBe("bot");
    expect(people.get("email:hello@shop.example.com")?.entity).toBe("person");
    expect(people.get("email:person-l@example.com")?.entity).toBe("person");
    const card = (key: string, body: string) => readCard({ source: CONTACTS, key }, 1, cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\n${body}\r\nEND:VCARD\r\n` })!);
    const joined = fold(home, [], [card("card-m", "FN:Person M\r\nEMAIL:person-m@example.com\r\nEMAIL:no-reply@calendar.example.com")]);
    expect([...joined.values()].filter((person) => person.name === "Person M").map((person) => person.entity)).toEqual(["person"]);
    const author = fold(home, [], [card("card-w", "FN:Avri Writer\r\nEMAIL:hello@shop.example.com")]);
    const id = [...author.values()].find((person) => person.name === "Avri Writer")!.id;
    expect(entityOf(author, id)).toEqual(["person", [{ value: "business", reasons: { relay: 1 }, ticked: false }]]);
  });

  it("a name like a business's the home knows offered, never judged: a given name the dictionary holds, a brand's surname, a namesake, a dotted name, a doctor's practice, a push name, a person the owner said", () => {
    const home = new Home(join(root, "judged-named"));
    homes.push(home);
    const pushName = (jid: string, name: string): ReaderOutput => ({ kind: "pushname", key: jid, content: { type: "whatsapp.pushname", ZJID: jid, ZPUSHNAME: name } });
    const verified = (lid: string, phone: string | null, name: string): ReaderOutput => ({
      kind: "business", key: lid, content: { type: "whatsapp.business", ZJID: lid, ZPHONENUMBERJID: phone, ZNAME: name, ZVERIFICATIONLEVEL: 3 },
    });
    home.deliver({ name: "named", source: WA_MAC, stated_ms: T1, rows: [
      ...["15550000069@s.whatsapp.net", "15550000070@s.whatsapp.net"].flatMap((jid) => [mine(jid), mine(jid), mine(jid)]),
      pushName("15550000069@s.whatsapp.net", "Exampleshop"), pushName("15550000070@s.whatsapp.net", "Exampleshop"),
      business("90000000000070@lid", "15550000070@s.whatsapp.net", 1),
      verified("90000000000071@lid", null, "Synthshop"), verified("90000000000075@lid", null, "Rose Baker"),
      verified("90000000000079@lid", "15550000079@s.whatsapp.net", "Avri Clinic"),
    ] });
    const mail: MailDayPart = { addresses: [
      address("orders-noreply@mail.exampleshop.co.in", [], { from: 4 }),
      address("hello@shoplex.co.in", ["Alpha at Shoplex", "Bravo from Shoplex", "Charlie Shoplex"], { from: 3 }),
      address("letters@personwriter.example", ["Personwriter"], { machine: 6 }),
      address("alerts-noreply@ab.example", [], { from: 2 }),
      address("noreply@garden.example", [], { from: 2 }),
      address("noreply@zandrelzorvath.example", [], { from: 2 }),
      address("noreply@ownshop.example", [], { from: 2 }),
    ] };
    const card = (key: string, ...lines: string[]) => readCard({ source: CONTACTS, key }, 1, cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.join("\r\n")}\r\nEND:VCARD\r\n` })!);
    const cards = [
      card("c61", "FN:Exampleshop Delivery", "TEL:+15550000061"), card("c62", "FN:Avri Exampleshop", "TEL:+15550000062"),
      card("c63", "FN:Personwriter", "TEL:+15550000063"), card("c64", "FN:AB", "TEL:+15550000064"), card("c65", "FN:Garden", "TEL:+15550000065"),
      card("c66", "FN:Zandrel Zorvath", "TEL:+15550000066"), card("c67", "FN:Shoplex.co.in", "TEL:+15550000067"), card("c68", "FN:Synthshop Support", "TEL:+15550000068"),
      card("c72", "FN:Exampleshop Delivery", "NICKNAME:Avri", "TEL:+15550000072"),
      card("c73", "FN:Jay Exampleshop", "TEL:+15550000073"), card("c74", "FN:Exampleshop", "TEL:+15550000074"), card("c75", "FN:Rose Baker", "TEL:+15550000075"),
      card("c76", "FN:Exampleshop.Avri", "TEL:+15550000076"), card("c77", "FN:Exampleshop.co.in", "TEL:+15550000077"),
      card("c78", "FN:Avri Doctor", "TEL:+15550000078", "TEL:+15550000079"),
      card("c80", "FN:Ownshop Delivery", "TEL:+15550000080"),
    ];
    const named = { value: "business", reasons: { named: 1 }, ticked: false };
    const people = fold(home, [], cards, mail);
    const judged = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, entityOf(people, `phone:+155500000${id}`)]));
    expect(judged(["61", "67", "68", "73", "74", "75", "77", "80"])).toEqual({
      61: ["person", [named]], 67: ["person", [named]], 68: ["person", [named]], 73: ["person", [named]], 74: ["person", [named]],
      75: ["person", [named]], 77: ["person", [named]], 80: ["person", [named]],
    });
    expect(judged(["62", "72", "63", "64", "65", "66", "76"])).toEqual(Object.fromEntries(["62", "72", "63", "64", "65", "66", "76"].map((id) => [id, ["person", []]])));
    expect(entityOf(people, "phone:+15550000078")).toEqual(["person", [{ value: "business", reasons: { whatsapp: 3 }, ticked: false }]]);
    expect(entityOf(people, "phone:+15550000069")).toEqual(["person", []]);
    expect(entityOf(people, "phone:+15550000070")).toEqual(["person", [{ value: "business", reasons: { whatsapp: 1, named: 1 }, ticked: false }]]);
    const said: RecordState = {
      record: { slug: "person-o", name: "Person O", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false, anchor: { kind: "email", value: "noreply@ownshop.example" }, handles: [], excluded: [], dismissed: [], merged_into: null, also_called: [] },
      since: new Map([["email:noreply@ownshop.example", 1]]), me_since: null, merged_since: null,
    };
    expect(entityOf(fold(home, [said], cards, mail), "phone:+15550000080")).toEqual(["person", []]);
  });
});
