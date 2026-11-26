import { describe, expect, it } from "vitest";
import { dayBounds } from "@lifestreamprotocol/core";
import type { Health } from "./health.js";
import { PAGES } from "./pages.js";
import { SETTINGS_ANSWERS, SETTINGS_INDEX, settingsHandler, settingsPageHandler, type Running, type SettingsReads } from "./page-settings.js";
import { servePages } from "./page-serve.js";
import type { Ask, Reply } from "./reads.js";
import { Refusal } from "./refusal.js";
import { NB } from "./stream-words.js";
import type { Act, DeviceRow, HomeSettings, StreamsReport } from "./streams-report.js";
import { clientFixture } from "./test/harness-root.js";

const DAY = { zone: "Asia/Kolkata", day_start_hour: 4 };
const NOW_MS = Date.parse("2026-11-23T06:00:00Z");
const TODAY = "2026-11-23";
const ASKER = "iphone-0001";

const health = (state: Health<Act>["state"], words: string): Health<Act> => ({ state, reason: null, words, since_ms: null, next_ms: null, acts: [], detail: null });

const device = (unit: string, kind: "mac" | "phone", name: string, more: Partial<DeviceRow> = {}): DeviceRow =>
  ({ unit, kind, name, health: health("ok", "Sent just now"), contact_ms: null, grants: null, found: null, pass: null, replaced: [], retired: false, streams: [], ...more });

const HOME: HomeSettings = { zone: DAY.zone, day_start_hour: DAY.day_start_hour, helpers: "auto", helpers_resolved: 6, model_cap: 8, model_cap_default: 8, port: 4680, lan_port: 4682 };

const DEVICES: DeviceRow[] = [
  device("macbook-pro-0001", "mac", "Desk Mac", { health: health("ok", "Running") }),
  device(ASKER, "phone", "Phone A"),
  device("iphone-0002", "phone", "Phone B", { health: health("needs-you", "Needs you to open it") }),
  device("iphone-0003", "phone", "Phone C", { retired: true, health: health("off", "Removed") }),
];

const reportOf = (devices: readonly DeviceRow[] = DEVICES, settings: HomeSettings = HOME): StreamsReport => ({
  at_ms: NOW_MS, day: TODAY, products: "sha256:p", needs: [], disk: { free_bytes: 111_000_000_000, max_bundle_bytes: 64 * 1024 ** 3 }, paused: [],
  home: { name: "Lifestream", health: health("ok", "Running"), settings }, devices: [...devices],
  extension: { name: "Chrome extension", health: health("ok", "Running in Chrome"), placed: true, present: true, browsers: [] },
  connectors: [], setup: null, off: [], imports: [], adding: { prompt: "", blank: "" },
});

const YOU = { id: "person:0001", name: "Person A", named: true, face: false, photo: null, when: null, line: "You", find: ["person a"] };

const runningOf = (settings: HomeSettings = HOME): Running => ({ position: "4:1", settings, max_bundle_bytes: 64 * 1024 ** 3 });

const readsOf = (report: StreamsReport = reportOf(), running: Running = runningOf()): SettingsReads & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    report: () => {
      reads.push("report");
      return { position: "3:1", report, asks: 0 };
    },
    you: () => {
      reads.push("you");
      return YOU;
    },
    running: () => {
      reads.push("running");
      return running;
    },
  };
};

type Asker = { kind: "phone" | "mac"; unit: string } | null;
const PHONE: Asker = { kind: "phone", unit: ASKER };
const MAC: Asker = { kind: "mac", unit: "macbook-pro-0001" };

async function asked(reads: SettingsReads, route: string, by: Asker, query = ""): Promise<Record<string, any>> {
  const routes = servePages({ settings: settingsHandler(reads), settingsPage: settingsPageHandler(reads) }, () => DAY);
  const ask = { url: `${route}${query}`, now_ms: NOW_MS, held: { machine: "machine-0001" }, ...(by === null ? {} : { device: by }) } as unknown as Ask;
  const reply: Reply = await routes.get(route)!(ask);
  return JSON.parse(reply.body as string) as Record<string, any>;
}

const live = (by: Asker, reads: SettingsReads = readsOf()) => asked(reads, PAGES.settings.route, by);
const rows = (id: string, by: Asker, reads: SettingsReads = readsOf()) => asked(reads, PAGES.settingsPage.route, by, `?id=${id}`);
const rowOf = (answer: Record<string, any>, id: string) => (answer.parts as { rows: Record<string, any>[] }[]).flatMap((part) => part.rows).find((row) => row.id === id)!;

