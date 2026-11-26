import {
  baseOf, DETAIL_TYPES, detailKey, HideError, heldMarks, hideDetails, hides, hidesAny, isDetailType, loadWords, overlap, readWords, sha256, wantedOf,
  type Box, type Counts, type DetailType, type Entry, type Hidden, type Level, type Mark, type Marked, type Owner, type Piece, type PlaceholderTable, type Quote, type Reading, type Wanted,
} from "@lifestreamprotocol/core";
import { fitted } from "./fits.js";
import { waitLine, type Detector, type DetectorModel, type FindFor, type PassageMark } from "./detector.js";
import { businessOrBot, marksOfFree, readPassages, standsInside, type Free, type Ways } from "./free.js";
import type { MarksStore } from "./marks-store.js";
import type { Found } from "./merge.js";
import { compileNames, NAMING, sealOf, sealsAny, type NameMatcher, type NameTable, type Seal, type Sealed } from "./names.js";
import { passagesOf } from "./passages.js";
import { facesDrawn, linesText, type Face, type Picture, type PictureText, type Pictures } from "./pictures.js";
import type { PrivacySettings } from "./settings.js";

export interface HiderInputs {
  people: () => NameTable | undefined;
  settings: () => PrivacySettings;
  detector: Detector;
  pictures: Pictures;
  marks: MarksStore;
}

export type Text = readonly (Piece | Quote)[] | PictureText;

export type HiddenText = string | Picture | { cannot: string };

export type Placed = Hidden["spans"][number][number];

export type HideAnswer =
  | { texts: HiddenText[]; spans: Placed[][]; table: PlaceholderTable; counts: Counts; detector: string | null; fallback?: string }
  | { wait: string };

export interface Reader {
  sealed?: Sealed;
  shown: readonly string[];
}

const OPEN: Reader = { shown: [] };

export interface Hider {
  hide(texts: readonly Text[], level: Level, table: PlaceholderTable | ((wanted: Wanted) => PlaceholderTable | Promise<PlaceholderTable>), bound?: number | AbortSignal, epoch?: string, reader?: Reader): Promise<HideAnswer>;
  mark(texts: readonly string[], epoch: string): Promise<{ passages: number; found: number } | { wait: string } | { again: string }>;
  ready(level: Level): true | { wait: string };
}

export const BATCH = 32;

const ROUNDS = 3;


const NO_NAMES = "Waiting for People to list the names of your people";

const UNREAD = "This text cannot be hidden: the hiding model cannot read a passage of it.";
const UNREAD_PICTURE = "This picture cannot be hidden: the hiding model cannot read its words.";

interface PlacedFree extends Free {
  at: number;
}

interface Segment {
  text: string;
  quoted: boolean;
  stated: Found[];
  frees: PlacedFree[];
  own: { start: number; end: number }[];
}

interface Prepared {
  segments?: Segment[];
  picture?: PictureText;
}

interface Read {
  start: number;
  text: string;
  digest: string;
}

