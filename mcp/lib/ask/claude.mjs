// @ts-check
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { kept } from './programs.mjs';

/**
 * @typedef {import('./programs.mjs').At} At
 * @typedef {{ loggedIn: boolean, email: string | null, plan: string | null }} ClaudeStatus
 * @typedef {{ status: 'done', text: string, model: string | null, usage: { input: number, output: number, cache_read: number } } | { status: 'stopped' } | { status: 'failed', auth: boolean, limited: boolean, until_ms: number | null, exited: boolean, detail: string }} TurnEnd
 * @typedef {{ text: (delta: string) => void, message: () => void }} Hearing
 */

const QUIET = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '',
  '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--permission-mode', 'dontAsk'];
const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'];
const STATUS_MS = 5_000;
const ASK_MS = 30_000;
const END_MS = 3_000;
const LOOK_MS = 25;
const TOOLS_SERVER = 'lifestream';

/** @param {string} status */
const limitMet = status => !status.startsWith('allowed');

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
function claudeEnv(home, env = process.env) {
  const rest = { ...env };
  for (const key of KEYS) delete rest[key];
  return {
    ...rest, CLAUDE_CONFIG_DIR: home, USER: env.USER || userInfo().username, DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
}

/** @param {{ tools: string, prompt: string, model: string, effort: string | null }} run */
function chatArgs({ tools, prompt, model, effort }) {
  return [...QUIET, '--include-partial-messages', '--mcp-config', tools, '--allowedTools', `mcp__${TOOLS_SERVER}__*`,
    '--system-prompt-file', prompt, '--model', model, ...effort === null ? [] : ['--effort', effort]];
}

/**
 * @param {At} at
 * @param {string[]} args
 */
function child(at, args) {
  mkdirSync(at.home, { recursive: true, mode: 0o700 });
  return spawn(at.binary, args, { cwd: at.home, env: claudeEnv(at.home), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
}

const linesOf = (/** @type {import('node:stream').Readable} */ output, /** @type {(line: any) => void} */ heard) => {
  createInterface({ input: output }).on('line', text => {
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      return;
    }
    if (line !== null && typeof line === 'object') heard(line);
  });
};

/**
 * @param {string} text
 * @param {{ data: string, mimeType: string }[]} [images]
 */
const userLine = (text, images = []) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text },
  ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))] } })}\n`;

/** @param {any} usage */
function answeredBy(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const named = Object.entries(usage).sort(([, one], [, other]) => Number(other?.outputTokens ?? 0) - Number(one?.outputTokens ?? 0));
  return named[0]?.[0] ?? null;
}

/** @param {{ at: () => At | null, machine: string, log: (line: Record<string, unknown>) => void, now?: () => number }} options */
export function openClaude({ at, machine, log, now = Date.now }) {
  const folders = { plain: join(machine, 'ask', 'claude'), keyed: join(machine, 'scratch', 'ask') };
  for (const folder of Object.values(folders)) rmSync(folder, { recursive: true, force: true });
  /** @type {Map<import('node:child_process').ChildProcess, Promise<void> | null>} */
  const children = new Map();
  /** @type {Set<() => void>} */
  const conversations = new Set();
  let closed = false;

  /**
   * @param {import('node:child_process').ChildProcess} process_
   * @returns {Promise<void>}
   */
  const ending = process_ => {
    const begun = children.get(process_);
    if (begun !== undefined && begun !== null) return begun;
    if (begun === undefined) return Promise.resolve();
    const pid = /** @type {number} */ (process_.pid);
    /** @param {NodeJS.Signals | 0} signal */
    const signalled = signal => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (error) {
        return /** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH';
      }
    };
    const ended = /** @type {Promise<void>} */ (new Promise(done => {
      if (!signalled('SIGTERM')) return done(undefined);
      const over = () => {
        clearTimeout(kill);
        clearInterval(look);
        done(undefined);
      };
      const kill = setTimeout(() => {
        if (signalled('SIGKILL')) log({ claude: 'killed', why: 'a child\'s group outlived SIGTERM by three seconds' });
        over();
      }, END_MS);
      const look = setInterval(() => { if (!signalled(0)) over(); }, LOOK_MS);
    })).then(() => void children.delete(process_));
    children.set(process_, ended);
    return ended;
  };

  /** @param {string[]} args */
  const started = args => {
    const where = at();
    if (where === null) throw new NoClaude();
    if (closed) throw new ClaudeError('Claude Code was closed.');
    const process_ = child(where, args);
    if (process_.pid === undefined) {
      process_.once('error', () => undefined);
    } else {
      children.set(process_, null);
      process_.once('exit', () => void ending(process_));
    }
    process_.stdin?.on('error', () => undefined);
    process_.stderr?.resume();
    return process_;
  };

  /** @returns {Promise<ClaudeStatus>} */
  const asked = () => new Promise((done, fail) => {
    const process_ = started(['auth', 'status']);
    let out = '';
    process_.stdout?.on('data', chunk => { out = `${out}${chunk}`.slice(-65_536); });
    const late = setTimeout(() => {
      fail(new ClaudeError('Claude Code did not say who is signed in in time.'));
      void ending(process_);
    }, ASK_MS);
    process_.once('error', () => {
      clearTimeout(late);
      fail(new ClaudeError('Claude Code did not start.'));
    });
    process_.once('close', (code, signal) => {
      clearTimeout(late);
      let said = null;
      try {
        said = JSON.parse(out);
      } catch {}
      out = '';
      if (said === null || typeof said !== 'object') return fail(new ClaudeError(`Claude Code did not say who is signed in (exit ${code ?? signal}).`));
      done({ loggedIn: said.loggedIn === true, email: typeof said.email === 'string' ? said.email : null,
        plan: typeof said.subscriptionType === 'string' ? said.subscriptionType : null });
    });
  });

  const status = kept(STATUS_MS, asked, now);

  const endConversations = () => {
    for (const retire of conversations) retire();
  };

  return {
    status: status.read,

    /** @param {{ address: (url: string) => void, ended: (signedIn: boolean) => void }} hearing */
    signIn({ address, ended }) {
      const process_ = started(['auth', 'login', '--claudeai']);
      /** @type {string | null} */
      let held = null;
      let asking = false;
      let heard = '';
      let told = false;
      /** @param {Buffer} chunk */
      const read = chunk => {
        heard = `${heard}${chunk}`.slice(-8_192);
        const url = /https:\/\/\S+(?=\s)/u.exec(heard)?.[0];
        if (url !== undefined && !told) {
          told = true;
          address(url);
        }
        if (!asking && /paste code/iu.test(heard)) {
          asking = true;
          if (held !== null) process_.stdin?.write(`${held}\n`);
          held = null;
        }
      };
      process_.stdout?.on('data', read);
      process_.stderr?.removeAllListeners('data');
      process_.stderr?.on('data', read);
      let over = false;
      /** @param {boolean} succeeded */
      const end = succeeded => {
        if (over) return;
        over = true;
        heard = '';
        held = null;
        status.forget();
        if (succeeded) {
          endConversations();
        }
        ended(succeeded);
      };
      process_.once('error', () => end(false));
      process_.once('exit', code => end(code === 0));
      return {
        /** @param {string} code */
        write(code) {
          if (asking) process_.stdin?.write(`${code}\n`);
          else held = code;
        },
        end: () => ending(process_),
      };
    },

    async signOut() {
      endConversations();
      const process_ = started(['auth', 'logout']);
      process_.stdout?.resume();
      await new Promise(done => {
        process_.once('exit', done);
        process_.once('error', done);
      });
      status.forget();
      endConversations();
    },

    /** @param {{ chat: string, model: string, effort: string | null, prompt: string, tools: string, bearer: string, keyed: boolean }} run */
    conversation({ chat, model, effort, prompt, tools, bearer, keyed }) {
      const files = keyed ? folders.keyed : folders.plain;
      mkdirSync(files, { recursive: true, mode: 0o700 });
      const name = `${chat}-${randomBytes(3).toString('hex')}`;
      const promptFile = join(files, `${name}.prompt.md`);
      const toolsFile = join(files, `${name}.tools.json`);
      writeFileSync(promptFile, prompt, { mode: 0o600 });
      writeFileSync(toolsFile, JSON.stringify({ mcpServers: { [TOOLS_SERVER]: { type: 'http', url: tools, headers: { Authorization: `Bearer ${bearer}` } } } }), { mode: 0o600 });
      const removeFiles = () => {
        rmSync(promptFile, { force: true });
        rmSync(toolsFile, { force: true });
      };
      let process_;
      try {
        process_ = started(chatArgs({ tools: toolsFile, prompt: promptFile, model, effort }));
      } catch (error) {
        removeFiles();
        throw error;
      }
      const running = process_;
      let alive = true;
      let stopping = false;
      let retired = false;
      /** @type {{ hearing: Hearing, done: (end: TurnEnd) => void, auth: boolean, until_ms: number | null, limited: boolean } | null} */
      let turn = null;
      const retire = () => {
        retired = true;
        if (turn === null) void ending(running);
      };
      conversations.add(retire);
      const exited = new Promise(done => {
        running.once('exit', done);
        running.once('error', done);
      });
      void exited.then(how => {
        alive = false;
        conversations.delete(retire);
        removeFiles();
        const asked = turn;
        turn = null;
        if (asked !== null) asked.done(stopping ? { status: 'stopped' } : { status: 'failed', auth: false, limited: false, until_ms: null, exited: true, detail: `exit ${how instanceof Error ? how.message : how}` });
      });
      linesOf(/** @type {import('node:stream').Readable} */ (running.stdout), line => {
        const asked = turn;
        if (asked === null) return;
        if (line.type === 'stream_event') {
          const event = line.event;
          if (event?.type === 'message_start') asked.hearing.message();
          else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') asked.hearing.text(event.delta.text);
        } else if (line.type === 'assistant' && line.error === 'authentication_failed') asked.auth = true;
        else if (line.type === 'rate_limit_event') {
          const info = line.rate_limit_info ?? {};
          if (typeof info.status === 'string' && limitMet(info.status)) {
            asked.limited = true;
            asked.until_ms = Number.isFinite(info.resetsAt) ? Math.round(info.resetsAt * 1000) : null;
          }
        } else if (line.type === 'result') {
          turn = null;
          if (retired) void ending(running);
          const usage = line.usage ?? {};
          if (line.is_error !== true && line.subtype === 'success') {
            asked.done({ status: 'done', text: String(line.result ?? ''), model: answeredBy(line.modelUsage),
              usage: { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0), cache_read: Number(usage.cache_read_input_tokens ?? 0) } });
            return;
          }
          const detail = String(line.result ?? (Array.isArray(line.errors) ? line.errors.join(' ') : '') ?? '') || `the turn ended ${line.subtype ?? 'unsaid'}`;
          asked.done({ status: 'failed', auth: asked.auth || LOGGED_OUT.test(detail), limited: asked.limited || line.api_error_status === 429,
            until_ms: asked.until_ms, exited: false, detail });
        }
      });
      return {
        get alive() {
          return alive && !retired;
        },
        ended: exited.then(() => undefined),
        /**
         * @param {string} text
         * @param {Hearing} hearing
         * @param {{ data: string, mimeType: string }[]} [images]
         * @returns {Promise<TurnEnd>}
         */
        ask(text, hearing, images = []) {
          return new Promise(done => {
            if (!alive) return done({ status: 'failed', auth: false, limited: false, until_ms: null, exited: true, detail: 'Claude Code was not running' });
            turn = { hearing, done, auth: false, until_ms: null, limited: false };
            running.stdin?.write(userLine(text, images));
          });
        },
        async close() {
          stopping = true;
          await ending(running);
          removeFiles();
        },
      };
    },

    /**
     * @param {{ system: string, ask: string, model: string, effort: string | null, signal: AbortSignal }} titled
     * @returns {Promise<string | null>}
     */
    async title({ system, ask, model, effort, signal }) {
      if (signal.aborted) return null;
      let process_;
      try {
        process_ = started([...QUIET, '--system-prompt', system, '--model', model, ...effort === null ? [] : ['--effort', effort]]);
      } catch {
        return null;
      }
      const running = process_;
      const stop = () => void ending(running);
      signal.addEventListener('abort', stop, { once: true });
      try {
        return await new Promise(done => {
          running.once('exit', () => done(null));
          running.once('error', () => done(null));
          linesOf(/** @type {import('node:stream').Readable} */ (running.stdout), line => {
            if (line.type !== 'result') return;
            done(line.is_error !== true && line.subtype === 'success' ? String(line.result ?? '') : null);
            running.stdin?.end();
          });
          running.stdin?.write(userLine(ask));
        });
      } finally {
        signal.removeEventListener('abort', stop);
        void ending(running);
      }
    },

    async close() {
      closed = true;
      await Promise.all([...children.keys()].map(ending));
    },
  };
}

const LOGGED_OUT = /not logged in|please run \/login|invalid api key|oauth token (?:has )?expired|authentication/iu;

export class ClaudeError extends Error {}

export class NoClaude extends ClaudeError {}
