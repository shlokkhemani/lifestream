import { CALLAUDIO_FAMILY, NOT_JOINED, type DayAtom, type DayDocument, type DayFileFact } from "@lifestreamprotocol/families";


export const BRIEF_LINES = 40;
export const BRIEF_WINDOWS = 6;

export interface BriefLine {
  part: Part;
  text: string;
  atoms: number[];
  refs?: string[];
}

export interface BriefWindow {
  text: string;
  ref: string;
  tenths: number;
}

export interface Brief {
  day: string;
  lines: BriefLine[];
}

type Part = "where" | "people" | "mail" | "screen" | "ai" | "calendar" | "days" | "workouts" | "money" | "photos" | "rest";

const PARTS: Readonly<Record<Part, number>> = { where: 6, people: 8, mail: 4, screen: 4, ai: 3, calendar: 3, days: 3, workouts: 2, money: 4, photos: 1, rest: 2 };

const FAMILY = { where: "physical", messages: "messages", calls: "calls", callaudio: CALLAUDIO_FAMILY, mail: "mail", screen: "screen", ai: "ai", calendar: "calendar", photos: "photos" } as const;
const LABEL: Partial<Record<Part, string>> = { days: "the day", workouts: "workout", money: "payment" };
const OWN: ReadonlySet<string> = new Set([...Object.values(FAMILY), "health", "money"]);

export function briefOf(day: Pick<DayDocument, "day" | "atoms" | "facts">, windows: readonly BriefWindow[] = []): Brief {
  const atoms = day.atoms;
  const of = (family: string) => atoms.filter((atom) => atom.family === family);
  const known = new Set(atoms.map((atom) => atom.n));
  const calls = unjoinedCalls(day.facts);
  const parts: Record<Part, BriefLine[]> = {
    where: of(FAMILY.where).map((atom) => atomLine("where", atom)),
    people: [
      ...blockLines("people", of(FAMILY.messages), "message"),
      ...atoms.filter((atom) => atom.family === FAMILY.calls || calls.has(atom.n)).map((atom) => atomLine("people", atom)),
    ],
    mail: of(FAMILY.mail).map((atom) => atomLine("mail", atom)),
    screen: of(FAMILY.screen).map((atom) => atomLine("screen", atom)),
    ai: blockLines("ai", of(FAMILY.ai), "turn"),
    calendar: of(FAMILY.calendar).map((atom) => atomLine("calendar", atom)),
    days: factLines("days", day.facts.filter((fact) => fact.of === "days"), atoms, known),
    workouts: factLines("workouts", day.facts.filter((fact) => fact.of === "workouts"), atoms, known),
    money: factLines("money", day.facts.filter((fact) => fact.of === "payments"), atoms, known),
    photos: countLine("photos", of(FAMILY.photos), "photo"),
    rest: restLines(atoms),
  };
  const lines = (Object.keys(PARTS) as Part[]).flatMap((part) => [...capped(parts[part], PARTS[part], part), ...part === "screen" ? windowLines(windows) : []]);
  return { day: day.day, lines };
}

function unjoinedCalls(facts: readonly DayFileFact[]): ReadonlySet<number> {
  return new Set(facts.filter((fact) => fact.of === FAMILY.callaudio && fact.keys.call === NOT_JOINED).flatMap((fact) => fact.lines));
}

function windowLines(windows: readonly BriefWindow[]): BriefLine[] {
  const ranked = [...windows].sort((left, right) => right.tenths - left.tenths);
  const shown = ranked.slice(0, BRIEF_WINDOWS).map((window): BriefLine => ({ part: "screen", text: window.text, atoms: [], refs: [window.ref] }));
  const rest = ranked.slice(BRIEF_WINDOWS);
  return rest.length === 0 ? shown : [...shown, { part: "screen", text: `and ${rest.length} more window${rest.length === 1 ? "" : "s"}`, atoms: [], refs: rest.map((window) => window.ref) }];
}

function capped(lines: BriefLine[], share: number, part: Part): BriefLine[] {
  if (lines.length <= share) return lines;
  const kept = lines.slice(0, share - 1);
  const rest = lines.slice(share - 1);
  return [...kept, { part, text: `and ${rest.length} more`, atoms: sorted(rest.flatMap((line) => line.atoms)) }];
}

function clockOf(start: string | null, end: string | null): string {
  return start === null ? "" : `${start}${end === null ? "" : `–${end}`} `;
}

