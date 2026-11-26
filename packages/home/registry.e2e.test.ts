import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromeSites, declarations } from "@lifestreamprotocol/connect";
import type { Json } from "@lifestreamprotocol/core";
import * as exported from "@lifestreamprotocol/families";
import { CALL_PROMPTS, CALL_TRANSCRIPT, collectionsFault, type Family } from "@lifestreamprotocol/families";
import { TIMED_TRANSCRIPT } from "@lifestreamprotocol/model";
import { promptFaults } from "./prompts.js";
import { connectDigest, homeOf } from "./registry.js";
import homeRegistry, { emptyFacesWork } from "./registry-home.js";
const { LENT } = (await import(new URL("../connect/test/drive.ts", import.meta.url).href)) as typeof import("../connect/test/drive.js");
import { connectorOf, connectorSettings, effective, personal, reset, sealStrays } from "./settings.js";
import { writeFolder } from "./test/ops-support.js";
import { KeyError, openHomeFolder } from "@lifestreamprotocol/core";
import { keyedFolder, testMachine } from "@lifestreamprotocol/core/test/keyed";


const SITE_LANES = [...new Set(chromeSites(declarations()).flatMap((site) => site.lanes))];

function isFamily(value: unknown): value is Family {
  const family = value as Partial<Family> | null;
  return typeof family === "object" && family !== null && typeof family.name === "string" && typeof family.code === "string" &&
    Array.isArray(family.inputs) && typeof family.extract === "function" && typeof family.day === "function";
}

