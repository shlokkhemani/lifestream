// @ts-check
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.CLAUDE_CONFIG_DIR ?? '';
const fake = join(home, 'fake');
mkdirSync(fake, { recursive: true });
const args = process.argv.slice(2);
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
/** @param {string} flag */
const flag = flag => {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
};
const sleep = (/** @type {number} */ ms) => new Promise(done => setTimeout(done, ms));
const session = 'fake-session-0000';
/** @param {unknown} line */
const say = line => process.stdout.write(`${JSON.stringify(line)}\n`);

/**
 * @param {{ url: string, headers?: Record<string, string> }} server
 */
async function connectMcp(server) {
  let nextId = 0;
  let sessionId = '';
  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {boolean} [notify]
   */
  const post = async (method, params, notify = false) => {
    const headers = {
      ...server.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++nextId, method, params };
    const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = response.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (!response.ok) throw new Error(`MCP ${method} failed (${response.status}): ${await response.text()}`);
    if (notify || response.status === 202) return undefined;
    const type = response.headers.get('content-type') ?? '';
    const text = await response.text();
    const message = type.includes('text/event-stream')
      ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).findLast(Boolean) ?? '{}')
      : JSON.parse(text);
    if (message.error) throw new Error(`MCP ${method}: ${message.error.message ?? JSON.stringify(message.error)}`);
    return message.result;
  };
  await post('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.321' } });
  await post('notifications/initialized', {}, true);
  return {
    listTools: () => /** @type {Promise<{ tools: { name: string }[] }>} */ (post('tools/list', {})),
    /** @param {{ name: string, arguments: Record<string, unknown> }} params */
    callTool: params => /** @type {Promise<{ content: unknown, isError?: boolean }>} */ (post('tools/call', params)),
  };
}

append('started.jsonl', {
  argv: args, cwd: process.cwd(), pid: process.pid,
  env: Object.fromEntries(['CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ENABLE_CLAUDEAI_MCP_SERVERS']
    .map(name => [name, process.env[name] ?? null])),
  user: process.env.USER !== undefined && process.env.USER !== '',
  keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'].filter(name => process.env[name] !== undefined),
});

const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

async function status() {
  while (existsSync(join(fake, 'status-held'))) await sleep(20);
  if (existsSync(join(fake, 'status-unreadable'))) {
    process.stdout.write('Not JSON: Token sk-ant-oat01-SYNTHETIC-TOKEN-0000\n');
    process.stderr.write('Error reading credentials: sk-ant-oat01-SYNTHETIC-TOKEN-0000\n');
    process.exit(1);
  }
  const held = json('auth.json');
  process.stdout.write(`${JSON.stringify({ loggedIn: held !== null, authMethod: held === null ? 'none' : 'claude.ai', apiProvider: 'firstParty',
    ...held === null ? {} : { email: held.email, subscriptionType: held.plan }, configDirectory: home, loginExpiresAt: null }, null, 2)}\n`);
  process.exit(held === null ? 1 : 0);
}

