import type { DayAtom, DayDocument } from "./days.js";
import type { RecordRef } from "@lifestreamprotocol/core";
import { appMinutes, appName, callHeadOf, callOf, capital, checkInOf, counted, dictatedApp, duration, mailOf, NB, paymentOf, productId, productOf, who, type Products } from "./day-words.js";

export type EpisodesFile = Pick<DayDocument, "day" | "zone" | "window" | "coverage" | "atoms">;

export interface EpisodesExtras {
  sleep?: Record<string, { start_ms: number; end_ms: number }>;
  sent?: string[];
  groups?: string[];
  sources?: { id: string; read_through_ms: number | null }[];
  products?: Products;
}

type Atom = DayAtom;

export interface HeldPhoto {
  item: string;
  hash: string;
  at_ms: number | null;
  video: boolean;
  duration_ms: number | null;
  live?: true;
}

export type Kind = "stay" | "move" | "sleep" | "workout" | "sitting" | "phone" | "browsing" | "conversation" | "ai" | "call"
  | "mail_sent" | "mail_received" | "event" | "note" | "voice_note" | "dictation" | "search" | "photos" | "listening"
  | "check_in" | "payment" | "other";

export type Run = { type: "text"; text: string; tone: "secondary" | "tertiary" } | { type: "quote"; text: string } | { type: "list"; items: string[] }
  | { type: "span"; text: string; tone: "secondary"; start_ms: number; end_ms: number }
  | { type: "titles"; items: string[] } | { type: "tiles"; photos: HeldPhoto[]; more: number };

export type Count = { text: string } | { sent: number } | { received: number };

export interface Row {
  name: string;
  note: string;
  words: Run[];
  count: Count | null;
  quiet: boolean;
}

export type Mode = "walk" | "run" | "transit" | "drive";

export interface Episode {
  id: string;
  kind: Kind;
  family: string;
  title: string | null;
  row: Row;
  start_ms: number | null;
  end_ms: number | null;
  at_ms: number | null;
  atoms: number[];
  count?: number;
  mode?: Mode | null;
  sent?: number;
  group?: boolean;
  within?: string;
  folder?: string;
  product?: string;
}

export interface Gap {
  id: string;
  start_ms: number;
  end_ms: number;
  played: string[];
  row: Row;
}

export interface Name {
  text: string;
  firstRowId: string;
  at_ms: number | null;
}

export interface Hour {
  start_ms: number;
  rows: string[];
  sent: number;
  names: Name[];
}

export interface Chapter {
  kind: "stay" | "move" | "none" | "day";
  episode: string | null;
  start_ms: number;
  end_ms: number;
  rows: string[];
  gaps: Gap[];
  names: Name[];
  hours?: Hour[];
}

export interface Figures {
  asleep_ms: number | null;
  steps: number | null;
  places: number | null;
  people: number | null;
  mac_ms: number | null;
  phone_ms: number | null;
  recovery: number | null;
  sent: number | null;
  received: number | null;
}

export interface Contact {
  key: string;
  title: string;
  sent: number;
  received: number;
  first_ms: number;
}

export interface People {
  contacts: Contact[];
  groups: { key: string; title: string }[];
}

export interface DayEpisodes {
  chapters: Chapter[];
  episodes: Episode[];
  also: string[];
  all_day: string[];
  untimed: { rows: string[]; names: Name[] };
  plan: string[];
  headings: number[];
  figures: Figures;
  people: People;
  updated: number | null;
}

export const QUIET_MS = 30 * 60000;
export const GAP_MS = 20 * 60000;
export const HOURS_OVER = 12;

export const figuresOnly = (atom: Atom): boolean => atom.family === "health" && atom.unit.startsWith("span/") && !isHeading(atom);

const isHeading = (atom: Atom): boolean => atom.flags.includes("heading");
const untimed = (atom: Atom): boolean => atom.flags.includes("date_only") || atom.flags.includes("no_time");
const unitKind = (atom: Atom): string => atom.unit.slice(0, atom.unit.indexOf("/"));
const firstLine = (text: string): string => text.split("\n")[0] as string;
const quietLine = (atom: Atom): boolean => atom.family === "messages" && untimed(atom) && atom.text.includes(" · ");
const PLAIN = "plain";
const streamOf = (atom: Atom): string => atom.record?.source ?? atom.block?.key ?? "";
const OWNER = "the user";
const UNKNOWN = "an unknown number";
const speaker = (atom: Atom): string => {
  const colon = atom.text.indexOf(": ");
  return colon < 0 ? "" : atom.text.slice(0, colon);
};
const UNSAID = new Set([OWNER, "the group", ""]);
export const received = (atom: Atom): boolean => atom.family === "messages" && !UNSAID.has(speaker(atom));

export function workoutMs(atom: Atom): number | null {
  const stated = /(?:— |, )duration (\d+):(\d\d)\b/u.exec(atom.text);
  return stated ? (Number(stated[1]) * 60 + Number(stated[2])) * 60000 : null;
}

interface Draft {
  key: string;
  kind: Kind;
  atoms: Atom[];
  also: boolean;
}

interface Span {
  start_ms: number | null;
  end_ms: number | null;
}

interface Context {
  window: { start_ms: number; end_ms: number };
  today: number | null;
  zone: string;
  groups: Set<string>;
  sittings: Map<string, string>;
  products: Products;
}

