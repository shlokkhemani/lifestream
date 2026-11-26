// @ts-check
import { randomBytes } from 'node:crypto';
import { ToolError } from '../errors.mjs';
import { NoClaude } from './claude.mjs';
import { NoCodex } from './codex.mjs';
import { downloading, PRODUCT, PROGRAM_OF, programOf } from './programs.mjs';

/**
 * @typedef {import('./programs.mjs').Subscription} Of
 * @typedef {ReturnType<typeof import('./codex.mjs').openCodex>} Codex
 * @typedef {ReturnType<typeof import('./claude.mjs').openClaude>} Claude
 * @typedef {import('../door.mjs').Door} Door
 * @typedef {'absent' | 'fetching' | 'signed_out' | 'signing_in' | 'signed_in' | 'failed'} Stage
 * @typedef {{ state: Stage, bytes: number | null, total: number | null, attempt: string | null, url: string | null, code: string | null, account: string | null, plan: string | null, why: string | null }} Subscription
 * @typedef {{ chatgpt: Subscription, claude: Subscription }} LoginState
 * @typedef {{ email: string | null, plan: string | null, usable: boolean }} Account
 * @typedef {{ program: 'absent' } | { program: 'downloading' } | { program: 'ready', account: Account | null }} Held
 * @typedef {{ name: string, state: string, bytes: number | null, total: number | null, why: string | null }} Fetched
 * @typedef {object} Operation
 * @property {Of} of
 * @property {Door} door
 * @property {'starting' | 'fetching' | 'signing_in' | 'signing_out'} phase
 * @property {Promise<void>} after
 * @property {Fetched | null} fetched
 * @property {string | null} attempt
 * @property {string | null} url
 * @property {string | null} code
 * @property {number | null} runsOut
 * @property {{ end: () => Promise<unknown>, write?: (code: string) => void } | null} child
 * @property {NodeJS.Timeout | undefined} timer
 * @property {AbortController} stopping
 * @property {Promise<void>} shown
 * @property {() => void} show
 */

const SIGN_IN_MS = 15 * 60_000;
const FOLLOW_MS = 1_000;
const SHOW_MS = 10_000;
const UNFINISHED = /** @type {const} */ ({
  chatgpt: { failed: 'ChatGPT sign-in didn\'t finish.', ranOut: 'This code ran out.' },
  claude: { failed: 'Claude sign-in didn\'t finish.', ranOut: 'This sign-in ran out.' },
});
export const PAID_PLAN = 'Chat needs a paid ChatGPT plan.';
const CODE = /^\S{1,512}$/u;

/**
 * @param {Codex} codex
 * @returns {Promise<Account | null>}
 */
async function accountOf(codex) {
  const { account } = await codex.request('account/read', { refreshToken: false });
  if (account?.type !== 'chatgpt') return null;
  const plan = String(account.planType ?? 'unknown');
  return { email: account.email ?? null, plan, usable: plan !== 'free' };
}

/**
 * @param {Of} of
 * @param {{ machine: string, codex?: Codex, claude?: Claude }} programs
 * @returns {Promise<Held>}
 */
export async function heldOf(of, { machine, codex, claude }) {
  const { chosen, binary } = programOf(machine, PROGRAM_OF[of]);
  const asked = of === 'chatgpt' ? codex && (() => accountOf(codex)) : claude && (async () => {
    const { loggedIn, email, plan } = await claude.status();
    return loggedIn ? { email, plan, usable: true } : null;
  });
  if (!chosen || asked === undefined) return { program: 'absent' };
  if (binary === null) return { program: 'downloading' };
  try {
    return { program: 'ready', account: await asked() };
  } catch (error) {
    if (error instanceof NoCodex || error instanceof NoClaude) return { program: 'downloading' };
    throw error;
  }
}

/**
 * @param {Stage} state
 * @param {Partial<Subscription>} [said]
 * @returns {Subscription}
 */
const shaped = (state, said = {}) => ({ state, bytes: null, total: null, attempt: null, url: null, code: null, account: null, plan: null, why: null, ...said });

