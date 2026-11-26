import { addDays, type RecordRef } from "@lifestreamprotocol/core";
import type { DayAtom } from "./days.js";
import { episodes, photosOf, workoutMs, type DayEpisodes, type Episode, type EpisodesExtras, type EpisodesFile, type Kind } from "./day-episodes.js";
import { iconOf, recordFocus } from "./day-page.js";
import { peopleBy, type KnownPerson, type PeopleBy } from "./day-side.js";
import type { CallAudioView } from "./callaudio/view.js";
import { appMinutes, callHeadOf, callOf, capital, checkInOf, counted, mailOf, paymentOf, productOf, quietLineOf, type QuietLine } from "./day-words.js";
import type { RecordText } from "./family.js";

type Atom = DayAtom;

export interface MomentAsk {
  focus: string;
  whole: boolean;
  marks: readonly string[] | null;
  today: string;
}

export interface MomentMade {
  by: string | null;
  at_ms: number | null;
  state: "done" | "off" | "needs" | "waiting" | "failed";
  line: string | null;
  ask: { family: string; item: string; prompt: string } | null;
  choose: { value: string; words: string; note: string | null }[];
}

export interface CallHeard {
  view: CallAudioView;
  parts: MomentMade[];
  summary: MomentMade | null;
}

export interface MomentReads {
  text(ref: RecordRef): RecordText | null;
  account(item: string): unknown;
  turns(unit: string): unknown;
  open(chat: string): { label: string; href: string } | null;
  place(unit: string): string | null;
  made(ref: RecordRef): MomentMade | null;
  calls(day: string): Atom[];
  callAudio(unit: string): CallHeard | null;
  people(): readonly KnownPerson[];
}

export interface Fact {
  label: string;
  value: string;
}

export interface Timed {
  start_ms: number | null;
  end_ms: number | null;
  text: string;
}

export interface Site {
  title: string;
  line: string | null;
  at_ms: number | null;
  icon: string;
  href: string | null;
}

export interface Letter {
  at_ms: number | null;
  from: string;
  to: string;
  subject: string;
  words: string;
  attached: string[];
  address: string | null;
  person: string | null;
  person_id: string | null;
  record: RecordRef | null;
}

export interface Turn {
  at_ms: number | null;
  mine: boolean;
  who: string | null;
  words: string;
  full: boolean;
  files: string[];
  tools: string[];
  marked: boolean;
  heard: { record: RecordRef; from_ms: number } | null;
}

export interface CallRecording {
  summary: string | null;
  stopped_ms: number | null;
  turns: Turn[];
  made: MomentMade | null;
  summarised: MomentMade | null;
}

export interface Step {
  start_ms: number;
  end_ms: number;
  present: string | null;
  task: string | null;
  where: string | null;
  doing: string | null;
  actions: { at_ms: number; what: string }[];
}

export interface Account {
  narrative: string;
  tasks: { task: string; seconds: number }[];
  people: string[];
  projects: string[];
  steps: Step[];
  loose: { at_ms: number; what: string }[];
  actions: number;
}

export interface WeekCall {
  day: string;
  at_ms: number;
  title: string;
  icon: string;
  length_ms: number | null;
  focus: string;
}

export interface MinuteApp {
  name: string;
  minutes: number | null;
}

export type MomentView =
  | { view: "thread"; chat: string | null; group: boolean }
  | { view: "quiet"; chat: string }
  | { view: "ai"; work: string[]; turns: Turn[] }
  | {
    view: "call"; figure: { length_ms: number | null; words: string | null; label: string } | null; group: string; name: string;
    others: { at_ms: number; way: string; length_ms: number | null }[]; week: { current: boolean; calls: WeekCall[] } | null;
    recording: CallRecording | null;
  }
  | { view: "mail"; list: boolean; letters: Letter[] }
  | { view: "stay"; today_ms: number; unit: string; note: string | null; inside: Timed[] }
  | { view: "move"; km: string | null; length_ms: number | null; from: string; to: string; mode: string | null; legs: Timed[]; note: string | null }
  | { view: "body"; label: string; length_ms: number | null; bed_ms: number | null; wake_ms: number | null; facts: Fact[][]; vitals: string[] }
  | { view: "sitting"; account: Account | null; apps: MinuteApp[]; sites: Site[]; lines: Timed[] }
  | { view: "apps"; total_ms: number | null; apps: MinuteApp[]; sites: Site[] }
  | { view: "event"; plan: boolean; where: { text: string; href: string } | null; with: string | null; words: string }
  | { view: "note"; words: string | null }
  | { view: "voice"; timed: boolean; notes: { at_ms: number | null; words: string; seconds: number | null; record: RecordRef | null; made: MomentMade | null }[] }
  | { view: "photos"; lines: (Timed & { video: boolean })[] }
  | { view: "listening"; tracks: string[] }
  | { view: "check_in"; head: string | null; median: string | null; lapses: string | null; facts: Fact[]; note: string | null }
  | { view: "payment"; amount: string | null; direction: "in" | "out"; facts: Fact[] }
  | { view: "lines"; lines: Timed[] };

export interface Picture {
  hash: string;
  alt: string;
  words: string;
  video: boolean;
  duration_ms: number | null;
  live: boolean;
}

export interface MomentPerson {
  name: string;
  person: string | null;
  chat: string | null;
  call: RecordRef | null;
}