export function episodes(file: EpisodesFile, extras: EpisodesExtras, now: number | null = null): DayEpisodes {
  const { window } = file;
  const today = now !== null && window.start_ms <= now && now < window.end_ms ? now : null;
  const sleeps = extras.sleep ?? {};
  const sent = new Set(extras.sent ?? []);
  const groups = new Set(extras.groups ?? []);
  const drafts = new Map<string, Draft>();
  const headings: number[] = [];
  const stayParts: Atom[] = [];
  const recoveries: Atom[] = [];
  const chats = new Map<string, { at: number; index: number }>();
  let searched: { at: number; index: number } | null = null;

  const add = (key: string, kind: Kind, atom: Atom): void => {
    const draft = drafts.get(key);
    if (draft) draft.atoms.push(atom);
    else drafts.set(key, { key, kind, atoms: [atom], also: false });
  };

  for (const atom of file.atoms) {
    if (untimed(atom)) {
      drafts.set(`also:${atom.n}`, { key: `also:${atom.n}`, kind: aloneKind(atom, sent), atoms: [atom], also: true });
      continue;
    }
    if (isHeading(atom)) {
      if (atom.family === "health" && Object.hasOwn(sleeps, atom.unit)) {
        add(`sleep:${atom.unit}`, "sleep", atom);
      } else headings.push(atom.n);
      continue;
    }
    if (figuresOnly(atom)) continue;
    const own = `${atom.family}:${atom.n}`;
    const block = atom.block ? `${atom.family}:block:${atom.block.key}` : own;
    switch (atom.family) {
      case "physical": {
        const kind = unitKind(atom);
        if ((kind === "stay" || kind === "seen") && /^(?:At|In) /u.test(atom.text)) add(own, "stay", atom);
        else if (kind === "stay" || kind === "seen") stayParts.push(atom);
        else if (kind === "trip") add(block, "move", atom);
        else if (kind === "report" || kind === "vigilance") add(own, "check_in", atom);
        else add(own, "other", atom);
        break;
      }
      case "health":
        if (unitKind(atom) === "phone") add(own, "phone", atom);
        else if (atom.text.startsWith("nap — ")) add(own, "sleep", atom);
        else if (atom.text.startsWith("workout — ")) add(own, "workout", atom);
        else if (atom.text === "recovery" || atom.text.startsWith("recovery — ")) recoveries.push(atom);
        else add(block, "other", atom);
        break;
      case "screen":
        add(`sitting:${atom.unit}`, "sitting", atom);
        break;
      case "phone":
        add(own, "phone", atom);
        break;
      case "web": {
        if (atom.record?.kind !== "search") {
          add(block, "browsing", atom);
          break;
        }
        const at = atom.start_ms as number;
        const index: number = !searched ? 0 : at - searched.at >= QUIET_MS ? searched.index + 1 : searched.index;
        searched = { at, index };
        add(`web:search#${index}`, "search", atom);
        break;
      }
      case "messages": {
        const chat = atom.block?.key ?? atom.unit;
        const at = atom.start_ms as number;
        const last = chats.get(chat);
        const index = !last ? 0 : at - last.at >= QUIET_MS ? last.index + 1 : last.index;
        chats.set(chat, { at, index });
        add(`messages:chat:${chat}#${index}`, "conversation", atom);
        break;
      }
      case "ai":
        add(block, "ai", atom);
        break;
      case "calls":
        add(atom.record ? callKey(atom.record) : own, "call", atom);
        break;
      case "callaudio":
        add(atom.joins ? callKey(atom.joins) : block, "call", atom);
        break;
      case "mail":
        if (isSent(atom, sent)) add(own, "mail_sent", atom);
        else add(`mail:hour:${hourOf(atom.start_ms as number, file.zone)}`, "mail_received", atom);
        break;
      case "calendar":
        add(own, "event", atom);
        break;
      case "notes":
        add(own, "note", atom);
        break;
      case "voice":
        add(block, isDictation(atom) ? "dictation" : "voice_note", atom);
        break;
      case "photos":
        add(block, "photos", atom);
        break;
      case "listening":
        add(own, "listening", atom);
        break;
      case "money":
        add(own, "payment", atom);
        break;
      default:
        add(block, "other", atom);
    }
  }

  const spanOfDraft = (draft: Draft): Span => draft.key.startsWith("sleep:") ? { ...sleeps[draft.key.slice("sleep:".length)] } as Span
    : spanOf(draft.kind === "call" ? callAtoms(draft.atoms) : draft.atoms);

  const stays = [...drafts.values()].filter((draft) => draft.kind === "stay");
  for (const atom of stayParts) {
    const at = atom.start_ms as number;
    const holding = stays.filter((stay) => {
      const span = spanOf(stay.atoms);
      return span.start_ms !== null && span.start_ms <= at && at <= (span.end_ms ?? span.start_ms);
    });
    const ownUnit = holding.filter((stay) => firstOf(stay).unit === atom.unit);
    const stay = (ownUnit.length ? ownUnit : holding).sort(byFirstStart).at(-1);
    if (stay) stay.atoms.push(atom);
    else add(`physical:${atom.n}`, "other", atom);
  }
  const nights = [...drafts.values()].filter((draft) => draft.kind === "sleep");
  for (const atom of recoveries) {
    const night = nights.find((draft) => spanOfDraft(draft).end_ms === atom.start_ms);
    if (night) night.atoms.push(atom);
    else add(`health:${atom.n}`, "other", atom);
  }

  const ordered = [...drafts.values()].map((draft) => ({ ...draft, atoms: [...draft.atoms].sort((left, right) => left.n - right.n) }))
    .sort((left, right) => firstOf(left).n - firstOf(right).n);
  const sittings = new Map(ordered.filter((draft) => draft.kind === "sitting").map((draft) => [firstOf(draft).unit, `e${firstOf(draft).n}`]));
  const ctx: Context = { window, today, zone: file.zone, groups, sittings, products: extras.products ?? {} };
  const list = ordered.map((draft) => finish(draft, draft.also ? { start_ms: null, end_ms: null } : spanOfDraft(draft), ctx));

  const byN = new Map(file.atoms.map((atom) => [atom.n, atom]));
  const plan = list.filter((episode) => today !== null && episode.kind === "event" && (episode.at_ms as number) > today);
  const also = list.filter((episode) => episode.at_ms === null);
  const allDay = also.filter((episode) => episode.kind === "event" && (byN.get(episode.atoms[0] as number) as Atom).flags.includes("date_only"));
  const rest = also.filter((episode) => !allDay.includes(episode));
  return {
    chapters: chaptersOf(list.filter((episode) => !plan.includes(episode)), ctx, byN),
    episodes: list,
    also: also.map((episode) => episode.id),
    all_day: allDay.map((episode) => episode.id),
    untimed: { rows: rest.map((episode) => episode.id), names: namesOf(rest.map((episode) => episode.id), indexOf(rest)) },
    plan: plan.map((episode) => episode.id),
    headings,
    figures: figuresOf(file, list),
    people: peopleOf(file, list),
    updated: updatedOf(file, extras),
  };
}

export function readsOf(file: Pick<EpisodesFile, "window" | "coverage">, extras: Pick<EpisodesExtras, "sources" | "products">): Map<string, number> {
  const { start_ms, end_ms } = file.window;
  const through = new Map((extras.sources ?? []).map((row) => [row.id, row.read_through_ms]));
  const least = new Map<string, number | null>();
  for (const family of file.coverage ?? []) {
    for (const { source, read } of family.sources) {
      const now = through.get(source);
      const into = read === "into" && now !== undefined && now !== null && now >= start_ms;
      const ms = read === "through" ? end_ms : into ? Math.min(Math.floor((now as number) / 60_000) * 60_000, end_ms) : null;
      const held = least.get(source);
      least.set(source, held === undefined ? ms : held === null || ms === null ? null : Math.min(held, ms));
    }
  }
  const named = new Map<string, number>();
  for (const [source, ms] of least) {
    if (ms === null) continue;
    const product = productOf(extras.products, source).row;
    named.set(product, Math.min(named.get(product) ?? ms, ms));
  }
  return named;
}

