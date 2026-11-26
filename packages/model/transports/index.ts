import type { RunnerListing } from "../runner-wire.js";
import type { TransportSettings } from "../settings.js";
import type { ListedModel, Transport } from "../transport.js";
import { addressTransport } from "./address.js";
import { claudeTransport } from "./claude.js";
import { codexTransport } from "./codex.js";
import { fakeTransport } from "./fake.js";
import { OPENROUTER_SECRET, openRouterTransport } from "./openrouter.js";
import type { ProgramAt } from "./program.js";
import { CALL_PASS, runnerTransport } from "./runner.js";

export interface Found {
  programs?: Readonly<Record<string, ProgramAt>>;
  door?: string;
  runners?: readonly RunnerListing[];
  listed?: Readonly<Record<string, readonly ListedModel[]>>;
  held?(name: string): boolean;
  secret?(name: string): string | undefined;
}

export function transportsOf(transports: TransportSettings | undefined, found: Found = {}): Transport[] {
  const held = (secret: string) => found.held?.(secret) ?? false;
  const value = (secret: string) => found.secret?.(secret);
  const listed = (name: string) => found.listed?.[name] ?? [];
  const { address, fake } = transports ?? {};
  return [
    runnerTransport({ door: found.door, pass: () => value(CALL_PASS), ...(found.runners === undefined ? {} : { runners: found.runners }) }),
    claudeTransport({ claude: found.programs?.claude, listed: listed("claude") }),
    codexTransport({ codex: found.programs?.codex, listed: listed("codex") }),
    openRouterTransport({ held: () => held(OPENROUTER_SECRET), key: () => value(OPENROUTER_SECRET), listed: listed("openrouter") }),
    ...address === undefined ? [] : [addressTransport({
      ...address, listed: listed("address"), held: () => address.secret === undefined || held(address.secret), key: () => (address.secret === undefined ? undefined : value(address.secret)),
    })],
    ...fake === undefined ? [] : [fakeTransport(fake)],
  ];
}

export function priced(transports: TransportSettings | undefined): string[] {
  return transportsOf(transports).filter((transport) => transport.cost === "priced").map((transport) => transport.name);
}

export function transportSecret(name: string, transports: TransportSettings | undefined): string | null {
  if (name === "openrouter") return OPENROUTER_SECRET;
  if (name === "runner") return CALL_PASS;
  if (name === "address") return transports?.address?.secret ?? null;
  return null;
}