export interface MomentSource {
  records: (RecordRef & { at_ms: number | null })[];
  more: number;
  units: { family: string; unit: string }[];
  atoms: number;
  start_ms: number | null;
  end_ms: number | null;
}

export interface Moment {
  key: string;
  row: string;
  kind: Kind;
  icon: string;
  title: string;
  name: string;
  near: string | null;
  start_ms: number | null;
  end_ms: number | null;
  untimed: string | null;
  length_ms: number | null;
  products: string[];
  people: MomentPerson[];
  place: { name: string; unit: string; slug: string | null } | null;
  out: { label: string; href: string } | null;
  record: RecordRef | null;
  letter: number | null;
  marks: string[];
  pictures: Picture[];
  source: MomentSource;
  view: MomentView;
}

const LABELS: Readonly<Record<Kind, string>> = {
  stay: "A place", move: "A move", sleep: "Asleep", workout: "Workout", sitting: "At the Mac", phone: "Phone", browsing: "Web",
  conversation: "A conversation", ai: "An AI conversation", call: "A call", mail_sent: "Mail sent", mail_received: "Mail", event: "An event",
  note: "A note", voice_note: "A voice note", dictation: "Dictated", search: "Searched", photos: "Photos", listening: "Listening",
  check_in: "Check-in", payment: "A payment", other: "Other",
};
const FIGURED = new Set<Kind>(["call", "move", "sleep", "workout"]);
const VOICED = new Set<Kind>(["voice_note", "dictation", "search"]);
const PEOPLE_SHOWN = 4;
const LISTED = 60;
const WITH_SHOWN = 6;
const UNANSWERED: Readonly<Record<string, string>> = { Missed: "They called", "No answer": "You called" };
const AWAY_PRESENT = new Set(["yes"]);
const CALLS = "calls";
const CALL = "Call";
const CALLAUDIO = "callaudio";
const CALL_TRANSCRIPT = "call-transcript";

interface Model {
  file: EpisodesFile;
  extras: EpisodesExtras;
  result: DayEpisodes;
  byId: Map<string, Episode>;
  atoms: Map<number, Atom>;
  chapterOf: Map<string, DayEpisodes["chapters"][number]>;
  quiet: Map<string, QuietLine>;
}

function modelOf(file: EpisodesFile, extras: EpisodesExtras, now: number | null): Model {
  const today = now !== null && file.window.start_ms <= now && now < file.window.end_ms ? now : null;
  const result = episodes(file, extras, today);
  const atoms = new Map(file.atoms.map((atom) => [atom.n, atom]));
  const byId = new Map(result.episodes.map((episode) => [episode.id, episode]));
  const chapterOf = new Map<string, DayEpisodes["chapters"][number]>();
  for (const chapter of result.chapters) for (const id of chapter.rows) chapterOf.set(id, chapter);
  const quiet = new Map<string, QuietLine>();
  for (const id of result.also) {
    const first = byId.get(id)?.atoms[0];
    const line = first === undefined ? null : quietLineOf(atoms.get(first)!);
    if (line !== null) quiet.set(id, line);
  }
  return { file, extras, result, byId, atoms, chapterOf, quiet };
}

const atomsOf = (model: Model, episode: Episode): Atom[] => episode.atoms.map((n) => model.atoms.get(n)!);

function ofUnit(focus: string): (atom: Atom) => boolean {
  const piece = /^u:(.*)@(\d+)-(\d+)$/u.exec(focus);
  const unit = piece ? piece[1] : focus.slice(2);
  if (!piece) return (atom) => atom.unit === unit;
  const start = Number(piece[2]), end = Number(piece[3]);
  return (atom) => atom.unit === unit && atom.start_ms !== null && atom.start_ms < end && (atom.end_ms === null ? atom.start_ms >= start : atom.end_ms > start);
}

function recordNamed(focus: string): (atom: Atom) => boolean {
  const [source, kind, ...key] = focus.slice(4).split(" ");
  const joined = key.join(" ");
  return (atom) => atom.record !== undefined && atom.record.source === source && atom.record.kind === kind && atom.record.key === joined;
}

function focusedId(model: Model, focus: string): string {
  const holding = (test: (atom: Atom) => boolean): Episode | undefined => model.result.episodes.find((episode) => episode.atoms.some((n) => test(model.atoms.get(n)!)));
  let found: Episode | undefined;
  if (/^e\d+$/u.test(focus)) found = model.byId.get(focus) ?? holding((atom) => atom.n === Number(focus.slice(1)));
  else if (/^a\d+$/u.test(focus)) found = holding((atom) => atom.n === Number(focus.slice(1)));
  else if (focus.startsWith("u:")) found = holding(ofUnit(focus));
  else if (focus.startsWith("rec:")) found = holding(recordNamed(focus));
  return found?.within ?? found?.id ?? "";
}

function markOf(model: Model, focus: string): number | null {
  if (/^a\d+$/u.test(focus)) return Number(focus.slice(1));
  const test = /^u:.*@\d+-\d+$/u.test(focus) ? ofUnit(focus) : focus.startsWith("rec:") ? recordNamed(focus) : null;
  if (test === null) return null;
  for (const atom of model.atoms.values()) if (test(atom)) return atom.n;
  return null;
}