export function updatedOf(file: Pick<EpisodesFile, "window" | "coverage">, extras: Pick<EpisodesExtras, "sources" | "products">): number | null {
  const newest = Math.max(...readsOf(file, extras).values());
  return Number.isFinite(newest) ? newest : null;
}

const head = (atoms: Atom[]): Atom => atoms[0] as Atom;
const firstOf = (draft: { atoms: Atom[] }): Atom => head(draft.atoms);

const byFirstStart = (left: Draft, right: Draft): number =>
  (firstOf(left).start_ms ?? 0) - (firstOf(right).start_ms ?? 0) || firstOf(left).n - firstOf(right).n;

function spanOf(atoms: Atom[]): Span {
  const timed = atoms.filter((atom) => atom.start_ms !== null);
  if (!timed.length) return { start_ms: null, end_ms: null };
  if (atoms.length === 1) return { start_ms: head(atoms).start_ms, end_ms: head(atoms).end_ms };
  return {
    start_ms: Math.min(...timed.map((atom) => atom.start_ms as number)),
    end_ms: Math.max(...timed.map((atom) => (atom.end_ms ?? atom.start_ms) as number)),
  };
}

const INSTANT = new Set<Kind>(["mail_sent", "mail_received", "photos", "check_in", "payment"]);
const COUNTED = new Set<Kind>(["conversation", "mail_received", "photos", "dictation", "search"]);

const anchorOf = (kind: Kind, span: Span, window: { start_ms: number }): number =>
  Math.max((kind === "sleep" ? span.end_ms ?? span.start_ms : span.start_ms) as number, window.start_ms);

function finish(draft: Draft, span: Span, ctx: Context): Episode {
  const { kind } = draft;
  const atoms = kind === "call" ? callOrder(draft.atoms) : draft.atoms;
  const first = head(atoms);
  const words = titleOf(kind, atoms);
  const title = words === null ? null : firstLine(words);
  const count = kind === "ai" ? atoms.filter((atom) => atom.record).length : atoms.length;
  const name = nameOf(kind, atoms, title, count, ctx.products);
  const end_ms = INSTANT.has(kind) ? null : span.end_ms;
  const sent = atoms.filter((atom) => speaker(atom) === OWNER).length;
  const folder = kind === "ai" && (first.block?.title ?? "").startsWith(`${name} in `) ? folderOf(first.block?.title ?? "") : undefined;
  const episode: Episode = {
    id: `e${firstOf(draft).n}`, kind, family: first.family, title,
    row: rowOf({ kind, atoms, name, title, start_ms: span.start_ms, end_ms, sent, folder }, ctx),
    start_ms: span.start_ms, end_ms, at_ms: draft.also ? null : anchorOf(kind, span, ctx.window), atoms: atoms.map((atom) => atom.n),
  };
  if (COUNTED.has(kind) || kind === "ai") episode.count = count;
  if (kind === "move") episode.mode = modeOf(atoms);
  if (kind === "conversation") {
    episode.sent = sent;
    episode.group = ctx.groups.has(first.block?.key ?? first.unit);
  }
  if (kind === "browsing" && !draft.also && first.block && ctx.sittings.has(first.block.key)) {
    episode.within = ctx.sittings.get(first.block.key) as string;
  }
  if (folder !== undefined) episode.folder = folder;
  if (first.family === PLAIN) episode.product = productId(streamOf(first));
  return episode;
}

const ALONE_KINDS: Record<string, Kind> = { money: "payment", calendar: "event", notes: "note", photos: "photos", calls: "call", callaudio: "call",
  listening: "listening", phone: "phone" };

const callKey = (record: RecordRef): string => `call:${record.source} ${record.key}`;

const callRank = (atom: Atom): number => atom.family === "calls" ? 0 : callHeadOf(atom) !== null ? 1 : 2;

function callOrder(atoms: Atom[]): Atom[] {
  return [...atoms].sort((left, right) => callRank(left) - callRank(right));
}

function callAtoms(atoms: Atom[]): Atom[] {
  const rank = Math.min(...atoms.map(callRank));
  return rank === 2 ? atoms : atoms.filter((atom) => callRank(atom) === rank);
}

function aloneKind(atom: Atom, sent: Set<string>): Kind {
  if (atom.family === "mail") return isSent(atom, sent) ? "mail_sent" : "mail_received";
  if (atom.family === "voice") return isDictation(atom) ? "dictation" : "voice_note";
  if (atom.family === "web" && atom.record?.kind === "search") return "search";
  return ALONE_KINDS[atom.family] ?? "other";
}

const isSent = (atom: Atom, sent: Set<string>): boolean => Boolean(atom.record && sent.has(`${atom.record.source} ${atom.record.key}`));
const isDictation = (atom: Atom): boolean => atom.record?.kind === "dictation";

const minutes = new Map<string, Intl.DateTimeFormat>();

export function hourOf(ms: number, zone: string): number {
  let formatter = minutes.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, minute: "2-digit", second: "2-digit" });
    minutes.set(zone, formatter);
  }
  const parts = formatter.formatToParts(ms);
  const part = (type: string): number => Number(parts.find((each) => each.type === type)?.value ?? 0);
  return ms - part("minute") * 60000 - part("second") * 1000 - (ms % 1000);
}

function titleOf(kind: Kind, atoms: Atom[]): string | null {
  const first = head(atoms);
  switch (kind) {
    case "stay":
      return stayPlace(first.text);
    case "move":
      return route(first);
    case "sleep":
    case "mail_received":
    case "photos":
    case "check_in":
      return null;
    case "workout": {
      const facts = first.text.slice("workout — ".length).split(", ");
      const lead = facts[0] as string;
      return lead.startsWith("duration ") ? null : lead;
    }
    case "sitting":
      return (first.block?.title ?? "").replace(/^Screen(?:: )?/u, "") || null;
    case "phone":
      return phoneApps(first);
    case "browsing":
      return sites(atoms);
    case "search":
      return term(first.text);
    case "conversation":
      return first.block?.title ? who(first.block.title) : null;
    case "ai":
      return first.block?.title ?? null;
    case "call": {
      const heard = callHeadOf(first);
      if (heard !== null) return heard.holder || null;
      const call = callOf(first.text);
      return call.who || call.group || null;
    }
    case "mail_sent":
    case "event":
    case "note":
      return quoted(first.text);
    case "voice_note":
    case "dictation":
      return voiceWords(first.text);
    case "listening":
      return afterColon(first.text);
    case "payment":
      return merchant(first.text);
    default:
      return first.family === PLAIN ? first.text : first.block?.title ?? first.text;
  }
}