export function openHider(inputs: HiderInputs): Hider {
  const { detector, pictures, marks: store } = inputs;
  loadWords();
  let compiledNames: { version: string; matcher: NameMatcher } | null = null;
  const matcherOf = (table: NameTable): NameMatcher => (compiledNames?.version === table.version ? compiledNames.matcher : (compiledNames = { version: table.version, matcher: compileNames(table) }).matcher);
  const finding = new Map<string, Promise<PassageMark[] | null>>();

  function ready(level: Level): true | { wait: string } {
    return hidesAny(level) && inputs.people() === undefined ? { wait: NO_NAMES } : true;
  }

  function place(batch: readonly string[], texts: ReadonlyMap<string, string>, by: FindFor, epoch: string): Promise<(PassageMark[] | null)[]> {
    const passages = batch.map((digest) => texts.get(digest)!);
    const found = new Promise<{ model: DetectorModel; marks: (PassageMark[] | null)[] }>((resolve) => resolve(detector.find(passages, by))).then((answer) => {
      const kept = checked(answer, passages);
      store.write(answer.model, new Map(batch.flatMap((digest, index) => (kept[index] === null ? [] : [[digest, kept[index]!] as const]))), epoch);
      return kept;
    });
    batch.forEach((digest, index) => {
      const claim = found.then((kept) => kept[index]!);
      claim.catch(() => undefined);
      finding.set(digest, claim);
      void claim.finally(() => {
        if (finding.get(digest) === claim) finding.delete(digest);
      }).catch(() => undefined);
    });
    return found;
  }

  async function detect(passages: readonly string[], stale: boolean, by: FindFor, epoch: string, bound?: number | AbortSignal): Promise<{ marks: Map<string, PassageMark[] | null>; found: number; model: DetectorModel } | { unready: string } | { wait: string }> {
    const state = detector.state();
    if (state.state !== "ready") return { unready: waitLine(state) };
    const texts = new Map(passages.map((passage) => [sha256(passage), passage]));
    const have = new Map<string, PassageMark[] | null>();
    const lookUp = (digests: readonly string[]) => {
      for (const [digest, kept] of store.read(digests, state.model)) if (kept.current || stale) have.set(digest, kept.marks);
    };
    lookUp([...texts.keys()]);
    if (have.size === texts.size) return { marks: have, found: 0, model: state.model };
    let found = 0;
    const work = (async () => {
      const waited = new Set<string>();
      for (;;) {
        const waits: Promise<void>[] = [];
        for (;;) {
          const open: string[] = [];
          for (const digest of texts.keys()) {
            if (have.has(digest) || waited.has(digest)) continue;
            const claim = finding.get(digest);
            if (claim === undefined) {
              open.push(digest);
              continue;
            }
            waited.add(digest);
            waits.push(claim.then((marks) => void have.set(digest, marks), () => void waited.delete(digest)));
          }
          if (open.length === 0) break;
          const batch = open.slice(0, BATCH);
          found += batch.length;
          const marks = await place(batch, texts, by, epoch);
          batch.forEach((digest, index) => have.set(digest, marks[index]!));
          lookUp(open.slice(BATCH));
        }
        if (waits.length === 0) return;
        await Promise.all(waits);
      }
    })();
    if (bound === undefined) {
      await work;
      return { marks: have, found, model: state.model };
    }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      if (typeof bound !== "number") {
        if (bound.aborted) resolve("late");
        else bound.addEventListener("abort", () => resolve("late"), { once: true });
        return;
      }
      timer = setTimeout(resolve, bound, "late");
      timer.unref();
    });
    const first = await Promise.race([work.then(() => "done" as const), late]).finally(() => clearTimeout(timer));
    if (first === "late") {
      work.catch(() => undefined);
      return { wait: `Marking your record: ${have.size} of ${texts.size} passages` };
    }
    return { marks: have, found, model: state.model };
  }

  return {
    ready,

    async mark(texts, epoch) {
      const chosen = detector.state();
      if (chosen.state === "off") return { wait: waitLine(chosen) };
      const passages = texts.flatMap((text) => passagesOf(text).map((passage) => text.slice(passage.start, passage.end)));
      const digests = [...new Set(passages.map(sha256))];
      const unread = new Set<string>();
      let found = 0;
      let marked = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const detected = await detect(passages.filter((passage) => !unread.has(sha256(passage))), false, "mark", epoch);
        if ("unready" in detected) return { wait: detected.unready };
        if ("wait" in detected) return detected;
        if (store.epoch !== epoch) return { again: "An erasure forgot passages while they were marked: read the texts again" };
        found += detected.found;
        for (const [digest, marks] of detected.marks) if (marks === null) unread.add(digest);
        const state = detector.state();
        if (state.state !== "ready") return { wait: waitLine(state) };
        const kept = store.read(digests, state.model);
        marked = digests.filter((digest) => kept.get(digest)?.current === true || unread.has(digest)).length;
        if (marked === digests.length) return { passages: digests.length, found };
      }
      return { again: `The hiding model changed while it marked: ${marked} of ${digests.length} passages` };
    },

    async hide(texts, level, table, bound, since, reader = OPEN) {
      const prepared = texts.map(prepare);
      const people = inputs.people();
      const sealing = sealsAny(reader.sealed);
      const leaves = sealing ? NAMING.filter((type) => !hides(level, type)) : [];
      const working = sealedOver(withWords(level), leaves);
      const tableOf = async (marked: readonly Marked[]): Promise<PlaceholderTable> => (typeof table === "function" ? table(hidesAny(working) ? wantedOf(marked) : { ...wantedOf(marked), words: new Set<string>() }) : table);
      if (!hidesAny(working)) {
        const segments = prepared.map((text) => text.segments?.map((segment) => ({ text: segment.text, marks: segment.stated.filter((mark) => mark.type === "ref").map(({ way: _way, ...mark }) => mark), ...(segment.quoted ? { quoted: true as const } : {}) })) ?? []);
        const marked = segments.flat();
        const named = new Map<number, NamedFace[]>();
        const cannot = new Map<number, string>();
        for (const [index, text] of prepared.entries()) {
          if (text.picture?.tags !== true) continue;
          const findings = await pictures.read(text.picture.picture);
          if ("cannot" in findings) {
            cannot.set(index, findings.cannot);
            continue;
          }
          named.set(index, namedFaces(findings.faces, people));
        }
        const owner = people?.owner ?? null;
        const hidden = hideDetails(marked, level, await tableOf([...marked, ...personTexts(named)]), owner);
        const tags = tagged(named, hidden.table, owner, hidden.texts);
        const made = await makeAll(prepared, (index) => ({ words: [], faces: [], cover: false, tagged: tags.faces.get(index) ?? [] }), cannot);
        return { ...assemble(prepared, segments, hidden, made, cannot), table: tags.table, counts: hidden.counts, detector: null };
      }
      if (people === undefined) return { wait: NO_NAMES };
      const settings = inputs.settings();
      const off = detector.state().state === "off";
      const epoch = off ? "" : (since ?? store.epoch);
      const seal: Seal | null = sealOf(people, reader.sealed);
      const sealed = (type: string, text: string, who?: string) => seal !== null && seal.detail(type, text, who);
      const open = (type: string, text: string, who?: string) => (leaves as readonly string[]).includes(type) && !sealed(type, text, who);
      const neverWords = reader.shown.length === 0 ? settings.never : [...settings.never, ...reader.shown];
      const ways: Ways = {
        names: matcherOf(people), links: settings.links, always: settings.always, never: neverWords,
        ...(seal === null ? {} : { seal: { open: (mark: Mark, text: string) => open(mark.type, text, mark.who), sealed: (mark: Mark, text: string) => sealed(mark.type, text, mark.who) } }),
      };
      const read = new Map<number, { text: string; words: { start: number; end: number; box: Box }[]; faces: Face[] }>();
      const cannot = new Map<number, string>();
      for (const [index, text] of prepared.entries()) {
        if (text.picture === undefined) continue;
        const findings = await pictures.read(text.picture.picture);
        if ("cannot" in findings) {
          cannot.set(index, findings.cannot);
          continue;
        }
        read.set(index, { ...linesText(findings.lines), faces: findings.faces });
      }
      const reads = new Map<Free, Read[]>();
      const readsOf = (free: Free) => {
        reads.set(free, readPassages(free).map((passage) => {
          const text = free.source.slice(passage.start, passage.end);
          return { start: passage.start, text, digest: sha256(text) };
        }));
        return free;
      };
      for (const text of prepared) for (const segment of text.segments ?? []) segment.frees.forEach(readsOf);
      const pictureFrees = new Map([...read].map(([index, picture]) => [index, readsOf({ length: picture.text.length, source: picture.text, known: [], lines: true })]));
      let detected = new Map<string, PassageMark[] | null>();
      let used: string | null = null;
      let fallback: string | undefined;
      if (!off && (hidesAny(level) || seal?.only === true)) {
        const answer = await detect([...reads.values()].flatMap((passages) => passages.map((passage) => passage.text)), true, "hide", epoch, bound)
          .catch((error: unknown) => ({ rejected: error instanceof Error ? error.message : String(error) }));
        if ("wait" in answer) return answer;
        if ("marks" in answer) {
          detected = answer.marks;
          used = answer.model.id;
        } else fallback = "unready" in answer ? answer.unready : answer.rejected;
      }
      const marksOfPiece = new Map<Free, Mark[]>();
      const openOf = new Map<Free, Mark[]>();
      const namesOf = new Map<string, readonly Mark[]>();
      const readings = new Map<string, Reading>();
      for (const free of reads.keys()) {
        await turn();
        let names = namesOf.get(free.source);
        if (names === undefined) {
          const reading = readWords(free.source);
          readings.set(free.source, reading);
          namesOf.set(free.source, (names = ways.names.marks(free.source, reading)));
        }
        let named: Mark[] | null = null;
        const fit = (passage: { start: number; text: string; digest: string }) => {
          const marks = detected.get(passage.digest) ?? [];
          if (marks.length === 0) return [];
          named ??= [...free.known, ...names].filter((mark) => baseOf(mark.type) === "person");
          const end = passage.start + passage.text.length;
          return fitted(passage.text, marks, named.filter((mark) => mark.start < end && passage.start < mark.end).map((mark) => ({ start: mark.start - passage.start, end: mark.end - passage.start })));
        };
        marksOfPiece.set(free, marksOfFree(free, ways, reads.get(free)!.map((passage) => ({ start: passage.start, marks: fit(passage) })), working, names));
        if (seal !== null) openOf.set(free, names.filter((mark) => open(mark.type, free.source.slice(mark.start, mark.end), mark.who)));
      }
      const unread = (free: Free) => reads.get(free)!.some((passage) => detected.get(passage.digest) === null);
      for (const [index, text] of prepared.entries()) {
        if (text.segments?.some((segment) => segment.frees.some(unread))) cannot.set(index, UNREAD);
        else if (pictureFrees.has(index) && unread(pictureFrees.get(index)!)) cannot.set(index, UNREAD_PICTURE);
      }
      const never = new Set(neverWords.map((word) => word.toLowerCase()));
      const segments: Marked[][] = prepared.map((text) => (text.segments ?? []).map((segment) => {
        if (segment.quoted) return { text: segment.text, marks: [], quoted: true };
        const leave = [...segment.own];
        const marks: Mark[] = [];
        const kept = (mark: Mark) => {
          const text = segment.text.slice(mark.start, mark.end);
          return sealed(mark.type, text, mark.who) || (!never.has(text.toLowerCase()) && !open(mark.type, text, mark.who));
        };
        for (const { way: _way, ...mark } of segment.stated) {
          if (!businessOrBot(mark, ways.names)) {
            if (kept(mark)) marks.push(mark);
            else if (open(mark.type, segment.text.slice(mark.start, mark.end), mark.who)) leave.push({ start: mark.start, end: mark.end });
            continue;
          }
          leave.push({ start: mark.start, end: mark.end });
          for (const named of ways.names.marks(segment.text.slice(mark.start, mark.end))) {
            const inside = { ...named, start: mark.start + named.start, end: mark.start + named.end };
            if (standsInside(mark, { ...inside, way: 3 }, segment.text) && kept(inside)) marks.push(inside);
          }
        }
        for (const free of segment.frees) {
          for (const mark of marksOfPiece.get(free)!) marks.push({ ...mark, start: free.at + mark.start, end: free.at + mark.end });
          for (const mark of free.known) {
            const [start, end] = [Math.max(mark.start, 0), Math.min(mark.end, free.length)];
            if (start < end && businessOrBot(mark, ways.names)) leave.push({ start: free.at + start, end: free.at + end });
          }
          for (const mark of openOf.get(free) ?? []) if (mark.start < free.length) leave.push({ start: free.at + mark.start, end: free.at + Math.min(mark.end, free.length) });
        }
        const reading = readings.get(segment.text);
        return { text: segment.text, marks, ...(leave.length === 0 ? {} : { leave }), ...(reading === undefined ? {} : { reading }) };
      }));
      const stated = segments.filter((_, index) => !cannot.has(index)).flat();
      const marked = stated.map((each) => asPeople(each, ways.names));
      const pictureMarked = [...pictureFrees].filter(([index]) => !cannot.has(index)).map(([index, free]): [number, Marked] => [index, { text: free.source, marks: marksOfPiece.get(free)!, reading: readings.get(free.source)! }]);
      const pictureTexts = pictureMarked.map(([, picture]) => picture);
      const named = new Map(pictureMarked.flatMap(([index]) => (prepared[index]!.picture!.tags === true ? [[index, namedFaces(read.get(index)!.faces, people)] as const] : [])));
      const part = await tableOf([...marked, ...pictureTexts, ...personTexts(named)]);
      await turn();
      const unheld = seal === null ? neverWords : unheldOf(neverWords, part, stated, open, sealed);
      const hidden = hideDetails(marked, working, part, people.owner, unheld);
      const tags = tagged(named, hidden.table, people.owner, hidden.texts);
      const held = pictureMarked.length === 0 ? [] : heldMarks([...marked, ...pictureTexts], working, part, unheld).slice(marked.length);
      const picturesMarked = new Map(pictureMarked.map(([index, picture], at) => [index, { ...picture, marks: [...picture.marks, ...held[at]!] }]));
      const covers = pictureMarked.length === 0 ? () => false : coverOf(working, part, [...marked, ...pictureTexts], (entry) => open(entry.type, entry.detail, entry.who));
      const made = await makeAll(prepared, (index) => {
        const picture = read.get(index)!;
        const { text, marks } = picturesMarked.get(index)!;
        const covered = marks.filter((mark) => covers(mark.type, text.slice(mark.start, mark.end)));
        const words = picture.words.filter((word) => covered.some((mark) => mark.start < word.end && word.start < mark.end)).map((word) => word.box);
        return { words, faces: picture.faces.map((face) => face.box), cover: hides(working, "face"), tagged: tags.faces.get(index) ?? [] };
      }, cannot);
      return { ...assemble(prepared, segments, hidden, made, cannot), table: tags.table, counts: hidden.counts, detector: used, ...(fallback === undefined ? {} : { fallback }) };
    },
  };

  async function makeAll(prepared: readonly Prepared[], fill: (index: number) => { words: Box[]; faces: readonly Box[]; cover: boolean; tagged: readonly Tagged[] }, cannot: Map<number, string>): Promise<Map<number, Picture>> {
    const made = new Map<number, Picture>();
    for (const [index, text] of prepared.entries()) {
      if (text.picture === undefined || cannot.has(index)) continue;
      const { words, faces, cover, tagged } = fill(index);
      const picture = await pictures.make({ blob: text.picture.picture, filled: words, ...facesDrawn(faces, [...(text.picture.faces ?? []), ...tagged], cover) });
      if ("cannot" in picture) cannot.set(index, picture.cannot);
      else made.set(index, picture);
    }
    return made;
  }
}