function wholeChat(model: Model, episode: Episode, block: string): Episode {
  const parts = model.result.episodes.filter((each) => each.kind === episode.kind && each.atoms.some((n) => model.atoms.get(n)?.block?.key === block));
  if (parts.length < 2) return episode;
  const atoms = parts.flatMap((each) => each.atoms).sort((a, b) => a - b);
  const starts = parts.flatMap((each) => each.start_ms ?? []);
  const ends = parts.flatMap((each) => each.end_ms ?? each.start_ms ?? []);
  const within = new Set(parts.map((each) => model.chapterOf.get(each.id))).size === 1;
  const first = parts[0]!;
  return { ...first, id: within ? first.id : `${first.id}-chat`, atoms, start_ms: starts.length ? Math.min(...starts) : null, end_ms: ends.length ? Math.max(...ends) : null };
}

const appNames = (text: string): string => appMinutes(text).map((app) => app.name).join(", ") || text;

function titleOf(episode: Episode): string {
  switch (episode.kind) {
    case "mail_received": return counted(episode.count ?? 1, "mail");
    case "photos": return counted(episode.count ?? 1, "photo");
    case "phone":
    case "sitting": return episode.title ? appNames(episode.title) : LABELS[episode.kind];
    case "workout": return episode.title ? capital(episode.title) : LABELS.workout;
    case "mail_sent": return episode.title ?? "(no subject)";
    case "call": return episode.title ?? (episode.family === CALLAUDIO ? LABELS.call : "Unknown caller");
    case "check_in":
    case "stay": return episode.row.name;
    default: return episode.title ?? LABELS[episode.kind];
  }
}

const rowLine = (episode: Episode): string => episode.row.words.map((run) => run.type === "text" ? run.text : "").filter(Boolean).join(" · ");

function speakerOf(text: string): { speaker: string; words: string; mine: boolean } {
  const colon = text.indexOf(": ");
  const speaker = colon < 0 ? "" : text.slice(0, colon);
  return { speaker, words: colon < 0 ? text : text.slice(colon + 2), mine: speaker === "the user" };
}

const unnamed = (name: string): boolean => /^\+?\d[\d ]*$/u.test(name) || name.includes("@") || /^unknown\b/u.test(name);
const shown = (name: string): boolean => Boolean(name) && name !== "You" && !unnamed(name);

const lengthOf = (episode: Episode): number | null =>
  episode.start_ms !== null && episode.end_ms !== null && episode.end_ms > episode.start_ms ? episode.end_ms - episode.start_ms : null;

const timed = (atom: Atom, text = atom.text): Timed => ({ start_ms: atom.start_ms, end_ms: atom.end_ms, text });
const at = (atom: Atom, text = atom.text): Timed => ({ start_ms: atom.start_ms, end_ms: null, text });

function fact(words: string): Fact {
  const measure = /^(.*?) ((?:[−+-]?[\d.,:/]+(?:%| ms| min| kJ| kcal)?|[\d.]+[–-][\d.]+(?: avg [\d.]+)?)(?: .*)?)$/u;
  const after = measure.exec(words);
  if (after) return { label: capital(after[1]!), value: after[2]! };
  const before = /^([\d.,]+) (\D.*)$/u.exec(words);
  return before ? { label: capital(before[2]!), value: before[1]! } : { label: "", value: capital(words) };
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./u, "");
  } catch {
    return href;
  }
}

function whereOf(place: string): { text: string; href: string } | null {
  const said = place.replace(/^at /u, "").trim();
  if (!said) return null;
  const address = /\bhttps?:\/\/[^\s<>"']+/u.exec(said)?.[0];
  if (address) return { text: hostOf(address), href: address };
  return { text: said, href: `https://maps.apple.com/?q=${encodeURIComponent(said)}` };
}

function siteOf(atom: Atom): Site {
  const visit = /^visited (\S+?)(?: (\d+) times)?(?:: ([\s\S]*?))?(?: \(([^)]*)\))?$/u.exec(atom.text);
  if (visit) {
    const line = [visit[2] ? `${visit[2]} visits` : "", visit[3] ?? ""].filter(Boolean).join(" · ");
    return { title: visit[1]!, line: line || null, at_ms: atom.start_ms, icon: "web", href: `https://${visit[1]}` };
  }
  const searched = /^searched "([\s\S]*)"/u.exec(atom.text);
  if (searched) return { title: searched[1]!, line: "Searched", at_ms: atom.start_ms, icon: "search", href: null };
  return { title: capital(atom.text), line: null, at_ms: atom.start_ms, icon: atom.text.startsWith("downloaded") ? "file" : "web", href: null };
}

const minuteApps = (text: string): MinuteApp[] => appMinutes(text);

