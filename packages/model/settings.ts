import type { Input } from "./transport.js";
import type { AddressSettings } from "./transports/address.js";
import type { FakeOptions } from "./transports/fake.js";

export interface ModelSettings {
  cap: number;
  transports?: TransportSettings;
}

export interface TransportSettings {
  codex?: Narrowed;
  claude?: Narrowed;
  openrouter?: Narrowed;
  address?: Narrowed & AddressSettings;
  fake?: Narrowed & Omit<FakeOptions, "reply"> & { reply?: string };
}

interface Narrowed {
  concurrency?: number;
}

const MEMBERS: Record<keyof TransportSettings, readonly string[]> = {
  codex: ["concurrency"],
  claude: ["concurrency"],
  openrouter: ["concurrency"],
  address: ["concurrency", "url", "secret", "input", "model"],
  fake: ["concurrency", "provider", "leaves", "reply", "delay_ms", "cost_usd", "cost", "fail", "status", "unavailable", "reason", "until_ms", "models", "log", "reach"],
};

export const OWN_BLOCKS: readonly string[] = Object.keys(MEMBERS).filter((name) => MEMBERS[name as keyof TransportSettings].some((member) => member !== "concurrency"));

export function readModelSettings(value: unknown): ModelSettings {
  const settings = object(value, "model");
  if (!positive(settings.cap)) throw new TypeError("model.cap is a positive number");
  if (settings.transports !== undefined) readTransportSettings(settings.transports);
  return settings as unknown as ModelSettings;
}

export function readTransportSettings(value: unknown): TransportSettings {
  for (const [name, block] of Object.entries(object(value, "model.transports"))) {
    const label = `model.transports.${name}`;
    const members = Object.hasOwn(MEMBERS, name) ? MEMBERS[name as keyof TransportSettings] : undefined;
    if (members === undefined) throw new TypeError(`${label}: no transport is named ${name}`);
    const each = object(block, label);
    const unknown = Object.keys(each).find((member) => !members.includes(member));
    if (unknown !== undefined) throw new TypeError(`${label}.${unknown}: ${name} takes no such member`);
    if (each.concurrency !== undefined && !(Number.isSafeInteger(each.concurrency) && positive(each.concurrency))) throw new TypeError(`${label}.concurrency is a positive whole number`);
    if (each.secret !== undefined && (typeof each.secret !== "string" || each.secret === "")) throw new TypeError(`${label}.secret names a secret`);
    if (name === "address") checkAddress(each, label);
  }
  return value as TransportSettings;
}

function checkAddress(address: Record<string, unknown>, label: string): void {
  let url: URL | undefined;
  try { url = new URL(String(address.url)); } catch { url = undefined; }
  if (typeof address.url !== "string" || url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) throw new TypeError(`${label}.url is an http or https address`);
  if (url.username !== "" || url.password !== "" || url.search !== "") throw new TypeError(`${label}.url holds no user name, password or query: a key goes in its secret`);
  if (address.model !== undefined && (typeof address.model !== "string" || address.model.trim() === "")) throw new TypeError(`${label}.model names a model the address serves`);
  const input = address.input;
  if (input === undefined) return;
  if (!Array.isArray(input) || !input.includes("text") || new Set(input).size !== input.length || input.some((each) => !(ADDRESS_INPUTS as readonly unknown[]).includes(each))) {
    throw new TypeError(`${label}.input is text, or text and image`);
  }
}

const ADDRESS_INPUTS: readonly Input[] = ["text", "image"];

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} is an object`);
  return value as Record<string, unknown>;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
