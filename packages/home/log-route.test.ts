import { describe, expect, it } from "vitest";
import { ACTS } from "./door.js";
import { routeOf, UNKNOWN_ROUTE } from "./log-route.js";

const HASH = "ab".repeat(32);

describe("a request's route as the door logs it", () => {
  it("keeps a parameter position's segment only as that position may show it", () => {
    expect({
      acquisition: routeOf(`/v1/acquisitions/${encodeURIComponent("whatsapp:+15550000001")}/20261003T090000Z.0123456789ab`),
      account_no_product: routeOf("/v1/acquisitions/person-a/20261003T090000Z"),
      stamp_not_one: routeOf("/v1/acquisitions/whatsapp:x/person-a"),
      bundle: routeOf(`/v1/bundles/sha256:${HASH}`),
      blob_not_one: routeOf("/v1/blobs/person-a"),
      day: routeOf("/v1/days/2026-10-03"),
      day_not_one: routeOf("/v1/days/15550000001"),
      stream: routeOf("/v1/connectors/whatsapp"),
      chat: routeOf("/v1/ask/chats/person-a/events"),
      chat_level: routeOf("/v1/privacy/chat/person-a"),
      outbound: routeOf("/v1/outbound/42"),
      outbound_not_one: routeOf("/v1/outbound/person-a"),
      program: routeOf("/v1/subscriptions/claude"),
      program_not_one: routeOf("/v1/subscriptions/person-a"),
      agent_state: routeOf("/v1/agents/request/15550000001"),
      sign_in: routeOf("/v1/agents/signins/AAAAAAAAAAAAAAAAAAAAAA"),
      station: routeOf("/v1/stations/person-a/reload"),
    }).toEqual({
      acquisition: "/v1/acquisitions/whatsapp:<account>/20261003T090000Z.0123456789ab",
      account_no_product: "/v1/acquisitions/<source>/20261003T090000Z",
      stamp_not_one: "/v1/acquisitions/whatsapp:<account>/<stamp>",
      bundle: "/v1/bundles/sha256:abababab",
      blob_not_one: "/v1/blobs/<blob>",
      day: "/v1/days/2026-10-03",
      day_not_one: "/v1/days/<day>",
      stream: "/v1/connectors/<id>",
      chat: "/v1/ask/chats/<id>/events",
      chat_level: "/v1/privacy/chat/<id>",
      outbound: "/v1/outbound/42",
      outbound_not_one: "/v1/outbound/<seq>",
      program: "/v1/subscriptions/claude",
      program_not_one: "/v1/subscriptions/<name>",
      agent_state: "/v1/agents/request/<id>",
      sign_in: "/v1/agents/signins/<id>",
      station: "/v1/stations/<id>/reload",
    });
  });

  it("names an uploaded file's whole tail, nested or bare, as one placeholder, and an errand by none of its id", () => {
    expect(routeOf("/v1/stations/files/e-5550aa09/person-a")).toBe("/v1/stations/files/<id>/<file>");
    expect(routeOf("/v1/stations/files/e-5550aa09/person-a/15550000001/statement.pdf")).toBe("/v1/stations/files/<id>/<file>");
    expect(routeOf("/v1/errands/e-5550aa09/files/person-a")).toBe("/v1/errands/<id>/files/<file>");
    expect(routeOf("/v1/errands/e-5550aa09/calls")).toBe("/v1/errands/<id>/calls");
    expect(routeOf("/v1/errands/e-5550aa09")).toBe("/v1/errands/<id>");
  });

  it("names Chat's file and note routes by none of a note's id", () => {
    expect([routeOf("/v1/ask/files"), routeOf("/v1/ask/notes/person-a"), routeOf("/v1/ask/notes/person-a/join"), routeOf("/v1/ask/notes/person-a/12"),
      routeOf("/v1/ask/notes/person-a/15550000001"), routeOf("/v1/ask/erased?chat=person-a")])
      .toEqual(["/v1/ask/files", "/v1/ask/notes/<id>", "/v1/ask/notes/<id>/join", "/v1/ask/notes/<id>/12", "/v1/ask/notes/<id>/<k>", "/v1/ask/erased"]);
  });

  it("names each fixed route the Mac asks, the held imports among them", () => {
    expect([routeOf("/v1/blobs/held"), routeOf("/v1/imports/held")]).toEqual(["/v1/blobs/held", "/v1/imports/held"]);
  });

  it("names a phone's file by its hash's first 8 hex, as a bundle", () => {
    expect([routeOf(`/v1/files/sha256:${"ab".repeat(32)}`), routeOf("/v1/files/IMG_0001.HEIC")]).toEqual(["/v1/files/sha256:abababab", "/v1/files/<blob>"]);
  });

  it("names the count route, so the door's log can tell a count's time from an unknown path's", () => {
    expect(routeOf("/v1/count?of=messages&by=year")).toBe("/v1/count");
  });

  it("logs no query, and a route no shape matches as the one placeholder, however it is spelled", () => {
    expect(routeOf("/v1/search?lists=record&query=person-a&from=2026-10-03")).toBe("/v1/search");
    expect(routeOf("/v1/days/2026-10-03?file=txt#person-a")).toBe("/v1/days/2026-10-03");
    for (const path of ["/v1/people/person-a/photos", "/v1/people/15550000001/photos", "/v1/person-a", "/person-a", "/v1/days/2026-10-03/person-a",
      "/v1/%E0%A4%A", "/v1//people", "/v2/status", "", "/"]) {
      expect([path, routeOf(path)]).toEqual([path, UNKNOWN_ROUTE]);
    }
  });

  it("names every route the door relays, as the door's own table states it", () => {
    const sample: Record<string, string> = { "<way>": "key", "<id>": "a", "<name>": "claude" };
    const unknown = Object.keys(ACTS)
      .map((act) => act.replace(/ drained$/u, "").split(" ")[1]!.replace(/<[a-z]+>/gu, (slot) => sample[slot]!))
      .filter((path) => routeOf(path) === UNKNOWN_ROUTE);
    expect(unknown).toEqual([]);
  });
});