function accountOf(content: unknown): Account | null {
  if (typeof content !== "object" || content === null) return null;
  const held = content as {
    summary?: unknown;
    life?: { people?: string[]; projects?: string[] };
    actions?: { at_ms: number; what: string }[];
    timeline?: { start_ms: number; end_ms: number; task?: string; where?: string; doing?: string; present?: string }[];
  };
  const tasks = new Map<string, number>();
  for (const entry of held.timeline ?? []) {
    const seconds = Math.max(0, Math.round((entry.end_ms - entry.start_ms) / 1000));
    if (entry.task) tasks.set(entry.task, (tasks.get(entry.task) ?? 0) + seconds);
  }
  const timeline = [...held.timeline ?? []].sort((left, right) => left.start_ms - right.start_ms);
  const actions = [...held.actions ?? []].sort((left, right) => left.at_ms - right.at_ms);
  const owned: { at_ms: number; what: string }[][] = timeline.map(() => []);
  const loose: { at_ms: number; what: string }[] = [];
  for (const action of actions) {
    let index = timeline.findIndex((step) => action.at_ms >= step.start_ms && action.at_ms < step.end_ms);
    if (index < 0) index = timeline.findLastIndex((step) => step.start_ms <= action.at_ms);
    if (index < 0 && timeline.length) index = 0;
    (index < 0 ? loose : owned[index]!).push({ at_ms: action.at_ms, what: action.what });
  }
  return {
    narrative: String(held.summary ?? ""),
    tasks: [...tasks].sort((left, right) => right[1] - left[1]).map(([task, seconds]) => ({ task: capital(task), seconds })),
    people: shortNames(held.life?.people ?? []),
    projects: shortNames(held.life?.projects ?? []),
    steps: timeline.map((step, index) => ({
      start_ms: step.start_ms, end_ms: step.end_ms, present: step.present && !AWAY_PRESENT.has(step.present) ? step.present : null,
      task: step.task ? capital(step.task) : null, where: step.where || null, doing: step.doing || null, actions: owned[index]!,
    })),
    loose,
    actions: actions.length,
  };
}

