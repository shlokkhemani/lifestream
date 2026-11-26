import { BRIEF_LINES, BRIEF_WINDOWS } from "./brief.js";
import { BUILDING, refused, SEARCH_REFUSALS, type SearchRefusalCode } from "./refusal.js";


export class ContractError extends Error {
  constructor(readonly at: string, readonly why: string) {
    super(`${at}: ${why}`);
    this.name = "ContractError";
  }
}

export type Form =
  | { of: "text" }
  | { of: "number" }
  | { of: "list"; each: Form }
  | { of: "one-or-list"; each: Form }
  | { of: "map"; each: Form }
  | { of: "object"; members: Readonly<Record<string, Shape<unknown>>> };

export type Schema = { readonly [key: string]: unknown };

export interface Shape<T> {
  parse(value: unknown, at?: string): T;
  readonly form?: Form;
  readonly schema: Schema;
}

export type Of<S> = S extends Shape<infer T> ? T : never;

type Shapes = Record<string, Shape<unknown>>;
type Flat<T> = { [K in keyof T]: T[K] } & {};
type Built<R extends Shapes, O extends Shapes> = Flat<{ [K in keyof R]: Of<R[K]> } & { [K in keyof O]?: Of<O[K]> }>;

const TEXT: Form = { of: "text" };
const NUMBER: Form = { of: "number" };

const shape = <T>(parse: (value: unknown, at: string) => T, form: Form | undefined, schema: Schema): Shape<T> =>
  ({ parse: (value, at = "$") => parse(value, at), schema, ...(form === undefined ? {} : { form }) });

const formOf = (of: Shape<unknown>): Form => of.form ?? TEXT;

const fail = (at: string, why: string): never => {
  throw new ContractError(at, why);
};

const said = (value: unknown): string => (value === undefined ? "nothing" : JSON.stringify(value)?.slice(0, 60) ?? String(value));

export const LEAVES = ["ref", "cursor", "name", "id", "excerpt", "free", "term", "label", "picture"] as const;
export type Leaf = (typeof LEAVES)[number];

export function text(pattern?: RegExp, what?: string, leaf: Leaf = "free"): Shape<string> {
  return shape((value, at) => {
    if (typeof value !== "string") return fail(at, `wants a string, has ${said(value)}`);
    if (pattern !== undefined && !pattern.test(value)) return fail(at, `wants ${what ?? String(pattern)}, has ${said(value)}`);
    return value;
  }, undefined, { type: "string", ...(pattern === undefined ? {} : { pattern: pattern.source }), ...(what === undefined ? {} : { description: what }), leaf });
}

export function int(min = 0, max = Number.MAX_SAFE_INTEGER): Shape<number> {
  return shape((value, at) => {
    if (typeof value !== "number" || !Number.isInteger(value)) return fail(at, `wants a whole number, has ${said(value)}`);
    if (value < min || value > max) return fail(at, `wants ${min} to ${max}, has ${value}`);
    return value;
  }, NUMBER, { type: "integer", ...(min === Number.MIN_SAFE_INTEGER ? {} : { minimum: min }), ...(max === Number.MAX_SAFE_INTEGER ? {} : { maximum: max }) });
}

export const num: Shape<number> = shape((value, at) =>
  typeof value === "number" && Number.isFinite(value) ? value : fail(at, `wants a number, has ${said(value)}`), NUMBER, { type: "number" });

export const bool: Shape<boolean> = shape((value, at) => (typeof value === "boolean" ? value : fail(at, `wants true or false, has ${said(value)}`)), undefined, { type: "boolean" });

export function oneOf<const V extends readonly (string | number | boolean)[]>(...values: V): Shape<V[number]> {
  return shape((value, at) =>
    values.includes(value as V[number]) ? (value as V[number]) : fail(at, `wants one of ${values.map(v => JSON.stringify(v)).join(", ")}, has ${said(value)}`),
  values.every(v => typeof v === "number") ? NUMBER : TEXT, { enum: values, leaf: "label" });
}

export function list<T>(of: Shape<T>, min = 0, max = Number.MAX_SAFE_INTEGER): Shape<T[]> {
  return shape((value, at) => {
    if (!Array.isArray(value)) return fail(at, `wants a list, has ${said(value)}`);
    if (value.length < min || value.length > max) return fail(at, `wants ${min} to ${max === Number.MAX_SAFE_INTEGER ? "any number of" : max} members, has ${value.length}`);
    return value.map((member, i) => of.parse(member, `${at}[${i}]`));
  }, { of: "list", each: formOf(of) }, {
    type: "array", items: of.schema, ...(min === 0 ? {} : { minItems: min }), ...(max === Number.MAX_SAFE_INTEGER ? {} : { maxItems: max }),
  });
}

