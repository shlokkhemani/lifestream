export * from "./seams.js";
export * from "./labeler.js";
export * from "./declaration.js";
export * from "./products.js";
export * from "./shared/index.js";
export * as ask from "./ai/ask/index.js";
export * as cameras from "./labelers/cameras/index.js";
export * as devices from "./devices/index.js";
export * as faces from "./labelers/faces/index.js";
export * as googlePlaces from "./labelers/google-places/index.js";
export * as groups from "./labelers/groups/index.js";
export * as people from "./people/index.js";
export * as places from "./places/index.js";
export * as stations from "./stations/index.js";
export * as upload from "./upload/index.js";
export { tabClaim, type TabClaim } from "./stations/index.js";
export { addressFault, admit, wholeAddress, admittedNone, ADAPTER_FAMILIES, connectorFaults, type Admitted, type Entry, type Fault, type Where, type Whose } from "./admit.js";
export { FOLDERS } from "./folders.js";
export { FakeRelay } from "./test/station.js";
export { fakeImap, loginRefused, refusedWith, type FakeImap, type ImapCommand } from "./test/imap.js";
export * as imports from "./imports/index.js";
export { audioCallAudio } from "./macos-app/audio/adapter.js";

import { SourceNameError, sourceName } from "@lifestreamprotocol/core";
import { roadsOf, withRoadDefaults, type Client, type Connector } from "./declaration.js";
import { FOLDERS } from "./folders.js";
import type { Labeler } from "./labeler.js";
import type { Acquirer, Reader, SignedIn } from "./seams.js";
import { domainOf, type IosBundle } from "./shared/ios-bundle.js";
import type { Dependencies } from "./shared/dependencies.js";
import type { Recipe } from "./shared/recipe.js";
import type { OwnerReader } from "./shared/statements.js";

export interface Provider {
  readonly connectors: readonly Connector[];
  readonly readers: readonly Reader[];
  readonly acquirers?: Readonly<Record<string, (settings: never, dependencies?: Dependencies) => Acquirer>>;
  readonly labelers?: Readonly<Record<string, (settings: never) => Labeler>>;
  readonly signins?: Readonly<Record<string, SignedIn>>;
  readonly recipes?: Readonly<Record<string, Recipe>>;
  readonly clients?: readonly Client[];
}

let walked: readonly Provider[] | undefined;
let declared: readonly Connector[] | undefined;

function isProvider(value: unknown): value is Provider {
  return typeof value === "object" && value !== null && Array.isArray((value as Partial<Provider>).connectors);
}

export function providers(): readonly Provider[] {
  return (walked ??= FOLDERS.map((each) => each.module).filter(isProvider));
}

let recipesMade: Readonly<Record<string, Recipe>> | undefined;
export function recipes(): Readonly<Record<string, Recipe>> {
  return (recipesMade ??= Object.fromEntries(providers().flatMap((provider) => Object.entries(provider.recipes ?? {}))));
}

export function clients(): readonly Client[] {
  return providers().flatMap((provider) => provider.clients ?? []).sort((a, b) => a.id.localeCompare(b.id));
}

export function declarations(): readonly Connector[] {
  return (declared ??= providers().flatMap((provider) => provider.connectors).map(withRoadDefaults).sort((a, b) => a.id.localeCompare(b.id)));
}

export function ownerReaders(): readonly OwnerReader[] {
  const named = new Set(declarations().flatMap((connector) => connector.sources.filter((source) => roadsOf(source).includes("owner")).map((source) => source.read)));
  return providers().flatMap((provider) => provider.readers).filter((reader): reader is OwnerReader => named.has(reader.name));
}

let phoneDomains: ReadonlyMap<string, { product: string; apple: boolean; cloud: boolean }> | undefined;
function domainSources(): ReadonlyMap<string, { product: string; apple: boolean; cloud: boolean }> {
  return (phoneDomains ??= new Map(declarations().flatMap((connector) => connector.sources.filter((source) => roadsOf(source).includes("phone")).map((source) => {
    const [product, account, copy] = source.id.split(":") as [string, string, string];
    return [domainOf(connector), { product, apple: account === "<account>", cloud: copy === "cloud" }] as const;
  }))));
}

export function iosBundleSources(bundle: IosBundle, names: { unit: string; apple_id: string }): { domain: string; file: string; source: string | null }[] {
  return bundle.domains.map(({ domain, file }) => {
    const derived = domainSources().get(domain);
    return { domain, file, source: derived === undefined ? null : `${derived.product}:${derived.apple ? names.apple_id : "local"}:${derived.cloud ? "cloud" : names.unit}` };
  });
}

export function iosDomainOf(source: string): string | null {
  let product: string;
  try {
    product = sourceName(source).product;
  } catch (error) {
    if (error instanceof SourceNameError) return null;
    throw error;
  }
  return [...domainSources()].find(([, derived]) => derived.product === product)?.[0] ?? null;
}