function atomLine(part: Part, atom: DayAtom): BriefLine {
  const first = atom.text.split("\n")[0]!;
  const block = atom.block !== undefined && leads(atom.block.title, first) && part !== "where" ? atom.block : undefined;
  return { part, text: `${clockOf(atom.local_start, atom.local_end)}${block === undefined ? "" : `${block.title}: `}${first}`, atoms: [atom.n] };
}

export function leads(title: string | undefined, line: string): title is string {
  return title !== undefined && title !== "" && !line.startsWith(title);
}

function blockLines(part: Part, atoms: readonly DayAtom[], noun: string): BriefLine[] {
  const blocks = new Map<string, { title: string; atoms: DayAtom[] }>();
  for (const atom of atoms) {
    const key = atom.block?.key ?? atom.unit;
    const held = blocks.get(key);
    if (held === undefined) blocks.set(key, { title: atom.block?.title ?? atom.unit, atoms: [atom] });
    else held.atoms.push(atom);
  }
  return [...blocks.values()].sort((left, right) => right.atoms.length - left.atoms.length || left.atoms[0]!.n - right.atoms[0]!.n)
    .map((block) => ({
      part, text: `${spanOf(block.atoms)}${block.title}: ${block.atoms.length} ${noun}${block.atoms.length === 1 ? "" : "s"}`, atoms: sorted(block.atoms.map((atom) => atom.n)),
    }));
}

function spanOf(atoms: readonly DayAtom[]): string {
  const timed = atoms.filter((atom): atom is DayAtom & { start_ms: number; local_start: string } => atom.start_ms !== null && atom.local_start !== null);
  if (timed.length === 0) return "";
  const first = timed.reduce((left, right) => (right.start_ms < left.start_ms ? right : left));
  const endOf = (atom: (typeof timed)[number]) => (atom.end_ms !== null && atom.local_end !== null ? { ms: atom.end_ms, clock: atom.local_end } : { ms: atom.start_ms, clock: atom.local_start });
  const last = timed.map(endOf).reduce((left, right) => (right.ms > left.ms ? right : left));
  return clockOf(first.local_start, last.clock === first.local_start ? null : last.clock);
}

function factLines(part: Part, facts: readonly DayFileFact[], atoms: readonly DayAtom[], known: ReadonlySet<number>): BriefLine[] {
  return facts.flatMap((fact) => {
    const cited = fact.lines.filter((n) => known.has(n));
    const atomsOf = cited.length > 0 ? cited : atoms.filter((atom) => atom.family === fact.family).map((atom) => atom.n);
    if (atomsOf.length === 0) return [];
    const measures = Object.entries(fact.measures).map(([name, value]) => `${name} ${value}`);
    const keys = Object.entries(fact.keys).filter(([key]) => key !== "currency").map(([key, value]) => (part === "days" ? `${key} ${value}` : value));
    const currency = fact.keys.currency === undefined ? [] : [fact.keys.currency];
    const said = part === "days" ? [...measures, ...keys.length === 0 ? [] : [`(${keys.join(", ")})`]] : [...keys, ...measures, ...currency];
    if (said.length === 0) return [];
    return [{ part, text: `${LABEL[part] ?? fact.of}: ${said.join(" ")}`, atoms: sorted(atomsOf) }];
  });
}

function countLine(part: Part, atoms: readonly DayAtom[], noun: string): BriefLine[] {
  return atoms.length === 0 ? [] : [{ part, text: `${atoms.length} ${noun}${atoms.length === 1 ? "" : "s"}`, atoms: sorted(atoms.map((atom) => atom.n)) }];
}

function restLines(atoms: readonly DayAtom[]): BriefLine[] {
  const families = new Map<string, number[]>();
  for (const atom of atoms) {
    if (OWN.has(atom.family)) continue;
    families.set(atom.family, [...(families.get(atom.family) ?? []), atom.n]);
  }
  return [...families].sort(([left, a], [right, b]) => b.length - a.length || (left < right ? -1 : 1))
    .map(([family, ns]) => ({ part: "rest" as const, text: `${family}: ${ns.length} line${ns.length === 1 ? "" : "s"}`, atoms: sorted(ns) }));
}

function sorted(ns: readonly number[]): number[] {
  return [...new Set(ns)].sort((left, right) => left - right);
}