export function tuple<const S extends readonly Shape<unknown>[]>(...shapes: S): Shape<{ -readonly [I in keyof S]: Of<S[I]> }> {
  return shape((value, at) => {
    if (!Array.isArray(value) || value.length !== shapes.length) return fail(at, `wants a list of ${shapes.length}, has ${said(value)}`);
    return shapes.map((s, i) => s.parse(value[i], `${at}[${i}]`)) as { -readonly [I in keyof S]: Of<S[I]> };
  }, undefined, { type: "array", prefixItems: shapes.map((s) => s.schema), minItems: shapes.length, maxItems: shapes.length });
}

export function nullable<T>(of: Shape<T>): Shape<T | null> {
  return shape((value, at) => (value === null ? null : of.parse(value, at)), of.form, { anyOf: [of.schema, { type: "null" }] });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export function map<T>(of: Shape<T>, key?: Shape<string>): Shape<Record<string, T>> {
  return shape((value, at) => {
    if (!isObject(value)) return fail(at, `wants an object, has ${said(value)}`);
    const out = dictionary<T>();
    for (const [name, member] of Object.entries(value)) {
      key?.parse(name, `${at}.${name}`);
      out[name] = of.parse(member, `${at}.${name}`);
    }
    return out;
  }, { of: "map", each: formOf(of) }, { type: "object", additionalProperties: of.schema, ...(key === undefined ? {} : { propertyNames: key.schema }) });
}

export function object<R extends Shapes, O extends Shapes = Record<never, never>>(required: R, optional?: O): Shape<Built<R, O>> {
  return shape((value, at) => {
    if (!isObject(value)) return fail(at, `wants an object, has ${said(value)}`);
    const out = dictionary<unknown>();
    for (const [name, member] of Object.entries(required)) {
      if (!Object.hasOwn(value, name)) return fail(`${at}.${name}`, "is missing");
      out[name] = member.parse(value[name], `${at}.${name}`);
    }
    for (const [name, member] of Object.entries(optional ?? {})) {
      if (Object.hasOwn(value, name) && value[name] !== undefined) out[name] = member.parse(value[name], `${at}.${name}`);
    }
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(required, name) && !Object.hasOwn(optional ?? {}, name)) return fail(`${at}.${name}`, "is no member of this shape");
    }
    return out as Built<R, O>;
  }, { of: "object", members: { ...required, ...optional } }, {
    type: "object",
    properties: Object.fromEntries(Object.entries({ ...required, ...optional }).map(([name, member]) => [name, member.schema])),
    ...(Object.keys(required).length === 0 ? {} : { required: Object.keys(required) }),
    additionalProperties: false,
  });
}

export function either<const S extends readonly Shape<unknown>[]>(...shapes: S): Shape<Of<S[number]>> {
  return shape((value, at) => {
    const breaks: string[] = [];
    for (const s of shapes) {
      try {
        return s.parse(value, at) as Of<S[number]>;
      } catch (error) {
        if (!(error instanceof ContractError)) throw error;
        breaks.push(error.message);
      }
    }
    return fail(at, `is none of its shapes (${breaks.join("; ")})`);
  }, eitherForm(shapes), { anyOf: shapes.map((s) => s.schema) });
}

export function endingIn<T, L>(each: Shape<T>, last: Shape<L>): Shape<(T | L)[]> {
  return shape((value, at) => {
    if (!Array.isArray(value) || value.length === 0) return fail(at, `wants a list of one or more, has ${said(value)}`);
    return value.map((member, i) => (i === value.length - 1 ? last : each).parse(member, `${at}[${i}]`) as T | L);
  }, { of: "list", each: formOf(each) }, { type: "array", items: each.schema, lastItem: last.schema, minItems: 1 });
}

const eitherForm = (shapes: readonly Shape<unknown>[]): Form | undefined => {
  const listed = shapes.map(formOf).find(form => form.of === "list");
  return listed?.of === "list" ? { of: "one-or-list", each: listed.each } : shapes[0]?.form;
};

export function tagged<const K extends string, const C extends Record<string, Shape<unknown>>>(tag: K, cases: C): Shape<Of<C[keyof C]>> {
  return shape((value, at) => {
    if (!isObject(value)) return fail(at, `wants an object, has ${said(value)}`);
    const name = Object.hasOwn(value, tag) ? value[tag] : undefined;
    if (typeof name !== "string" || !Object.hasOwn(cases, name)) return fail(`${at}.${tag}`, `wants one of ${Object.keys(cases).join(", ")}, has ${said(name)}`);
    return cases[name]!.parse(value, at) as Of<C[keyof C]>;
  }, undefined, { anyOf: Object.values(cases).map((each) => each.schema) });
}