async function login() {
  const stubborn = existsSync(join(fake, 'stubborn'));
  const helper = stubborn
    ? spawn('sh', ['-c', 'trap "" TERM; echo armed; exec sleep 600'], { stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn('sleep', ['600'], { stdio: 'ignore' });
  if (stubborn) {
    const said = /** @type {import('node:stream').Readable} */ (helper.stdout);
    await new Promise(resolve => said.once('data', resolve));
    said.destroy();
  }
  writeFileSync(join(fake, 'login.json'), JSON.stringify({ pid: process.pid, helper: helper.pid }));
  while (existsSync(join(fake, 'hold-login'))) await sleep(20);
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write('If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=synthetic-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=synthetic-challenge&code_challenge_method=S256&state=synthetic-state\nPaste code here if prompted > ');
  const signedIn = () => {
    writeFileSync(join(fake, 'auth.json'), JSON.stringify({ email: 'person-a@example.com', plan: 'max' }));
    process.stdout.write('Token: sk-ant-oat01-SYNTHETIC-TOKEN-0000\nLogin successful.\n');
    helper.kill();
    process.exit(0);
  };
  createInterface({ input: process.stdin }).on('line', line => {
    append('seen.jsonl', { code: line });
    process.stdout.write(`Received ${line}\n`);
    if (line === (readFileSync(join(fake, 'code'), { encoding: 'utf8', flag: 'a+' }).trim() || 'synthetic-code#synthetic-state')) return signedIn();
    process.stderr.write('Login failed: That code wasn\'t accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n');
    helper.kill();
    process.exit(1);
  });
  for (;;) {
    if (existsSync(join(fake, 'approve'))) {
      rmSync(join(fake, 'approve'), { force: true });
      signedIn();
    }
    await sleep(20);
  }
}

async function logout() {
  while (existsSync(join(fake, 'hold-logout'))) await sleep(20);
  rmSync(join(fake, 'auth.json'), { force: true });
  process.stdout.write('Successfully logged out from your Anthropic account.\n');
}

async function print() {
  const config = flag('--mcp-config');
  const model = flag('--model') ?? 'default';
  const resolved = MODELS.find(each => each.value === model)?.resolvedModel ?? model;
  /** @type {Awaited<ReturnType<typeof connectMcp>> | null} */
  let client = null;
  /** @type {string[]} */
  let tools = [];
  if (config !== undefined) {
    const server = JSON.parse(readFileSync(config, 'utf8')).mcpServers.lifestream;
    append('started.jsonl', { config_mode: (statSync(config).mode & 0o777).toString(8), prompt_mode: (statSync(String(flag('--system-prompt-file'))).mode & 0o777).toString(8) });
    client = await connectMcp(server);
    tools = (await client.listTools()).tools.map(tool => `mcp__lifestream__${tool.name}`);
  }
  let inited = false;
  let usage = 0;
  /** @param {string} text */
  const message = text => {
    say({ type: 'stream_event', event: { type: 'message_start', message: { model: resolved, role: 'assistant', content: [] } }, session_id: session });
    const half = Math.ceil(text.length / 2);
    for (const delta of [text.slice(0, half), text.slice(half)]) {
      if (delta !== '') say({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }, session_id: session });
    }
    say({ type: 'assistant', message: { model: resolved, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: session });
  };
  /** @param {{ tool: string, args: unknown }[]} calls */
  const called = async calls => {
    const uses = calls.map((call, at) => ({ type: 'tool_use', id: `toolu_${++usage}_${at}`, name: `mcp__lifestream__${call.tool}`, input: call.args }));
    say({ type: 'stream_event', event: { type: 'message_start', message: { model: resolved, role: 'assistant', content: [] } }, session_id: session });
    say({ type: 'assistant', message: { model: resolved, role: 'assistant', content: uses }, parent_tool_use_id: null, session_id: session });
    const results = await Promise.all(calls.map(async call => {
      const result = await /** @type {Awaited<ReturnType<typeof connectMcp>>} */ (client).callTool({ name: call.tool, arguments: /** @type {Record<string, unknown>} */ (call.args) });
      append('seen.jsonl', { answered: call.tool, result });
      return result;
    }));
    say({ type: 'user', message: { role: 'user', content: results.map((result, at) => ({ type: 'tool_result', tool_use_id: uses[at]?.id, content: result.content, is_error: result.isError === true })) }, session_id: session });
  };
  /** @param {Record<string, unknown>} fields */
  const result = fields => say({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, duration_ms: 1, num_turns: 1,
    session_id: session, total_cost_usd: 0, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800 },
    modelUsage: { [resolved]: { inputTokens: 1000, outputTokens: 200 } }, terminal_reason: 'completed', ...fields });

  /**
   * @param {string} text
   * @param {{ media_type: string, data: string }[]} images
   */
  const turn = async (text, images) => {
    if (!inited) {
      inited = true;
      say({ type: 'system', subtype: 'init', session_id: session, tools, mcp_servers: client === null ? [] : [{ name: 'lifestream', status: 'connected' }], model: resolved, permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: '2.1.321' });
    }
    if (json('auth.json') === null) {
      say({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', is_api_error_message: true, session_id: session });
      return result({ is_error: true, result: 'Not logged in · Please run /login', modelUsage: {}, terminal_reason: 'api_error' });
    }
    if (config === undefined) {
      append('seen.jsonl', { title: text, model, effort: flag('--effort') ?? null });
      const title = readFileSync(join(fake, 'title'), { encoding: 'utf8', flag: 'a+' }).trim() || 'A synthetic title';
      message(title);
      return result({ result: title });
    }
    append('seen.jsonl', { asked: text, model, effort: flag('--effort') ?? null, ...(images.length === 0 ? {} : { images }) });
    const n = Number(readFileSync(join(fake, 'turn-n'), { encoding: 'utf8', flag: 'a+' }) || '0');
    writeFileSync(join(fake, 'turn-n'), String(n + 1));
    const script = (json('turns.json') ?? [])[n] ?? [{ say: 'Nothing scripted.' }];
    let last = '';
    for (const step of script) {
      if (step.exit) process.exit(1);
      if (step.hold) await new Promise(() => undefined);
      while (step.waitFor !== undefined && !existsSync(join(fake, step.waitFor))) await sleep(20);
      if (step.say !== undefined) {
        last = String(step.say);
        message(last);
      }
      if (step.call !== undefined) await called([step.call]);
      if (step.calls !== undefined) await called(step.calls);
      if (step.limit !== undefined) {
        if (step.by !== 'status') say({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: step.limit, rateLimitType: 'five_hour' }, session_id: session });
        return result({ is_error: true, api_error_status: step.by === 'event' ? null : 429, result: 'Claude AI usage limit reached', terminal_reason: 'api_error' });
      }
      if (step.signedOut) {
        rmSync(join(fake, 'auth.json'), { force: true });
        say({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', is_api_error_message: true, session_id: session });
        return result({ is_error: true, result: 'Not logged in · Please run /login', modelUsage: {}, terminal_reason: 'api_error' });
      }
      if (step.fail !== undefined) return result({ is_error: true, result: String(step.fail), terminal_reason: 'api_error' });
    }
    say({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1_792_700_000, rateLimitType: 'seven_day' }, session_id: session });
    result({ result: last });
  };

  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  createInterface({ input: process.stdin }).on('line', line => {
    const said = JSON.parse(line);
    if (said.type === 'control_request' && said.request?.subtype === 'initialize') {
      if (existsSync(join(fake, 'models-broken'))) process.exit(1);
      if (existsSync(join(fake, 'models-held'))) return;
      say({ type: 'control_response', response: { subtype: 'success', request_id: said.request_id, response: { models: MODELS, account: { tokenSource: 'none', apiProvider: 'firstParty' } } } });
      return;
    }
    if (said.type !== 'user') return;
    /** @type {{ type: string, text?: string, source?: { media_type: string, data: string } }[]} */
    const parts = said.message.content;
    const text = parts.map(part => part.text ?? '').join('');
    const images = parts.flatMap(part => part.type === 'image' && part.source !== undefined ? [{ media_type: part.source.media_type, data: part.source.data }] : []);
    queue = queue.then(() => turn(text, images));
  });
  process.stdin.on('end', () => void queue.then(() => process.exit(0)));
}

if (args[0] === 'auth' && args[1] === 'status') void status();
else if (args[0] === 'auth' && args[1] === 'login') void login();
else if (args[0] === 'auth' && args[1] === 'logout') void logout();
else if (args[0] === '-p') void print();
else {
  process.stderr.write(`the fake claude has no ${args.join(' ')}\n`);
  process.exit(2);
}