const entries = (kind: "phone" | "mac") => SETTINGS_INDEX[kind].map((group) => [group.label, group.entries.map((each) => [each.id, each.label, each.icon, each.answer, each.host])]);

describe("the skeleton", () => {
  it("gives the phone its four groups, entry by entry and in order, and no Mac-only page", () => {
    expect(entries("phone")).toEqual([
      ["Devices", [["lifestream", "Lifestream", "home", "own", false], ["this-phone", "This iPhone", "phone-screen", "own", false]]],
      ["Lifestream", [["storage", "Storage", "drive", "storage", false], ["time", "Day and time", "time", "settingsPage", false]]],
      ["App", [["appearance", "Appearance", "settings", "own", false], ["advanced", "Advanced", "filter", "settingsPage", false]]],
      ["About", [["version", "Version", "info", "own", false], ["privacy-policy", "Privacy policy", "private", "own", false]]],
    ]);
    const phone = new Set(SETTINGS_INDEX.phone.flatMap((group) => group.entries.map((each) => each.id)));
    for (const id of ["home", "recovery", "mac", "iphone", "chrome", "defaults", "providers", "privacy", "meaning", "updates"]) expect(phone.has(id), id).toBe(false);
  });

  it("gives the Mac the groups its Settings drew before, the same ids, labels and icons, Recovery key and Updates inside the Mac app alone", () => {
    const before = [
      { label: "Lifestream", pages: [
        { id: "home", label: "General", icon: "home" }, { id: "storage", label: "Storage", icon: "drive" },
        { id: "time", label: "Day and time", icon: "time" }, { id: "recovery", label: "Recovery key", icon: "private", mac: true },
      ] },
      { label: "Devices", pages: [{ id: "mac", label: "This Mac", icon: "work-mac" }, { id: "iphone", label: "iPhone", icon: "phone-screen" }, { id: "chrome", label: "Chrome extension", icon: "web" }] },
      { label: "Models", pages: [
        { id: "defaults", label: "Default models", icon: "ai" }, { id: "providers", label: "Providers", icon: "ai-apps" },
        { id: "privacy", label: "Privacy", icon: "hidden" }, { id: "meaning", label: "Search by meaning", icon: "search" },
      ] },
      { label: "App", pages: [{ id: "appearance", label: "Appearance", icon: "settings" }, { id: "updates", label: "Updates", icon: "update", mac: true }, { id: "advanced", label: "Advanced", icon: "filter" }] },
    ];
    expect(SETTINGS_INDEX.mac.map((group) => ({ label: group.label, pages: group.entries.map((each) => ({ id: each.id, label: each.label, icon: each.icon, ...(each.host ? { mac: true } : {}) })) })))
      .toEqual(before);
    const answers = Object.fromEntries(SETTINGS_INDEX.mac.flatMap((group) => group.entries.map((each) => [each.id, each.answer])));
    expect(Object.entries(answers).filter(([, answer]) => answer !== "own")).toEqual([["storage", "storage"], ["time", "settingsPage"], ["defaults", "modelDefaults"], ["providers", "modelProviders"], ["advanced", "settingsPage"]]);
  });

  it("answers Default models and Providers each with its own page answer, every entry's answer one of SETTINGS_ANSWERS, each a page answer's name but own", () => {
    expect(SETTINGS_ANSWERS).toEqual(["settingsPage", "storage", "modelDefaults", "modelProviders", "own"]);
    expect([PAGES.modelDefaults.route, PAGES.modelProviders.route]).toEqual(["/v1/page/models/defaults", "/v1/page/models/providers"]);
    for (const answer of SETTINGS_ANSWERS.filter((each) => each !== "own")) expect(Object.keys(PAGES), answer).toContain(answer);
    const used = new Set(Object.values(SETTINGS_INDEX).flatMap((groups) => groups.flatMap((group) => group.entries.map((each) => each.answer))));
    expect([...used].filter((answer) => !SETTINGS_ANSWERS.includes(answer))).toEqual([]);
  });
});