function nameOf(kind: Kind, atoms: Atom[], title: string | null, count: number, products: Products): string {
  const first = head(atoms);
  switch (kind) {
    case "sleep":
      return first.text.startsWith("nap — ") ? "Nap" : "Woke";
    case "sitting":
      return "Mac";
    case "phone":
      return "Phone";
    case "dictation":
      return "Dictated";
    case "search":
      return "Searched";
    case "voice_note":
      return "Voice note";
    case "payment":
      return "Payment";
    case "mail_sent":
      return "Mail";
    case "mail_received":
      return counted(count, "mail");
    case "photos":
      return count === 1 ? "Photo" : "Photos";
    case "check_in":
      return unitKind(first) === "vigilance" ? "Vigilance test" : "Check-in";
    case "ai":
      return productOf(products, first.block?.key ?? first.unit).row;
    case "listening":
      return productOf(products, first.record?.source ?? first.unit).row;
    case "move":
      return moveName(atoms);
    case "workout":
      return title ? capital(title) : "Workout";
    case "call":
      return title ? capital(title) : "Call";
    case "other":
      if (quietLine(first)) return first.text.slice(0, first.text.lastIndexOf(" · "));
      if (first.family === "health") return healthLine(first.text)?.name ?? "Health";
      if (first.family === PLAIN) return productOf(products, streamOf(first)).row;
      return first.block ? title ?? "" : capital(first.family);
    default:
      return title ?? capital(kind.replace("_", " "));
  }
}

export const stayPlace = (text: string): string => text.replace(/^(?:At|In) /u, "")
  .replace(/ \((?:still there at the last fix|stated by [^)]*|from photos|[^()]* said [^)]*; a photo at [^)]*)\)$/u, "");

export function placeOf(words: string): { name: string; words: Run[]; quiet: boolean } {
  const place = stayPlace(words);
  if (words.startsWith("In ")) return { name: place, words: [], quiet: true };
  const near = /^an unnamed place (\d+(?:\.\d+)? km) from (.+)$/u.exec(place);
  if (near) return { name: `Near ${near[2]}`, words: [text(`${near[1]} away`)], quiet: true };
  const city = /^an unnamed place in (.+)$/u.exec(place)?.[1];
  if (city) return { name: city, words: [], quiet: true };
  if (place === "an unnamed place") return { name: "Unnamed place", words: [], quiet: true };
  if (place === "a hidden place") return { name: place, words: [], quiet: true };
  return { name: place, words: [], quiet: false };
}

function route(atom: Atom): string | null {
  if (atom.block) return /^Trip, ([\s\S]*), \d+\.\d km, \d+ legs$/u.exec(atom.block.title)?.[1] ?? null;
  const match = /^(?:Moved \d+\.\d km, mode unclear|[^,(]*(?: \([^)]*\))?), ([\s\S]*?)(?:, \d+\.\d km(?: in [^,]*)?(?:, [\s\S]*)?)?$/u
    .exec(atom.text);
  return match && (match[1] as string).includes(" → ") ? match[1] as string : null;
}

const MODES: Record<string, Mode | "cycle"> = {
  Walk: "walk", Walking: "walk", "On foot": "walk",
  Run: "run", Running: "run",
  Cycle: "cycle", Cycling: "cycle",
  "Road vehicle": "drive", "Passenger vehicle": "drive", Motorcycling: "drive", Taxi: "drive",
  Flight: "transit", Flying: "transit", Bus: "transit", Train: "transit", Tram: "transit", Subway: "transit",
  Ferry: "transit", "Cable car": "transit", Gondola: "transit",
};

const leadWord = (text: string): string => (/^[^,(]*/u.exec(text)?.[0] as string).trim();
const doubtful = (text: string): boolean => /^[^,]*\(stated by [^)]*, doubtful\)/u.test(text);

function modeOf(legs: Atom[]): Mode | null {
  const modes = new Set(legs.flatMap((leg) => {
    if (doubtful(leg.text)) return [];
    const mode = MODES[leadWord(leg.text)];
    return mode ? [mode] : [];
  }));
  const [mode] = modes;
  return modes.size === 1 && mode !== undefined && mode !== "cycle" ? mode : null;
}

function phoneApps(atom: Atom): string | null {
  if (atom.family === "health") return /^Phone: [^,]*, ([\s\S]+)$/u.exec(atom.text)?.[1] ?? null;
  return afterColon(atom.text);
}

