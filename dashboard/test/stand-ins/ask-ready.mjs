// @ts-check
const ASK_FILES = Object.freeze({
  limits: { photos: 10, photo_bytes: 26_214_400, voice_ms: 600_000 },
  voice: { ready: true, words: 'Parakeet · this Mac', line: null, caution: null, value: 'default',
    choices: [{ value: 'runner:macbook-pro-0001/parakeet', words: 'Parakeet · this Mac', sent: false }] },
});

/** @typedef {{ id: string, name: string, thinking: string[], default: string, group: string, input?: string[], leaves?: string | null, state?: string }} AskRow */

/** @param {AskRow} row */
export const askModel = row => {
  const { input = ['text', 'image'], leaves = row.group, state = 'ready' } = row;
  return { id: row.id, name: row.name, thinking: row.thinking, default: row.default, state,
    photos_off: input.includes('image') ? null : `${row.name} can't see photos.`, hides: leaves !== null };
};

/**
 * @param {AskRow[]} models
 * @param {string | null} chosen
 */
const menuOf = (models, chosen) => {
  /** @param {AskRow} row */
  const rowOf = row => ({ value: row.id, name: row.name, account: null, chosen: row.id === chosen });
  const usable = models.filter(row => (row.state ?? 'ready') === 'ready');
  const local = usable.filter(row => row.leaves === null).map(rowOf);
  return { default: null, rows: usable.filter(row => row.leaves !== null).map(rowOf), local: local.length ? { label: 'Local', rows: local } : null,
    more: { words: 'More', use: 'chat', work: null }, off: null };
};

/**
 * @param {AskRow[]} models
 * @param {{ model?: string | null, thinking?: string, said?: string, act?: string }} [answer]
 */
export const askReady = (models, { model, thinking, said, act } = {}) => {
  const rows = models.map(askModel);
  const chosen = model === undefined ? rows[0]?.id ?? null : model;
  const shown = rows.find(row => row.id === chosen)?.id ?? null;
  return { ...ASK_FILES, models: rows, menu: menuOf(models, chosen), starters: [],
    default: { model: chosen, thinking: thinking ?? rows.find(row => row.id === chosen)?.default ?? '', shown, choose: shown === null && rows.length > 0 ? 'Choose a model' : null },
    ...(said === undefined ? {} : { said }), ...(act === undefined ? {} : { act }) };
};

/**
 * @param {AskRow[]} models
 * @param {string} line
 */
export const askSignedOut = (models, line) => askReady(models.map(row => ({ ...row, state: 'unavailable' })), { said: line, act: `Sign in with ${models[0]?.group}…` });
