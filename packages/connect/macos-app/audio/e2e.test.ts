import { artifact, collect, counts, deliver, expectParity, openTestHome, readGolden, temp } from "../../test/drive.js";
import { describe, expect, it } from "vitest";
import { audioRecordings, MIC_RECORDING, SOUND_RECORDING } from "./reader.js";
import { AUDIO_FACTS, AUDIO_SOURCE, audioFiles, recordingFiles } from "./test/fixture.js";

const GOLDEN = new URL("./test/parity.golden.json", import.meta.url);

describe("audio recordings: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or a record loses its audio", async () => {
    const home = openTestHome();
    try {
      const delivery = deliver(home, AUDIO_SOURCE, audioFiles(), AUDIO_FACTS);
      const rows = await collect(audioRecordings.read(delivery, home.blobs));
      const landed = await home.land(audioRecordings, delivery, rows);
      expect(landed).toMatchObject({ new: 4, refused: 0, duplicated: 0 });
      const heads = home.heads(AUDIO_SOURCE);
      expect(heads.map((head) => `${head.kind} ${head.key}`)).toEqual([
        `${MIC_RECORDING} 20260930T100000.12Z`,
        `${MIC_RECORDING} 20260930T100000.12Z:1`,
        `${MIC_RECORDING} 20260930T100500.12Z`,
        `${SOUND_RECORDING} 20260930T100001Z`,
      ]);
      for (const row of rows) {
        const audio = (row.content as { audio: { file: string } }).audio;
        expect(row.blobs).toEqual([delivery.files.find((file) => file.path === audio.file)!.blob]);
        expect(home.blobs.has(row.blobs![0]!)).toBe(true);
      }
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    try {
      const rows = await collect(audioRecordings.read(deliver(home, AUDIO_SOURCE, audioFiles(), AUDIO_FACTS), home.blobs));
      artifact(home.dir, "parity.json", expectParity(rows, GOLDEN));
    } finally {
      home.close();
    }
  });

  it("a later delivery without an earlier recording lands a gone", async () => {
    const home = openTestHome();
    try {
      await home.land(audioRecordings, deliver(home, AUDIO_SOURCE, audioFiles(), AUDIO_FACTS));
      const later = recordingFiles({ at: "2026-09-30T11:00:00.000Z", until: "2026-09-30T11:01:00.000Z" });
      const landed = await home.land(audioRecordings, deliver(home, AUDIO_SOURCE, later, { snapshot_taken_at: "2026-09-30T11:05:00.000Z" }));
      expect(landed).toMatchObject({ new: 1, gone: 0 });
      expect(home.heads(AUDIO_SOURCE).filter((head) => head.version === "gone")).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    try {
      const files = {
        ...recordingFiles({ at: "2026-09-30T12:00:00.000Z", until: "2026-09-30T12:01:00.000Z" }),
        ...recordingFiles({ at: "2026-09-30T12:00:00.000Z", until: "2026-09-30T12:02:00.000Z", stem: "20260930T115959.999Z.mic" }),
      };
      const delivery = deliver(home, AUDIO_SOURCE, files, AUDIO_FACTS);
      expect(await collect(audioRecordings.read(delivery, home.blobs))).toHaveLength(2);
      const landed = await home.land(audioRecordings, delivery);
      expect(landed).toMatchObject({ new: 1, duplicated: 1 });
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a recording whose audio is not the bytes its sidecar states, or whose sidecar is not UTF-8, is read, or takes the other recordings with it", async () => {
    const home = openTestHome();
    try {
      const other = recordingFiles({ at: "2026-09-30T12:00:00.000Z", until: "2026-09-30T12:01:00.000Z" });
      other["20260930T120000.000Z.mic.m4a"] = Buffer.from("other bytes");
      const missing = recordingFiles({ at: "2026-09-30T12:10:00.000Z", until: "2026-09-30T12:11:00.000Z" });
      delete missing["20260930T121000.000Z.mic.m4a"];
      const binary = recordingFiles({ at: "2026-09-30T12:20:00.000Z", until: "2026-09-30T12:21:00.000Z" });
      binary["20260930T122000.000Z.mic.json"] = Buffer.from([0xff, 0xfe, 0x7b]);
      const files = { ...other, ...missing, ...binary, ...recordingFiles({ at: "2026-09-30T12:30:00.000Z", until: "2026-09-30T12:31:00.000Z" }) };
      const landed = await home.land(audioRecordings, deliver(home, AUDIO_SOURCE, files, AUDIO_FACTS));
      expect(landed).toMatchObject({ new: 1, refused: 3 });
      expect(landed.refusals.map((refusal) => `${refusal.key} ${refusal.violations.join()}`)).toEqual([
        expect.stringMatching(/^20260930T120000\.000Z\.mic\.json .*hash or size differs/u),
        expect.stringMatching(/^20260930T121000\.000Z\.mic\.json .*does not carry/u),
        expect.stringMatching(/^20260930T122000\.000Z\.mic\.json .*not UTF-8/u),
      ]);
      expect(home.heads(AUDIO_SOURCE).map((head) => head.key)).toEqual(["20260930T123000Z"]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a recording the person stopped is refused, or an ending outside the list lands", async () => {
    const home = openTestHome();
    try {
      const stopped = recordingFiles({ at: "2026-09-30T12:00:00.000Z", until: "2026-09-30T12:01:00.000Z", override: { ended_by: "stopped" } });
      const read = await home.land(audioRecordings, deliver(home, AUDIO_SOURCE, stopped, AUDIO_FACTS));
      expect(read).toMatchObject({ new: 1, refused: 0 });
      const unknown = recordingFiles({ at: "2026-09-30T12:05:00.000Z", until: "2026-09-30T12:06:00.000Z", override: { ended_by: "paused" } });
      const refused = await home.land(audioRecordings, deliver(home, AUDIO_SOURCE, unknown, { snapshot_taken_at: "2026-09-30T12:10:00.000Z" }));
      expect(refused).toMatchObject({ new: 0, refused: 1 });
      expect(refused.refusals[0]!.violations).toEqual([expect.stringContaining('ended_by "paused" is outside the closed list')]);
      artifact(home.dir, "landed.json", { read, refused });
    } finally {
      home.close();
    }
  });

  it("a sidecar outside the contract lands", async () => {
    const home = openTestHome();
    try {
      const files = recordingFiles({ at: "2026-09-30T12:00:00.000Z", until: "2026-09-30T12:01:00.000Z", override: { ended_by: "aliens", loudness: { every_ms: 0 } } });
      const landed = await home.land(audioRecordings, deliver(home, AUDIO_SOURCE, files, AUDIO_FACTS));
      expect(landed).toMatchObject({ new: 0, refused: 1 });
      expect(landed.refusals[0]!.violations).toHaveLength(2);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });
});