export function rule<T>(of: Shape<T>, check: (value: T) => string | null): Shape<T> {
  return shape((value, at) => {
    const parsed = of.parse(value, at);
    const broken = check(parsed);
    return broken === null ? parsed : fail(at, broken);
  }, of.form, of.schema);
}


export const day = text(/^\d{4}-\d{2}-\d{2}$/u, "a day, YYYY-MM-DD", "label");
export const month = text(/^\d{4}-\d{2}$/u, "a month, YYYY-MM", "label");
export const instant = text(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u, "an instant with its offset", "label");
export const when = text(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u, "a day, a local time or an instant", "label");
export const ref = text(/^\S/u, "a ref or a handle", "ref");
export const HANDLE = /^r[1-9]\d*$/u;
export const handle = text(HANDLE, "a handle, r<n>", "ref");
export const cursor = text(/^\S/u, "a cursor", "cursor");
const words = text();
const label = text(undefined, undefined, "label");
const name = text(undefined, undefined, "name");
const id = text(undefined, undefined, "id");
const excerpt = text(undefined, undefined, "excerpt");
const term = text(undefined, undefined, "term");
const picture = text(undefined, undefined, "picture");

export const FAMILIES = ["messages", "mail", "calls", "callaudio", "calendar", "notes", "ai", "web", "screen", "photos", "health", "money", "physical", "listening", "voice", "phone"] as const;
export const family = oneOf(...FAMILIES);
export type Family = Of<typeof family>;

export function familyOf(name: string | null | undefined): Family {
  return (FAMILIES as readonly string[]).includes(name ?? "") ? name as Family : "notes";
}

export function storedFamilies(asked: readonly Family[], held: readonly string[]): string[] {
  return [...asked, ...asked.includes("notes") ? held.filter((name) => name !== "notes" && familyOf(name) === "notes") : []];
}

export const reached = object({ side: oneOf("newest", "oldest"), at: instant, whole: nullable(day) });
export const screenReached = object({ side: oneOf("newest", "oldest"), whole: day });
export const pending = list(object({ day, why: oneOf("new", "erased", "failed") }), 0, 100);
const fresh = { pending, pending_more: int(1) };
export const fits = object({ from: day, to: day });
export const held = nullable(object({ first: day, last: day }));
export const unread = object({ unread: label });
export const focus = text(/^(?:rec:\S+ \S+ \S.*|u:\S.*)$/su, "a focus of Days, rec: or u:", "label");

const cappedHasNext = (value: { capped?: boolean; next?: string | null }): string | null =>
  value.capped === true && (value.next === undefined || value.next === null) ? "a capped list has no next" : null;


export const searchParams = object({}, {
  query: term,
  from: when,
  to: when,
  families: list(family, 1),
  products: list(label, 1),
  person: list(name, 1, 10),
  chat: ref,
  place: words,
  order: oneOf("relevance", "newest", "oldest"),
  limit: int(1, 50),
  lists: list(oneOf("record", "screen", "goto"), 1, 3),
  typing: oneOf(1),
  cursor,
});
export type SearchParams = Of<typeof searchParams>;

const groupCount = either(int(), object({ n: int(), partial: oneOf(true) }));

export const recordHit = rule(object({ ref, family }, {
  day,
  at: instant,
  product: words,
  title: words,
  from: name,
  snippet: excerpt,
  chat: ref,
  chat_title: name,
  the_user_was_at: words,
  picture: int(1),
  rev: label,
  more: oneOf(true),
}), (hit) => (hit.at !== undefined && hit.day === undefined ? "a hit with `at` states its `day`" : null));
export type RecordHit = Of<typeof recordHit>;

const order = oneOf("newest");

export const recordList = rule(object({ total: int(), hits: list(recordHit) }, {
  as_of: instant,
  capped: bool,
  reached,
  held,
  ...fresh,
  unproven: int(),
  spread: object({ families: map(groupCount, family), months: map(groupCount, month) }),
  order,
  next: nullable(cursor),
}), cappedHasNext);
export type RecordList = Of<typeof recordList>;

export const screenHit = rule(object({ ref, day, app: label, title: words, snippet: excerpt, reason: oneOf("words", "spelling", "partial", "meaning") }, {
  at: instant,
  until: instant,
  time_precision: oneOf("range"),
  also: int(1),
}), hit => ((hit.until === undefined) !== (hit.time_precision === undefined) ? "`until` and `time_precision: range` go together" : null));
export type ScreenHit = Of<typeof screenHit>;