/**
 * @param {unknown} answer
 * @param {string} name
 * @returns {Fetched | null}
 */
function fetchedIn(answer, name) {
  const programs = /** @type {{ programs?: unknown }} */ (answer ?? {}).programs;
  const found = Array.isArray(programs) ? programs.find(each => each?.name === name) : undefined;
  if (found === undefined) return null;
  const count = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return { name, state: String(found.state ?? ''), bytes: count(found.bytes), total: count(found.total), why: typeof found.why === 'string' ? found.why : null };
}

/** @param {{ codex: Codex, claude: Claude, machine: string, reread: () => Promise<unknown>, codeMs?: number, followMs?: number, now?: () => number, log: (line: Record<string, unknown>) => void }} options */
export function openSignIn({ codex, claude, machine, reread, codeMs = SIGN_IN_MS, followMs = FOLLOW_MS, now = Date.now, log }) {
  /** @type {Map<Of, Operation>} */
  const operations = new Map();
  /** @type {Map<Of, string>} */
  const failures = new Map();
  /** @type {Map<Of, Promise<void>>} */
  const tails = new Map();
  /** @type {Promise<unknown>} */
  let read = Promise.resolve();

  /** @param {Operation} operation */
  const live = operation => operations.get(operation.of) === operation;

  /**
   * @param {Operation} operation
   * @param {string | null} why
   * @param {string} [detail]
   */
  const finish = (operation, why, detail) => {
    if (!live(operation)) return;
    operations.delete(operation.of);
    clearTimeout(operation.timer);
    operation.stopping.abort();
    if (why !== null) failures.set(operation.of, why);
    else read = reread();
    operation.show();
    log({ login: why === null ? 'ended' : 'failed', of: operation.of, ...(detail === undefined ? {} : { why: detail }) });
  };

  /**
   * @param {Operation} operation
   * @returns {Promise<void>}
   */
  const ended = ({ stopping: { signal } }) => new Promise(done => {
    if (signal.aborted) return done();
    signal.addEventListener('abort', () => done(), { once: true });
  });

  /** @param {Operation} operation */
  const pause = operation => new Promise(done => {
    const timer = setTimeout(done, followMs);
    operation.stopping.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      done(undefined);
    }, { once: true });
  });

  /** @param {Operation} operation @param {unknown} error */
  const doorFailed = (operation, error) => finish(operation, error instanceof ToolError ? error.message : 'Can\'t reach Lifestream.',
    error instanceof Error ? error.message : String(error));

  /** @param {Operation} operation */
  const codexSignIn = async operation => {
    const begun = await codex.request('account/login/start', { type: 'chatgptDeviceCode' });
    const loginId = String(begun.loginId);
    operation.child = { end: () => codex.request('account/login/cancel', { loginId }).catch(() => undefined) };
    if (!live(operation)) return;
    Object.assign(operation, { phase: 'signing_in', attempt: loginId, code: String(begun.userCode), url: String(begun.verificationUrl), runsOut: now() + codeMs });
    operation.timer = setTimeout(() => finish(operation, UNFINISHED.chatgpt.ranOut, 'the code ran out'), codeMs);
    operation.timer.unref();
    operation.show();
  };

  /** @param {Operation} operation */
  const claudeSignIn = operation => {
    operation.child = claude.signIn({
      address: url => {
        if (!live(operation)) return;
        operation.url = url;
        operation.timer = setTimeout(() => finish(operation, UNFINISHED.claude.ranOut, 'the sign-in ran out'), codeMs);
        operation.timer.unref();
        operation.show();
      },
      ended: async signedIn => {
        if (!live(operation)) return;
        const held = signedIn ? await claude.status().catch(() => null) : null;
        finish(operation, held?.loggedIn === true ? null : UNFINISHED.claude.failed, held?.loggedIn === true ? undefined : 'Claude Code\'s sign-in ended unsigned');
      },
    });
    Object.assign(operation, { phase: 'signing_in', attempt: randomBytes(8).toString('hex') });
  };

  /** @param {Operation} operation */
  const run = async operation => {
    const { of } = operation;
    const name = PROGRAM_OF[of];
    const door = operation.door.during(operation.stopping.signal);
    await operation.after;
    if (!live(operation)) return;
    if (programOf(machine, name).binary === null) {
      operation.phase = 'fetching';
      try {
        operation.fetched = fetchedIn(await door.post(`/v1/subscriptions/${name}`, {}), name);
      } catch (error) {
        return doorFailed(operation, error);
      }
      operation.show();
      while (live(operation) && programOf(machine, name).binary === null) {
        if (operation.fetched?.state === 'failed') return finish(operation, operation.fetched.why ?? `${PRODUCT[of]} didn't download.`, 'the fetch failed');
        if (operation.fetched?.state === 'ready') return finish(operation, `${PRODUCT[of]} is on this Mac but doesn't run.`, 'ready, but current names nothing that runs');
        await pause(operation);
        if (!live(operation)) return;
        try {
          operation.fetched = fetchedIn(await door.json('/v1/subscriptions'), name);
        } catch (error) {
          return doorFailed(operation, error);
        }
      }
      if (!live(operation)) return;
    }
    const held = await Promise.race([heldOf(of, { machine, codex, claude }), ended(operation)]);
    if (held === undefined || !live(operation)) return;
    if (held.program !== 'ready') return finish(operation, downloading(of), 'the program went as it was asked');
    if (held.account?.usable === true) return finish(operation, null);
    if (of === 'chatgpt') await codexSignIn(operation);
    else claudeSignIn(operation);
    await ended(operation);
    await operation.child?.end();
  };

  /** @param {Operation} operation */
  const signingOut = async operation => {
    const { of } = operation;
    await operation.after;
    if (programOf(machine, PROGRAM_OF[of]).binary !== null) {
      if (of === 'chatgpt') await codex.request('account/logout', undefined);
      else await claude.signOut();
      log({ login: 'signed-out', of });
    }
    finish(operation, null);
  };

  /**
   * @param {Of} of
   * @param {Door} door
   * @param {Operation['phase']} phase
   * @param {(operation: Operation) => Promise<void>} body
   * @param {string} failed
   */
  const made = (of, door, phase, body, failed) => {
    /** @type {() => void} */
    let show = () => undefined;
    const shown = new Promise(done => { show = () => done(undefined); });
    /** @type {Operation} */
    const operation = { of, door, phase, after: tails.get(of) ?? Promise.resolve(), fetched: null, attempt: null, url: null, code: null, runsOut: null,
      child: null, timer: undefined, stopping: new AbortController(), shown, show };
    operations.set(of, operation);
    const over = body(operation).catch(error => finish(operation, failed, error instanceof Error ? error.message : String(error)));
    tails.set(of, over);
    return { operation, over };
  };

  codex.on('account/login/completed', async ({ params }) => {
    const operation = operations.get('chatgpt');
    if (operation === undefined || operation.phase !== 'signing_in' || params?.loginId !== operation.attempt) return;
    operation.child = null;
    if (params.success !== true) {
      return finish(operation, now() >= (operation.runsOut ?? 0) - 5_000 ? UNFINISHED.chatgpt.ranOut : UNFINISHED.chatgpt.failed, String(params.error ?? 'unsaid'));
    }
    try {
      const account = await accountOf(codex);
      if (!live(operation)) return;
      if (account?.usable === false) {
        await codex.request('account/logout', undefined);
        return finish(operation, PAID_PLAN, 'free plan');
      }
      log({ login: 'signed-in', of: 'chatgpt', plan: account?.plan ?? null });
      finish(operation, null);
    } catch (error) {
      finish(operation, UNFINISHED.chatgpt.failed, error instanceof Error ? error.message : String(error));
    }
  });
  codex.on('codex/exited', () => {
    const operation = operations.get('chatgpt');
    if (operation?.phase !== 'signing_in') return;
    operation.child = null;
    finish(operation, UNFINISHED.chatgpt.failed, 'Codex stopped while the code showed');
  });

  /**
   * @param {Of} of
   * @param {() => Promise<unknown>} programs
   * @returns {Promise<Subscription>}
   */
  const subscription = async (of, programs) => {
    const said = async () => fetchedIn(await programs(), PROGRAM_OF[of]);
    const running = operations.get(of);
    const operation = running?.phase === 'signing_out' ? undefined : running;
    if (operation !== undefined) {
      if (operation.phase === 'signing_in' || (operation.phase === 'starting' && programOf(machine, PROGRAM_OF[of]).binary !== null)) {
        return shaped('signing_in', { attempt: operation.attempt, url: operation.url, code: operation.code });
      }
      const fetching = operation.fetched ?? await said();
      return shaped('fetching', { bytes: fetching?.bytes ?? null, total: fetching?.total ?? null });
    }
    const why = failures.get(of);
    if (why !== undefined) return shaped('failed', { why });
    let held;
    try {
      held = await heldOf(of, { machine, codex, claude });
    } catch (error) {
      log({ login: 'unread', of, why: error instanceof Error ? error.message : String(error) });
      return shaped('failed', { why: `Lifestream couldn't ask ${PRODUCT[of]} who is signed in.` });
    }
    if (held.program === 'absent') return shaped('absent');
    if (held.program === 'downloading') {
      const fetched = await said();
      return fetched?.state === 'failed' ? shaped('failed', { why: fetched.why }) : shaped('fetching', { bytes: fetched?.bytes ?? null, total: fetched?.total ?? null });
    }
    return held.account?.usable === true ? shaped('signed_in', { account: held.account.email, plan: held.account.plan }) : shaped('signed_out');
  };

  /**
   * @param {Door} door
   * @returns {Promise<LoginState>}
   */
  const state = async door => {
    await read;
    /** @type {Promise<unknown> | null} */
    let asked = null;
    const programs = () => (asked ??= door.json('/v1/subscriptions').catch(() => null));
    const [chatgpt, claudeOne] = await Promise.all([subscription('chatgpt', programs), subscription('claude', programs)]);
    return { chatgpt, claude: claudeOne };
  };

  /**
   * @param {Of} of
   * @returns {Promise<void>}
   */
  const cancelled = of => {
    failures.delete(of);
    const operation = operations.get(of);
    if (operation !== undefined) {
      log({ login: 'cancel', of });
      finish(operation, null);
    }
    return tails.get(of) ?? Promise.resolve();
  };

  return {
    state,

    /**
     * @param {Of} of
     * @param {Door} door
     */
    async start(of, door) {
      let operation = operations.get(of);
      if (operation === undefined || operation.phase === 'signing_out') {
        failures.delete(of);
        log({ login: 'start', of });
        operation = made(of, door, 'starting', run, UNFINISHED[of].failed).operation;
      }
      /** @type {NodeJS.Timeout | undefined} */
      let late;
      await Promise.race([operation.shown, new Promise(done => { late = setTimeout(done, SHOW_MS); late.unref(); })]);
      clearTimeout(late);
      return state(door);
    },

    /**
     * @param {string} attempt
     * @param {string} code
     * @param {Door} door
     * @returns {Promise<LoginState | { refused: number, error: string }>}
     */
    async code(attempt, code, door) {
      if (!CODE.test(code)) return { refused: 400, error: 'code is the code Anthropic\'s page shows, as it shows it.' };
      const operation = operations.get('claude');
      if (operation === undefined || operation.attempt !== attempt) return { refused: 409, error: 'This sign-in has ended. Sign in with Claude again.' };
      operation.child?.write?.(code);
      log({ login: 'code', of: 'claude' });
      return state(door);
    },

    /**
     * @param {Of} of
     * @param {Door} door
     */
    async cancel(of, door) {
      await cancelled(of);
      return state(door);
    },

    /**
     * @param {Of} of
     * @param {Door} door
     */
    async signOut(of, door) {
      cancelled(of);
      await made(of, door, 'signing_out', signingOut, `${PRODUCT[of]} didn't sign out. Try again.`).over;
      return state(door);
    },

    close: () => Promise.all([...tails.keys()].map(cancelled)).then(() => undefined),
  };
}