const shortNames = (entries: string[]): string[] => [...new Set(entries.map((entry) => capital((entry.split(/, | \(|: | — /u)[0] ?? "").replace(/\.$/u, ""))))];

function letterOf(atom: Atom, reads: MomentReads, by: PeopleBy): Letter {
  const mail = mailOf(atom.text);
  const found = atom.record === undefined ? null : reads.text(atom.record);
  const person = shown(mail.from) ? mail.from : null;
  return {
    at_ms: atom.start_ms, from: mail.from, to: mail.to, subject: mail.subject, words: found?.text || mail.words, attached: mail.attached,
    address: found?.who?.[0] ?? null, person, person_id: person === null ? null : personOf(by, { name: person, chat: null, call: null }, found?.who ?? []),
    record: atom.record ?? null,
  };
}

function picturesOf(atoms: Atom[]): Picture[] {
  return photosOf(atoms).map((held) => {
    const atom = atoms.find((each) => each.item === held.item);
    const about = held.video ? "" : /^(?:Photo|Screenshot|Image): ([\s\S]*)$/u.exec(atom?.text ?? "")?.[1] ?? "";
    return { hash: held.hash, alt: about || (held.video ? "Video" : held.live ? "Live Photo" : "Photo"), words: about, video: held.video, duration_ms: held.duration_ms, live: held.live === true };
  });
}

function sourceOf(atoms: Atom[]): MomentSource {
  const listed = new Set<string>();
  const records = atoms.flatMap((atom) => {
    if (!atom.record) return [];
    const key = `${atom.record.source} ${atom.record.kind} ${atom.record.key}`;
    if (listed.has(key)) return [];
    listed.add(key);
    return [{ ...atom.record, at_ms: atom.start_ms }];
  });
  const units = [...new Map(atoms.map((atom) => [`${atom.family} ${atom.unit}`, { family: atom.family, unit: atom.unit }])).values()];
  const times = atoms.filter((atom) => atom.start_ms !== null);
  const last = Math.max(...times.map((atom) => (atom.end_ms ?? atom.start_ms)!));
  const first = times[0];
  return {
    records: records.slice(0, LISTED), more: Math.max(0, records.length - LISTED), units, atoms: atoms.length,
    start_ms: first?.start_ms ?? null, end_ms: first !== undefined && (times.length > 1 || first.end_ms !== null) ? last : null,
  };
}

type Named = Omit<MomentPerson, "person">;

function namedIn(episode: Episode, atoms: Atom[]): Named[] {
  const first = atoms[0]!;
  if (episode.kind === "conversation" && !episode.group && episode.title) return [{ name: episode.title, chat: first.block?.key || null, call: null }];
  if (episode.kind === "conversation") {
    const said = new Map<string, number>();
    for (const atom of atoms) {
      const line = speakerOf(atom.text);
      if (!line.mine && line.speaker && line.speaker !== "the group") said.set(line.speaker, (said.get(line.speaker) ?? 0) + 1);
    }
    return [...said].sort((left, right) => right[1] - left[1]).map(([name]) => ({ name, chat: null, call: null }));
  }
  if (episode.kind === "call") {
    const call = callAtomOf(atoms);
    return call === undefined ? [] : callOf(call.text).who.split(", ").map((name) => ({ name, chat: null, call: call.record ?? null }));
  }
  if (episode.kind === "mail_received" && atoms.length === 1) return [{ name: mailOf(first.text).from, chat: null, call: null }];
  if (episode.kind === "mail_sent") return mailOf(first.text).to.split(", ").map((name) => ({ name, chat: null, call: null }));
  return [];
}

function personOf(by: PeopleBy, named: Named, handles: readonly string[]): string | null {
  const found = (named.chat === null ? undefined : by.chat.get(named.chat)) ?? handles.map((handle) => by.handle.get(handle)).find(Boolean) ?? by.name.get(named.name);
  return found?.id ?? null;
}

function peopleOf(episode: Episode, atoms: Atom[], reads: MomentReads): MomentPerson[] {
  const named = namedIn(episode, atoms).filter((person) => shown(person.name)).slice(0, PEOPLE_SHOWN);
  if (!named.length) return [];
  const by = peopleBy(reads.people());
  const record = (episode.kind === "call" ? callAtomOf(atoms) : atoms[0])?.record;
  const handled = episode.kind === "call" || episode.kind === "mail_received";
  const handles = handled && named.length === 1 && record !== undefined ? reads.text(record)?.who ?? [] : [];
  return named.map((person) => ({ name: person.name, person: personOf(by, person, handles), chat: person.chat, call: person.call }));
}

function placeOf(model: Model, episode: Episode, reads: MomentReads): Moment["place"] {
  const chapter = model.chapterOf.get(episode.id);
  const holder = chapter?.episode ? model.byId.get(chapter.episode) ?? null : null;
  const stay = episode.kind === "stay" ? episode : holder?.kind === "stay" ? holder : null;
  if (stay === null) return null;
  const unit = atomsOf(model, stay)[0]!.unit;
  return { name: titleOf(stay), unit, slug: reads.place(unit) };
}

const sameRecord = (left: RecordRef, right: RecordRef): boolean => left.source === right.source && left.kind === right.kind && left.key === right.key;

function mondayOf(day: string): string {
  return addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

function weekCallOf(day: string, atom: Atom): WeekCall {
  const call = callOf(atom.text);
  const kind = call.kind || "Call";
  const lasted = atom.end_ms !== null && atom.end_ms > atom.start_ms! ? atom.end_ms - atom.start_ms! : null;
  return {
    day, at_ms: atom.start_ms!, title: call.way === "Missed" ? `Missed ${kind.toLowerCase()}` : kind,
    icon: call.way === "Missed" ? "call-missed" : /video/iu.test(kind) ? "video" : "call", length_ms: lasted,
    focus: recordFocus(atom.record!),
  };
}

function weekOf(model: Model, own: RecordRef, ids: ReadonlySet<string>, reads: MomentReads, today: string): { current: boolean; calls: WeekCall[] } | null {
  if (!ids.size) return null;
  const first = mondayOf(model.file.day);
  const last = [addDays(first, 6), today].sort()[0]!;
  const calls: WeekCall[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const atoms = day === model.file.day ? model.file.atoms.filter((atom) => atom.family === CALLS) : reads.calls(day);
    for (const atom of atoms) {
      if (atom.record === undefined || atom.start_ms === null || sameRecord(atom.record, own)) continue;
      if ((reads.text(atom.record)?.who ?? []).some((id) => ids.has(id))) calls.push(weekCallOf(day, atom));
    }
  }
  return { current: first === mondayOf(today), calls: calls.sort((left, right) => left.at_ms - right.at_ms) };
}

const callAtomOf = (atoms: Atom[]): Atom | undefined => atoms[0]?.family === CALLS ? atoms[0] : undefined;

interface Recorded {
  holder: string;
  camera: boolean;
  recording: CallRecording | null;
}

function transcriptsOf(parts: readonly MomentMade[], item: string): MomentMade | null {
  if (!parts.length) return null;
  const ask = { family: CALLAUDIO, item, prompt: CALL_TRANSCRIPT };
  const done = parts.filter((part) => part.state === "done");
  const failed = parts.filter((part) => part.state === "failed");
  const stuck = parts.find((part) => part.state === "off" || part.state === "needs");
  if (stuck !== undefined) return { ...stuck, ask };
  const waiting = parts.find((part) => part.state === "waiting");
  if (waiting !== undefined) return { ...waiting, ask, line: `Transcribing, ${done.length} of ${parts.length} parts` };
  if (failed.length) return { ...failed[0]!, ask, line: `${failed.length} ${failed.length === 1 ? "part" : "parts"} couldn't be read` };
  return { ...done.reduce((latest, part) => (part.at_ms ?? 0) > (latest.at_ms ?? 0) ? part : latest), ask };
}

function recordedOf(atoms: Atom[], reads: MomentReads, marks: ReadonlySet<number>): Recorded | null {
  const head = atoms.find((atom) => callHeadOf(atom) !== null);
  if (head === undefined) return null;
  const holder = callHeadOf(head)!.holder;
  const heard = reads.callAudio(head.unit);
  if (heard === null) return { holder, camera: false, recording: null };
  const marked = new Set(atoms.filter((atom) => marks.has(atom.n) && atom.family === CALLAUDIO).map((atom) => `${atom.item} ${atom.start_ms}`));
  const { view } = heard;
  return {
    holder,
    camera: view.camera,
    recording: {
      summary: view.summary?.summary || null,
      stopped_ms: view.stopped_ms,
      turns: view.turns.map((turn): Turn => ({
        at_ms: turn.at_ms, mine: turn.mine, who: turn.who, words: turn.words, full: true, files: [], tools: [],
        marked: marked.has(`${turn.heard.item} ${turn.at_ms}`), heard: { record: turn.heard.record, from_ms: turn.heard.from_ms },
      })),
      made: transcriptsOf(heard.parts, view.summary_item),
      summarised: heard.summary,
    },
  };
}

function callView(model: Model, episode: Episode, atoms: Atom[], reads: MomentReads, today: string, recorded: Recorded | null): MomentView {
  const lasted = lengthOf(episode);
  const first = callAtomOf(atoms);
  const recording = recorded?.recording ?? null;
  if (first === undefined) {
    return {
      view: "call", figure: lasted === null ? null : { length_ms: lasted, words: null, label: CALL }, group: "", name: recorded?.holder || CALL,
      others: [], week: null, recording,
    };
  }
  const call = callOf(first.text);
  const figure = lasted !== null ? { length_ms: lasted, words: null, label: call.way || CALL }
    : UNANSWERED[call.way] ? { length_ms: null, words: call.way, label: UNANSWERED[call.way]! } : null;
  const recordOf = (other: Episode): RecordRef | undefined => callAtomOf(atomsOf(model, other))?.record;
  const others = first.record === undefined ? [] : model.result.episodes.filter((other) => other.kind === "call" && other.id !== episode.id
    && other.start_ms !== null && recordOf(other) !== undefined);
  const mine = first.record === undefined ? null : reads.text(first.record);
  const ids = new Set(mine?.who ?? []);
  const same = mine === null ? [] : others.filter((other) => (reads.text(recordOf(other)!)?.who ?? []).some((id) => ids.has(id)))
    .sort((left, right) => left.start_ms! - right.start_ms!);
  return {
    view: "call", figure, group: call.group, name: call.who || (others.length ? mine?.title : undefined) || "them",
    others: same.map((other) => {
      const each = callOf(callAtomOf(atomsOf(model, other))!.text);
      return { at_ms: other.start_ms!, way: capital(each.way || each.kind), length_ms: lengthOf(other) };
    }),
    week: first.record === undefined ? null : weekOf(model, first.record, ids, reads, today),
    recording,
  };
}

function aiView(atoms: Atom[], reads: MomentReads, marks: ReadonlySet<number>): MomentView {
  const turns = new Map<string, { role: string; words: string; attachments?: { name: string }[]; images?: number; tools?: string[] }>();
  for (const unit of new Set(atoms.filter((atom) => atom.record).map((atom) => atom.unit))) {
    const content = reads.turns(unit) as { turns?: { key: string; role: string; words: string; attachments?: { name: string }[]; images?: number; tools?: string[] }[] } | null;
    for (const turn of content?.turns ?? []) turns.set(turn.key, turn);
  }
  return {
    view: "ai",
    work: atoms.filter((atom) => !atom.record).map((atom) => atom.text),
    turns: atoms.filter((atom) => atom.record).map((atom): Turn => {
      const line = speakerOf(atom.text);
      const turn = turns.get(atom.record!.key);
      const full = Boolean(turn?.words);
      const files = full ? [...(turn!.attachments ?? []).map((file) => file.name), ...(turn!.images ? [counted(turn!.images, "image")] : [])] : [];
      const mine = full ? turn!.role === "user" : line.mine;
      return { at_ms: atom.start_ms, mine, who: null, words: full ? turn!.words : line.words, full, files, tools: full ? turn!.tools ?? [] : [], marked: marks.has(atom.n), heard: null };
    }),
  };
}

function bodyView(model: Model, episode: Episode, atoms: Atom[]): MomentView {
  const stated = episode.kind === "workout" ? workoutMs(atoms[0]!) : null;
  const sleep = episode.kind === "sleep" && episode.start_ms !== null && episode.end_ms !== null;
  const facts = atoms.map((atom) => {
    const bare = atom.text.startsWith("workout — ") ? atom.text.replace(/ \([^)]*\)$/u, "") : atom.text;
    const words = bare.replace(/^(?:nap|workout|recovery) — /u, "");
    const colon = words.indexOf(": ");
    return (colon >= 0 && atom.flags.includes("heading") ? words.slice(colon + 2) : words).split(", ").filter((part) => !part.startsWith("duration ")).map(fact);
  });
  const vitals = episode.kind === "sleep" && atoms.some((atom) => atom.flags.includes("heading"))
    ? model.result.headings.map((n) => model.atoms.get(n)!).filter((atom) => atom.family === "health" && atom.unit.startsWith("vitals/")).map((atom) => atom.text) : [];
  return {
    view: "body", label: episode.kind === "sleep" ? "Asleep" : "Duration", length_ms: stated ?? lengthOf(episode),
    bed_ms: sleep ? episode.start_ms : null, wake_ms: sleep ? episode.end_ms : null, facts, vitals,
  };
}

function sittingView(model: Model, episode: Episode, atoms: Atom[], reads: MomentReads): MomentView {
  const first = atoms[0]!;
  const account = accountOf(reads.account(first.item ?? first.unit));
  const sites = model.result.episodes.filter((other) => other.within === episode.id).flatMap((other) => atomsOf(model, other)).map(siteOf);
  return {
    view: "sitting", account, apps: minuteApps((first.block?.title ?? "").replace(/^Screen(?:: )?/u, "")), sites,
    lines: account === null ? atoms.map((atom) => at(atom, atom.text.replace(/^Summary: /u, ""))) : [],
  };
}

function appsView(episode: Episode, atoms: Atom[]): MomentView {
  if (episode.kind !== "phone") return { view: "apps", total_ms: null, apps: [], sites: atoms.map(siteOf) };
  const text = atoms[0]!.text;
  const used = atoms[0]!.family === "health" ? text.replace(/^Phone: [^,]*,? ?/u, "") : text.slice(text.indexOf(": ") + 2);
  const total = /^Phone: (\d+) min/u.exec(text)?.[1];
  return { view: "apps", total_ms: total === undefined ? null : Number(total) * 60000, apps: minuteApps(used), sites: [] };
}

function eventView(episode: Episode, atoms: Atom[], reads: MomentReads, now: number | null): MomentView {
  const first = atoms[0]!;
  const plan = now !== null && episode.start_ms !== null && episode.start_ms > now;
  const found = first.record === undefined ? null : reads.text(first.record);
  if (found !== null) {
    const [place = "", ...rest] = found.text.split("\n");
    const people = found.who ?? [];
    const others = people.length > WITH_SHOWN ? ` and ${people.length - WITH_SHOWN} more` : "";
    return { view: "event", plan, where: whereOf(place), with: people.length ? people.slice(0, WITH_SHOWN).join(", ") + others : null, words: rest.join("\n").trim() };
  }
  const text = first.text;
  const close = /”(?=$|[, :\n])/u.exec(text)?.index ?? text.length;
  const [place = "", ...rest] = text.slice(close + 1).replace(/^,\s*/u, "").split(", ").filter(Boolean);
  return { view: "event", plan, where: whereOf(place), with: null, words: rest.map(capital).join("\n") };
}

function noteView(atoms: Atom[], reads: MomentReads): MomentView {
  const first = atoms[0]!;
  const found = first.record === undefined ? null : reads.text(first.record);
  if (found?.text) {
    const lines = found.text.split("\n");
    return { view: "note", words: lines[0]?.trim() === found.title?.trim() ? lines.slice(1).join("\n") : found.text };
  }
  const text = first.text;
  const colon = text.search(/” (?:written|created|edited)[^:]*: /u);
  const words = colon < 0 ? "" : text.slice(text.indexOf(": ", colon) + 2);
  return { view: "note", words: words || null };
}

function voiceView(atoms: Atom[], reads: MomentReads): MomentView {
  return {
    view: "voice", timed: atoms.length > 1,
    notes: atoms.map((atom) => {
      const colon = atom.text.indexOf(": ");
      const words = atom.text.startsWith("Voice note, ") ? colon < 0 ? "" : atom.text.slice(colon + 2) : /"([\s\S]*)"/u.exec(atom.text)?.[1] ?? "";
      const seconds = Number(/(\d+) s\b/u.exec(atom.text)?.[1] ?? NaN);
      return { at_ms: atom.start_ms, words, seconds: Number.isFinite(seconds) ? seconds : null, record: atom.record ?? null, made: atom.record ? reads.made(atom.record) : null };
    }),
  };
}

function stayView(model: Model, episode: Episode, atoms: Atom[]): MomentView {
  const here = model.result.episodes.filter((other) => other.kind === "stay" && other.title === episode.title && !model.result.also.includes(other.id));
  const today = here.reduce((sum, other) => sum + (other.end_ms ?? other.start_ms!) - other.start_ms!, 0);
  const note = /\(([^)]*)\)$/u.exec(atoms[0]!.text)?.[1] ?? "";
  return { view: "stay", today_ms: today, unit: atoms[0]!.unit, note: note ? capital(note) : null, inside: atoms.slice(1).map((atom) => timed(atom)) };
}

