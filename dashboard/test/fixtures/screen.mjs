// @ts-check
// The screen's meaning as search's state says it (`screen` of the door's `/v1/search/state`; Settings › Search by
// meaning draws it), synthetic, on and off. The machine is `macbook-pro-0001`; nothing in them is anyone's. Each is
// shaped as the door's own answer in `screen-door.json` (the screen-reads journey writes it,
// packages/home/screen-reads.e2e.test.ts), which test/settings-pages.mjs draws.

/**
 * The screen's meaning in search's state (`screen` of `/v1/search/state`): on through this Mac's runner, 62% of the
 * screen's texts embedded, waiting for this Mac to be idle; off.
 */
export const STATE_ON = {
  power: 'plugged-idle',
  words_indexed_through: '2026-11-13 13:55', bytes: 734_003_200, vectors_bytes: 46_137_344, queued: 38_000,
  waits: /** @type {string | null} */ ('in_use'), waits_line: /** @type {string | null} */ ('Waiting for macbook-pro-0001 to be idle'),
  embedded: 62_000, named: 100_000, skipped: 0,
};
export const STATE_OFF = { ...STATE_ON, vectors_bytes: 0, queued: 0,
  waits: null, waits_line: null, embedded: 0, named: 0, skipped: 0 };
