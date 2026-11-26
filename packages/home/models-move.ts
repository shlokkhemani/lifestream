import { isObject, metaAsItLies, SETTINGS_MOVE, type HomeFolder, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { routeId } from "@lifestreamprotocol/model";
import { MODELS_META, WORK_MEMBER } from "./models.js";
import { personal } from "./settings.js";

const VOICE = "openrouter-voice";
const VOICE_BLOCK = `model.transports.${VOICE}`;
const ADDRESS = "model.transports.address";
const DEFAULTS = "model.defaults.";
const CHAT_DEFAULT = `${DEFAULTS}chat`;
const SCRIBE = "elevenlabs/scribe-v2";
const SCRIBE_IDS: readonly string[] = [routeId({ transport: VOICE, model: SCRIBE }), routeId({ transport: "openrouter", model: SCRIBE })];
const PARAKEET = "parakeet-unified-en-0.6b";
const MEANING = "search.meaning";
const MEANING_FILE = "search.meaning.model";
const MEANING_FILE_DEFAULT = "embeddinggemma-2-q8-512";
const DETECTOR = "privacy.detector";
const DETECTOR_FILE = "privacy-filter";
const CHAT = "connectors.ask";
const CHAT_VOICE = `${WORK_MEMBER}voice`;
const GONE: readonly string[] = [MEANING, MEANING_FILE, DETECTOR];

interface StoredThen {
  routes?: readonly { id: string; offered: boolean; state: string }[];
  runners?: readonly { unit: string; present: boolean; files: readonly { id: string; state: string }[] }[];
}

export function settingsMove(folder: HomeFolder): JsonObject | null {
  const lies = metaAsItLies(folder, [MODELS_META, SETTINGS_MOVE.key]);
  if (lies !== null && lies.version >= SETTINGS_MOVE.version && !lies.values.has(SETTINGS_MOVE.key)) return null;
  return movedSettings(personal(folder), lies?.values.get(MODELS_META) ?? null);
}

export function movedSettings(held: JsonObject, stored: string | null): JsonObject {
  const moved: JsonObject = {};
  for (const [key, value] of Object.entries(held)) {
    if (GONE.includes(key) || key === VOICE_BLOCK || key.startsWith(`${VOICE_BLOCK}.`) || (key === CHAT_DEFAULT && value === null)) continue;
    moved[key] = key === ADDRESS ? addressMoved(value) : key.startsWith(DEFAULTS) ? voiceMoved(value) : key.startsWith("connectors.") ? blockMoved(value) : value;
  }
  runnerDefault(moved, "search", held[MEANING], held[MEANING_FILE] ?? MEANING_FILE_DEFAULT);
  runnerDefault(moved, "hiding", held[DETECTOR], DETECTOR_FILE);
  if (stored !== null) chatVoice(moved, JSON.parse(stored) as StoredThen);
  return moved;
}

function voiceMoved(value: Json): Json {
  return typeof value === "string" && value.startsWith(`${VOICE}:`) ? `openrouter:${value.slice(VOICE.length + 1)}` : value;
}

function blockMoved(block: Json): Json {
  if (!isObject(block)) return block;
  return Object.fromEntries(Object.entries(block as JsonObject).map(([member, value]) => [member, member.startsWith(WORK_MEMBER) ? voiceMoved(value) : value]));
}

function addressMoved(block: Json): Json {
  if (!isObject(block)) return block;
  const { kinds, ...rest } = block as JsonObject;
  if (kinds === undefined) return block;
  return { ...rest, input: rest.input ?? (Array.isArray(kinds) && kinds.includes("pictures") ? ["text", "image"] : ["text"]) };
}

function runnerDefault(moved: JsonObject, use: "search" | "hiding", chosen: Json | undefined, file: Json): void {
  const key = `${DEFAULTS}${use}`;
  if (chosen === undefined || Object.hasOwn(moved, key)) return;
  moved[key] = typeof chosen === "string" && chosen.startsWith("runner-") ? routeId({ transport: "runner", runner: chosen, model: String(file) }) : null;
}

function chatVoice(moved: JsonObject, stored: StoredThen): void {
  const block = isObject(moved[CHAT]) ? moved[CHAT] as JsonObject : {};
  const value = block[CHAT_VOICE];
  if (typeof value === "string" && value !== "default") return;
  const answer = preferred(stored);
  if (answer === null || answer === (moved[`${DEFAULTS}audio`] ?? null)) return;
  moved[CHAT] = { ...block, [CHAT_VOICE]: answer };
}

function preferred(stored: StoredThen): string | null {
  const installed = (stored.runners ?? []).filter((runner) => runner.files.some((file) => file.id === PARAKEET && file.state === "ready"))
    .sort((a, b) => Number(b.present) - Number(a.present) || (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
  if (installed.length > 0) return routeId({ transport: "runner", runner: installed[0]!.unit, model: PARAKEET });
  const cloud = (stored.routes ?? []).find((route) => SCRIBE_IDS.includes(route.id));
  return cloud !== undefined && cloud.offered && cloud.state !== "unavailable" ? SCRIBE_IDS[1]! : null;
}
