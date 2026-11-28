import type { IncomingMessage } from "node:http";
import type { Connector } from "@lifestreamprotocol/connect";
import type { JsonObject } from "@lifestreamprotocol/core";
import { catalogOf } from "./catalog.js";
import type { Custody } from "./custody.js";
import { assertAllowed, type Principal } from "./principals.js";
import { macRefreshes } from "./refresh-now.js";
import { refuse } from "./refusal.js";
import type { HomeRefresh } from "./verbs/act.js";
import type { RefreshAnswer } from "./wire.js";

export interface RefreshDoor {
  readonly connectors: readonly Connector[];
  readonly custody: Pick<Custody, "askRefresh" | "delivers">;
  relay(request: JsonObject): Promise<unknown>;
  body(request: IncomingMessage): Promise<JsonObject>;
  notifyMacRefresh?(connector: string, excludeUnit: string | null): void;
}

export function refreshRoute(door: RefreshDoor): (principal: Principal, request: IncomingMessage, reach: string | null) => Promise<[number, JsonObject]> {
  return async (principal, request, reach) => {
    if (principal.kind !== "mac" && !(principal.scopes.includes("drive") && reach === "loopback")) assertAllowed(principal, "read");
    const { connector } = await door.body(request);
    const declared = door.connectors.find((each) => each.id === connector) ?? refuse(422, "BAD_REQUEST", "refresh names a connector the home declares");
    const home = await door.relay({ verb: "connectors", args: ["--", "refresh", declared.id], by: "you" }) as HomeRefresh;
    if (home.state === "blocked" && (home.blocked.reason === "paused" || home.blocked.reason === "disk")) return [200, home as unknown as JsonObject];
    const asking = principal.kind === "mac" ? principal.unit : null;
    const macs = macRefreshes(declared);
    const asked = macs ? door.custody.askRefresh(declared.id, asking) : [];
    if (macs) door.notifyMacRefresh?.(declared.id, asking);
    const catalog = catalogOf(door.connectors);
    const own = macs && asking !== null && door.custody.delivers(principal).some((source) => catalog.delivered("mac", source)?.id === declared.id);
    const answer: RefreshAnswer | null = home.state === "queued" ? { state: "queued" } : asked.length > 0 || own ? { state: "asked" } : home.state === "blocked" ? home : null;
    return answer === null ? refuse(409, "NOT_OFFERED", `nothing of ${declared.id} refreshes from here`) : [200, answer as unknown as JsonObject];
  };
}