export const screenList = rule(rule(rule(object({ meaning: oneOf("on", "off", "not_asked", "waits", "withheld"), hits: list(screenHit) }, {
  as_of: instant,
  total: int(),
  capped: bool,
  reached: screenReached,
  ...fresh,
  unproven: int(),
  waits: label,
  order,
  next: nullable(cursor),
  next_gives: oneOf("windows", "days"),
}), cappedHasNext), list => ((list.meaning === "waits") !== (list.waits !== undefined) ? "`meaning: waits` and its line `waits` go together" : null)),
list => ((typeof list.next === "string") !== (list.next_gives !== undefined) ? "a `next` and its `next_gives` go together" : null));
export type ScreenList = Of<typeof screenList>;

export const goto = object({ people: list(object({ ref, name }), 0, 3), places: list(object({ ref, name: words }), 0, 3), day: nullable(day), month: nullable(month) });

export const personResolved = object({ asked: term, name }, { ref });

export const searchAnswer = object({}, {
  read_as: object({ without: list(term), as: map(list(words), term) }),
  variants: map(list(words, 1, 5), term),
  not_searched: list(term, 1),
  person: list(personResolved, 1, 10),
  record: recordList,
  screen: either(screenList, unread),
  goto,
  outside: oneOf(true),
});
export type SearchAnswer = Of<typeof searchAnswer>;


export const OPS = ["sum", "avg", "min", "max", "first", "last"] as const;
const op = oneOf(...OPS);

export const collectionKey = text(/^[a-z][a-z0-9_]*$/u, "a key a collection has, a lower-case name", "label");

const counted = {
  measure: label,
  op,
  by: list(label, 1, 2),
  from: when,
  to: when,
  person: list(name, 1, 10),
  chat: ref,
  place: words,
  words: term,
  match: map(term, collectionKey),
  at_least: num,
  at_most: num,
  order: oneOf("value", "time"),
  limit: int(1, 100),
};
const countRule = (asked: { by?: string[]; op?: string; measure?: string }): string | null =>
  asked.by?.includes("item") === true && asked.by.length > 1 ? "`by: item` stands alone"
    : asked.op !== undefined && asked.measure === undefined ? "an `op` takes a `measure`"
    : null;

export const countParams = rule(object({}, { of: label, ...counted, cursor }), countRule);
export type CountParams = Of<typeof countParams>;

export const countHeld = rule(object({}, { of: label, ...counted, typing: oneOf(1) }), countRule);

export const rowAsk = rule(object({ of: label }, { ...counted, typing: oneOf(1) }), countRule);
export type RowAsk = Of<typeof rowAsk>;

const cell = nullable(either(words, num, bool));
const countRow = endingIn(cell, nullable(ref));

const amount = either(num, words);

const matched = map(either(words, map(list(words), term)), label);

export const countResult = object({
  asked: words,
  population: object({ facts: int(), valued: int(), missing: int(), excluded: map(int(), label) }, { shared: int() }),
  counted: words,
  columns: list(label, 1),
  rows: list(countRow),
}, {
  as_of: instant,
  matched,
  held,
  also: list(words),
  readings: list(label),
  days_there: object({ zone: label, first: day, last: day }),
  total: object({ n: int() }, { ref, said: words, sum: amount, avg: amount, min: amount, max: amount }),
  ...fresh,
  not_searched: list(term, 1),
  next: nullable(cursor),
  outside: oneOf(true),
});
export type CountResult = Of<typeof countResult>;

const foundFact = object({ value: amount, ref }, { at: instant, day, said: words });
export const countFound = object({
  asked: words,
  op: oneOf("first", "last"),
  found: nullable(foundFact),
}, {
  as_of: instant,
  ties: list(foundFact, 1),
  matched,
  held,
  readings: list(label),
  ...fresh,
  not_searched: list(term, 1),
  columns: list(label, 1),
  rows: list(countRow),
  next: nullable(cursor),
  outside: oneOf(true),
});
export type CountFound = Of<typeof countFound>;

export const countCatalog = object({
  families: list(object({ family, products: list(label), held })),
  collections: list(object({
    of: label,
    keys: list(label),
    measures: list(object({ measure: label, unit: label }, { sums: oneOf(true), readings: list(label), held, stated: int() })),
    held,
  }, { about: label })),
  screen: either(object({ held, shows: list(label, 0, 20) }), unread),
}, {
  as_of: instant,
  outside: oneOf(true),
});
export type CountCatalog = Of<typeof countCatalog>;

export const countAnswer = either(countResult, countFound, countCatalog);


export const searchPeopleParams = rule(object({}, { name, id: ref, cursor }),
  asked => (asked.name !== undefined && asked.id !== undefined ? "give `name` or `id`, not both"
    : asked.name === undefined && asked.id === undefined && asked.cursor === undefined ? "give `name`, `id` or `cursor`"
    : null));
export type SearchPeopleParams = Of<typeof searchPeopleParams>;