function sites(atoms: Atom[]): string | null {
  const found = atoms.flatMap((atom) => {
    const words = atom.text.replace(/^[^:"]*: (?=visited |searched |downloaded |tab open: )/u, "");
    const site = /^visited (\S+?)(?= \d+ times|: | \(|$)/u.exec(words)?.[1]
      ?? /^tab open: (?:"[\s\S]*" \(([^)]+)\)|(\S+))$/u.exec(words)?.slice(1).find(Boolean)
      ?? /^downloaded [\s\S]* from (\S+?)(?: \((?:cancelled|interrupted|under way)\))?$/u.exec(words)?.[1];
    return site ? [site] : [];
  });
  return found.length ? [...new Set(found)].join(", ") : null;
}

const term = (text: string): string | null => /searched "([\s\S]*)"(?: \(\d+ times\))?$/u.exec(text)?.[1] ?? null;

const MODE_WORDS: Record<string, string> = {
  "Road vehicle": "Drive", "Passenger vehicle": "Drive", Taxi: "Drive", Motorcycling: "Drive", Walking: "Walk",
  "On foot": "Walk", Running: "Run", Flying: "Flight", Cycling: "Cycle",
};

export function moveName(legs: Atom[]): string {
  const words = new Set(legs.flatMap((leg) => {
    if (doubtful(leg.text)) return [];
    const word = leadWord(leg.text);
    return !word || word === "Not recorded" || word.startsWith("Moved ") ? [] : [MODE_WORDS[word] ?? word];
  }));
  const [one] = words;
  const word = words.size === 1 && one ? one : "Move";
  const lead = head(legs);
  const km = (lead.block ? kilometres(lead.block.title) : null) ?? (legs.length === 1 ? kilometres(lead.text) : null);
  if (km === null) return word;
  return `${word} ${km >= 1000 ? Math.round(km).toLocaleString("en-US") : String(km)} km`;
}

function kilometres(words: string): number | null {
  const part = words.split(", ").map((each) => /^(?:Moved )?(\d+(?:\.\d+)?) km(?: |$)/u.exec(each)?.[1]).find(Boolean);
  return part === undefined ? null : Number(part);
}

function healthLine(text: string): { name: string; facts: string[] } | null {
  const facts = (rest: string): string[] => rest ? rest.split(", ") : [];
  if (text === "recovery" || text.startsWith("recovery — ")) return { name: "Recovery", facts: facts(text.slice("recovery — ".length)) };
  if (text.startsWith("day strain ")) return { name: "Strain", facts: facts(text.slice("day strain ".length)) };
  if (text.startsWith("Activity: ")) return { name: "Activity", facts: facts(text.slice("Activity: ".length)) };
  return null;
}

export function folderOf(title: string): string {
  const path = / in (\S+)$/u.exec(title)?.[1] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (path === "~" || /^~\/*$/u.test(path) || (/^\/(?:Users|home)\/[^/]+\/*$/u.test(path))) return "~";
  const last = parts.at(-1) ?? "";
  if (/^[a-z]+-[a-z]+-[0-9a-f]{4,}$/u.test(last)) {
    const repository = parts.slice(0, -1).reverse().find((part) => !/^\.?worktrees$/u.test(part) && !part.startsWith("."));
    return repository && repository !== "~" ? repository : "";
  }
  return /^[0-9a-f-]{12,}$/u.test(last) ? "" : last;
}

function quoted(text: string): string | null {
  return /“([\s\S]*?)”(?=$|[, :\n])/u.exec(text)?.[1] ?? null;
}

function afterColon(text: string): string | null {
  const colon = text.indexOf(": ");
  return colon < 0 ? null : text.slice(colon + 2);
}

function voiceWords(text: string): string | null {
  if (text.startsWith("Voice note, ")) return afterColon(text);
  return /"([\s\S]*)"/u.exec(text)?.[1] ?? null;
}

function merchant(text: string): string {
  return /^[−+][^ ]+ [A-Z]{3} [^:]*: ([\s\S]*) \(balance [^)]*\)(?: \[[^\]]*\])?$/u.exec(text)?.[1] ?? text;
}

interface RowParts {
  kind: Kind;
  atoms: Atom[];
  name: string;
  title: string | null;
  start_ms: number | null;
  end_ms: number | null;
  sent: number;
  folder: string | undefined;
}

const CALL_WORDS: Record<string, string> = { "They called": "Called you", "You called": "You called", Missed: "Missed call", "No answer": "No answer" };

function rowOf({ kind, atoms, name, title, start_ms, end_ms, sent, folder }: RowParts, ctx: Context): Row {
  const first = head(atoms);
  const lasted: Count | null = start_ms !== null && end_ms !== null && end_ms > start_ms ? { text: duration(end_ms - start_ms) } : null;
  const row = (words: Run[], count: Count | null = lasted, { note = "", quiet = false }: { note?: string; quiet?: boolean } = {}): Row =>
    ({ name, note, words, count, quiet });
  switch (kind) {
    case "conversation": {
      const mine = atoms.filter((atom) => speaker(atom) === OWNER).map((atom) => messageOf(atom.text));
      const said = quotes(mine.map((message) => message.words));
      const carried = sentWords(mine.flatMap((message) => message.carried));
      const came = atoms.filter(received).length;
      return row(said.length ? said : carried ? [text(carried)] : [],
        sent ? { sent } : came ? { received: came } : null, { quiet: !sent });
    }
    case "call": {
      const { way } = callHeadOf(first) === null ? callOf(first.text) : { way: "" };
      const said = CALL_WORDS[way];
      const summary = atoms.map(callHeadOf).find((heard) => heard !== null)?.title;
      return row([...said ? [text(said)] : [], ...summary ? [text(summary)] : []], way === "Missed" ? null : lasted);
    }
    case "sitting": {
      const pending = atoms.some((atom) => atom.text.includes("(account pending)"));
      const apps = appMinutes(title ?? "").filter((app) => app.name)
        .map((app) => app.minutes === null ? app.name : `${app.name} ${app.minutes < 1 ? "<1m" : duration(app.minutes * 60000)}`);
      const titles = atoms.filter((atom) => !/^(?:Summary|Did): /u.test(atom.text) && !atom.text.includes(" at the Mac ("))
        .map((atom) => oneLine(atom.text.replace(/ \[[^\]]*\]/gu, "")));
      return row(pending || !apps.length ? [text("Apps not counted yet")]
        : [{ type: "list", items: apps }, ...titles.length ? [{ type: "titles", items: titles } as Run] : []]);
    }
    case "phone": {
      const apps = title ? appMinutes(title).map((app) => app.name).filter(Boolean) : [];
      const stated = first.family === "health" ? /^Phone: (\d+) min/u.exec(first.text)?.[1] : undefined;
      return row(apps.length ? [{ type: "list", items: apps }] : [],
        stated === undefined ? lasted : { text: duration(Number(stated) * 60000) });
    }
    case "browsing":
      return row(quotes([...new Set(atoms.flatMap((atom) => [...atom.text.matchAll(/"([^"]+)"/gu)].map((match) => match[1] as string)))]));
    case "ai": {
      const prompts = atoms.filter((atom) => speaker(atom) === OWNER).map((atom) => atom.text.slice(OWNER.length + 2));
      const quote = prompts.find((prompt) => prompt.length >= 40)
        ?? prompts.reduce((longest, prompt) => prompt.length > longest.length ? prompt : longest, "");
      const conversation = first.block?.title ?? "";
      const note = folder ?? (conversation.startsWith(`${name} · `) ? conversation.slice(name.length + 3) : conversation);
      return row(quotes([quote]), prompts.length ? { text: counted(prompts.length, "prompt") } : null, { note });
    }
    case "dictation": {
      const app = dictatedApp(first.block?.title ?? first.text);
      return row(quotes(atoms.map((atom) => /"([\s\S]*)"/u.exec(atom.text)?.[1] ?? "")),
        { text: counted(atoms.length, "dictation") }, { note: app ? `to ${appName(app)}` : "" });
    }
    case "search":
      return row(quotes(atoms.map((atom) => /searched "([\s\S]*)"/u.exec(atom.text)?.[1] ?? "")),
        { text: counted(atoms.length, "search", "searches") });
    case "listening": {
      const played = heard(atoms);
      const names = [...new Set([...played.artists, ...played.shows])];
      return row(names.length ? [{ type: "list", items: names }] : [],
        played.tracks ? { text: counted(played.tracks, "track") } : played.pieces ? { text: counted(played.pieces, "episode") } : lasted);
    }
    case "workout": {
      const facts = first.text.replace(/^workout — /u, "").split(", ").filter((fact) => !fact.startsWith("duration "))
        .slice(title ? 1 : 0);
      const said = sourced(facts, sourceOf(first, ctx.products)).join(" · ");
      const stated = workoutMs(first);
      return row(said ? [text(said)] : [], stated === null ? lasted : { text: duration(stated) });
    }
    case "sleep": {
      const nap = name === "Nap";
      const source = nap ? "" : sourceOf(first, ctx.products);
      return row([
        ...start_ms !== null && end_ms !== null ? [{ type: "span", text: nap ? "" : "asleep", tone: "secondary", start_ms, end_ms } as const] : [],
        ...source ? [text(source)] : [],
      ]);
    }
    case "photos": {
      const held = photosOf(atoms);
      return row(held.length ? [{ type: "tiles", photos: held.slice(0, 4), more: Math.max(0, held.length - 4) }] : [],
        { text: counted(atoms.length, "photo") });
    }
    case "mail_sent": {
      const mail = mailOf(first.text);
      return row([text(mail.label === "Drafts" ? "Draft" : "Sent"), ...quotes([mail.subject])], null);
    }
    case "mail_received": {
      const senders = [...new Set(atoms.map((atom) => mailOf(atom.text).from).filter(Boolean))];
      return row(senders.length ? [{ type: "list", items: senders }] : [], null);
    }
    case "event": {
      const facts = first.text.replace(/^[^”]*”,?\s*/u, "").split(", ").filter(Boolean).map((fact) => fact.replace(/^you /u, ""));
      const calendar = first.record ? productOf(ctx.products, first.record.source).row : "Calendar";
      return row([text([calendar,
        ...first.flags.includes("date_only") ? ["all day"] : [], ...facts].join(" · "))]);
    }
    case "note": {
      const body = /^Note “[\s\S]*?” (?:written|created|edited)(?:: ([\s\S]*))?$/u.exec(first.text)?.[1] ?? "";
      return row(quotes([firstLine(body)]), null);
    }
    case "voice_note":
      return row(quotes([voiceWords(first.text) ?? ""]));
    case "check_in": {
      const check = checkInOf(first.text);
      return row([...check.answers.length ? [{ type: "list", items: check.answers } as Run] : [],
        ...quotes([check.note])], null);
    }
    case "payment": {
      const payment = paymentOf(first.text);
      return row([...payment.amount ? [text(`${payment.amount}${NB}${payment.currency}`)] : [], text(payment.merchant)], null);
    }
    case "move": {
      const missing = atoms.filter((atom) => atom.text.startsWith("Not recorded"))
        .reduce((sum, atom) => sum + Number(/(\d+(?:\.\d+)?) km/u.exec(atom.text)?.[1] ?? 0), 0);
      const from = Math.max(start_ms as number, ctx.window.start_ms);
      const to = Math.min(end_ms ?? from, ctx.today ?? ctx.window.end_ms);
      return row(missing && atoms.length > 1 ? [text(`${kilometresWords(missing)} of it not recorded`, "tertiary")] : [],
        to > from ? { text: duration(to - from) } : null);
    }
    case "stay": {
      const head = placeOf(first.text);
      return { name: head.name, note: "", words: head.words, count: null, quiet: head.quiet };
    }
    default: {
      if (quietLine(first)) {
        const held = /^([\d,]+) /u.exec(first.text.slice(first.text.lastIndexOf(" · ") + 3))?.[1];
        return row([], held ? { received: Number(held.replaceAll(",", "")) } : null, { quiet: true });
      }
      const line = first.family === "health" ? healthLine(first.text) : null;
      if (line) {
        const said = sourced(line.facts, sourceOf(first, ctx.products)).join(" · ");
        return row(said ? [text(said)] : [], null);
      }
      return row(title && title !== name ? [text(title)] : []);
    }
  }
}

