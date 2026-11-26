// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.CODEX_HOME ?? '';
const fake = join(home, 'fake');
mkdirSync(fake, { recursive: true });
/** @param {string} name @param {unknown} line */
const append = (name, line) => appendFileSync(join(fake, name), `${JSON.stringify(line)}\n`);
/** @param {string} name */
const json = name => {
  try {
    return JSON.parse(readFileSync(join(fake, name), 'utf8'));
  } catch {
    return null;
  }
};
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  const held = json('auth.json');
  process.stdout.write(held === null ? 'Not logged in\n' : `Logged in using ChatGPT (${held.email})\n`);
  process.exit(held === null ? 1 : 0);
}
const generation = (() => {
  try {
    return readFileSync(join(fake, 'started.jsonl'), 'utf8').split('\n').filter(line => line !== '').length + 1;
  } catch {
    return 1;
  }
})();
append('started.jsonl', {
  argv: process.argv.slice(2), codex_home: home, home: process.env.HOME ?? null, cwd: process.cwd(),
  openai_api_key: process.env.OPENAI_API_KEY !== undefined, codex_api_key: process.env.CODEX_API_KEY !== undefined,
});

/** @param {unknown} message */
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
/** @param {string} method @param {unknown} params */
const notify = (method, params) => write({ method, params });
let asked = 0;
/** @type {Map<string, (result: any) => void>} */
const answers = new Map();
/** @param {string} method @param {unknown} params @returns {Promise<any>} */
const ask = (method, params) => new Promise(done => {
  const id = `fake-${++asked}`;
  answers.set(id, done);
  write({ id, method, params });
});
const sleep = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms));

/** @type {{ id: string, timer: NodeJS.Timeout } | null} */
let login = null;
let logins = 0;
let threads = 0;
const started = new Set();
/** @type {Map<string, { interrupted: boolean, thread: string }>} */
const turns = new Map();

const MODELS = [
  { id: 'gpt-6.1-terra', model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'],
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort, description: '' })) },
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'],
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort, description: '' })) },
  { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', inputModalities: ['text'],
    supportedReasoningEfforts: ['low', 'medium'].map(reasoningEffort => ({ reasoningEffort, description: '' })) },
  { id: 'codex-internal', model: 'codex-internal', displayName: 'Hidden', hidden: true, isDefault: false, defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] },
];

/**
 * @param {string} thread
 * @param {string} id
 */
async function run(thread, id) {
  const state = /** @type {{ interrupted: boolean, thread: string }} */ (turns.get(id));
  const n = Number(readFileSync(join(fake, 'turn-n'), { encoding: 'utf8', flag: 'a+' }) || '0');
  writeFileSync(join(fake, 'turn-n'), String(n + 1));
  const script = (json('turns.json') ?? [])[n] ?? [{ say: 'Nothing scripted.' }];
  let calls = 0;
  let items = 0;
  /** @param {string} status @param {unknown} [error] */
  const complete = (status, error = null) => {
    turns.delete(id);
    notify('turn/completed', { threadId: thread, turn: { id, items: [], status, error, startedAt: null, completedAt: null, durationMs: null } });
  };
  /** @param {{ tool: string, args: unknown }} call @param {string} callId */
  const tool = async ({ tool: name, args }, callId) => {
    notify('item/started', { threadId: thread, turnId: id, item: { type: 'dynamicToolCall', id: callId, tool: name, arguments: args } });
    const result = await ask('item/tool/call', { threadId: thread, turnId: id, callId, namespace: null, tool: name, arguments: args });
    append('seen.jsonl', { answered: callId, tool: name, result });
    notify('item/completed', { threadId: thread, turnId: id, item: { type: 'dynamicToolCall', id: callId, tool: name, success: result?.success ?? null } });
  };
  for (const step of script) {
    if (state.interrupted) return complete('interrupted');
    if (step.exit) process.exit(1);
    if (step.say !== undefined) {
      const item = `msg-${++items}`;
      const text = String(step.say);
      notify('item/started', { threadId: thread, turnId: id, item: { type: 'agentMessage', id: item, text: '' } });
      const half = Math.ceil(text.length / 2);
      for (const delta of [text.slice(0, half), text.slice(half)]) if (delta !== '') notify('item/agentMessage/delta', { threadId: thread, turnId: id, itemId: item, delta });
      notify('item/completed', { threadId: thread, turnId: id, item: { type: 'agentMessage', id: item, text } });
    }
    if (step.warning !== undefined) notify('warning', { threadId: thread, message: String(step.warning) });
    if (step.call !== undefined) await tool(step.call, `call_${++calls}`);
    if (step.script !== undefined) await Promise.all(step.script.map((/** @type {any} */ call) => tool(call, `exec-${++calls}`)));
    if (step.usage !== undefined) notify('thread/tokenUsage/updated', { threadId: thread, turnId: id, tokenUsage: { total: step.usage, last: step.usage, modelContextWindow: null } });
    if (step.fail !== undefined) {
      const error = { message: step.fail.message ?? 'failed', codexErrorInfo: step.fail.codexErrorInfo ?? null, additionalDetails: null, misalignment: null };
      notify('error', { threadId: thread, turnId: id, error, willRetry: false });
      return complete('failed', error);
    }
    if (step.offline) {
      for (let tries = 1; !state.interrupted; tries++) {
        notify('error', { threadId: thread, turnId: id, willRetry: true, error: { message: 'Reconnecting... waiting for network', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'Connection failed: error sending request', misalignment: null } });
        await sleep(50);
      }
    }
    if (step.hold) while (!state.interrupted) await sleep(20);
  }
  complete(state.interrupted ? 'interrupted' : 'completed');
}

