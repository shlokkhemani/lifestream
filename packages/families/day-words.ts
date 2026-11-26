import type { DayAtom } from "./days.js";
import { QUIET_TITLE } from "./messages/family.js";

export interface Product {
  name: string;
  row: string;
  icon: string | null;
}

export type Products = Readonly<Record<string, Product>>;

export const NB = "\u00a0";
const WHOLE_HOURS = 100;
const OWNER = "the user";

export const capital = (words: string): string => words.replace(/^./u, (letter) => letter.toUpperCase());

export const count = (value: number): string => value.toLocaleString("en-US");

export const counted = (n: number, one: string, many = `${one}s`): string => `${count(n)}${NB}${n === 1 ? one : many}`;

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes >= WHOLE_HOURS * 60) return `${Math.round(minutes / 60).toLocaleString("en-US")}h`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export const appName = (name: string): string => /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9_-]+){2,}$/u.test(name)
  ? capital(name.split(".").at(-1) as string)
  : name;

export function appMinutes(text: string): { name: string; minutes: number | null }[] {
  return text.split(", ").map((part) => {
    const match = /^([\s\S]+?) (<1|\d+) min$/u.exec(part);
    if (!match) return { name: appName(part), minutes: null };
    return { name: appName(match[1] as string), minutes: match[2] === "<1" ? 0.5 : Number(match[2]) };
  });
}

export const productId = (source: string): string => source.split(":")[0] as string;

export function productOf(products: Products | undefined, id: string): Product {
  const product = productId(id);
  return products?.[product] ?? { name: product, row: product, icon: "info" };
}

export const who = (name: string): string => name === OWNER ? "You" : name;

export interface Mail {
  label: string;
  from: string;
  to: string;
  subject: string;
  words: string;
  attached: string[];
}

export function mailOf(text: string): Mail {
  const match = /^Mail (?:in (.+?) )?from (.+?)(?: to (.+?))?: (?:“([\s\S]*?)”|\(no subject\))(?: — ([\s\S]*?))?(?: \[attached: ([^\]]*)\])?$/u
    .exec(text);
  if (!match) return { label: "", from: "", to: "", subject: "", words: text, attached: [] };
  return {
    label: match[1] ?? "",
    from: who(match[2] as string),
    to: who(match[3] ?? ""),
    subject: match[4] ?? "",
    words: match[5] ?? "",
    attached: match[6] ? match[6].split(", ") : [],
  };
}

export interface Call {
  kind: string;
  who: string;
  group: string;
  way: string;
  length: string;
}

const CALL_WAYS: Record<string, string> = { "the user called": "You called", "they called": "They called" };

export function callOf(text: string): Call {
  const match = /^(Missed )?([\s\S]*?call)(?: (?:with|from|to) ([\s\S]*?))?(?: in ([\s\S]*?))?(?:, (no answer|not answered|the user called|they called)(?:, ([\s\S]*))?)?$/u
    .exec(text);
  if (!match) return { kind: "", who: "", group: "", way: "", length: "" };
  const way = match[1] ? "Missed" : match[5] ? CALL_WAYS[match[5]] ?? "No answer" : "";
  return { kind: capital(match[2] as string), who: match[3] ? match[3].split(", ").map(who).join(", ") : "", group: match[4] ?? "", way,
    length: match[6] ?? "" };
}

export interface CallHead {
  holder: string;
  length: string;
  title: string | null;
  bracket: string | null;
}

const CALL_HEAD = /^(Call(?: transcript|(?: on ([\s\S]+?))?, (\d+ s|\d+ min|\d+ h \d+ min)))(?: \(([^)]*)\))?(?=: |$)/u;

export function callHeadOf(atom: Pick<DayAtom, "family" | "text" | "block">): CallHead | null {
  if (atom.family !== "callaudio") return null;
  const match = CALL_HEAD.exec(atom.text);
  if (!match) return null;
  const base = match[1] as string;
  const block = atom.block?.title ?? "";
  return { holder: match[2] ?? "", length: match[3] ?? "", bracket: match[4] ?? null, title: block.startsWith(`${base}: `) ? block.slice(base.length + 2) : null };
}

export const dictatedApp =(text: string): string | undefined => /^Dictated into ([^:(]*?)(?: \([^)]*\))?(?::|$)/u.exec(text)?.[1];

export function checkInOf(text: string): { head: string; answers: string[]; note: string } {
  const colon = text.indexOf(": ");
  const head = colon < 0 ? text : text.slice(0, colon);
  const rest = colon < 0 ? "" : text.slice(colon + 2);
  const [answers, ...note] = rest.split("; note: ");
  return { head, answers: answers ? answers.split(/, |; /u) : [], note: note.join("; note: ") };
}

export function paymentOf(text: string): { amount: string; currency: string; account: string; merchant: string; balance: string } {
  const match = /^([−+][^ ]+) ([A-Z]{3}) ([^:]*): ([\s\S]*?)(?: \(balance ([^)]*)\))?(?: \[[^\]]*\])?$/u.exec(text);
  if (!match) return { amount: "", currency: "", account: "", merchant: text, balance: "" };
  return { amount: match[1] as string, currency: match[2] as string, account: match[3] as string, merchant: match[4] as string, balance: match[5] ?? "" };
}


export interface QuietLine {
  chat: string;
  heading: string;
  title: string;
  count: string;
}

export function quietLineOf(atom: DayAtom): QuietLine | null {
  if (atom.family !== "messages" || atom.block?.title !== QUIET_TITLE) return null;
  const line = atom.text.split("\n")[0] as string;
  const cut = line.lastIndexOf(" · ");
  return { chat: atom.block.key, heading: atom.block.title, title: cut < 0 ? line : line.slice(0, cut), count: cut < 0 ? "" : line.slice(cut + 3) };
}