interface GapSpan {
  start_ms: number;
  end_ms: number;
  played: Episode[];
}

function gapRow(gap: GapSpan, atoms: Map<number, Atom>): Row {
  const played = gap.played.map((episode) => heard(episode.atoms.map((n) => atoms.get(n) as Atom)));
  const whom = played.flatMap((each) => [...each.artists, ...each.shows])[0] ?? gap.played[0]?.row.name;
  const titles = [...new Set(played.flatMap((each) => each.titles))];
  const words: Run[] = whom === undefined ? [] : [text(whom), ...titles.length ? [{ type: "list", items: titles } as Run] : []];
  return { name: "Nothing recorded", note: "", words, count: { text: duration(gap.end_ms - gap.start_ms) }, quiet: true };
}

const text = (words: string, tone: "secondary" | "tertiary" = "secondary"): Run => ({ type: "text", text: words, tone });

const oneLine = (words: string): string => words.replace(/\s*\n\s*/gu, " ").trim();

const wordsIn = (words: string): boolean => /[\p{L}\p{N}]/u.test(words);

const quotes = (said: string[]): Run[] => said.map(oneLine).filter(wordsIn).map((words) => ({ type: "quote", text: words }));

export const sourceOf = (atom: Atom, products: Products): string => productOf(products, atom.record ? atom.record.source : atom.unit.split("/")[1] ?? "").row;

function sourced(facts: string[], source: string): string[] {
  const said = source.toLowerCase();
  const kept = facts.map((fact) => {
    const instrument = / \(([^()]+)\)$/u.exec(fact);
    return instrument && (instrument[1] as string).toLowerCase() === said ? fact.slice(0, instrument.index) : fact;
  });
  return [...kept, source].filter(Boolean);
}

const kilometresWords = (km: number): string => `${km >= 1000 ? Math.round(km).toLocaleString("en-US") : String(Math.round(km * 10) / 10)} km`;

const PART_KINDS = ["photo", "video", "voice note", "sticker", "document", "contact card", "location", "link preview", "link",
  "group event", "message deleted", "message unsent", "reaction", "attachment"];
const PART = new RegExp(`(?:^| )\\[(${PART_KINDS.join("|")})(?=[\\]:, ])`, "gu");
const SENT_KINDS: Record<string, string> = { photo: "photo", video: "video", "voice note": "voice note",
  sticker: "sticker", document: "document", "contact card": "contact card", location: "location", "link preview": "link",
  link: "link", attachment: "attachment" };

function messageOf(line: string): { words: string; carried: string[] } {
  const colon = line.indexOf(": ");
  let said = colon < 0 ? line : line.slice(colon + 2);
  if (said === "[empty message]") return { words: "", carried: [] };
  said = said.replace(/^\(forwarded\)(?: |$)/u, "").replace(/(?:^| )\(edited\)$/u, "")
    .replace(/(?:^| )\((?:reply to|to) [^()]*\)$/u, "");
  const carried: string[] = [];
  for (let part = [...said.matchAll(PART)].at(-1); part && said.endsWith("]"); part = [...said.matchAll(PART)].at(-1)) {
    const kind = SENT_KINDS[part[1] as string];
    if (kind) carried.unshift(kind);
    said = said.slice(0, part.index);
  }
  return { words: said.trim(), carried };
}

function sentWords(carried: string[]): string {
  const kinds = new Map<string, number>();
  for (const kind of carried) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  return kinds.size ? `Sent ${[...kinds].map(([kind, n]) => counted(n, kind)).join(", ")}` : "";
}

interface Heard {
  tracks: number;
  titles: string[];
  artists: string[];
  shows: string[];
  pieces: number;
}

