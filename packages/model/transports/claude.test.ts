import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeTransport } from "./claude.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fakeClaude(models: readonly Record<string, unknown>[]): { binary: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "lifestream-claude-list-"));
  folders.push(root);
  const binary = join(root, "claude");
  const answer = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "list", response: { models } } });
  writeFileSync(binary, [
    "#!/bin/sh",
    "read line",
    `echo '{"type":"system","subtype":"synthetic"}'`,
    `echo '${answer}'`,
    "cat > /dev/null",
    "",
  ].join("\n"), { mode: 0o755 });
  return { binary, home: join(root, "home") };
}

describe("the Claude transport's list", () => {
  it("names each model once by the model an alias resolves to, never by the alias, and keeps the declared rows first", async () => {
    const claude = fakeClaude([
      { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "medium", "high", "max"] },
      { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "medium", "high", "max"] },
      { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low", "medium", "high"] },
      { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5-5" },
    ]);
    const listed = await claudeTransport({ claude }).list!();
    expect(listed.map(({ model, name, thinking }) => ({ model, name, thinking }))).toEqual([
      { model: "claude-opus-5-5", name: "Opus", thinking: ["low", "medium", "high", "max"] },
      { model: "claude-sonnet-5-5", name: "Sonnet", thinking: ["low", "medium", "high"] },
      { model: "claude-haiku-5-5", name: "Haiku", thinking: [] },
    ]);
    const models = await claudeTransport({ claude, listed }).models();
    expect(models.map(({ model, suggested }) => [model, suggested ?? []])).toEqual([
      ["claude-haiku-5-5", ["pictures", "text"]], ["claude-opus-5-5", ["chat"]], ["claude-sonnet-5-5", []],
    ]);
  });

  it("a program that ends before it lists fails the list, and with no program there is nothing to list", async () => {
    const claude = fakeClaude([]);
    writeFileSync(claude.binary, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    await expect(claudeTransport({ claude }).list!()).rejects.toThrow("ended before it answered (exit 3)");
    await expect(claudeTransport({ claude: undefined }).list!()).rejects.toThrow("not on this Mac");
  });
});