export const peopleMatch = object({ ref, kind: oneOf("person", "group", "business", "bot"), name }, {
  id,
  the_user: oneOf(true),
  also: list(name),
  tied: list(ref),
  same: list(object({ ref, why: words })),
  handles: list(id),
  chats: list(object({ chat: ref, title: name, messages: int() }), 0, 12),
  reach: map(tuple(int(), day, day), label),
});
export type PeopleMatch = Of<typeof peopleMatch>;

export const elsewhere = rule(object({ as: oneOf("place", "payee", "app", "chat", "words") }, {
  n: int(),
  family: label,
  first: day,
  last: day,
  capped: bool,
  ref,
}), (each) => (each.n === undefined && each.capped !== true ? "an entry with no count is `capped`" : null));

export const searchPeopleAnswer = rule(object({ matches: list(peopleMatch, 0, 10) }, {
  note: words,
  elsewhere: list(elsewhere, 1),
  capped: bool,
  as_of: instant,
  next: nullable(cursor),
  outside: oneOf(true),
}), cappedHasNext);
export type SearchPeopleAnswer = Of<typeof searchPeopleAnswer>;


export const REFS_MOST = 20;
export const REFS_CHARS = 12_000;
const refsOf = (asked: { ref?: string | string[] }): string[] => (asked.ref === undefined ? [] : typeof asked.ref === "string" ? [asked.ref] : asked.ref);
const refsTooLong = (asked: { ref?: string | string[] }): string | null =>
  refsOf(asked).reduce((sum, each) => sum + each.length, 0) > REFS_CHARS
    ? `the refs together are over ${REFS_CHARS.toLocaleString("en")} characters: ask for fewer at once, the rest in another call` : null;

export const LAST_MOST_MS = 24 * 3_600_000;
const LAST = /^[1-9][0-9]{0,3}[mh]$/u;

export function lastMs(last: string): number {
  if (!LAST.test(last)) throw new Error(`${last} is not a duration`);
  return Number(last.slice(0, -1)) * (last.endsWith("h") ? 3_600_000 : 60_000);
}

export const readParams = rule(object({}, {
  ref: either(ref, list(ref, 1, REFS_MOST)),
  history: oneOf(1),
  chat: ref,
  from: when,
  to: when,
  last: text(LAST, "a duration: 45m, 3h", "label"),
  families: list(family, 1),
  products: list(label, 1),
  detail: oneOf("lines", "brief", "raw"),
  cursor,
}), asked => {
  if (asked.last !== undefined && asked.cursor !== undefined) return "`next` is given alone";
  if (asked.last !== undefined && (asked.from !== undefined || asked.to !== undefined)) return "`last` is a stretch that ends now: give `last`, or `from` and `to`";
  if (asked.last !== undefined && lastMs(asked.last) > LAST_MOST_MS) return "`last` is 24h at most: read days with `from` and `to`";
  const stretch = asked.chat === undefined && (asked.from !== undefined || asked.to !== undefined || asked.last !== undefined);
  const addresses = [asked.ref !== undefined, asked.chat !== undefined, stretch].filter(Boolean).length;
  if (addresses > 1) return "one address: `ref`, `chat`, or a stretch: `last`, or `from` and `to`";
  if (addresses === 0 && asked.cursor === undefined) return "give `ref`, `chat`, `last`, `from` and `to`, or `cursor`";
  if (asked.history !== undefined && asked.ref === undefined) return "`history` reads a ref's versions";
  if ((asked.detail !== undefined || asked.families !== undefined || asked.products !== undefined) && !stretch) return "`detail`, `families` and `products` read a stretch";
  return refsTooLong(asked);
});
export type ReadParams = Of<typeof readParams>;

export const line = object({ text: words }, {
  ref,
  at: instant,
  day,
  family,
  from: name,
  picture: oneOf(true),
  cites: list(ref, 1),
  cites_more: int(1),
});
export const screenLine = object({ at: instant, text: words }, { app: label, title: words });
export const pageSpan = object({ from: when, to: when });

const page = { as_of: instant, ...fresh, next: nullable(cursor), outside: oneOf(true) };
const stretchPage = { ...page, freshness: words };

export const readRecord = object({ what: oneOf("record"), ref, family, text: words }, {
  ...page,
  day,
  at: instant,
  product: words,
  title: words,
  from: name,
  to: list(name),
  who: list(name),
  link: words,
  picture: int(1),
  history: list(object({ at: instant, text: words })),
});
export const readChat = object({ what: oneOf("chat"), chat: ref, title: name, span: pageSpan, lines: list(line) }, { ...page, around: ref });