function heard(atoms: Atom[]): Heard {
  const out: Heard = { tracks: 0, titles: [], artists: [], shows: [], pieces: 0 };
  const byWhom = (item: string): [string, string | null] => {
    const by = item.lastIndexOf(" by ");
    return by < 0 ? [item, null] : [item.slice(0, by), item.slice(by + 4)];
  };
  for (const atom of atoms) {
    const colon = atom.text.indexOf(": ");
    const words = oneLine(colon < 0 ? atom.text : atom.text.slice(colon + 2))
      .replace(/; offline, timed when logged$/u, "").replace(/; no end stated for [\s\S]*$/u, "");
    const bracketed = /^([\s\S]*?) \(([\s\S]*, \d+ min)\)$/u.exec(words);
    const alone = !bracketed && /, \d+ min$/u.test(words);
    const tracks = bracketed ? bracketed[1] as string : alone ? "" : words;
    for (const piece of bracketed ? (bracketed[2] as string).split("; ") : alone ? words.split("; ") : []) {
      const item = (/^([\s\S]*) in [^,]*, \d+ min$/u.exec(piece) ?? /^([\s\S]*), \d+ min$/u.exec(piece))?.[1] ?? piece;
      const [title, show] = byWhom(item);
      out.titles.push(title);
      if (show) out.shows.push(show);
      out.pieces += 1;
    }
    const tally = /^(\d+) tracks(?: in [\s\S]*?)?(?: — ([\s\S]*))?$/u.exec(tracks);
    if (tally) {
      out.tracks += Number(tally[1]);
      out.artists.push(...tally[2] ? tally[2].split(", ") : []);
    } else if (tracks) {
      for (const item of tracks.replace(/ in (?:(?! by )[^,])*$/u, "").split(", ")) {
        const [title, artist] = byWhom(item);
        out.titles.push(title);
        if (artist) out.artists.push(artist);
        out.tracks += 1;
      }
    }
  }
  return { ...out, artists: [...new Set(out.artists)], shows: [...new Set(out.shows)] };
}

export const photosOf = (atoms: Atom[]): HeldPhoto[] => [...new Map(atoms
  .filter((atom) => atom.family === "photos" && /^photo:[0-9a-f]{64}$/u.test(atom.item ?? ""))
  .map((atom): [string | undefined, HeldPhoto] => [atom.item, { item: atom.item as string, hash: `sha256:${atom.item?.slice("photo:".length)}`, at_ms: atom.start_ms,
    video: atom.video !== undefined, duration_ms: atom.video?.duration_ms ?? null, ...atom.live === true ? { live: true as const } : {} }]))
  .values()];

const indexOf = (rows: (Episode | Gap)[]): Map<string, Episode | Gap> => new Map(rows.map((row) => [row.id, row]));

const isGap = (row: Episode | Gap): row is Gap => "played" in row;
const atOf = (row: Episode | Gap): number => isGap(row) ? row.start_ms : row.at_ms as number;

interface Holder {
  kind: Chapter["kind"];
  episode: string | null;
  start_ms: number;
  end_ms: number;
  held: Episode[];
  order: number;
}

function chaptersOf(list: Episode[], ctx: Context, atoms: Map<number, Atom>): Chapter[] {
  const { window, today, zone } = ctx;
  const end = today ?? window.end_ms;
  const byAt = (left: Episode, right: Episode): number => atOf(left) - atOf(right) || (left.atoms[0] as number) - (right.atoms[0] as number);
  const rows = list.filter((episode) => episode.at_ms !== null && episode.kind !== "stay" && episode.kind !== "move"
    && episode.within === undefined).sort(byAt);
  const physical = list.filter((episode) => episode.kind === "stay" || episode.kind === "move").sort(byAt);

  const blocks: Holder[] = physical.map((episode, order) => ({
    kind: episode.kind as "stay" | "move", episode: episode.id, start_ms: episode.start_ms as number,
    end_ms: episode.end_ms ?? episode.start_ms as number, held: [], order,
  }));
  const stretches: Holder[] = [];
  if (!physical.length) stretches.push({ kind: "day", episode: null, start_ms: window.start_ms, end_ms: end, held: [], order: 0 });
  else {
    let from = window.start_ms;
    for (const episode of [...physical].sort((left, right) => (left.start_ms as number) - (right.start_ms as number))) {
      const start = Math.max(episode.start_ms as number, window.start_ms);
      if (start > from) stretches.push({ kind: "none", episode: null, start_ms: from, end_ms: start, held: [], order: physical.length });
      from = Math.max(from, Math.min(episode.end_ms ?? episode.start_ms as number, window.end_ms));
    }
    if (end > from) stretches.push({ kind: "none", episode: null, start_ms: from, end_ms: end, held: [], order: physical.length });
  }

  const all = [...blocks, ...stretches];
  for (const row of rows) {
    const at = atOf(row);
    const holder = [...blocks].reverse().find((block) => block.start_ms <= at && at < block.end_ms)
      ?? stretches.find((stretch) => stretch.start_ms <= at && at < stretch.end_ms)
      ?? all.filter((block) => block.start_ms <= at).sort((left, right) => left.start_ms - right.start_ms).at(-1);
    holder?.held.push(row);
  }
  return all.filter((block) => block.kind !== "none" || block.held.length || block.end_ms - block.start_ms >= GAP_MS)
    .sort((left, right) => left.start_ms - right.start_ms || left.order - right.order)
    .map((block) => {
      const spans: GapSpan[] = block.kind === "none" && !block.held.length ? [{ start_ms: block.start_ms, end_ms: block.end_ms, played: [] }]
        : gapsOf(block, block.held, today);
      const gaps: Gap[] = spans.map((gap) => ({ id: `gap:${gap.start_ms}`, start_ms: gap.start_ms, end_ms: gap.end_ms,
        played: gap.played.map((episode) => episode.id), row: gapRow(gap, atoms) }));
      const played = new Set(gaps.flatMap((gap) => gap.played));
      const placed: (Episode | Gap)[] = [...block.held.filter((row) => !played.has(row.id)), ...gaps]
        .sort((left, right) => atOf(left) - atOf(right) || Number(isGap(left)) - Number(isGap(right)));
      const index = indexOf([...block.held, ...gaps]);
      const ids = placed.map((row) => row.id);
      const chapter: Chapter = {
        kind: block.kind, episode: block.episode,
        start_ms: block.start_ms, end_ms: block.end_ms, rows: ids, gaps, names: namesOf(ids, index),
      };
      if (ids.length > HOURS_OVER) chapter.hours = hoursOf(ids, index, zone);
      return chapter;
    });
}