/** @param {{ id: number, method: string, params: any }} message */
function answer({ id, method, params }) {
  append('seen.jsonl', { method, params: params ?? null });
  if (json('hold') === method) {
    rmSync(join(fake, 'hold'), { force: true });
    void (async () => {
      while (!existsSync(join(fake, 'release'))) await sleep(20);
      rmSync(join(fake, 'release'), { force: true });
      append('seen.jsonl', { released: method });
      answered({ id, method, params });
    })();
    return undefined;
  }
  return answered({ id, method, params });
}

/** @param {{ id: number, method: string, params: any }} message */
function answered({ id, method, params }) {
  const reply = (/** @type {unknown} */ result) => write({ id, result });
  switch (method) {
    case 'initialize': return reply({ userAgent: 'fake-codex/0.166.0' });
    case 'account/read': {
      const held = json('auth.json');
      return reply({ account: held === null ? null : { type: 'chatgpt', email: held.email, planType: held.plan }, requiresOpenaiAuth: true });
    }
    case 'account/login/start': {
      if (login !== null) clearInterval(login.timer);
      const loginId = `login-${++logins}`;
      const timer = setInterval(() => {
        const confirmed = json('confirm');
        if (confirmed === null) return;
        rmSync(join(fake, 'confirm'), { force: true });
        clearInterval(timer);
        if (confirmed.exit) process.exit(1);
        login = null;
        if (confirmed.decline) return notify('account/login/completed', { loginId, success: false, error: 'access_denied', onboardingEntrypoint: null });
        writeFileSync(join(fake, 'auth.json'), JSON.stringify({ email: confirmed.email ?? 'person-a@example.com', plan: confirmed.plan ?? 'plus' }));
        notify('account/login/completed', { loginId, success: true, error: null, onboardingEntrypoint: null });
      }, 20);
      login = { id: loginId, timer };
      return reply({ type: 'chatgptDeviceCode', loginId, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-1234' });
    }
    case 'account/login/cancel': {
      const live = login;
      if (live !== null && live.id === params?.loginId) {
        clearInterval(live.timer);
        login = null;
        notify('account/login/completed', { loginId: params.loginId, success: false, error: 'canceled', onboardingEntrypoint: null });
      }
      return reply({ status: 'canceled' });
    }
    case 'account/logout': {
      rmSync(join(fake, 'auth.json'), { force: true });
      return reply({});
    }
    case 'model/list': return reply({ data: MODELS, nextCursor: null });
    case 'thread/start': {
      if (json('auth.json') === null && params?.dynamicTools !== undefined) return write({ id, error: { code: -32600, message: 'not signed in' } });
      const thread = `thread-${generation}-${++threads}`;
      started.add(thread);
      return reply({ thread: { id: thread }, model: params?.model ?? null });
    }
    case 'thread/inject_items': return reply({});
    case 'thread/unsubscribe': return reply({ status: 'unsubscribed' });
    case 'turn/start': {
      if (!started.has(params?.threadId)) return write({ id, error: { code: -32600, message: `thread not found: ${params?.threadId}` } });
      const turn = `turn-${params.threadId}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      turns.set(turn, { interrupted: false, thread: params.threadId });
      reply({ turn: { id: turn, items: [], status: 'inProgress', error: null } });
      void run(params.threadId, turn);
      return undefined;
    }
    case 'turn/interrupt': {
      const turn = turns.get(params?.turnId);
      if (turn !== undefined) turn.interrupted = true;
      return reply({});
    }
    default: return write({ id, error: { code: -32601, message: `fake codex has no ${method}` } });
  }
}

if (process.argv[2] !== 'app-server') {
  process.stderr.write('the fake codex runs app-server only\n');
  process.exit(2);
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    answers.get(String(message.id))?.(message.result ?? { error: message.error });
    answers.delete(String(message.id));
  } else if (message.id !== undefined) answer(message);
});
process.stdin.on('end', () => process.exit(0));
