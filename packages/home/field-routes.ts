import type { IncomingMessage } from "node:http";
import type { Connector } from "@lifestreamprotocol/connect";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Act } from "./door.js";
import type { Principal } from "./principals.js";
import { refuse } from "./refusal.js";
import { deviceSets, unitOfSetting, type Member } from "./settings.js";
import type { SealAnswer, SettingAnswer } from "./wire.js";

const ROUTES = new Set(["/v1/settings", "/v1/seal"]);

export const isFieldRoute = (pathname: string): boolean => ROUTES.has(pathname);

export interface FieldDoor {
  connectors: readonly Connector[];
  homeUnit(): string;
  body(request: IncomingMessage): Promise<JsonObject>;
  relay(request: JsonObject, act: Act, http: IncomingMessage): Promise<unknown>;
}

export function fieldRoutes(door: FieldDoor): (principal: Principal, pathname: string, request: IncomingMessage) => Promise<[number, JsonObject]> {
  const declared = (id: unknown): Connector =>
    door.connectors.find((each) => each.id === id) ?? refuse(403, "PRINCIPAL_SCOPE", `the home declares no connector ${String(id)}`);

  const homeSetting = async (principal: Principal, body: JsonObject, request: IncomingMessage): Promise<[number, JsonObject]> => {
    const keys = Object.keys(body);
    if (keys.length !== 1) refuse(422, "BAD_REQUEST", "a body naming no connector names one setting and its value");
    const key = keys[0]!;
    if (!deviceSets(key)) refuse(403, "PRINCIPAL_SCOPE", `${key} is set on the Mac Lifestream runs on, never by a device's pass`);
    const unit = unitOfSetting(key);
    if (unit !== null && unit !== principal.unit) refuse(403, "PRINCIPAL_SCOPE", `${key} is device ${unit}'s own: a pass sets its own device's alone`);
    await door.relay({ verb: "settings", args: ["set", key, JSON.stringify(body[key])], by: "you" }, "POST /v1/settings", request);
    return [200, {}];
  };

  const setting = async (principal: Principal, request: IncomingMessage): Promise<[number, JsonObject]> => {
    const body = await door.body(request);
    if (!Object.hasOwn(body, "connector")) return homeSetting(principal, body, request);
    const { connector: id, member, value, was } = body;
    if (typeof id !== "string" || typeof member !== "string" || value === undefined) refuse(422, "BAD_REQUEST", "settings names a connector, a member and its value, and the value it was");
    const kind = declared(id).fields?.[member]?.kind;
    if (kind === "secret") refuse(403, "PRINCIPAL_SCOPE", `${id}'s ${member} is a secret: it is sealed (POST /v1/seal), never set`);
    if (kind === "path" && !(principal.kind === "mac" && principal.unit === door.homeUnit())) {
      refuse(403, "PRINCIPAL_SCOPE", `${id}'s ${member} names a file on the Mac Lifestream runs on: it is chosen there`);
    }
    const words = [...(was === undefined ? [] : [`--was=${JSON.stringify(was)}`]), "--", "set", id, member, JSON.stringify(value)];
    const { changed } = await door.relay({ verb: "connectors", args: words, by: "you" }, "POST /v1/settings", request) as { changed: readonly Member[] };
    const answer: SettingAnswer = { landed: { connector: id, member, value: changed.find((each) => each.member === member)?.value ?? null } };
    return [200, answer as unknown as JsonObject];
  };

  const seal = async (request: IncomingMessage): Promise<[number, JsonObject]> => {
    const { connector: id, member, value } = await door.body(request);
    if (typeof id !== "string" || typeof member !== "string" || typeof value !== "string") refuse(422, "BAD_REQUEST", "seal names a connector, a member and the secret's value");
    declared(id);
    const answer = await door.relay({ verb: "seal-field", connector: id, member, value }, "POST /v1/seal", request) as SealAnswer;
    return [200, answer as unknown as JsonObject];
  };

  return async (principal, pathname, request) => {
    if (principal.kind !== "mac" && principal.kind !== "phone") {
      refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no device's: a setting is changed, and a secret typed, on a Mac or a phone`);
    }
    return pathname === "/v1/seal" ? seal(request) : setting(principal, request);
  };
}