interface NamedFace {
  box: Box;
  who: string;
  shown: string;
}

interface Tagged {
  box: Box;
  placeholder: string;
}

function namedFaces(faces: readonly Face[], people: NameTable | undefined): NamedFace[] {
  const named: NamedFace[] = [];
  for (const { box, who } of faces) {
    if (who === undefined || people === undefined) continue;
    const shown = who === people.owner?.who ? people.owner.shown : people.people.find((person) => person.who === who)?.shown;
    if (shown === undefined || shown === "" || named.some((face) => overlap(face.box, box, "smaller") >= 0.5)) continue;
    named.push({ box, who, shown });
  }
  return named;
}

function personTexts(named: ReadonlyMap<number, readonly NamedFace[]>): Marked[] {
  const people = new Map<string, string>();
  for (const faces of named.values()) for (const face of faces) if (!people.has(face.who)) people.set(face.who, face.shown);
  return [...people].map(([who, shown]) => ({ text: shown, marks: [{ start: 0, end: shown.length, type: "person", who, shown }] }));
}

function tagged(named: ReadonlyMap<number, readonly NamedFace[]>, table: PlaceholderTable, owner: Owner | null, texts: readonly string[]): { table: PlaceholderTable; faces: Map<number, Tagged[]> } {
  const people = personTexts(named);
  if (people.length === 0) return { table, faces: new Map() };
  const standing = texts.filter((text) => text !== "").map((text): Marked => ({ text, marks: [], leave: [{ start: 0, end: text.length }] }));
  const given = hideDetails([...people, ...standing], ["person"], table, owner);
  const placeholders = new Map(people.map((person, at) => [person.marks[0]!.who!, given.texts[at]!]));
  return { table: given.table, faces: new Map([...named].map(([index, faces]) => [index, faces.map((face) => ({ box: face.box, placeholder: placeholders.get(face.who)! }))])) };
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function coverOf(level: Level, table: PlaceholderTable, marked: readonly Marked[], open: (entry: Entry) => boolean): (type: DetailType, text: string) => boolean {
  const hidden = new Set<string>();
  for (const entry of table.entries) if (entry.face === undefined && !open(entry) && (baseOf(entry.type) !== "person" || hides(level, entry.type))) hidden.add(detailKey(entry.type, entry.detail));
  for (const { text, marks, quoted } of marked) {
    if (quoted) continue;
    for (const mark of marks) if (isDetailType(mark.type) && mark.type !== "face" && hides(level, mark.type)) hidden.add(detailKey(mark.type, text.slice(mark.start, mark.end)));
  }
  return (type, text) => {
    if (hides(level, type)) return true;
    if (hidden.size === 0 || baseOf(type) === "ref") return false;
    const { keys } = wantedOf([{ text, marks: [{ start: 0, end: text.length, type }] }]);
    return [...keys].some((key) => hidden.has(key));
  };
}

function sealedOver(level: Level, leaves: readonly DetailType[]): Level {
  if (leaves.length === 0) return level;
  return [...(typeof level === "string" ? DETAIL_TYPES.filter((type) => hides(level, type)) : level), ...leaves];
}

type Judged = (type: string, text: string, who?: string) => boolean;

function unheldOf(never: readonly string[], table: PlaceholderTable, marked: readonly Marked[], open: Judged, sealed: Judged): string[] {
  const folded = (text: string) => text.normalize("NFC").toLowerCase();
  const held = new Set<string>();
  for (const entry of table.entries) if (sealed(entry.type, entry.detail, entry.who)) held.add(folded(entry.detail));
  for (const { text, marks } of marked) {
    for (const mark of marks) {
      const value = text.slice(mark.start, mark.end);
      if (sealed(mark.type, value, mark.who)) held.add(folded(value));
    }
  }
  const unheld = [...never, ...table.entries.filter((entry) => open(entry.type, entry.detail, entry.who)).map((entry) => entry.detail)];
  return unheld.filter((word) => !held.has(folded(word)));
}

function asPeople(marked: Marked, names: NameMatcher): Marked {
  if (marked.marks.every((mark) => mark.who === undefined)) return marked;
  return { ...marked, marks: marked.marks.map((mark) => (mark.who === undefined ? mark : { ...mark, who: names.personOf(mark.who) })) };
}

function withWords(level: Level): Level {
  return typeof level === "string" || !hidesAny(level) || level.includes("word") ? level : [...level, "word"];
}

function prepare(text: Text): Prepared {
  if (!Array.isArray(text)) return { picture: text as PictureText };
  const segments: Segment[] = [];
  let open: Segment | null = null;
  for (const piece of text as readonly (Piece | Quote)[]) {
    if ("quote" in piece) {
      segments.push({ text: piece.text, quoted: true, stated: [], frees: [], own: [] });
      open = null;
      continue;
    }
    if (open === null) segments.push((open = { text: "", quoted: false, stated: [], frees: [], own: [] }));
    const at = open.text.length;
    open.text += piece.text;
    if ("is" in piece) {
      if (!isDetailType(piece.is) || piece.is === "face") throw new HideError(`${JSON.stringify(piece.is)} is no type a stated piece may be`);
      if (piece.text !== "") open.stated.push({ start: at, end: at + piece.text.length, type: piece.is, ...(piece.who === undefined ? {} : { who: piece.who }), ...(piece.shown === undefined ? {} : { shown: piece.shown }), way: 1 });
    } else if ("free" in piece) {
      const source = piece.whole ?? piece.text;
      if (!source.startsWith(piece.text)) throw new HideError("a free piece's `whole` begins with its text");
      for (const mark of piece.known ?? []) {
        if (!isDetailType(mark.type) || mark.start < 0 || mark.end <= mark.start || mark.end > source.length) throw new HideError(`a known mark from ${mark.start} to ${mark.end} is outside its piece`);
      }
      open.frees.push({ at, length: piece.text.length, source, known: piece.known ?? [] });
    } else if (piece.text !== "") {
      open.own.push({ start: at, end: at + piece.text.length });
    }
  }
  return { segments };
}

function assemble(prepared: readonly Prepared[], segments: readonly (readonly Marked[])[], hidden: Pick<Hidden, "texts" | "spans">, pictures: ReadonlyMap<number, Picture>, cannot: ReadonlyMap<number, string>): { texts: HiddenText[]; spans: Placed[][] } {
  let next = 0;
  const spans: Placed[][] = [];
  const texts = prepared.map((text, index): HiddenText => {
    const why = cannot.get(index);
    if (why !== undefined || text.picture !== undefined) {
      spans.push([]);
      return why !== undefined ? { cannot: why } : pictures.get(index)!;
    }
    const placed: Placed[] = [];
    let at = 0;
    let joined = "";
    for (const segment of segments[index]!) {
      for (const span of hidden.spans[next]!) placed.push({ start: at + span.start, end: at + span.end, placeholder: span.placeholder });
      joined += hidden.texts[next]!;
      at += segment.text.length;
      next += 1;
    }
    spans.push(placed);
    return joined;
  });
  return { texts, spans };
}

function checked(found: { model: DetectorModel; marks: (PassageMark[] | null)[] }, passages: readonly string[]): (PassageMark[] | null)[] {
  if (!Array.isArray(found.marks) || found.marks.length !== passages.length) throw new HideError(`the detector answered ${found.marks?.length} lists for ${passages.length} passages`);
  return found.marks.map((marks, index) => {
    if (marks === null) return null;
    if (!Array.isArray(marks)) throw new HideError(`the detector answered no list for passage ${index}`);
    return marks.flatMap((mark: unknown): PassageMark[] => {
      if (typeof mark !== "object" || mark === null) return [];
      const { start, end, type } = mark as Partial<Record<keyof PassageMark, unknown>>;
      if (!isDetailType(type) || ["ref", "face", "word"].includes(type)) return [];
      if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > passages[index]!.length) return [];
      return [{ start, end, type }];
    });
  });
}