function moveView(episode: Episode, atoms: Atom[]): MomentView {
  const first = atoms[0]!;
  const [from = "", to = ""] = (episode.title ?? "").split(" → ");
  const km = /(\d+(?:\.\d+)?) km/u.exec(first.block?.title ?? first.text)?.[1];
  const legs = atoms.length > 1 || first.block ? atoms.map((atom) => timed(atom, capital(atom.text))) : [];
  return {
    view: "move", km: km === undefined ? null : `${km} km`, length_ms: lengthOf(episode), from, to, mode: episode.mode ? capital(episode.mode) : null, legs,
    note: atoms.length === 1 && !first.block ? capital(first.text) : null,
  };
}

function checkInView(atoms: Atom[]): MomentView {
  const check = checkInOf(atoms[0]!.text);
  if (check.head.startsWith("Vigilance")) {
    const median = check.answers.find((answer) => answer.startsWith("median "))?.slice("median ".length) || null;
    const lapses = /^(\d+) lapses?$/u.exec(check.answers.find((answer) => /lapses?$/u.test(answer)) ?? "")?.[1] ?? null;
    const rest = check.answers.filter((answer) => !answer.startsWith("median ") && !/lapses?$/u.test(answer));
    return { view: "check_in", head: null, median, lapses, facts: rest.map(fact), note: null };
  }
  return { view: "check_in", head: check.head, median: null, lapses: null, facts: check.answers.map(fact), note: check.note || null };
}