describe("the live answer", () => {
  it("words the phone's Storage from the disk reading alone, and reads nothing but the report and you", async () => {
    const reads = readsOf();
    const answer = await live(PHONE, reads);
    PAGES.settings.shape.parse(answer);
    expect(answer.values.find((each: { id: string }) => each.id === "storage")).toEqual({ id: "storage", label: null, value: [{ kind: "words", words: `111${NB}GB left` }], signal: null });
    expect(reads.reads.sort()).toEqual(["report", "you"]);
  });

  it("says when the phone's day starts as a clock When at today's start, never as words of a time", async () => {
    const answer = await live(PHONE);
    expect(answer.values.find((each: { id: string }) => each.id === "time").value).toEqual([
      { kind: "words", words: "Starts " }, { kind: "time", time: { kind: "clock", at_ms: dayBounds(TODAY, DAY).start_ms } },
    ]);
  });

  it("gives the phone every other device, the extension, and the removed after them, never the asker", async () => {
    const answer = await live(PHONE);
    expect(answer.devices.map((each: Record<string, unknown>) => [each.id, each.icon, each.signal, each.removed])).toEqual([
      ["macbook-pro-0001", "work-mac", "ok", false], ["iphone-0002", "phone-screen", "needs-you", false], ["extension", "web", "ok", false], ["iphone-0003", "phone-screen", "off", true],
    ]);
    expect(answer.removed).toBe("1 removed");
    expect(answer.you).toEqual(YOU);
  });

  it("names the Mac's This Mac and iPhone pages for two of a kind, and dots iPhone when a phone needs the person; asked by a Mac it lists no device", async () => {
    const one = await live(MAC, readsOf(reportOf(DEVICES.slice(0, 2).map((each) => ({ ...each, health: health("ok", "Running") })))));
    expect([one.values, one.devices]).toEqual([[], []]);
    const two = await live(MAC, readsOf(reportOf([...DEVICES, device("macbook-air-0002", "mac", "Second Mac")])));
    expect(two.values).toEqual([{ id: "mac", label: "Macs", value: null, signal: null }, { id: "iphone", label: "iPhones", value: null, signal: "needs-you" }]);
    expect(two.devices).toEqual([]);
  });
});

describe("a page of rows", () => {
  it("marks a picked 8 chosen and default, and a held 12 chosen beside the default 8, both offered", async () => {
    const cap = (answer: Record<string, any>) => rowOf(answer, "model-cap").end;
    const eight = cap(await rows("advanced", PHONE));
    expect(eight.kind).toBe("choice");
    expect(eight.key).toBe("model.cap");
    expect(eight.choices.map((each: Record<string, unknown>) => [each.value, each.chosen, each.default])).toEqual([
      [1, false, false], [2, false, false], [4, false, false], [8, true, true], [16, false, false], [32, false, false],
    ]);
    const held = cap(await rows("advanced", PHONE, readsOf(reportOf(), runningOf({ ...HOME, model_cap: 12 }))));
    expect(held.choices.filter((each: Record<string, unknown>) => each.chosen || each.default).map((each: Record<string, unknown>) => [each.value, each.chosen, each.default]))
      .toEqual([[8, false, true], [12, true, false]]);
  });

  it("gives a choice only to a device that may set the key, and its words to a reader that is no device", async () => {
    expect(rowOf(await rows("advanced", MAC), "model-cap").end.kind).toBe("choice");
    expect(rowOf(await rows("advanced", null), "model-cap").end).toEqual({ kind: "value", value: [{ kind: "words", words: "8" }], signal: null });
  });

  it("says the day's start on Day and time as a clock When, and the zone with its offset from the home", async () => {
    const answer = await rows("time", PHONE);
    PAGES.settingsPage.shape.parse(answer);
    expect([answer.title, rowOf(answer, "zone").end.value, rowOf(answer, "day-start").end.value]).toEqual([
      "Day and time", [{ kind: "words", words: "Asia/Kolkata · GMT+5:30" }], [{ kind: "time", time: { kind: "clock", at_ms: dayBounds(TODAY, DAY).start_ms } }],
    ]);
  });

  it("refuses an id whose entry for the asker's kind is no page of rows", async () => {
    for (const [id, by] of [["recovery", PHONE], ["storage", PHONE], ["appearance", MAC], ["nothing", MAC]] as const) {
      await expect(rows(id, by), id).rejects.toSatisfy((error) => error instanceof Refusal && error.status === 404 && error.code === "NOT_FOUND");
    }
  });
});

describe("the fixtures", () => {
  it("pins each answer the apps decode", async () => {
    const pinned = {
      "settings.phone": await live(PHONE),
      "settings.mac": await live(MAC, readsOf(reportOf([...DEVICES, device("macbook-air-0002", "mac", "Second Mac")]))),
      "settingsPage.advanced": await rows("advanced", PHONE),
      "settingsPage.time": await rows("time", PHONE),
    };
    for (const [name, answer] of Object.entries(pinned)) {
      const fixture = clientFixture(`pages/${name}`, answer);
      expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
    }
  });
});
