// @ts-check
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

/**
 * @typedef {{ method: string, params: any, id?: number | string }} Message
 * @typedef {(message: Message) => unknown} Listener
 */


const CONFIG = [
  'check_for_update_on_startup=false', 'analytics.enabled=false', 'approval_policy="never"', 'sandbox_mode="read-only"',
  'web_search="disabled"', 'project_doc_max_bytes=0', 'skills.include_instructions=false', 'skills.bundled.enabled=false',
  'include_permissions_instructions=false', 'include_environment_context=false', 'include_collaboration_mode_instructions=false',
  'include_apps_instructions=false',
  ...['shell_tool', 'unified_exec', 'shell_snapshot', 'multi_agent', 'goals', 'view_image', 'image_generation', 'skill_search',
    'plugins', 'remote_plugin', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'sleep_tool', 'hooks',
    'tool_suggest', 'workspace_dependencies', 'realtime_conversation', 'memories', 'skill_mcp_dependency_install'].map(feature => `features.${feature}=false`),
].flatMap(setting => ['-c', setting]);

/**
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
function codexEnv(home, env = process.env) {
  const { OPENAI_API_KEY: _openai, CODEX_API_KEY: _codex, ...rest } = env;
  return { ...rest, CODEX_HOME: home, HOME: home };
}

/** @param {{ at: () => import('./programs.mjs').At | null, log: (line: Record<string, unknown>) => void }} options */
export function openCodex({ at, log }) {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  let child = null;
  /** @type {Promise<void> | null} */
  let ready = null;
  let next = 0;
  /** @type {Map<number, { done: (value: any) => void, fail: (error: Error) => void }>} */
  const pending = new Map();
  /** @type {Map<string, Listener>} */
  const threads = new Map();
  /** @type {Map<string, Set<Listener>>} */
  const methods = new Map();
  let closed = false;

  /** @param {unknown} message */
  const write = message => child?.stdin.write(`${JSON.stringify(message)}\n`);

  /**
   * @param {string} method
   * @param {unknown} params
   */
  const send = (method, params) => new Promise((done, fail) => {
    const id = ++next;
    pending.set(id, { done, fail });
    write({ id, method, params });
  });

  /** @param {Message & { result?: unknown, error?: { message?: string } }} message */
  const heard = async message => {
    if (message.method === undefined) {
      const waiting = pending.get(Number(message.id));
      pending.delete(Number(message.id));
      if (message.error !== undefined) waiting?.fail(new CodexError(String(message.error?.message ?? 'Codex refused the request')));
      else waiting?.done(message.result);
      return;
    }
    const thread = typeof message.params?.threadId === 'string' ? threads.get(message.params.threadId) : undefined;
    const listeners = thread === undefined ? [...methods.get(message.method) ?? []] : [thread];
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
      return;
    }
    try {
      if (listeners.length === 0) throw new Error(`Ask does not answer ${message.method} here`);
      write({ id: message.id, result: await listeners[0](message) });
    } catch (error) {
      write({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  };

  const start = () => {
    if (ready !== null) return ready;
    ready = (async () => {
      const where = at();
      if (where === null) throw new NoCodex();
      mkdirSync(where.home, { recursive: true, mode: 0o700 });
      const started = Date.now();
      const process_ = spawn(where.binary, ['app-server', ...CONFIG], { stdio: ['pipe', 'pipe', 'pipe'], env: codexEnv(where.home), cwd: where.home });
      child = process_;
      let said = '';
      process_.stderr.on('data', chunk => { said = `${said}${chunk}`.slice(-2_000); });
      createInterface({ input: process_.stdout }).on('line', line => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        void heard(message);
      });
      const exited = new Promise(done => {
        process_.once('error', error => done(error));
        process_.once('exit', code => done(code));
      });
      void exited.then(how => {
        if (child === process_) {
          child = null;
          ready = null;
        }
        const why = new CodexError(closed ? 'Codex was closed.' : `Codex stopped (${how instanceof Error ? how.message : `exit ${how}`})`);
        for (const [id, waiting] of pending) {
          pending.delete(id);
          waiting.fail(why);
        }
        const exit = { method: 'codex/exited', params: { why: why.message } };
        for (const listener of [...threads.values(), ...methods.get('codex/exited') ?? []]) listener(exit);
        if (!closed) log({ codex: 'exited', how: how instanceof Error ? how.message : how, said: said.trim().slice(-300) });
      });
      await Promise.race([
        send('initialize', { clientInfo: { name: 'lifestream-ask', title: 'Lifestream Ask', version: '1' }, capabilities: { experimentalApi: true } }),
        exited.then(how => { throw new CodexError(`Codex did not start (${how instanceof Error ? how.message : `exit ${how}`}): ${said.trim().slice(-300)}`); }),
      ]);
      write({ method: 'initialized' });
      log({ codex: 'started', ms: Date.now() - started });
    })();
    ready.catch(() => { ready = null; });
    return ready;
  };

  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {Promise<any>}
   */
  const request = async (method, params) => {
    if (closed) throw new CodexError('Codex was closed.');
    await start();
    const answer = await send(method, params);
    return answer;
  };

  return {
    request,

    /**
     * @param {string} thread
     * @param {Listener} listener
     */
    thread(thread, listener) {
      threads.set(thread, listener);
      return () => void (threads.get(thread) === listener && threads.delete(thread));
    },

    /**
     * @param {string} method
     * @param {Listener} listener
     */
    on(method, listener) {
      const set = methods.get(method) ?? new Set();
      set.add(listener);
      methods.set(method, set);
      return () => void set.delete(listener);
    },

    async close() {
      closed = true;
      const running = child;
      if (running === null) return;
      const gone = new Promise(done => running.once('exit', done));
      running.kill('SIGTERM');
      const late = setTimeout(() => running.kill('SIGKILL'), 3_000);
      await gone;
      clearTimeout(late);
    },
  };
}

export class CodexError extends Error {}

export class NoCodex extends CodexError {}