function paymentView(atoms: Atom[]): MomentView {
  const payment = paymentOf(atoms[0]!.text);
  return {
    view: "payment", amount: payment.amount ? `${payment.amount} ${payment.currency}` : null, direction: payment.amount.startsWith("+") ? "in" : "out",
    facts: [{ label: "Merchant", value: payment.merchant }, { label: "Account", value: payment.account }, { label: "Balance after", value: payment.balance }],
  };
}

function viewOf(model: Model, episode: Episode, atoms: Atom[], reads: MomentReads, marks: ReadonlySet<number>, now: number | null, today: string, recorded: Recorded | null): MomentView {
  const quiet = model.quiet.get(episode.id);
  if (quiet) return { view: "quiet", chat: quiet.chat };
  switch (episode.kind) {
    case "conversation": return { view: "thread", chat: atoms.find((atom) => atom.block)?.block?.key ?? null, group: Boolean(episode.group) };
    case "ai": return aiView(atoms, reads, marks);
    case "call": return callView(model, episode, atoms, reads, today, recorded);
    case "mail_sent":
    case "mail_received": {
      const list = episode.kind === "mail_received" && atoms.length > 1;
      const by = peopleBy(reads.people());
      return { view: "mail", list, letters: (list ? atoms : [atoms[0]!]).map((atom) => letterOf(atom, reads, by)) };
    }
    case "stay": return stayView(model, episode, atoms);
    case "move": return moveView(episode, atoms);
    case "sleep":
    case "workout": return bodyView(model, episode, atoms);
    case "sitting": return sittingView(model, episode, atoms, reads);
    case "phone":
    case "browsing":
    case "search": return appsView(episode, atoms);
    case "event": return eventView(episode, atoms, reads, now);
    case "note": return noteView(atoms, reads);
    case "voice_note":
    case "dictation": return voiceView(atoms, reads);
    case "photos": {
      const drawn = new Set(photosOf(atoms).map((held) => held.item));
      return { view: "photos", lines: atoms.filter((atom) => !drawn.has(atom.item ?? "")).map((atom) => ({ ...at(atom), video: atom.video !== undefined })) };
    }
    case "listening": {
      const text = atoms[0]!.text;
      const colon = text.indexOf(": ");
      return { view: "listening", tracks: colon < 0 ? [text] : text.slice(colon + 2).split(", ") };
    }
    case "check_in": return checkInView(atoms);
    case "payment": return paymentView(atoms);
    default: return { view: "lines", lines: atoms.map((atom) => at(atom)) };
  }
}

