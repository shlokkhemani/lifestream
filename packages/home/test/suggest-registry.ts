import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Guard, Json, Type } from "@lifestreamprotocol/core";
import { googlePlaces, people, places, type Reader } from "@lifestreamprotocol/connect";
import { bigHints, labelsFamily, linesOnly, physicalFamily, type Family } from "@lifestreamprotocol/families";
import { machine } from "../machine.js";
import { placesFileOf, readOwed } from "../places.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import { fakeRows } from "./fakes.js";
import { connectors, lookupsOf, lookupWriter, placesKey } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

const object: Guard = (content) => typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["content is an object"];
const SAID_KINDS = ["msg", "event", "note", "frame", "search", "directions", "activity", "agent-turn"];
const saidRows: Reader = { ...fakeRows, name: "said-rows", kinds: Object.fromEntries(SAID_KINDS.map((kind) => [kind, object])) };

function saying(name: string, type: Type, product: string[], kinds: string[]): Family {
  return {
    name, type, code: "1", inputs: [{ sources: { product }, kinds, role: "evidence" }],
    touched: () => [], extract: () => null, days: () => [], day: linesOnly(() => []),
    text: {
      version: "1", kinds,
      of(_record, version) {
        const { title, text } = version.content as { title?: Json; text?: Json };
        const said = typeof text === "string" ? text : "";
        return typeof title === "string" ? { title, text: said } : said === "" ? null : { text: said };
      },
    },
  };
}

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const endpoint = readFileSync(join(folder, "fake-google.txt"), "utf8").trim();
  return {
    connectors: connectors(), readers: [fakeRows, saidRows, people.peopleHome, ...places.readers, ...googlePlaces.readers],
    families: [
      physical, labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels),
      saying("messages", "messages", ["whatsapp", "imessage"], ["msg"]), saying("calendar", "plans", ["apple-calendar"], ["event"]), saying("notes", "notes", ["apple-notes"], ["note"]),
      saying("screen", "device-activity", ["screen"], ["frame"]), saying("ai", "ai", ["ask", "chatgpt", "claude-code"], ["msg", "agent-turn"]),
    ],
    labelers: settings.unit === null ? [] : [
      googlePlaces.googlePlacesLabeler({ unit: settings.unit, key: placesKey(settings), owed: () => readOwed(home.folder(), placesFileOf(folder, machine().dir)), hints: bigHints, lookup: lookupWriter(home, "google-places"), looked: lookupsOf(home, "google-places"), endpoint }),
    ],
    placesSearch: { secret: placesKey(settings), endpoint },
  };
}