describe("the live registry", () => {
  it("a family the families package exports is missing from the live registry, or a settings file naming families.photos stops the home building the photos family", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-registry-"));
    try {
      writeFolder(dir, { "families.photos": { per: "week" } });
      const { settings, notices } = effective(dir);
      expect(notices).toEqual([]);
      const families = (await homeRegistry(settings, homeOf(openHomeFolder(dir)))).families;
      const registered = families.map((family) => family.name).sort();
      expect(collectionsFault(families)).toEqual([]);
      const expected = Object.entries(exported).flatMap(([name, value]) => {
        if (isFamily(value)) return value.inputs.some((input) => input.role === "evidence") ? [value.name] : [];
        if (typeof value === "function" && /^[a-z]+Family$/u.test(name)) return [name.slice(0, -"Family".length)];
        return [];
      }).sort();
      expect(registered).toEqual([...new Set(expected)].sort());
      expect(registered).toEqual(expect.arrayContaining(["health", "photos", "physical"]));
      reset(dir, "families.photos");
      expect(Object.keys(personal(dir))).not.toContain("families.photos");
      expect((await homeRegistry(effective(dir).settings, homeOf(openHomeFolder(dir)))).families.map((family) => family.name).sort()).toEqual(registered);
      writeFileSync(join(dir, "registry.json"), `${JSON.stringify({ registered, expected }, null, 2)}\n`);
    } finally {
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the call transcript's answer type drifts from the timed transcript a timed model answers, or a call prompt is faulty", () => {
    expect(CALL_PROMPTS[CALL_TRANSCRIPT]!.type).toEqual(TIMED_TRANSCRIPT);
    expect(promptFaults(CALL_PROMPTS, [])).toEqual(new Map());
  });

  it("a Coast poll keeps its gigabytes of files off the home's disk, under the OS temp dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-registry-"));
    const unit = `macbook-pro-${dir.slice(-6).toLowerCase()}`;
    const temp = join(tmpdir(), `lifestream-coast-${unit}`);
    try {
      writeFolder(dir, {
        unit,
        "connectors.coast": { database: join(dir, "absent", "rem.db"), videos: join(dir, "absent", "videos") },
      });
      mkdirSync(join(dir, "tools"));
      const coast = (await homeRegistry(effective(dir).settings, homeOf(openHomeFolder(dir)))).acquirers!.find((acquirer) => acquirer.name === "coast")!;
      await expect(coast.fetch(null, { get: () => undefined, rotate: () => undefined }, LENT)).rejects.toThrow();
      const work = { root: existsSync(join(dir, "tools", "coast-work")), temp: existsSync(temp) };
      expect(work).toEqual({ root: true, temp: false });
      writeFileSync(join(dir, "coast-work.json"), `${JSON.stringify(work, null, 2)}\n`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a keyed home's registry is built with no key and asks for no work folder; a connector's work folder is asked for when it first runs, in the machine's scratch, never in the home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-registry-keyed-"));
    const machine = testMachine();
    const unit = `macbook-pro-${dir.slice(-6).toLowerCase()}`;
    try {
      writeFolder(dir, { unit, "connectors.coast": { database: join(dir, "absent", "rem.db"), videos: join(dir, "absent", "videos") } });
      const keyed = keyedFolder(dir, machine);
      expect(sealStrays(keyed)).toEqual(["connectors.coast"]);
      let held = false;
      let asked = 0;
      const home = { root: dir, folder: () => {
        asked++;
        if (!held) throw new KeyError("LOCKED", "synthetic: this program holds no keys");
        return keyed;
      } };
      const registry = await homeRegistry(effective(keyed).settings, home);
      expect([asked, registry.labelers!.length > 0]).toEqual([0, true]);
      const coast = registry.acquirers!.find((acquirer) => acquirer.name === "coast")!;
      held = true;
      await expect(coast.fetch(null, { get: () => undefined, rotate: () => undefined }, LENT)).rejects.toThrow();
      await expect(coast.fetch(null, { get: () => undefined, rotate: () => undefined }, LENT)).rejects.toThrow();
      const works = () => readdirSync(join(machine, "scratch", "home")).filter((name) => name.startsWith("coast-work-"));
      expect({ asked, scratch: works().length, home: existsSync(join(dir, "tools", "coast-work")) }).toEqual({ asked: 1, scratch: 1, home: false });
    } finally {
      keyedFolder(dir, machine).emptyWork({ job: "coast-work" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Delete all face data finds every faces work folder in its program's scratch on a keyed home, and the one in the home's tools on a plain one, and leaves other work", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-registry-faces-work-"));
    const machine = testMachine();
    try {
      writeFolder(dir, { unit: `macbook-pro-${dir.slice(-6).toLowerCase()}` });
      const plainWork = join(dir, "tools", "faces-work", "draw-aa");
      mkdirSync(plainWork, { recursive: true });
      emptyFacesWork(homeOf(openHomeFolder(dir)));
      expect(existsSync(join(dir, "tools", "faces-work"))).toBe(false);
      const keyed = keyedFolder(dir, machine);
      const threads = [keyed.work("faces-work", join(dir, "tools", "faces-work")), keyed.work("faces-work", join(dir, "tools", "faces-work"))];
      for (const work of threads) mkdirSync(join(work.path, "draw-aa"));
      const other = keyed.work("coast-work", join(dir, "tools", "coast-work"));
      emptyFacesWork(homeOf(keyed));
      expect({ threads: threads.map((work) => existsSync(work.path)), other: existsSync(other.path), home: existsSync(join(dir, "tools", "faces-work")) }).toEqual({ threads: [false, false], other: true, home: false });
      other.empty();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a site's lane runs at its connector's refresh, or reaches a station other than through the stations the home lends it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-registry-"));
    try {
      const built = async (members: Record<string, Json>) => {
        writeFolder(dir, members);
        const { settings } = effective(dir);
        return { settings, acquirers: (await homeRegistry(settings, homeOf(openHomeFolder(dir)))).acquirers!.filter((acquirer) => SITE_LANES.includes(acquirer.name)) };
      };
      const bare = await built({});
      expect(bare.acquirers.map((acquirer) => [acquirer.name, acquirer.source]).sort()).toEqual(SITE_LANES.map((lane) => [lane, lane]).sort());
      const refresh = (lane: string) => {
        const connector = connectorOf(declarations(), lane);
        return connectorSettings(connector, bare.settings.connectors[connector.id]).refresh_ms;
      };
      expect(Object.fromEntries(SITE_LANES.map((lane) => [lane, refresh(lane)]))).toEqual({ "claude-browser": 1_800_000, "chatgpt-browser": 1_800_000, whoop: 3_600_000 });
      const failures = async (acquirers: typeof bare.acquirers) => Object.fromEntries(await Promise.all(acquirers.map(async (acquirer) =>
        [acquirer.name, ((await acquirer.fetch(null, { get: () => undefined, rotate: () => undefined }, LENT).catch((error: unknown) => error)) as Error).message] as const)));
      mkdirSync(join(dir, "tools"));
      const tried = await failures(bare.acquirers);
      for (const lane of ["claude-browser", "chatgpt-browser"]) expect(tried[lane]).toBe("this test lends no station: using");
      writeFileSync(join(dir, "site-lanes.json"), `${JSON.stringify(tried, null, 2)}\n`);
    } finally {
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the connect code moved by an edit of a test or its support, or not by a reader's", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-registry-"));
    try {
      const connect = join(dir, "connect");
      mkdirSync(join(connect, "notes", "test"), { recursive: true });
      const write = (files: Record<string, string>) => { for (const [path, text] of Object.entries(files)) writeFileSync(join(connect, path), text); };
      write({ "notes/reader.ts": "reader 1", "notes/e2e.test.ts": "test 1", "notes/notes.test-support.ts": "support 1", "notes/test/fixture.ts": "fixture 1" });
      const codes = [connectDigest(connect)];
      write({ "notes/e2e.test.ts": "test 2", "notes/notes.test-support.ts": "support 2", "notes/test/fixture.ts": "fixture 2" });
      codes.push(connectDigest(connect));
      write({ "notes/reader.ts": "reader 2" });
      codes.push(connectDigest(connect));
      expect([codes[1] === codes[0], codes[2] === codes[1]]).toEqual([true, false]);
      writeFileSync(join(dir, "connect-code.json"), `${JSON.stringify(codes, null, 2)}\n`);
    } finally {
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });
});