const placeNamed = object({ slug: words, name: words });
const circle = object({ latitude: num, longitude: num, radius_m: num });
const ms = int(Number.MIN_SAFE_INTEGER);
const onePlaceMembers = {
  latitude: num,
  longitude: num,
  radius_m: num,
  also: list(circle),
  ids: list(words),
  area: object({ city: nullable(words), region: nullable(words), country: nullable(words) }),
  days: int(),
  hours: num,
  first_ms: nullable(ms),
  last_ms: nullable(ms),
  visits_count: int(),
  nights: int(),
  here: bool,
  part_of: nullable(placeNamed),
  inside: list(placeNamed),
  ask_home: nullable(words),
  rhythm: nullable(words),
  visits: list(object({ unit: label, start_ms: ms, end_ms: ms, day, people: list(name), centre: object({ latitude: num, longitude: num }) })),
  photos: list(object({ image: label, at_ms: ms })),
  photos_count: int(),
  people: list(object({ id, name, days: int() }, { photo: either(object({ crop: label }), object({ card: label })) })),
};
export const onePlace = object({ slug: words, name: words, ...onePlaceMembers }, { home: bool });
export type OnePlace = Of<typeof onePlace>;
const placePage = object({ slug: words, name: words }, {
  ...onePlaceMembers,
  visits: list(object({ unit: label, start_ms: ms }, { end_ms: ms, day, people: list(name), centre: object({ latitude: num, longitude: num }) })),
  home: bool,
});

const opened = {
  record: readRecord,
  chat: readChat,
  line: object({ what: oneOf("line"), ref, day, rev: label, lines: list(line, 1) }, { ...page, record: readRecord }),
  row: object({ what: oneOf("row"), ref, asked: words, n: int(), columns: list(label, 1), rows: list(countRow) },
    { as_of: instant, ...fresh, next: nullable(cursor), now: int(), outside: oneOf(true) }),
  window: object({ what: oneOf("window"), ref, day, app: label, title: words, lines: list(screenLine) }, { ...page, at: instant }),
  photo: object({ what: oneOf("photo"), ref }, { ...page, day, image: picture, at: instant, title: words, the_user_was_at: words, facts: list(words) }),
  people: object({ what: oneOf("people"), match: peopleMatch }, { ...page, latest: readChat }),
  place: object({ what: oneOf("place"), ref, place: placePage }, page),
  gone: object({ what: oneOf("gone"), ref, why: words }),
};
export const readOne = tagged("what", opened);
export type ReadOne = Of<typeof readOne>;

export const readAnswer = tagged("what", {
  ...opened,
  refs: object({ what: oneOf("refs"), opened: list(readOne, 1, REFS_MOST) }, { unopened: list(ref, 1, REFS_MOST - 1), outside: oneOf(true) }),
  lines: object({ what: oneOf("lines"), span: pageSpan, lines: list(line) }, stretchPage),
  brief: object({ what: oneOf("brief"), span: pageSpan, days: list(object({ day, lines: list(line, 0, BRIEF_LINES + BRIEF_WINDOWS + 1) })) }, stretchPage),
  raw: object({ what: oneOf("raw"), span: pageSpan, records: list(readRecord) }, stretchPage),
  screen: object({ what: oneOf("screen"), span: pageSpan, lines: list(screenLine) }, stretchPage),
});
export type ReadAnswer = Of<typeof readAnswer>;


const building = nullable(object({ done: int(), of: int() }));
const indexState = { as_of: nullable(instant), building };

export const searchState = object({
  record: object(indexState),
  screen: object({
    ...indexState,
    power: oneOf("plugged-idle"),
    words_indexed_through: nullable(text(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u, "the home's minute, YYYY-MM-DD HH:MM", "label")),
    bytes: int(),
    vectors_bytes: int(),
    queued: int(),
    waits: nullable(label),
    waits_line: nullable(label),
    embedded: int(),
    named: int(),
    skipped: int(),
  }),
});


export const opens = either(
  object({ page: oneOf("days"), day }, { focus }),
  object({ page: oneOf("people", "places"), id: words }, { person: nullable(id), group: id }),
  object({ page: oneOf("read") }),
);

const thing = { ref, opens };
const placed = { day, at: instant, title: words, chat: ref, chat_title: words };
const voice = object({ audio: words, record: ref }, { seconds: int(), from_s: int(), from: name, mine: oneOf(true) });
export type Voice = Of<typeof voice>;
export const citation = tagged("kind", {
  record: object({ ...thing, kind: oneOf("record") }, { ...placed, voice }),
  message: object({ ...thing, kind: oneOf("message") }, { ...placed, voice }),
  turn: object({ ...thing, kind: oneOf("turn") }, placed),
  line: object({ ...thing, kind: oneOf("line") }, { ...placed, voice }),
  photo: object({ ...thing, kind: oneOf("photo"), image: words }, placed),
  window: object({ ...thing, kind: oneOf("window"), day, app: words, title: words }, { at: instant }),
  row: object({ ref, kind: oneOf("row"), asked: words, n: int(), opens }),
  person: object({ ref, kind: oneOf("person"), name: words, opens }),
  chat: object({ ref, kind: oneOf("chat"), name: words, opens }),
  place: object({ ref, kind: oneOf("place"), name: words, opens }),
  gone: object({ ref, kind: oneOf("gone"), why: words }),
});
export type Citation = Of<typeof citation>;
export type Opens = Of<typeof opens>;
export const citations = map(citation, handle);

