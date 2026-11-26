import { isProgramName } from "./subscriptions.js";

export const UNKNOWN_ROUTE = "<unknown>";

const LITERAL = new Set([
  "/v1/pair", "/v1/exchange", "/v1/act", "/v1/refresh", "/v1/account", "/v1/settings", "/v1/seal", "/v1/process", "/v1/me",
  "/v1/feedback", "/v1/feedback/draft", "/v1/feedback/screenshot", "/v1/feedback/send", "/v1/restore", "/v1/stated", "/v1/home/verify", "/v1/outbound", "/v1/hide-details", "/v1/restore-details",
  "/v1/privacy", "/v1/privacy/keep", "/v1/chat/completions", "/v1/subscriptions",
  "/v1/signin/key", "/v1/signin/device/start", "/v1/signin/device/poll", "/v1/signin/client/start", "/v1/signin/client/finish",
  "/v1/agents/request", "/v1/agents/grant", "/v1/agents/refresh", "/v1/agents/revoke", "/v1/agents/waiting", "/v1/agents/answer",
  "/v1/agents/guides", "/v1/agents/address", "/v1/agents/keys",
  "/v1/ask", "/v1/ask/stop", "/v1/ask/login", "/v1/ask/chats", "/v1/ask/files", "/v1/ask/words", "/v1/ask/taken", "/v1/ask/erased",
  "/v1/feed", "/v1/days", "/v1/sources", "/v1/records", "/v1/counts", "/v1/record", "/v1/extracts", "/v1/enrichments",
  "/v1/labels", "/v1/conversation", "/v1/owner/act", "/v1/people", "/v1/people/card", "/v1/people/photos", "/v1/places",
  "/v1/places/photos", "/v1/places/suggest", "/v1/devices", "/v1/where", "/v1/status", "/v1/connectors", "/v1/products",
  "/v1/search", "/v1/count", "/v1/read", "/v1/describe", "/v1/clock", "/v1/time", "/v1/models", "/v1/models/read", "/v1/processing/range", "/v1/storage", "/v1/start/cost", "/v1/photos/wanted", "/v1/blobs/held", "/v1/streams/leaving", "/v1/imports/held",
  "/v1/search/state", "/v1/search/kinds",
  "/v1/runners", "/v1/runners/exchange", "/v1/runners/calls",
  "/v1/stations", "/v1/stations/exchange", "/v1/errands", "/v1/sites",
]);

type Shows = (segment: string) => string;

const STAMP = /^\d{8}T\d{6}(?:\.\d{1,9})?Z(?:\.[0-9a-f]{12})?$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const BLOB = /^sha256:([0-9a-f]{64})$/u;
const PRODUCT = /^([a-z][a-z0-9-]*):./u;
const SEQ = /^[1-9]\d{0,14}$/u;
const SECOND = /^(?:0|[1-9]\d{0,2})$/u;

const id: Shows = () => "<id>";
const blob: Shows = (segment) => {
  const hash = BLOB.exec(segment);
  return hash === null ? "<blob>" : `sha256:${hash[1]!.slice(0, 8)}`;
};
const source: Shows = (segment) => {
  const product = PRODUCT.exec(segment);
  return product === null ? "<source>" : `${product[1]}:<account>`;
};
const delivery: Shows = (segment) => STAMP.test(segment) ? segment : "<stamp>";
const day: Shows = (segment) => DAY.test(segment) ? segment : "<day>";
const seq: Shows = (segment) => SEQ.test(segment) ? segment : "<seq>";
const second: Shows = (segment) => SECOND.test(segment) ? segment : "<k>";
const program: Shows = (segment) => isProgramName(segment) ? segment : "<name>";

type Shape = { readonly parts: readonly (string | Shows)[]; readonly tail?: true };

const SHAPES: readonly Shape[] = [
  { parts: ["acquisitions", source, delivery] },
  { parts: ["bundles", blob] },
  { parts: ["files", blob] },
  { parts: ["connectors", id] },
  { parts: ["days", day] },
  { parts: ["blobs", blob] },
  { parts: ["pictures", blob] },
  { parts: ["photos", blob] },
  { parts: ["ask", "chats", id] },
  { parts: ["ask", "chats", id, "events"] },
  { parts: ["privacy", "chat", id] },
  { parts: ["ask", "notes", id] },
  { parts: ["ask", "notes", id, "join"] },
  { parts: ["ask", "notes", id, second] },
  { parts: ["agents", "request", id] },
  { parts: ["agents", "signins", id] },
  { parts: ["agents", id, "disconnect"] },
  { parts: ["subscriptions", program] },
  { parts: ["outbound", seq] },
  { parts: ["errands", id] },
  { parts: ["errands", id, "calls"] },
  { parts: ["errands", id, "files"], tail: true },
  { parts: ["stations", id, "reload"] },
  { parts: ["stations", "files", id], tail: true },
];

export function routeOf(target: string): string {
  const path = target.split(/[?#]/u, 1)[0]!;
  if (LITERAL.has(path)) return path;
  const raw = path.split("/");
  if (raw[0] !== "" || raw[1] !== "v1") return UNKNOWN_ROUTE;
  let segments: string[];
  try {
    segments = raw.slice(2).map((segment) => decodeURIComponent(segment));
  } catch {
    return UNKNOWN_ROUTE;
  }
  if (segments.some((segment) => segment === "")) return UNKNOWN_ROUTE;
  for (const shape of SHAPES) {
    const fits = shape.tail === true ? segments.length > shape.parts.length : segments.length === shape.parts.length;
    if (!fits || shape.parts.some((part, at) => typeof part === "string" && part !== segments[at])) continue;
    const named = shape.parts.map((part, at) => typeof part === "string" ? part : part(segments[at]!));
    return `/v1/${[...named, ...(shape.tail === true ? ["<file>"] : [])].join("/")}`;
  }
  return UNKNOWN_ROUTE;
}
