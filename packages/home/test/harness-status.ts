import { openHomeFolder, readTables, type HomeFolder } from "@lifestreamprotocol/core";
import { pauses } from "../jobs.js";
import { storedModels } from "../models.js";
import { modelsPage, type ModelsPage } from "../page-models.js";
import { HomeFile } from "../home-file.js";
import { machine } from "../machine.js";
import { effective } from "../settings.js";
import { readStatus, readStreams, withLedger, type StatusOptions, type StatusReport } from "../status.js";
import type { StreamsReport } from "../streams-report.js";
import fakeRegistry, { fakeDeclarations } from "./fakes.js";
import { homeOf } from "../registry.js";

export function statusOf(root: string, options: Omit<StatusOptions, "folder" | "ledger" | "connectors" | "families" | "now_ms" | "settings"> & Partial<Pick<StatusOptions, "connectors" | "families" | "now_ms" | "settings">> = {}, folder: HomeFolder = openHomeFolder(root)): StatusReport {
  return withLedger(folder, (ledger) => {
    const asked = {
      folder, ledger, now_ms: Date.now(), settings: options.settings ?? effective(folder).settings, connectors: fakeDeclarations(),
      families: options.families ?? fakeRegistry(effective(folder).settings, homeOf(folder)).families, ...options,
    };
    return new HomeFile(folder, 5_000).read((db) => readStatus(db, asked)) ?? readStatus(null, asked);
  });
}

export function streamsOf(root: string, options: { now_ms?: number; unit?: string } = {}): StreamsReport {
  const folder = openHomeFolder(root);
  const settings = effective(root).settings;
  const registry = fakeRegistry(settings, homeOf(folder));
  return withLedger(folder, (ledger) => new HomeFile(folder, 5_000).read((db) => readStreams(db, {
    folder, now_ms: options.now_ms ?? Date.now(), settings, registry, ledger, machine: machine().dir, sites: null, present: [], refused: [], stated: null,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
  }))!);
}

export function modelsPageOf(root: string, now_ms = Date.now()): ModelsPage {
  const folder = openHomeFolder(root);
  const { settings } = effective(folder);
  return new HomeFile(folder, 5_000).read((db) => modelsPage({ stored: storedModels(readTables(db).meta), settings, pauses: pauses(db), now_ms, day: settings.day }))
    ?? modelsPage({ stored: { routes: [], runners: [], connections: {} }, settings, pauses: [], now_ms, day: settings.day });
}

export const runnerOf = (page: ModelsPage, unit: string) => {
  const found = page.connections.find((each) => each.kind === "runner" && each.id === `runner:${unit}`);
  if (found?.kind !== "runner") throw new Error(`the models page holds no runner ${unit}`);
  return found;
};