function gapsOf(span: { start_ms: number; end_ms: number }, rows: Episode[], now: number | null): GapSpan[] {
  const stop = now === null ? span.end_ms : Math.min(span.end_ms, now);
  const music = rows.filter((row) => row.kind === "listening");
  const occupied = rows.filter((row) => row.kind !== "listening").map((row): [number, number] => {
    const clip = (ms: number): number => Math.min(Math.max(ms, span.start_ms), stop);
    const start = row.start_ms as number;
    return [clip(start), clip(row.end_ms ?? start)];
  }).sort((left, right) => left[0] - right[0]);
  if (!occupied.length) return [];
  const gaps: GapSpan[] = [];
  const gap = (start: number, end: number): void => {
    if (end - start < GAP_MS) return;
    const played = music.filter((row) => (row.start_ms as number) >= start && (row.end_ms ?? row.start_ms as number) <= end);
    gaps.push({ start_ms: start, end_ms: end, played });
  };
  let cursor = span.start_ms;
  for (const [start, end] of occupied) {
    gap(cursor, start);
    cursor = Math.max(cursor, end);
  }
  gap(cursor, stop);
  return gaps;
}

function namesOf(ids: string[], rows: Map<string, Episode | Gap>): Name[] {
  const all = ids.map((id) => rows.get(id) as Episode | Gap);
  const length = (episode: Episode): string => duration((episode.end_ms ?? episode.start_ms as number) - (episode.start_ms as number));
  const mac = all.filter((row): row is Episode => !isGap(row) && row.kind === "sitting")
    .reduce((sum, row) => sum + (row.end_ms as number) - (row.start_ms as number), 0);
  const names = new Map<string, Name>();
  for (const row of all) {
    const said: [string, Episode][] = isGap(row)
      ? row.played.map((id) => [id, rows.get(id) as Episode])
      : [[row.id, row]];
    for (const [id, episode] of said) {
      const { name } = episode.row;
      const woke = episode.kind === "sleep" && name === "Woke";
      const shown = episode.kind === "photos" ? null
        : episode.kind === "mail_sent" || episode.kind === "mail_received" ? "Mail"
        : episode.kind === "sitting" ? `Mac ${duration(mac)}`
        : woke ? name
        : episode.kind === "workout" ? [name, episode.row.count && "text" in episode.row.count ? episode.row.count.text : ""].filter(Boolean).join(" ")
        : episode.kind === "sleep" || episode.kind === "listening" ? `${name} ${length(episode)}`
        : name || null;
      if (shown === null) continue;
      const key = woke ? `${shown} ${episode.end_ms}` : shown;
      if (!names.has(key)) names.set(key, { text: shown, firstRowId: id, at_ms: woke ? episode.end_ms : null });
    }
  }
  return [...names.values()];
}

function hoursOf(ids: string[], rows: Map<string, Episode | Gap>, zone: string): Hour[] {
  const hours = new Map<number, string[]>();
  for (const id of ids) {
    const start = hourOf(atOf(rows.get(id) as Episode | Gap), zone);
    hours.set(start, [...hours.get(start) ?? [], id]);
  }
  return [...hours].map(([start_ms, held]) => ({
    start_ms, rows: held,
    sent: held.reduce((sum, id) => {
      const row = rows.get(id) as Episode | Gap;
      return sum + (isGap(row) ? 0 : row.sent ?? 0);
    }, 0),
    names: namesOf(held, rows),
  }));
}

function peopleOf(file: EpisodesFile, list: Episode[]): People {
  const atoms = new Map(file.atoms.map((atom) => [atom.n, atom]));
  const contacts = new Map<string, Contact>();
  const groups = new Map<string, string>();
  for (const episode of list) {
    if (episode.at_ms === null || episode.kind !== "conversation") continue;
    const parts = episode.atoms.map((n) => atoms.get(n) as Atom);
    const lead = head(parts);
    const key = lead.block?.key ?? lead.unit;
    if (episode.group) {
      if (episode.sent && !groups.has(key)) groups.set(key, episode.title ?? key);
      continue;
    }
    const entry = contacts.get(key) ?? { key, title: episode.title ?? key, sent: 0, received: 0, first_ms: episode.at_ms };
    entry.sent += episode.sent ?? 0;
    entry.received += parts.filter(received).length;
    contacts.set(key, entry);
  }
  return {
    contacts: [...contacts.values()].sort((left, right) => right.sent - left.sent || left.first_ms - right.first_ms
      || (left.key < right.key ? -1 : 1)),
    groups: [...groups].map(([key, title]) => ({ key, title })),
  };
}

function figuresOf(file: EpisodesFile, list: Episode[]): Figures {
  const length = (episode: Episode): number => episode.start_ms === null || episode.end_ms === null ? 0 : episode.end_ms - episode.start_ms;
  const timed = (kind: Kind): Episode[] => list.filter((episode) => episode.kind === kind && episode.at_ms !== null);
  const atoms = new Map(file.atoms.map((atom) => [atom.n, atom]));
  const atomsOf = (episode: Episode): Atom[] => episode.atoms.map((n) => atoms.get(n) as Atom);

  const nights = timed("sleep").filter((episode) => atomsOf(episode).some(isHeading));
  const steps = file.atoms.filter((atom) => atom.family === "health" && isHeading(atom) && atom.unit.startsWith("vitals/"))
    .map((atom) => /(?:: |; )steps ([\d,]+) \(/u.exec(atom.text)?.[1]).find(Boolean);
  const recovery = file.atoms.filter((atom) => atom.family === "health" && !untimed(atom))
    .map((atom) => /^recovery — (?:[\s\S]*, )?score (\d+(?:\.\d+)?)(?:,|$)/u.exec(atom.text)?.[1]).find(Boolean);
  const stays = timed("stay");
  const messages = file.atoms.filter((atom) => atom.family === "messages" && !untimed(atom));

  const people = new Set(timed("conversation").flatMap((episode) => atomsOf(episode).filter(received).map(speaker)));
  people.delete(UNKNOWN);

  const sittings = timed("sitting");
  const phones = timed("phone");
  const hours = phones.filter((episode) => episode.family === "health");
  const stated = (episode: Episode): number => 60000 * Number(/^Phone: (\d+) min/u.exec(head(atomsOf(episode)).text)?.[1] ?? 0);
  return {
    asleep_ms: nights.length ? Math.max(...nights.map(length)) : null,
    steps: steps === undefined ? null : Number(steps.replaceAll(",", "")),
    places: stays.length ? new Set(stays.map((stay) => stay.title)).size : null,
    people: people.size || null,
    mac_ms: sittings.length ? sittings.reduce((sum, sitting) => sum + length(sitting), 0) : null,
    phone_ms: !phones.length ? null : hours.length ? hours.reduce((sum, hour) => sum + stated(hour), 0)
      : phones.reduce((sum, stretch) => sum + length(stretch), 0),
    recovery: recovery === undefined ? null : Math.round(Number(recovery)),
    sent: messages.length ? messages.filter((atom) => speaker(atom) === OWNER).length : null,
    received: messages.length ? messages.filter(received).length : null,
  };
}