export const describeParams = rule(object({ ref: either(ref, list(ref, 1, REFS_MOST)) }), refsTooLong);
export type DescribeParams = Of<typeof describeParams>;
export const describeAnswer = object({ described: list(citation, 1, REFS_MOST) }, { unopened: list(ref, 1, REFS_MOST - 1) });
export type DescribeAnswer = Of<typeof describeAnswer>;


export const searchRefusal = object({ code: oneOf(...(Object.keys(SEARCH_REFUSALS) as SearchRefusalCode[])), message: words }, {
  fits,
  keys: list(label),
  ops: list(op),
  instead: label,
  matches: list(peopleMatch, 1),
  not_searched: list(term, 1),
  building: list(oneOf(...BUILDING), 1),
  ...fresh,
});
export type SearchRefusal = Of<typeof searchRefusal>;


export function modelCall<T>(args: Shape<T>) {
  return object({ args }, { to: label, shown: list(words) });
}

export const ROUTES = {
  "/v1/search": { params: searchParams, call: modelCall(searchParams), answer: searchAnswer },
  "/v1/count": { params: countParams, call: modelCall(countParams), answer: countAnswer },
  "/v1/people/search": { params: searchPeopleParams, call: modelCall(searchPeopleParams), answer: searchPeopleAnswer },
  "/v1/read": { params: readParams, call: modelCall(readParams), answer: readAnswer },
  "/v1/describe": { params: describeParams, answer: describeAnswer },
  "/v1/search/state": { params: object({}), answer: searchState },
} as const;
export type RoutePath = keyof typeof ROUTES;

export type ContractPath = Exclude<RoutePath, "/v1/search/state">;

export const TOOL_ROUTES = ["/v1/search", "/v1/count", "/v1/people/search", "/v1/read"] as const;

const plainSchema = (schema: unknown): unknown =>
  Array.isArray(schema) ? schema.map(plainSchema)
    : isObject(schema) ? Object.fromEntries(Object.entries(schema).filter(([key, value]) => !(key === "leaf" && typeof value === "string")).map(([key, value]) => [key, plainSchema(value)]))
    : schema;

export function routeParams(): Record<(typeof TOOL_ROUTES)[number], Schema> {
  return Object.fromEntries(TOOL_ROUTES.map((path) => [path, plainSchema(ROUTES[path].params.schema)])) as Record<(typeof TOOL_ROUTES)[number], Schema>;
}

export interface Leaves {
  leaf?: Leaf;
  members?: Record<string, Leaves>;
  each?: Leaves;
  last?: Leaves;
  at?: Leaves[];
  values?: Leaves;
  keys?: Leaf;
}

const wider = (left: Leaf | undefined, right: Leaf): Leaf => {
  if (left === undefined || left === right || left === "ref" || left === "cursor") return left ?? right;
  if (right === "ref" || right === "cursor" || left === "label") return right;
  if (right === "label") return left;
  return left === "picture" || right === "picture" ? "picture" : "free";
};

export function leavesOf(of: Shape<unknown>): Leaves {
  const walk = (schema: Schema, into: Leaves): Leaves => {
    if (typeof schema.leaf === "string") into.leaf = wider(into.leaf, schema.leaf as Leaf);
    for (const each of (schema.anyOf as Schema[] | undefined) ?? []) walk(each, into);
    for (const [member, inner] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) {
      into.members ??= Object.create(null) as Record<string, Leaves>;
      into.members[member] = walk(inner, into.members[member] ?? {});
    }
    if (typeof schema.additionalProperties === "object") {
      into.values = walk(schema.additionalProperties as Schema, into.values ?? {});
      into.keys = wider(into.keys, ((schema.propertyNames as Schema | undefined)?.leaf as Leaf | undefined) ?? "free");
    }
    if (typeof schema.items === "object") into.each = walk(schema.items as Schema, into.each ?? {});
    if (typeof schema.lastItem === "object") into.last = walk(schema.lastItem as Schema, into.last ?? {});
    ((schema.prefixItems as Schema[] | undefined) ?? []).forEach((each, i) => {
      into.at ??= [];
      into.at[i] = walk(each, into.at[i] ?? {});
    });
    return into;
  };
  return walk(of.schema, {});
}