const untimedWhen = (episode: Episode, first: Atom): string => episode.kind === "event" && first.flags.includes("date_only") ? "All day" : "No time of day";

export function moment(file: EpisodesFile, extras: EpisodesExtras, ask: MomentAsk, reads: MomentReads, now: number | null): Moment | null {
  const model = modelOf(file, extras, now);
  const id = focusedId(model, ask.focus);
  const found = id ? model.byId.get(id) : undefined;
  if (found === undefined) return null;
  const mark = markOf(model, ask.focus);
  const block = ask.whole && mark !== null ? model.atoms.get(mark)?.block?.key : undefined;
  const episode = block ? wholeChat(model, found, block) : found;
  const atoms = atomsOf(model, episode);
  const first = atoms[0]!;
  const marked = new Set((ask.marks ?? [ask.focus]).flatMap((each) => markOf(model, each) ?? []));
  const quiet = model.quiet.get(episode.id);
  const also = model.result.also.includes(episode.id);
  const letter = episode.kind === "mail_received" && mark !== null && marked.has(mark) ? atoms.findIndex((atom) => atom.n === mark) : -1;
  const recorded = episode.kind === "call" ? recordedOf(atoms, reads, marked) : null;
  const call = episode.kind === "call" ? callAtomOf(atoms) : undefined;
  const products = episode.kind === "call" ? call !== undefined ? [callOf(call.text).kind] : recorded?.holder ? [recorded.holder] : [] : quiet ? [productOf(extras.products, quiet.chat).name]
    : [...new Set(atoms.flatMap((atom) => atom.record ? [productOf(extras.products, atom.record.source).name] : []))];
  const named = quiet ? quiet.title : titleOf(episode);
  const single = episode.kind === "mail_received" && atoms.length === 1 ? first : null;
  const title = single ? mailOf(single.text).subject || "(no subject)" : VOICED.has(episode.kind) && episode.title !== null ? `“${named}”` : named;
  const chat = episode.kind === "conversation" && !episode.group ? first.block?.key ?? "" : "";
  const out = episode.kind === "conversation" ? (episode.group ? null : reads.open(chat)) : null;
  const record = episode.kind === "conversation" || (episode.kind === "mail_received" && atoms.length > 1) ? null
    : (call ?? atoms.find((atom) => atom.record))?.record ?? null;
  return {
    key: episode.id,
    row: id,
    kind: episode.kind,
    icon: quiet ? "meeting" : call === undefined && recorded?.camera ? "video" : iconOf(episode, extras.products),
    title,
    name: named,
    near: episode.kind === "stay" ? rowLine(episode) || null : null,
    start_ms: episode.start_ms,
    end_ms: episode.end_ms,
    untimed: quiet ? quiet.count : also ? untimedWhen(episode, first) : null,
    length_ms: FIGURED.has(episode.kind) ? null : lengthOf(episode),
    products: products.slice(0, 2),
    people: peopleOf(episode, atoms, reads),
    place: placeOf(model, episode, reads),
    out,
    record,
    letter: letter < 0 ? null : letter,
    marks: [...marked].flatMap((n) => model.atoms.get(n)?.record?.key ?? []),
    pictures: picturesOf(atoms),
    source: sourceOf(atoms),
    view: viewOf(model, episode, atoms, reads, marked, now, ask.today, recorded),
  };
}
