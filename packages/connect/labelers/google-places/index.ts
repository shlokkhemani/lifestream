import type { Connector, Reader } from "@lifestreamprotocol/connect/sdk";
import { googlePlacesConnector } from "./reader.js";
import { googlePlaces } from "./connector.js";
import { googlePlacesLabeler } from "./labeler.js";

export const contract = 3;
export const connectors: readonly Connector[] = [googlePlaces];
export const readers: Reader[] = [googlePlacesConnector];
export const labelers = { "google-places": googlePlacesLabeler };
export { ANSWER_KIND, ANSWER_TYPE, ANSWERS_FILE, answerKey, googlePlacesConnector, readAnswerKey, REQUESTS, type Request } from "./reader.js";
export { ANSWER_REACH_M, GOOGLE, googlePlacesLabeler, keyRefused, PER_DAY, PER_RUN, PLACES_EVENT, RECEIVER, type GooglePlacesSettings, type Lookup, type Owed } from "./labeler.js";
export { TYPED_MAX, TYPED_MIN, typedSearch, type TypedAnswer, type TypedPlace } from "./search.js";