export function pathsOf(leaves: Leaves, kinds: readonly Leaf[], keys = false): string[] {
  const out = new Set<string>();
  const walk = (at: Leaves, path: string) => {
    if ((at.leaf !== undefined && kinds.includes(at.leaf)) || (keys && at.keys !== undefined && kinds.includes(at.keys))) out.add(path);
    for (const [member, inner] of Object.entries(at.members ?? {})) walk(inner, path === "" ? member : `${path}.${member}`);
    if (at.values !== undefined) walk(at.values, `${path}{}`);
    if (at.each !== undefined) walk(at.each, `${path}[]`);
    if (at.last !== undefined) walk(at.last, `${path}[-1]`);
    (at.at ?? []).forEach((each, i) => walk(each, `${path}[${i}]`));
  };
  walk(leaves, "");
  return [...out].sort();
}

export function routeRefs(): Record<(typeof TOOL_ROUTES)[number] | "refusal", string[]> {
  const of = (shape: Shape<unknown>) => pathsOf(leavesOf(shape), ["ref", "cursor"]);
  return { ...Object.fromEntries(TOOL_ROUTES.map((path) => [path, of(ROUTES[path].answer)])), refusal: of(searchRefusal) } as Record<(typeof TOOL_ROUTES)[number] | "refusal", string[]>;
}

export const CURSOR_PARAMS: ReadonlySet<string> = new Set(TOOL_ROUTES.flatMap((path) =>
  Object.entries(leavesOf(ROUTES[path].params as Shape<unknown>).members ?? {})
    .filter(([, leaves]) => (leaves?.leaf ?? leaves?.each?.leaf ?? leaves?.values?.leaf) === "cursor")
    .map(([name]) => name)));

export function routeEchoes(): Record<(typeof TOOL_ROUTES)[number], string[]> {
  const of = (shape: Shape<unknown>) => [...new Set(pathsOf(leavesOf(shape), ["term"], true).map((path) => path.replace(/(?:\[\]|\{\})+$/u, "")))].sort();
  return Object.fromEntries(TOOL_ROUTES.map((path) => [path, of(ROUTES[path].answer)])) as Record<(typeof TOOL_ROUTES)[number], string[]>;
}

const memberOf = (members: Form & { of: "object" }, at: string): string => {
  const [, base = "", key] = /^\$\.([^.[]+)(?:\.([^.[]+))?/u.exec(at) ?? [];
  return key !== undefined && Object.hasOwn(members.members, base) && formOf(members.members[base]!).of === "map" ? `${base}.${key}` : base;
};

const badParameter = (member: string, why: string): never =>
  refused("BAD_PARAMETER", member === "" ? `${why}.` : `\`${member}\` ${why}.`);

const valueOf = (form: Form, value: string): unknown =>
  form.of === "number" && /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : value;

export function paramsOf<T>(of: Shape<T>, query: URLSearchParams): T {
  const form = formOf(of);
  if (form.of !== "object") throw new Error("paramsOf reads a route's parameters, an object's shape");
  const value = dictionary<unknown>();
  for (const name of new Set(query.keys())) {
    const given = query.getAll(name);
    const dot = name.indexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const member = Object.hasOwn(form.members, base) ? formOf(form.members[base]!) : undefined;
    if (member === undefined || (member.of === "map") !== (dot > 0)) return badParameter(name, "is not an argument this takes");
    if (member.of === "list") value[name] = given.map(one => valueOf(member.each, one));
    else if (member.of === "one-or-list") value[name] = given.length === 1 ? valueOf(member.each, given[0]!) : given.map(one => valueOf(member.each, one));
    else if (given.length > 1) return badParameter(name, "is given more than once: it takes one value");
    else if (member.of === "map") ((value[base] ??= dictionary()) as Record<string, unknown>)[name.slice(dot + 1)] = valueOf(member.each, given[0]!);
    else value[name] = valueOf(member, given[0]!);
  }
  return argsOf(of, value);
}

export function argsOf<T>(of: Shape<T>, value: unknown): T {
  const form = formOf(of);
  try {
    return of.parse(value);
  } catch (error) {
    if (error instanceof ContractError) return badParameter(form.of === "object" ? memberOf(form, error.at) : "", error.why);
    throw error;
  }
}

export function answerOf<P extends RoutePath>(path: P, status: number, body: unknown): Of<(typeof ROUTES)[P]["answer"]> | SearchRefusal {
  if (status === 200) return ROUTES[path].answer.parse(body) as Of<(typeof ROUTES)[P]["answer"]>;
  const refused = searchRefusal.parse(body);
  if (SEARCH_REFUSALS[refused.code] !== status) throw new ContractError("$.code", `${refused.code} is ${SEARCH_REFUSALS[refused.code]}, answered ${status}`);
  return refused;
}
