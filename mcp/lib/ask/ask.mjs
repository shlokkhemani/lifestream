// @ts-check
import { randomBytes } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ProviderDoc, watchEvents } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { z } from 'zod';
import { GONE } from '../door.mjs';
import { DoorRefusal, ToolError, argumentError } from '../errors.mjs';
import { HidingFailed, openWrapper } from '../hiding.mjs';
import { named } from '../pieces.mjs';
import { BUILDING, compactCatalog } from './catalog.mjs';
import { ASK_TOOLS, FAULT, fault, unfit } from '../tools.mjs';
import { agents } from './agents.mjs';
import { CHAT_ERASED, ERASED, modelsRead, openConversations, RESTARTED, serverCall, VOICE_TITLE } from './conversations.mjs';
import { openHandles } from './handles.mjs';
import { ClaudeError, NoClaude } from './claude.mjs';
import { CodexError, NoCodex } from './codex.mjs';
import { downloading } from './programs.mjs';
import { askedLine, askPrompt, EARLIER_PHOTO, photoLine, TITLE_PROMPT, titleAsk, VOICE_LINE, youLine } from './prompt.mjs';
import { doorModels, TOO_LITTLE, windowOf as rowWindow } from './reach.mjs';
import { askedOf, seenOf } from './seen.mjs';
import { openStarters } from './starters.mjs';
import { openTracer } from './trace.mjs';
import { textHead } from '../shape.mjs';

/**
 * @typedef {import('../door.mjs').Door} Door
 * @typedef {ReturnType<typeof import('../memory.mjs').openMemory>} Memory
 * @typedef {import('@earendil-works/pi-ai').Models} Models
 * @typedef {import('./reach.mjs').Row} Row
 * @typedef {{ value: string, name: string, account: string | null, chosen: boolean }} MenuRow
 * @typedef {{ default: MenuRow | null, rows: MenuRow[], local: { label: string, rows: MenuRow[] } | null, more: { words: string, use: string, work: string | null }, off: MenuRow | null }} ModelMenu
 * @typedef {{ connections: { id: string, kind: 'plan' | 'key' | 'runner' | 'address', name: string, line: string | null }[], uses: { chat: { value: string | null, thinking: string | null, fits: string[], menu: ModelMenu } }, models: Record<string, Row> }} ModelsRead
 * @typedef {'door' | 'claude' | 'codex'} WayName
 * @typedef {(row: Row) => { models: Models, model: Model }} Reach
 * @typedef {import('@earendil-works/pi-durable').AgentEvent} AgentEvent
 * @typedef {import('@earendil-works/pi-durable').SubmissionRecord} SubmissionRecord
 * @typedef {import('./conversations.mjs').Message} Message
 * @typedef {import('./conversations.mjs').Told} Told
 * @typedef {import('./conversations.mjs').Conversation} Conversation
 * @typedef {import('./conversations.mjs').Step} Step
 * @typedef {import('./agents.mjs').AccessChange} AccessChange
 * @typedef {Step & { failed: string, called?: string, gave?: string[], found?: number | string }} Taken
 * @typedef {ReturnType<typeof openHandles>} Handles
 * @typedef {Omit<ReturnType<typeof openConversations>, 'erase'>} Conversations
 * @typedef {{ input: number, output: number, cache_read: number }} Tokens
 * @typedef {{ type: 'chat', chat: string, n: number, level: string, audio?: string } | { type: 'step', call: number, name: string, words: string, said?: string } | { type: 'step', call: number, words: string, ms: number, error?: string } | { type: 'ref', handle: string, cited: import('./conversations.mjs').Cited } | { type: 'text', delta: string } | { type: 'waiting', words: string } | { type: 'words', words: string } | { type: 'done', message: Told } | { type: 'title', chat: string, title: string } | { type: 'error', error: Failure, message: string } | { type: 'access', change: AccessChange }} AskEvent
 * @typedef {Ended | 'erased'} Failure
 * @typedef {'login' | 'door' | 'model' | 'restart'} Ended
 * @typedef {ReturnType<typeof turnOf>} Turn
 * @typedef {{ refused: number, error: string }} Refused
 * @typedef {import('@earendil-works/pi-ai').ThinkingLevel} Thinking
 * @typedef {{ provider: string, modelId: string }} Model
 * @typedef {{ row: Row, way: WayName, modelId: string, name: string, thinking: string, value: string }} Picked
 * @typedef {{ read: ModelsRead, rows: Row[], fits: Row[], picked: Picked | null, gone: boolean, said: string | undefined, failure: Ended }} Chosen
 * @typedef {ReturnType<typeof import('./codex.mjs').openCodex>} Codex
 * @typedef {ReturnType<typeof import('./claude.mjs').openClaude>} Claude
 * @typedef {import('../home-clock.mjs').HomeClock} Home
 * @typedef {{ chat: string, level: string, epoch: number | null, turn: Turn, door: Door, home: Home, today: string, asked: string, question: string, images: Image[], messages: Earlier[], handles: Handles, wrapper: Wrapper, picked: Picked, steps: Taken[], tools: string }} Asking
 * @typedef {ReturnType<typeof openWrapper>} Wrapper
 * @typedef {Message & { images?: Image[] }} Earlier
 * @typedef {{ note: string, seconds: number } | { audio: string }} VoiceAsked
 * @typedef {{ ms: number, offset_min?: number, at?: [number, number] }} Shot
 * @typedef {{ words: string } | { writing: true } | { failed: string }} Words
 * @typedef {{ answered: Turn, question: string, at_ms: number }} Settled
 * @typedef {{ level: string, epoch: number | null, name: string }} Privacy
 * @typedef {{ end: 'done' | 'stopped' | 'failed', tokens: Tokens, model?: string, error?: { error: Ended, message: string } }} Answered
 * @typedef {{ answer: (asking: Asking) => Promise<Answered>, close: () => Promise<void>, alive: () => boolean }} Context
 * @typedef {{ open: (asking: Asking) => Promise<Context>, title: (asked: string, picked: Picked, signal: AbortSignal) => Promise<string | null>, said: (error: unknown) => string | null }} Way
 * @typedef {{ follow: ReturnType<typeof streamFollowing>, door: Door, handles: Handles, wrapper: Wrapper, signal: AbortSignal }} Bound
 * @typedef {Context & { readonly turn: Bound | null }} ClaudeContext
 * @typedef {{ context: Context, handles: Handles, wrapper: Wrapper, shown: string[], level: string, epoch: number | null, model: string, thinking: string, clock: string, day: string, at: number, idle?: number, timer?: NodeJS.Timeout }} Live
 * @typedef {{ data: string, mimeType: string }} Image
 * @typedef {{ text: string, images: Image[], error: boolean }} ToolAnswer
 * @typedef {Pick<Row, 'id' | 'name' | 'thinking' | 'state'> & { default: string, photos: boolean, photos_off: string | null, hides: boolean }} AskModel
 */

const MODELS_ROUTE = '/v1/models';
const ALONE = 'Answer alone, with the record\'s tools: never start, message or wait on other agents, never ask the person for input before you answer, and never edit files.';
const CATALOG_MS = 60 * 60_000;
const context = BACKGROUND_CONTEXT;
const CHAT = /^[0-9]{13}-[0-9a-f]{6}$/u;
const MAX_TITLE = 200;
const RANGED = /([ \t]*)\[(r[1-9][0-9]*(?:\s*(?:[-–—]|to)\s*r?[1-9][0-9]*)?(?:\s*,\s*r[1-9][0-9]*(?:\s*(?:[-–—]|to)\s*r?[1-9][0-9]*)?)*)\]/gu;
const PROVIDER_CITE = /[ \t]*\uE200[^\uE201]*\uE201/gu;
const RANGE = /^r([1-9][0-9]*)\s*(?:[-–—]|to)\s*r?([1-9][0-9]*)$/u;
const CITED = /\[(r[1-9][0-9]*(?:\s*,\s*r[1-9][0-9]*)*)\]/gu;
const CITING = /\[[r0-9 \t,\-–—to]*$/u;
const PROVIDER_CITING = /[ \t]*\uE200[^\uE201]*$/u;
const SPACES = /[ \t]+$/u;
const SENTENCE_END = /[.!?…]\s+/u;
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/gu;
const THINKING = 'medium';
const MOST_LIVE = 12;
const LIVE_MS = 60 * 60_000;
const LISTED_MS = 2_000;
const ENDED_CALL = 'The question this call was part of has ended: its answer is dropped.';
/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number | null} ms
 * @param {T} otherwise
 * @returns {Promise<T>}
 */
function within(promise, ms, otherwise) {
  if (ms === null) return promise;
  /** @type {NodeJS.Timeout | undefined} */
  let late;
  return Promise.race([promise, new Promise(done => { late = setTimeout(() => done(otherwise), ms); })]).finally(() => clearTimeout(late));
}

const TOOLKIT = [...ASK_TOOLS, agents].map(tool => {
  const schema = z.toJSONSchema(z.object(tool.inputSchema), { target: 'draft-7' });
  return { tool: /** @type {import('../hiding.mjs').Tool} */ (tool), schema, parameters: Type.Unsafe(schema) };
});
const IMAGES = /** @type {const} */ ({
  claude: { count: 100, tokens: 3_025 },
  codex: { count: 1_500, tokens: 2_765 },
  door: { count: 100, tokens: 3_025 },
});
export const LIMITS = /** @type {const} */ ({ photos: 10, photo_bytes: 26_214_400, voice_ms: 600_000 });
const WORDS_POLL_MS = 1_000;
const TAKEN_MAX = 1_000;
const ASK_CONNECTOR = 'ask';
const VOICE_MEMBER = 'llm.voice';
const NO_SPEECH = 'Your voice note had no words in it.';
const PHOTO_UNMADE = 'Lifestream couldn\'t prepare your photo for the model. Try again.';
/** @typedef {{ ready: boolean, words: string, line: string | null, caution: string | null, value: string, choices: { value: string, words: string, sent: boolean }[] }} Voice */
const UNREAD_VOICE = /** @type {const} */ ({ ready: true, words: '', line: null, caution: null, value: 'default', choices: [] });
class PhotoUnmade extends Error {}

const READS = 3;
const KEEP_TRIES = 3;
const NOT_KEPT = 'Lifestream couldn\'t keep this conversation\'s privacy level: ask again.';
const READY_POLL_MS = 2_000;
const LONGEST_PLACEHOLDER = 32;

/** @param {{ reach?: Reach, codex?: Codex, claude?: Claude, memory: Memory, machine: string, door: string, now?: () => number, liveMs?: number, listedMs?: number | null, putMs?: number, retryMs?: number, log: (line: Record<string, unknown>) => void, conversations?: Conversations, trace?: (trace: import('./trace.mjs').TurnTrace) => void, titles?: boolean, prompt?: typeof askPrompt }} options */
export function openAsk({ codex, claude, memory, machine, door: doorUrl, reach = row => doorModels(row, { door: doorUrl, machine }), now = Date.now, liveMs = LIVE_MS, listedMs = LISTED_MS, putMs, retryMs, log,
  conversations: given, trace, titles = true, prompt: promptOf = askPrompt }) {
  const conversations = given ?? openConversations({ machine, door: doorUrl, now, log, putMs, retryMs, onLetGo: (conversation, n) => {
    const running = conversation.running;
    if (n !== null) {
      if (running?.n !== n) return;
      running.unkept = true;
      running.stopping.abort();
      return;
    }
    running?.erase();
    if (conversation.live !== null) void dropLive(conversation, conversation.live);
  } });
  /** @type {Map<string, { at: number, text: Promise<string> }>} */
  const catalogs = new Map();
  /** @type {Map<string, Promise<Settled>>} */
  const claimed = new Map();
  /** @type {Map<string, number>} */
  const admissions = new Map();
  const starters = openStarters({ memory, any: door => conversations.any(door), now });
  const sandbox = new CodemodeSandbox();
  let closing = false;
  let idled = 0;
  /** @type {Map<string, ClaudeContext>} */
  const bindings = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const beginning = new Map();
  /** @type {Map<Wrapper, import('./trace.mjs').Tracer>} */
  const tracing = new Map();
  /** @type {WeakMap<Wrapper, string>} */
  const prompts = new WeakMap();
  /** @type {WeakMap<Wrapper, string>} */
  const chats = new WeakMap();
  /** @type {WeakMap<Wrapper, (change: AccessChange) => void>} */
  const changes = new WeakMap();

  /**
   * @param {Asking} asking
   * @param {{ catalog: string, you: string | null }} quoted
   */
  const promptFor = (asking, { catalog, you }) => {
    const text = promptOf(asking.home, catalog, you);
    if (trace !== undefined) {
      prompts.set(asking.wrapper, text);
      tracing.get(asking.wrapper)?.prompted(text);
    }
    return text;
  };

  /**
   * @param {Conversation} conversation
   * @param {Live} live
   */
  const holdLive = (conversation, live) => {
    clearTimeout(live.timer);
    live.idle = ++idled;
    conversation.live = live;
    live.timer = setTimeout(() => { if (conversation.live === live) void dropLive(conversation, live); }, liveMs);
    live.timer.unref();
    const idle = conversations.all().filter(each => each.live !== null).sort((left, right) => (left.live?.idle ?? 0) - (right.live?.idle ?? 0));
    for (const old of idle.slice(0, Math.max(0, idle.length - MOST_LIVE))) void dropLive(old, /** @type {Live} */ (old.live));
  };

  /**
   * @param {Conversation} conversation
   * @param {Live} live
   */
  const dropLive = async (conversation, live) => {
    if (conversation.live === live) conversation.live = null;
    clearTimeout(live.timer);
    await live.context.close().catch(() => undefined);
  };

  /** @param {Asking} asking */
  const catalogText = asking => {
    for (const [held, { at }] of catalogs) if (now() - at >= CATALOG_MS) catalogs.delete(held);
    const key = `${asking.chat} ${asking.level} ${asking.epoch}`;
    const kept = catalogs.get(key);
    if (kept !== undefined) return kept.text;
    const door = asking.door.forModel();
    const text = compactCatalog(args => asking.wrapper.route(door, '/v1/count', args));
    catalogs.set(key, { at: now(), text });
    text.then(said => { if (said === BUILDING) catalogs.delete(key); }, () => catalogs.delete(key));
    return text;
  };

  /**
   * @param {Asking} asking
   * @returns {Promise<{ catalog: string, you: string | null }>}
   */
  const homeQuoted = async asking => {
    const [catalog, you] = await Promise.all([catalogText(asking), youOf(asking.door)]);
    const given = you === null ? [] : [you.name, you.full, ...you.also];
    const sent = /** @type {string[]} */ (given.filter(each => each !== null));
    const back = await asking.wrapper.text(asking.door, sent.map(each => named(each, you?.id).pieces));
    const [name = null, full = null, ...also] = given.map(each => (each === null ? null : back.shift() ?? null));
    return { catalog, you: you === null ? null : youLine(name, full, /** @type {string[]} */ (also.filter(each => each !== null))) };
  };

  /**
   * @param {{ tool: (typeof TOOLKIT)[number]['tool'] }} entry
   * @param {unknown} args
   * @param {Door} door
   * @param {{ handles: Handles, wrapper: Wrapper }} veil
   * @param {() => boolean} [current]
   * @param {string} [via]
   */
  const runTool = async ({ tool }, args, door, { handles, wrapper }, current = () => true, via) => {
    const traced = trace === undefined ? undefined : tracing.get(wrapper)?.call(tool.name, args, via);
    let ran;
    /** @type {unknown} */
    let faulted;
    try {
      const misfit = unfit(tool, args);
      if (misfit !== null) throw argumentError(misfit);
      ran = await wrapper.run(tool, /** @type {Record<string, unknown>} */ (args ?? {}), {
        door: door.forModel(), seen: handles.seen, outbound: async link => { await door.post('/v1/outbound', { link }); },
        chat: chats.get(wrapper), changed: (/** @type {AccessChange} */ change) => changes.get(wrapper)?.(change),
        ...(traced === undefined ? {} : { restored: traced.restored }),
      }).catch(error => {
        if (!fault(tool.name, error, log)) throw error;
        faulted = error;
        return null;
      });
      if (!current()) throw new Error(ENDED_CALL);
    } catch (error) {
      traced?.failed(error);
      throw error;
    }
    if (ran === null) {
      traced?.failed(faulted);
      return { text: FAULT, images: [], found: undefined, gave: /** @type {string[]} */ ([]) };
    }
    traced?.answered(ran);
    const gave = handles.ran(ran);
    const called = windowCalled(tool.name, args, ran.span);
    return { text: ran.text, images: ran.images, found: ran.found, gave, ...(called === undefined ? {} : { called }) };
  };

  /**
   * @param {{ model?: string, thinking?: string }} asked
   * @param {Door} door
   */
  const asksOf = async (asked, door) => chosenOf(/** @type {ModelsRead} */ (await door.json(MODELS_ROUTE, asked.model === undefined ? {} : { chat: asked.model })), asked);

  /**
   * @param {Failure} error
   * @param {string} message
   */
  const alone = (error, message) => {
    const turn = turnOf('', 0, null, '');
    turn.send({ type: 'error', error, message });
    turn.end();
    return turn;
  };

  /**
   * @param {number} status
   * @param {string} message
   */
  const refusedTurn = (status, message) => alone(status === 503 ? 'restart' : 'door', message);

  /** @type {Way} */
  const throughDoor = {
    said: () => null,
    async open(asking) {
      const { chat, door, messages, picked } = asking;
      const veil = { handles: asking.handles, wrapper: asking.wrapper };
      const prompt = promptFor(asking, await homeQuoted(asking));
      let reading = door;
      const tools = TOOLKIT.map(({ tool, parameters }) => defineTool({
        name: tool.name,
        description: tool.description,
        parameters,
        execute: async (args, _api, call) => {
          const { text, images, found, gave, called } = await runTool({ tool }, args, call.abortSignal === undefined ? reading : reading.during(call.abortSignal), veil);
          return {
            output: [{ type: /** @type {const} */ ('text'), text }, ...images.map(image => ({ type: /** @type {const} */ ('image'), ...image }))],
            details: { gave, ...(found === undefined ? {} : { found }), ...(called === undefined ? {} : { called }) },
          };
        },
      }));
      const registry = createRegistry();
      registry.install(defineExtension({ name: 'lifestream', tools }));
      registry.install(createCodemodeExtension({ sandbox, models: false }));
      const { models, model } = reach(picked.row);
      const pi = await Harness.open(new MemoryStorage(), { models, registry, settings: { toolExecution: 'parallel', compaction: { enabled: false } } }, context);
      const api = models.getModel(model.provider, model.modelId)?.api ?? 'unknown';
      const conversation = await pi.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { model, thinkingLevel: /** @type {Thinking} */ (picked.thinking), instructions: prompt },
        init: async (tx, id) => {
          (await tx.doc(ProviderDoc, id)).sessionId = cacheKeyOf(chat);
          for (const message of messages) {
            if (message.role === 'user') await tx.appendEntry(id, { kind: 'ask.earlier', model: [{ role: 'user', content: piContent(message.text, message.images ?? []), timestamp: message.at_ms }] });
            else if (tracedText(message) !== '') await tx.appendEntry(id, { kind: 'ask.earlier', model: [earlierAnswer(message, api, { provider: model.provider, modelId: message.model ?? model.modelId })] });
          }
        },
      }, context);
      return {
        alive: () => true,
        close: () => pi.close(context),
        async answer(asking) {
          const { turn } = asking;
          reading = asking.door;
          const follow = following(turn, asking.steps, asking.handles, asking.today.slice(0, 4));
          const events = await watchEvents(pi, conversation.id, context);
          follow.begin(events.snapshot);
          events.start(async batch => follow.read(batch));
          /** @type {() => void} */
          let leave = () => undefined;
          const stopped = new Promise(done => { leave = () => done(null); });
          turn.stopping.signal.addEventListener('abort', leave, { once: true });
          /** @type {SubmissionRecord | null} */
          let settled = null;
          try {
            const submission = await conversation.submit({ type: 'input', content: piContent(sentOf(asking), asking.images) }, context);
            if (!turn.stopping.signal.aborted) settled = await Promise.race([follow.settled(submission.id), stopped]);
            if (settled === null) await conversation.abort(context);
          } finally {
            turn.stopping.signal.removeEventListener('abort', leave);
            await events.stop();
          }
          if (settled === null) return unfinished(follow);
          if (settled.status !== 'done') {
            const detail = typeof settled.detail === 'string' ? settled.detail : settled.reason ?? 'unanswered';
            log({ ask: 'model failed', detail: detail.slice(0, 300) });
            return unfinished(follow, { error: 'model', message: modelFailed(asking.picked.name, detail) });
          }
          const answerId = settled.answer;
          const entry = (await conversation.context(context)).entries.find(each => each.id === answerId);
          follow.finish(textOf(entry?.model?.[0]));
          return { end: 'done', tokens: follow.usage() };
        },
      };
    },
    async title(asked, picked, signal) {
      const { models, model } = reach(picked.row);
      const info = models.getModel(model.provider, model.modelId);
      if (info === undefined) return null;
      const reply = await models.completeSimple(info, { systemPrompt: TITLE_PROMPT, messages: [{ role: 'user', content: asked, timestamp: now() }] }, { signal });
      return reply.stopReason === 'error' || reply.stopReason === 'aborted' ? null : textOf(reply);
    },
  };

  /**
   * @param {Codex} client
   * @returns {Way}
   */
  const throughCodex = client => {
    return {
      said: error => error instanceof NoCodex ? downloading('chatgpt') : error instanceof CodexError ? CODEX_EXITED : null,
      async open(asking) {
        const { chat, messages, picked } = asking;
        const prompt = promptFor(asking, await homeQuoted(asking));
        const started = await client.request('thread/start', {
          model: picked.value, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
          baseInstructions: prompt, developerInstructions: ALONE,
          dynamicTools: TOOLKIT.map(({ tool, schema }) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: schema })),
        });
        const thread = String(started.thread.id);
        /** @type {import('./codex.mjs').Listener | null} */
        let listener = null;
        let gone = false;
        const unlisten = client.thread(thread, message => {
          if (message.method === 'codex/exited') gone = true;
          if (listener !== null) return listener(message);
          if (message.id !== undefined) throw new Error('No question is being answered.');
          const conversation = conversations.get(chat);
          if (gone && conversation?.live?.context === opened) void dropLive(conversation, conversation.live);
          return undefined;
        });
        /** @type {Context} */
        const opened = {
          alive: () => !gone,
          close: async () => {
            unlisten();
            if (!gone) await client.request('thread/unsubscribe', { threadId: thread }).catch(() => undefined);
          },
          async answer(asking) {
            const { turn } = asking;
            const follow = streamFollowing(turn, asking.steps, asking.handles, asking.today.slice(0, 4));
            /** @type {string | null} */
            let turnId = null;
            /** @type {(how: { status: string, error?: any }) => void} */
            let ended = () => undefined;
            const over = /** @type {Promise<{ status: string, error?: any }>} */ (new Promise(done => {
              let decided = false;
              ended = how => {
                if (decided) return;
                decided = true;
                listener = null;
                done(how);
              };
            }));
            let unreached = 0;
            let interrupting = false;
            const interrupt = () => {
              interrupting = true;
              if (turnId !== null) void client.request('turn/interrupt', { threadId: thread, turnId }).catch(() => undefined);
            };
            listener = message => {
              const params = message.params ?? {};
              switch (message.method) {
                case 'item/tool/call': return follow.call(String(params.tool ?? ''), params.arguments, async signal => {
                  const entry = TOOLKIT.find(each => each.tool.name === params.tool);
                  if (entry === undefined) throw new Error(`No tool ${params.tool}.`);
                  return runTool(entry, params.arguments, asking.door.during(signal), asking, undefined, typeof params.callId === 'string' ? params.callId : undefined);
                }).then(codexAnswer);
                case 'item/started':
                  if (params.item?.type === 'agentMessage') follow.message();
                  return undefined;
                case 'item/agentMessage/delta': return void follow.delta(String(params.delta ?? ''));
                case 'item/completed':
                  if (params.item?.type === 'agentMessage') follow.completed(String(params.item.text ?? ''));
                  return undefined;
                case 'thread/tokenUsage/updated': {
                  const last = params.tokenUsage?.last;
                  if (last !== undefined && last !== null) follow.used({ input: Number(last.inputTokens ?? 0), output: Number(last.outputTokens ?? 0), cache_read: Number(last.cachedInputTokens ?? 0) });
                  return undefined;
                }
                case 'warning':
                  log({ ask: 'codex warning', detail: String(params.message ?? '').slice(0, 300) });
                  if (CODE_MODE_OFF.test(String(params.message ?? ''))) {
                    ended({ status: 'toolless' });
                    interrupt();
                  }
                  return undefined;
                case 'error':
                  if (params.willRetry === true && unreachedOf(params.error) && ++unreached === 2) {
                    ended({ status: 'unreached' });
                    interrupt();
                  }
                  return undefined;
                case 'turn/completed': return void ended(params.turn ?? { status: 'failed' });
                case 'codex/exited': return void ended({ status: 'failed', error: { message: params.why, codexErrorInfo: 'exited' } });
                default: return undefined;
              }
            };
            const stopped = () => {
              ended({ status: 'stopped' });
              interrupt();
            };
            if (turn.stopping.signal.aborted) stopped();
            else turn.stopping.signal.addEventListener('abort', stopped, { once: true });
            let how;
            try {
              const begun = await client.request('turn/start', {
                threadId: thread, input: [{ type: 'text', text: sentOf(asking), text_elements: [] }, ...asking.images.map(image => ({ type: 'image', url: dataUrl(image) }))],
                model: asking.picked.value, effort: asking.picked.thinking,
              });
              turnId = String(begun.turn?.id ?? '');
              if (interrupting) interrupt();
              how = await over;
            } finally {
              turn.stopping.signal.removeEventListener('abort', stopped);
              listener = null;
              follow.end();
            }
            if (how.status === 'stopped') return unfinished(follow);
            if (how.status === 'unreached') return unfinished(follow, { error: 'model', message: UNREACHED_WORDS });
            if (how.status === 'toolless') return unfinished(follow, { error: 'model', message: TOOLLESS_WORDS });
            if (how.status !== 'completed') {
              const error = how.error ?? { message: `the turn ended ${how.status}` };
              log({ ask: 'model failed', detail: String(error.message ?? '').slice(0, 300), info: error.codexErrorInfo ?? null });
              if (!signedOutOf(error)) return unfinished(follow, { error: 'model', message: codexFailed(error) });
              await modelsRead(machine, doorUrl);
              return unfinished(follow, { error: 'login', message: signInLine(asking.picked.row) });
            }
            return { end: 'done', tokens: follow.usage() };
          },
        };
        const items = messages.flatMap(message => message.role === 'user'
          ? [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.text }, ...(message.images ?? []).map(image => ({ type: 'input_image', image_url: dataUrl(image) }))] }]
          : tracedText(message) === '' ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tracedText(message) }] }]);
        if (items.length > 0) await client.request('thread/inject_items', { threadId: thread, items });
        return opened;
      },
      async title(asked, picked, signal) {
        const modelId = picked.value;
        const started = await client.request('thread/start', { model: modelId, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: TITLE_PROMPT, developerInstructions: ALONE });
        const thread = String(started.thread.id);
        let text = '';
        /** @type {(status: string) => void} */
        let ended = () => undefined;
        const over = /** @type {Promise<string>} */ (new Promise(done => { ended = done; }));
        const unlisten = client.thread(thread, message => {
          if (message.id !== undefined) throw new Error('A title calls no tool.');
          if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') text = String(message.params.item.text ?? '');
          if (message.method === 'turn/completed') ended(String(message.params?.turn?.status));
          if (message.method === 'codex/exited') ended('failed');
        });
        try {
          const begun = await client.request('turn/start', { threadId: thread, input: [{ type: 'text', text: asked, text_elements: [] }], model: modelId, effort: 'low' });
          const leave = () => {
            void client.request('turn/interrupt', { threadId: thread, turnId: String(begun.turn?.id ?? '') }).catch(() => undefined);
            ended('interrupted');
          };
          if (signal.aborted) leave();
          signal.addEventListener('abort', leave, { once: true });
          const status = await over;
          signal.removeEventListener('abort', leave);
          return status === 'completed' ? text : null;
        } finally {
          unlisten();
          await client.request('thread/unsubscribe', { threadId: thread }).catch(() => undefined);
        }
      },
    };
  };

  /**
   * @param {Claude} client
   * @returns {Way}
   */
  const throughClaude = client => {
    return {
      said: error => error instanceof NoClaude ? downloading('claude') : error instanceof ClaudeError ? CLAUDE_EXITED : null,
      async open(asking) {
        const { chat, picked, tools } = asking;
        const prompt = promptFor(asking, await homeQuoted(asking));
        const bearer = randomBytes(32).toString('base64url');
        const process_ = client.conversation({ chat, model: picked.value, effort: picked.thinking === '' ? null : picked.thinking, prompt, tools, bearer, keyed: conversations.keyed() });
        /** @type {Bound | null} */
        let bound = null;
        let fresh = true;
        /** @type {Promise<void> | null} */
        let closed = null;
        const close = () => {
          if (closed === null) {
            bindings.delete(bearer);
            closed = process_.close();
          }
          return closed;
        };
        /** @type {ClaudeContext} */
        const opened = {
          get turn() {
            return bound;
          },
          alive: () => process_.alive,
          close,
          async answer(asking) {
            const { turn } = asking;
            const follow = streamFollowing(turn, asking.steps, asking.handles, asking.today.slice(0, 4));
            const question = fresh ? replayed(asking.messages, sentOf(asking)) : { text: sentOf(asking), images: [] };
            fresh = false;
            bound = { follow, door: asking.door, handles: asking.handles, wrapper: asking.wrapper, signal: turn.stopping.signal };
            const stop = () => void close();
            if (turn.stopping.signal.aborted) stop();
            else turn.stopping.signal.addEventListener('abort', stop, { once: true });
            try {
              const end = await process_.ask(question.text, { text: delta => follow.delta(delta), message: () => follow.message() }, [...question.images, ...asking.images]);
              if (end.status === 'stopped' || turn.stopping.signal.aborted) return unfinished(follow);
              if (end.status === 'failed') {
                log({ ask: 'model failed', maker: 'claude', detail: end.detail.slice(0, 300), limited: end.limited, auth: end.auth, exited: end.exited });
                if (end.auth) {
                  await modelsRead(machine, doorUrl);
                  return unfinished(follow, { error: 'login', message: signInLine(asking.picked.row) });
                }
                if (end.limited) {
                  const until = end.until_ms !== null && Number.isFinite(end.until_ms) && end.until_ms > now() ? end.until_ms : null;
                  return unfinished(follow, { error: 'model', message: usedUp(until, asking.home) });
                }
                return unfinished(follow, { error: 'model', message: end.exited ? CLAUDE_EXITED : UNREACHED.test(end.detail) ? CLAUDE_UNREACHED : `Claude didn't answer: ${end.detail}` });
              }
              follow.used(end.usage);
              follow.completed(end.text);
              return { end: 'done', model: end.model ?? asking.picked.value, tokens: follow.usage() };
            } finally {
              turn.stopping.signal.removeEventListener('abort', stop);
              bound = null;
              follow.end();
            }
          },
        };
        bindings.set(bearer, opened);
        void process_.ended.then(close);
        return opened;
      },
      async title(asked, picked, signal) {
        const effort = picked.row.thinking.includes('low') ? 'low' : null;
        return client.title({ system: TITLE_PROMPT, ask: asked, model: picked.value, effort, signal });
      },
    };
  };

  /** @type {Record<WayName, Way>} */
  const ways = { door: throughDoor, codex: throughCodex(/** @type {Codex} */ (codex)), claude: throughClaude(/** @type {Claude} */ (claude)) };

  /** @param {{ conversation: Conversation, turn: Turn, door: Door, home: Home, question: string, asked: Message, note: string | null, earlier: import('./conversations.mjs').Read | null, handles: Handles, wrapper: Wrapper, privacy: Privacy, started: number, release: () => void, picked: Picked, moved: string | null, session: Live | null, tools: string, tracer: import('./trace.mjs').Tracer | null }} given */
  const run = async ({ conversation, turn, door: asker, home, question, asked, note, earlier, handles, wrapper, privacy, started, release, picked, moved, session, tools, tracer }) => {
    const { chat, n } = turn;
    const door = asker.during(turn.stopping.signal);
    const answering = answerStart(turn, now);
    turn.send({ type: 'chat', chat, n, level: privacy.name, ...(asked.voice === undefined ? {} : { audio: asked.voice.audio }) });
    if (moved !== null) turn.send({ type: 'waiting', words: moved });
    const today = home.dayAt(now()).day;
    const voice = voiced(turn, {
      many: texts => wrapper.many(asker, texts),
      cited: async text => {
        const kept = await wrapper.words(asker, text);
        return { text: kept.text, refs: citedOf(kept.refs, kept.citations) };
      },
    }, handles, log);
    changes.set(wrapper, change => {
      turn.access.push(change);
      voice.turn.send({ type: 'access', change });
    });
    const messages = earlier?.messages ?? [];
    /** @type {Asking} */
    const asking = { chat, level: privacy.level, epoch: privacy.epoch, turn: voice.turn, door, home, today, asked: askedLine(asked.at_ms, home), question, images: [], messages, handles, wrapper, picked, steps: [], tools };
    const way = ways[picked.way];
    let live = session;
    const shown = session?.shown ?? [];
    conversation.shown = shown;
    /** @type {Answered | null} */
    let answered = null;
    let spoken = question;
    /** @type {{ asked: import('./seen.mjs').Span[] | null, pictures: (string | null)[] } | null} */
    let sent = null;
    try {
      const said = asked.voice === undefined ? { words: question } : await wordsOf(turn, conversation, door, asked.voice.audio, note);
      if ('failed' in said) answered = { end: said.failed === null ? 'stopped' : 'failed', tokens: { ...NO_TOKENS }, ...(said.failed === null ? {} : { error: said.failed }) };
      else {
        spoken = said.words;
        const photos = asked.photos ?? [];
        const [earlierTexts, facts] = await Promise.all([live === null ? earlierOf(conversation, messages, picked, door, photos.length, home) : null, photoFacts(photos)]);
        const pieces = questionPieces(said.words, asked.voice !== undefined, photos, photo => facts.get(photo), home.zone);
        const pictures = photos.map(photo => ({ picture: photo, tags: /** @type {const} */ (true) }));
        const hidden = await readAgain(wrapper, () => wrapper.pictured(door, [pieces, ...pictures, ...(earlierTexts?.texts ?? [])]));
        asking.question = typeof hidden.texts[0] === 'string' ? hidden.texts[0] : '';
        /** @type {(string | null)[]} */
        const drawn = [];
        asking.images = hidden.texts.slice(1, 1 + photos.length).map(made => {
          if (made === undefined || typeof made === 'string' || !('jpeg' in made)) throw new PhotoUnmade(typeof made === 'object' && made !== null && 'cannot' in made ? made.cannot : 'not made');
          drawn.push(made.drew ? made.jpeg : null);
          return { data: made.jpeg, mimeType: 'image/jpeg' };
        });
        sent = Array.isArray(hidden.spans) ? { asked: askedOf(pieces, said.words, asked.voice !== undefined, hidden.spans[0] ?? []), pictures: drawn } : null;
        if (earlierTexts !== null) {
          asking.messages = earlierTexts.rebuild(hidden.texts.slice(1 + photos.length));
          shown.splice(0, shown.length, ...asking.messages.flatMap(message => message.role === 'user' ? [message.text] : [tracedText(message)]));
        }
        for (const message of asking.messages) if (message.role === 'user') handles.heard(message.text);
        handles.heard(asking.question);
        shown.push(asking.question);
        live ??= { context: await way.open(asking), handles, wrapper, shown, level: levelOf(picked.row, privacy), epoch: privacy.epoch,
          model: picked.modelId, thinking: picked.thinking, clock: home.id, day: today, at: now() };
        answered = await live.context.answer(asking);
      }
    } catch (error) {
      if (error instanceof PhotoUnmade) log({ ask: 'a photo not made for the model', why: error.message });
      const said = error instanceof PhotoUnmade ? { error: /** @type {const} */ ('door'), message: PHOTO_UNMADE }
        : error instanceof ToolError ? { error: /** @type {const} */ ('door'), message: error.message } : { error: /** @type {const} */ ('model'), message: way.said(error) };
      if (said.message === null) throw error;
      answered = { end: 'failed', tokens: { ...NO_TOKENS }, error: { error: said.error, message: said.message } };
    } finally {
      if (live !== null) {
        const same = levelOf(picked.row, { level: levelKey(wrapper.level()) }) === live.level && wrapper.epoch() === live.epoch;
        if (answered?.end === 'done' && live.context.alive() && same && !conversation.erased) holdLive(conversation, { ...live, at: now() });
        else await dropLive(conversation, live);
      }
    }
    if (conversation.erased) return;
    /** @type {Answered} */
    const outcome = answered.end === 'stopped' && turn.restarting ? { ...answered, end: 'failed', error: { error: 'restart', message: RESTARTED } } : answered;

    await voice.flush();
    const at_ms = now();
    const written = voice.written();
    const kept = await restoredAnswer(written, wrapper, asker);
    const steps = await restoredSteps(asking.steps, wrapper, asker);
    const refs = voice.shown(citedOf(kept.refs, kept.citations));
    if (kept.marks.length > 0) conversation.marks.set(n, kept.marks.map(({ placeholder: _placeholder, ...mark }) => mark));
    /** @type {Answered} */
    const ended = turn.unkept ? { ...outcome, end: 'failed', error: { error: 'door', message: UNKEPT } } : outcome;
    const seen = ended.end === 'failed' || (ended.end === 'stopped' && kept.text === '') || sent === null ? null : recordOf({
      words: spoken, spoken: asked.voice !== undefined, asked: sent.asked, question: asking.question,
      answer: kept.text, answered: kept.marks.map(({ start, end, placeholder }) => ({ start, end, placeholder })), written, drawn: sent.pictures.map(picture => picture !== null),
    });
    /** @type {Message} */
    const reply = {
      type: 'ask.msg', chat, n, at_ms, role: 'assistant', text: kept.text, ...(seen === null ? {} : { seen }),
      ...(Object.keys(refs).length === 0 ? {} : { refs }), ...(steps.length === 0 ? {} : { steps }), ...(turn.access.length === 0 ? {} : { access: [...turn.access] }),
      model: picked.modelId, thinking: picked.thinking, ms: Math.round(at_ms - started),
      thought_ms: Math.round((answering() ?? at_ms) - started), end: ended.end,
      ...(ended.error === undefined ? {} : { error: ended.error.message, failed: ended.error.error }),
    };
    if (ended.error !== undefined) turn.send({ type: 'error', ...ended.error });
    tracer?.ended({
      question_hidden: asking.question, answered_model: ended.model ?? picked.modelId, end: ended.end, text: kept.text, written,
      tokens: ended.tokens, ...(ended.error === undefined ? {} : { error: ended.error.message, failed: ended.error.error }),
    });
    if (conversation.erased) return;
    const told = await conversations.finish(conversation, earlier?.title ?? (spoken === '' ? VOICE_TITLE : opening(spoken)), reply, seen === null ? [] : sent?.pictures ?? []);
    turn.send({ type: 'done', message: told });
    release();
    log({ ask: ended.end, ms: reply.ms, steps: steps.length, tokens: ended.tokens, ...(kept.unknown.length === 0 ? {} : { unknown: kept.unknown.length }) });
    if (titles && ended.end === 'done' && earlier === null) {
      const said = await titleOf(asking.question, written, turn.stopping.signal, picked);
      const title = said === null ? null : await wrapper.many(asker, [said]).then(([back]) => back ?? null, () => null);
      if (title !== null) {
        turn.send({ type: 'title', chat, title });
        conversations.retitle(conversation, title);
      }
    }
  };

  /**
   * @param {Omit<import('./seen.mjs').Turned, 'asked'> & { asked: import('./seen.mjs').Span[] | null }} turned
   * @returns {import('./seen.mjs').Seen | null}
   */
  const recordOf = ({ asked: spans, ...turned }) => {
    const built = spans === null ? { differs: /** @type {const} */ (true) } : seenOf({ ...turned, asked: spans });
    if ('seen' in built) return built.seen;
    log({ ask: 'seen differs' });
    return null;
  };

  /**
   * @param {string[]} photos
   * @returns {Promise<Map<string, Shot>>}
   */
  const photoFacts = async photos => {
    const asked = [...new Set(photos)];
    /** @type {Map<string, Shot>} */
    const facts = new Map();
    for (let at = 0; at < asked.length; at += TAKEN_MAX) {
      const answer = await serverCall(machine, doorUrl, 'POST', '/v1/ask/taken', { photos: asked.slice(at, at + TAKEN_MAX) });
      if (answer.status !== 200) throw new ToolError(typeof answer.body?.message === 'string' ? answer.body.message : 'Can\'t reach Lifestream.');
      for (const each of answer.body.photos ?? []) if (each.taken !== undefined) facts.set(each.file, each.taken);
    }
    return facts;
  };

  /**
   * @param {Conversation} conversation
   * @param {Message[]} messages
   * @param {Picked} picked
   * @param {Door} door
   * @param {number} current
   * @param {Home} home
   */
  const earlierOf = async (conversation, messages, picked, door, current, home) => {
    const bound = IMAGES[picked.way];
    const window = rowWindow(picked.row);
    let room = !picked.row.input.includes('image') ? 0 : Math.max(0, Math.min(bound.count, Math.floor(window / 4 / bound.tokens)) - current);
    /** @type {Set<string>} */
    const restated = new Set();
    for (const message of [...messages].reverse()) {
      if (message.role !== 'user') continue;
      (message.photos ?? []).forEach((_, at) => {
        if (room > 0) {
          restated.add(`${message.n} ${at}`);
          room--;
        }
      });
    }
    const [spokenWords, facts] = await Promise.all([
      Promise.all(messages.map(message => message.role === 'user' && message.voice !== undefined ? spokenOf(door, message) : null)),
      photoFacts(messages.flatMap(message => message.role === 'user' ? message.photos ?? [] : [])),
    ]);
    /** @type {unknown[]} */
    const texts = [];
    /** @param {string} text */
    const hide = text => texts.push([{ text, free: true }]) - 1;
    const places = messages.map((message, index) => {
      const marks = message.role === 'assistant' ? conversation.marks.get(message.n) : undefined;
      const spoken = spokenWords[index];
      const words = message.voice === undefined ? message.text : spoken !== null && spoken !== undefined && 'words' in spoken ? spoken.words : '';
      const text = texts.push(message.role === 'user' ? questionPieces(words, message.voice !== undefined, message.photos ?? [], photo => facts.get(photo), home.zone)
        : [{ text: words, free: true, ...(marks === undefined ? {} : { known: marks }) }]) - 1;
      const pictures = (message.photos ?? []).map((photo, at) => restated.has(`${message.n} ${at}`) ? texts.push({ picture: photo, tags: true }) - 1 : null);
      const steps = (message.steps ?? []).map(step => ({ words: hide(step.words), line: step.line === undefined ? undefined : hide(step.line) }));
      return { text, pictures, steps };
    });
    return {
      texts,
      /** @param {(string | { jpeg: string } | { cannot: string })[]} out @returns {Earlier[]} */
      rebuild: out => messages.map((message, at) => {
        const place = /** @type {(typeof places)[number]} */ (places[at]);
        /** @type {Image[]} */
        const images = [];
        let unshown = 0;
        for (const index of place.pictures) {
          const made = index === null ? undefined : out[index];
          if (made !== undefined && typeof made === 'object' && 'jpeg' in made) images.push({ data: made.jpeg, mimeType: 'image/jpeg' });
          else unshown++;
        }
        const said = typeof out[place.text] === 'string' ? /** @type {string} */ (out[place.text]) : '';
        /** @param {number} index */
        const back = index => { const words = out[index]; return typeof words === 'string' ? words : ''; };
        const text = [said, ...Array.from({ length: unshown }, () => EARLIER_PHOTO)].filter(each => each !== '').join('\n');
        return { ...message, text: message.role === 'user' ? `${askedLine(message.at_ms, home)}\n${text}` : text,
          ...(images.length === 0 ? {} : { images }),
          ...(message.steps === undefined ? {} : { steps: message.steps.map((step, index) => {
            const hidden = /** @type {{ words: number, line: number | undefined }} */ (place.steps[index]);
            return { ...step, words: back(hidden.words), ...(hidden.line === undefined ? {} : { line: back(hidden.line) }) };
          }) }) };
      }),
    };
  };

  /**
   * @param {Turn} turn
   * @param {Conversation} conversation
   * @param {Door} door
   * @param {string} audio
   * @param {string | null} note
   * @returns {Promise<{ words: string } | { failed: { error: Ended, message: string } | null }>}
   */
  const wordsOf = async (turn, conversation, door, audio, note) => {
    let said = '';
    for (;;) {
      if (turn.stopping.signal.aborted || conversation.erased) return { failed: null };
      const { status, body: answer } = await serverCall(machine, doorUrl, 'POST', '/v1/ask/words', { audio, ...(note === null ? {} : { note }) });
      if (turn.stopping.signal.aborted) continue;
      if (status === 503 && answer.code === 'OUTCOME_UNKNOWN' && answer.again === true) continue;
      if (status !== 200) {
        if (answer.code === CHAT_ERASED && await conversations.erasedNow(conversation.chat)) return { failed: null };
        return { failed: { error: 'door', message: typeof answer.message === 'string' ? answer.message : GONE } };
      }
      if (typeof answer.words === 'string') {
        if (answer.words.trim() === '[no speech]' || answer.words.trim() === '') return { failed: { error: 'model', message: NO_SPEECH } };
        conversation.words.set(audio, answer.words);
        turn.send({ type: 'words', words: answer.words });
        return { words: answer.words };
      }
      if (typeof answer.failed === 'string') return { failed: { error: 'model', message: /^Couldn't write out/u.test(answer.failed) ? answer.failed : `Couldn't write out your voice note: ${answer.failed}` } };
      if (typeof answer.waiting === 'string' && answer.waiting !== said) {
        said = answer.waiting;
        turn.send({ type: 'waiting', words: said });
      }
      await pause(WORDS_POLL_MS, turn.stopping.signal);
    }
  };

  /**
   * @param {Door} door
   * @param {Message} message
   * @returns {Promise<Words | null>}
   */
  const spokenOf = async (door, message) => {
    const audio = message.voice?.audio;
    if (audio === undefined) return null;
    const known = conversations.get(message.chat)?.words.get(audio);
    if (known !== undefined) return { words: known };
    const id = await conversations.sourceId(door).catch(() => null);
    if (id === null) return null;
    try {
      const record = await door.json('/v1/record', { source: id, kind: 'msg', key: `${message.chat}:${String(message.n).padStart(4, '0')}`, text: '1' });
      return wordsRead(record);
    } catch (error) {
      if (error instanceof ToolError) return null;
      throw error;
    }
  };

  /**
   * @param {string} chat
   * @param {Picked} picked
   * @param {number | null} epoch
   */
  const wrapperOf = (chat, picked, epoch) => {
    const wrapper = openWrapper({
      table: `chat:${chat}`, to: picked.modelId, agent: false, epoch,
      shown: () => conversations.get(chat)?.shown ?? [],
      showed: words => void conversations.get(chat)?.shown.push(words),
      ready: (line, door) => readyFor(chat, line, door),
    });
    chats.set(wrapper, chat);
    return wrapper;
  };

  /**
   * @param {string} chat
   * @param {string} line
   * @param {Door} door
   */
  const readyFor = async (chat, line, door) => {
    const conversation = conversations.get(chat);
    const turn = conversation?.running;
    let said = line;
    turn?.send({ type: 'waiting', words: said });
    for (let first = now() - (conversation?.readied ?? 0) >= READY_POLL_MS; ; first = false) {
      if (!first) await pause(READY_POLL_MS, turn?.stopping.signal);
      if (turn?.stopping.signal.aborted === true) throw new ToolError('Stopped: the person stopped this answer.');
      const state = await door.json('/v1/privacy');
      if (state.ready === true) {
        if (conversation !== undefined) conversation.readied = now();
        return;
      }
      if (typeof state.line === 'string' && state.line !== said) {
        said = state.line;
        turn?.send({ type: 'waiting', words: said });
      }
    }
  };

  /**
   * @param {string} question
   * @param {string} answer
   * @param {AbortSignal} signal
   * @param {Picked} picked
   */
  const titleOf = async (question, answer, signal, picked) => {
    const said = await ways[picked.way].title(titleAsk(question, answer), picked, signal).catch(() => null);
    if (said === null) return null;
    const title = textHead(said.replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/gu, '').replace(/\s+/gu, ' '), MAX_TITLE);
    return title === '' ? null : title;
  };

  /** @param {string} chat */
  const settling = chat => {
    const settled = claimed.get(chat);
    if (settled !== undefined && !conversations.get(chat)?.running) log({ ask: 'waits for a question to begin', chat });
    return settled;
  };

  /**
   * @param {Door} door
   * @param {string} id
   */
  const keptLevel = async (door, id) => {
    for (let tried = 1; tried <= KEEP_TRIES; tried += 1) {
      try {
        const kept = await door.post('/v1/privacy/keep', {});
        if (typeof kept?.level === 'string') return /** @type {string} */ (kept.level);
        log({ ask: 'level not kept', chat: id, tried, why: 'the door named no level' });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        log({ ask: 'level not kept', chat: id, tried, why: error.message });
      }
    }
    return null;
  };

  /** @type {Voice | null} */
  let lastVoice = null;

  /**
   * @param {Door} door
   * @returns {Promise<Voice>}
   */
  const voiceOf = async door => {
    const [connectors, privacy] = await Promise.all([serverCall(machine, doorUrl, 'GET', '/v1/connectors'), door.json('/v1/privacy')]);
    if (connectors.status !== 200) throw new ToolError(typeof connectors.body.message === 'string' ? connectors.body.message : GONE);
    const listed = connectors.body;
    const voice = voiceRow({ listed, privacy });
    lastVoice = voice;
    return voice;
  };

  /**
   * @param {Door} door
   * @param {import('./conversations.mjs').Read | null} read
   */
  const withWords = async (door, read) => {
    if (read === null) return null;
    const messages = await Promise.all(read.messages.map(async message => {
      if (message.role !== 'user' || message.voice === undefined) return message;
      const words = await spokenOf(door, message);
      return { ...message, voice: { ...message.voice, ...(words ?? { writing: true }) } };
    }));
    return { ...read, messages };
  };

  /**
   * @param {Door} door
   * @param {import('./conversations.mjs').Submitted} made
   * @returns {Promise<Turn | Refused>}
   */
  const replay = async (door, made) => {
    await memory.clock(door);
    if (made.state === 'erased') return alone('erased', ERASED);
    const running = conversations.get(made.chat)?.running;
    if (running !== undefined && running !== null && running.n === made.n) return running;
    const read = await conversations.read(door, made.chat);
    if ('absent' in read && read.absent === 'erased') return alone('erased', ERASED);
    const found = 'absent' in read ? null : read;
    const answer = found?.messages.find(message => message.n === made.n);
    if (answer === undefined) return { refused: 503, error: SAVING };
    const privacy = await serverCall(machine, doorUrl, 'GET', `/v1/privacy/chat/${made.chat}`);
    if (privacy.status !== 200) return refusedBy(privacy);
    const { level } = privacy.body;
    const turn = turnOf(made.chat, made.n, null, found?.title ?? '');
    const audio = found?.messages.find(message => message.n === made.n - 1)?.voice?.audio;
    turn.send({ type: 'chat', chat: made.chat, n: made.n, level: String(level), ...(audio === undefined ? {} : { audio }) });
    turn.send({ type: 'done', message: answer });
    turn.end();
    return turn;
  };

  /**
   * @param {string} note
   * @param {number} seconds
   * @returns {Promise<{ audio: string, ms: number } | Refused & { missing?: unknown }>}
   */
  const joined = async (note, seconds) => {
    const answer = await serverCall(machine, doorUrl, 'POST', `/v1/ask/notes/${note}/join`, { seconds });
    if (answer.status !== 200) {
      log({ ask: 'a note\'s join refused', status: answer.status, code: answer.body?.code ?? null });
      return refusedBy(answer);
    }
    return { audio: String(answer.body.audio), ms: Number(answer.body.ms) };
  };

  /**
   * @param {Door} door
   * @param {{ question: string, chat: string | undefined, id: string, tools: string, started: number, keep: boolean, photos: string[], voice?: VoiceAsked, submission: string, asked: { model?: string, thinking?: string }, resumed: { chat: string, question: Message } | null, hold: { begun: boolean } }} begun
   * @returns {Promise<Turn | { refused: number, error: string, missing?: unknown }>}
   */
  const begin = async (door, { question, chat, id, tools, started, keep, photos, voice, submission, asked, resumed, hold }) => {
    let chosen;
    try {
      chosen = await asksOf(asked, door);
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return alone('door', error.message);
    }
    const { picked, said, failure } = chosen;
    if (picked === null || picked.row.state !== 'ready') return alone(failure, said ?? NO_MODEL);
    const blind = photosOff(picked.row);
    if (photos.length > 0 && blind !== null) return alone('model', blind);
    const moved = said ?? null;
    if (chat !== undefined && resumed === null) conversations.landUnsealed(chat);
    let home;
    let placed;
    /** @type {import('./conversations.mjs').Read | null} */
    let earlier = null;
    /** @type {import('./conversations.mjs').Absent['absent']} */
    let absent = 'waiting';
    /** @type {Privacy} */
    let privacy;
    try {
      home = await memory.clock(door);
      placed = await conversations.knowsSource(door);
      if (chat !== undefined) {
        const read = await conversations.read(door, chat);
        if ('absent' in read) absent = read.absent;
        else earlier = read;
      }
      const state = await door.json(`/v1/privacy/chat/${id}`);
      privacy = { level: levelKey(state.level), epoch: typeof state.epoch === 'number' ? state.epoch : null, name: String(state.level) };
    } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      return alone('door', error.message);
    }
    if (!placed) return alone('door', 'Lifestream has no place for Chat\'s conversations yet: restart it on your Mac.');
    if (chat !== undefined && earlier === null) return refusedAbsent(chat, absent);
    if (resumed !== null && earlier !== null) earlier = resumed.question.n === 1 ? null : { ...earlier, messages: earlier.messages.filter(message => message.n < resumed.question.n) };
    if (keep) {
      const kept = await keptLevel(door, id);
      if (kept === null) return alone('door', NOT_KEPT);
      privacy = { ...privacy, level: levelKey(kept), name: kept };
    }
    if (closing) return { refused: 503, error: 'Chat is restarting: ask again in a moment.' };
    const messages = earlier?.messages ?? [];
    const n = resumed === null ? (messages.at(-1)?.n ?? 0) + 2 : resumed.question.n + 1;
    let begun;
    if (resumed !== null) begun = await conversations.resume(submission);
    else {
      const said = voice === undefined ? null : 'note' in voice ? await joined(voice.note, voice.seconds) : stated(messages, voice.audio);
      if (said !== null && 'refused' in said) return said;
      begun = await conversations.begin({
        title: earlier?.title ?? (voice === undefined ? opening(question) : VOICE_TITLE), chat: id, n: n - 1, submission,
        files: photos.length > 0 || said !== null,
        question: {
          type: 'ask.msg', chat: id, n: n - 1, at_ms: started, role: 'user', text: voice === undefined ? question : '',
          ...(photos.length === 0 ? {} : { photos }), ...(said === null ? {} : { voice: said }),
        },
      });
    }
    if ('erased' in begun) return refusedAbsent(id, 'erased');
    if ('unsaved' in begun) return { refused: 503, error: 'Chat couldn\'t keep your question on this Mac: its disk may be full. Ask again.' };
    if ('refused' in begun || 'unknown' in begun) {
      const { status, body } = 'refused' in begun ? begun.refused : begun.unknown;
      log({ ask: 'a question\'s seal refused', status, code: body?.code ?? null });
      if (status === 422) return alone('door', SEAL_REFUSED);
      return refusedBy({ status, body });
    }
    const { conversation, question: kept } = begun;
    const held = conversation.live ?? undefined;
    if (held !== undefined) {
      conversation.live = null;
      clearTimeout(held.timer);
    }
    const session = held !== undefined && held.context.alive() && held.model === picked.modelId && held.thinking === picked.thinking
      && held.clock === home.id && held.day === home.dayAt(now()).day && now() - held.at < LIVE_MS && held.level === levelOf(picked.row, privacy) && held.epoch === privacy.epoch ? held : null;
    if (held !== undefined && session === null) void dropLive(conversation, held);
    const handles = session?.handles ?? openHandles(Object.assign({}, ...messages.map(message => message.refs ?? {})));
    const wrapper = session?.wrapper ?? wrapperOf(id, picked, privacy.epoch);
    const turn = turnOf(id, n, kept, earlier?.title ?? (voice === undefined ? opening(question) : VOICE_TITLE));
    conversation.running = turn;
    hold.begun = true;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (conversation.running === turn) conversation.running = null;
      claimed.delete(id);
    };
    const note = voice !== undefined && 'note' in voice ? voice.note : null;
    const tracer = trace === undefined ? null : openTracer({ chat: id, n, connection: picked.row.connection, model: picked.modelId, thinking: picked.thinking,
      question, prompt: prompts.get(wrapper) });
    if (tracer !== null) {
      tracing.set(wrapper, tracer);
      turn.follow(event => { if (event !== null) tracer.event(event); });
    }
    run({ conversation, turn, door, home, question, asked: kept, note, earlier, handles, wrapper, privacy, started, release, picked, moved, session, tools, tracer })
      .catch(error => {
        log({ failed: error instanceof Error ? error.message : String(error) });
        tracer?.ended({ end: 'failed', error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        release();
        if (tracer !== null) {
          if (tracing.get(wrapper) === tracer) tracing.delete(wrapper);
          const traced = tracer.finish();
          if (traced !== null) {
            try {
              /** @type {NonNullable<typeof trace>} */ (trace)(traced);
            } catch (error) {
              log({ ask: 'trace not taken', why: error instanceof Error ? error.message : String(error) });
            }
          }
        }
        turn.end();
      });
    return turn;
  };
  return {
    /**
     * @param {Door} door
     * @param {{ model?: string, thinking?: string }} asked
     */
    async status(door, asked) {
      const [chosen, offered, voice] = await Promise.all([asksOf(asked, door),
        within(starters.read(door), listedMs, []), within(voiceOf(door).catch(error => {
          if (!(error instanceof ToolError)) throw error;
          return null;
        }), listedMs, null)]);
      const unsaved = conversations.unsavedIn();
      return {
        ...readyModels(chosen), starters: offered,
        voice: voice ?? lastVoice ?? UNREAD_VOICE, limits: LIMITS,
        ...(unsaved === null ? {} : { unsaved_in_ms: unsaved }),
      };
    },

    /**
     * @param {Door} door
     * @param {{ question: string, chat?: string, fresh?: string, keep?: boolean, model?: string, thinking?: string, tools: string, photos?: string[], voice?: VoiceAsked, submission: string }} asked
     * @returns {Promise<Turn | { refused: number, error: string, missing?: unknown }>}
     */
    async ask(door, { question, chat, fresh, keep = false, tools, photos = [], voice, submission, ...asked }) {
      if (closing) return { refused: 503, error: 'Chat is restarting: ask again in a moment.' };
      await beginning.get(submission)?.catch(() => undefined);
      const made = conversations.submitted(submission);
      const resumed = made?.state === 'pending' ? conversations.unsealed(submission) : null;
      if (made !== null && resumed === null) return replay(door, made);
      const started = now();
      const given = resumed?.chat ?? chat;
      if (given !== undefined && !CHAT.test(given)) return { refused: 404, error: `No conversation ${given}.` };
      const id = given ?? fresh ?? `${started}-${randomBytes(3).toString('hex')}`;
      if (claimed.has(id)) return { refused: 409, error: 'This conversation is still answering its last question: stop it, or wait for its answer.' };
      /** @type {(settled: Settled) => void} */
      let settle = () => undefined;
      claimed.set(id, new Promise(done => { settle = done; }));
      admissions.set(id, (admissions.get(id) ?? 0) + 1);
      const hold = { begun: false };
      /** @type {() => void} */
      let begun = () => undefined;
      beginning.set(submission, new Promise(done => { begun = () => done(undefined); }));
      /** @type {Turn | undefined} */
      let settled;
      try {
        const answered = await begin(door, { question, chat: given, id, tools, started, keep: keep && resumed === null, photos, voice, submission, asked, resumed, hold });
        settled = 'refused' in answered ? refusedTurn(answered.refused, answered.error) : answered;
        return answered;
      } catch (error) {
        settled = alone('door', error instanceof ToolError ? error.message : `The ask failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      } finally {
        if (!hold.begun) claimed.delete(id);
        settle({ answered: /** @type {Turn} */ (settled), question, at_ms: started });
        beginning.delete(submission);
        begun();
      }
    },


    /** @param {string} bearer */
    tooling(bearer) {
      const held = bindings.get(bearer);
      if (held === undefined) return null;
      const admitted = held.turn;
      const current = () => admitted !== null && !admitted.signal.aborted && held.turn === admitted && bindings.get(bearer) === held;
      return {
        list: () => TOOLKIT.map(({ tool, schema }) => ({ name: tool.name, description: tool.description, inputSchema: schema })),
        /**
         * @param {string} name
         * @param {unknown} args
         * @returns {Promise<ToolAnswer>}
         */
        async call(name, args) {
          const on = current() ? admitted : null;
          if (on === null) return { text: 'No question is being answered: this call is refused.', images: [], error: true };
          const entry = TOOLKIT.find(each => each.tool.name === name);
          if (entry === undefined) return { text: `No tool ${name}.`, images: [], error: true };
          const answer = await on.follow.call(name, args, signal => runTool(entry, args, on.door.during(signal), on, current));
          return current() ? answer : { text: ENDED_CALL, images: [], error: true };
        },
      };
    },

    /** @param {string} chat */
    stop(chat) {
      const turn = conversations.get(chat)?.running ?? undefined;
      turn?.stopping.abort();
      return turn !== undefined;
    },

    /**
     * @param {Door} door
     * @param {string} chat
     * @returns {Promise<Turn | null | Refused>}
     */
    async follow(door, chat) {
      const settled = await settling(chat);
      const turn = conversations.get(chat)?.running ?? settled?.answered;
      if (turn !== undefined && turn !== null) return turn;
      if (!CHAT.test(chat)) return refusedAbsent(chat, 'unknown');
      const read = await conversations.read(door, chat);
      return 'absent' in read ? refusedAbsent(chat, read.absent) : null;
    },

    /** @param {number} ms */
    async close(ms) {
      closing = true;
      const until = Date.now() + ms;
      const turns = conversations.all().flatMap(each => each.running === null ? [] : [each.running]);
      for (const turn of turns) {
        turn.restarting = true;
        turn.stopping.abort();
      }
      await Promise.race([Promise.all(turns.map(turn => turn.over)), new Promise(done => setTimeout(done, ms).unref())]);
      await Promise.all(conversations.all().flatMap(each => each.live === null ? [] : [dropLive(each, each.live)]));
      await Promise.all([codex?.close(), claude?.close()]);
      return conversations.settle(Math.max(0, until - Date.now()));
    },

    /** @param {Door} door */
    allowed: async door => void await memory.clock(door),

    /**
     * @param {Door} door
     * @param {string | undefined} after
     */
    list: (door, after) => conversations.list(door, after),

    /**
     * @param {Door} door
     * @param {string} chat
     */
    async read(door, chat) {
      if (!CHAT.test(chat)) return refusedAbsent(chat, 'unknown');
      let admission;
      let settled;
      let read;
      do {
        admission = admissions.get(chat);
        settled = await settling(chat);
        read = await conversations.read(door, chat);
      } while (settled !== undefined && admissions.get(chat) !== admission);
      const turn = conversations.get(chat)?.running ?? undefined;
      if ('absent' in read && (turn === undefined || read.absent === 'erased')) return refusedAbsent(chat, read.absent);
      const found = 'absent' in read ? null : await withWords(door, read);
      if (turn === undefined) return found === null ? null : refusedIn(found, settled);
      const kept = found?.messages ?? [];
      const asked = turn.asked !== null && !kept.some(message => message.n === turn.asked?.n) ? [turn.asked] : [];
      return { chat, title: found?.title ?? turn.title, messages: [...kept, ...asked], running: { n: turn.n } };
    },
  };
}

/**
 * @param {Turn} turn
 * @returns {{ error: Ended, message: string } | null}
 */
function refusalOf(turn) {
  if (turn.chat !== '') return null;
  /** @type {{ error: Ended, message: string } | null} */
  let refusal = null;
  turn.follow(event => {
    if (event?.type === 'error' && event.error !== 'erased') refusal = { error: event.error, message: event.message };
  });
  return refusal;
}

/**
 * @template {{ messages: Message[] }} T
 * @param {T} found
 * @param {Settled | undefined} settled
 * @returns {T}
 */
function refusedIn(found, settled) {
  const refusal = settled === undefined ? null : refusalOf(settled.answered);
  if (settled === undefined || refusal === null) return found;
  const chat = /** @type {{ chat?: string }} */ (found).chat ?? '';
  const n = (found.messages.at(-1)?.n ?? 0) + 1;
  /** @type {Message[]} */
  const said = [
    { type: 'ask.msg', chat, n, at_ms: settled.at_ms, role: 'user', text: settled.question },
    { type: 'ask.msg', chat, n: n + 1, at_ms: settled.at_ms, role: 'assistant', text: '', end: 'failed', error: refusal.message, failed: refusal.error },
  ];
  return { ...found, messages: [...found.messages, ...said] };
}

/**
 * @param {Pick<Turn, 'follow'>} turn
 * @param {() => number} now
 * @returns {() => number | null}
 */
export function answerStart(turn, now) {
  /** @type {number | null} */
  let at = null;
  turn.follow(event => {
    if (event?.type === 'step' && !('ms' in event)) at = null;
    else if (event?.type === 'text' && event.delta !== '') at ??= now();
  });
  return () => at;
}

/**
 * @param {string} chat
 * @param {number} n
 * @param {Message | null} asked
 * @param {string} title
 */
function turnOf(chat, n, asked, title) {
  /** @type {AskEvent[]} */
  const events = [];
  /** @type {Set<(event: AskEvent | null) => void>} */
  const listeners = new Set();
  let ended = false;
  let sealed = false;
  /** @type {() => void} */
  let over = () => undefined;
  const stopping = new AbortController();
  /** @param {AskEvent} event */
  const send = event => {
    if (sealed) return;
    events.push(event);
    for (const listener of listeners) listener(event);
  };
  return {
    chat,
    n,
    asked,
    title,
    stopping,
    restarting: false,
    unkept: false,
    /** @type {AccessChange[]} */
    access: [],
    /** @type {Promise<void>} */
    over: new Promise(done => { over = done; }),
    send,
    erase() {
      send({ type: 'error', error: 'erased', message: ERASED });
      sealed = true;
      ended = true;
      for (const listener of listeners) listener(null);
      listeners.clear();
      stopping.abort();
    },
    end() {
      ended = true;
      over();
      for (const listener of listeners) listener(null);
      listeners.clear();
    },
    /** @param {(event: AskEvent | null) => void} listener */
    follow(listener) {
      for (const event of events) listener(event);
      if (ended) {
        listener(null);
        return () => undefined;
      }
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const NO_MODEL = 'Chat needs a model: choose one in Settings › Default models.';
const NO_DEFAULT = 'Chat has no default model: choose one from the menu.';
const CHOOSE_MODEL = 'Choose a model';
const CONNECT_MODEL = 'Connect a model…';
const OPEN_MODELS = 'Open Providers';

/**
 * @param {Row} row
 * @returns {WayName | null}
 */
function wayOf(row) {
  if (row.chat === 'door') return 'door';
  if (row.chat !== 'program') return null;
  return row.connection === 'claude' || row.connection === 'codex' ? row.connection : null;
}

/** @param {Pick<Row, 'thinking'>} row */
const startOf = row => (row.thinking.includes(THINKING) ? THINKING : row.thinking[0] ?? '');

/**
 * @param {Pick<Row, 'thinking'>} row
 * @param {string | null | undefined} wanted
 */
const levelFor = (row, wanted) => (typeof wanted === 'string' && row.thinking.includes(wanted) ? wanted : startOf(row));

/**
 * @param {Row} row
 * @param {string} thinking
 * @returns {Picked}
 */
function pickedOf(row, thinking) {
  return { row, way: /** @type {WayName} */ (wayOf(row)), modelId: row.id, name: row.name, thinking, value: row.model };
}

/**
 * @param {ModelsRead} read
 * @param {{ model?: string, thinking?: string }} asked
 * @returns {Chosen}
 */
export function chosenOf(read, asked) {
  const chat = read.uses.chat;
  const fits = chat.fits.flatMap(id => {
    const row = read.models[id];
    return row !== undefined && wayOf(row) !== null ? [row] : [];
  });
  const listed = new Set([...chat.menu.rows, ...chat.menu.local?.rows ?? []].map(row => row.value));
  const rows = fits.filter(row => listed.has(row.id));
  const pick = asked.model === undefined ? undefined : fits.find(row => row.id === asked.model);
  const gone = asked.model !== undefined && pick === undefined;
  const chosen = pick ?? fits.find(row => row.id === chat.value);
  if (chosen === undefined) {
    const first = rows[0] ?? fits[0];
    if (first === undefined) return { read, rows, fits, picked: null, gone, said: NO_MODEL, failure: 'model' };
    if (first.state === 'ready') return { read, rows, fits, picked: null, gone, said: NO_DEFAULT, failure: 'model' };
    return { read, rows, fits, picked: null, gone, said: first.line ?? NO_MODEL, failure: failureOf(read, first) };
  }
  const picked = pickedOf(chosen, levelFor(chosen, pick === undefined ? chat.thinking : asked.thinking));
  const moved = gone ? `${read.models[/** @type {string} */ (asked.model)]?.name ?? asked.model} isn't offered now. Asking ${chosen.name}.` : undefined;
  return { read, rows, fits, picked, gone, said: chosen.state === 'ready' ? moved : chosen.line ?? NO_MODEL, failure: failureOf(read, chosen) };
}

/** @param {Chosen} chosen */
export function readyModels({ read, rows, fits, picked, said, gone }) {
  const kept = keptOf(rows.length > 0 ? rows : fits, picked);
  const told = said ?? kept.said;
  const act = actOf(read, picked?.row ?? rows[0] ?? fits[0]);
  const { value, thinking, menu } = read.uses.chat;
  const shown = fits.find(row => row.id === value)?.id ?? null;
  return {
    model: kept.model, name: kept.name, thinking: kept.thinking, login: kept.login,
    ...(told === undefined ? {} : { said: told }), ...(act === null ? {} : { act }), ...(gone ? { gone: true } : {}),
    models: fits.filter(row => rows.includes(row) || row.id === picked?.row.id || row.id === shown).map(askModelOf),
    menu,
    default: { model: value, thinking, shown, choose: shown === null && fits.length > 0 ? CHOOSE_MODEL : null },
  };
}

/**
 * @param {ModelsRead} read
 * @param {Row | undefined} row
 * @returns {Ended}
 */
function failureOf(read, row) {
  return read.connections.find(each => each.id === row?.connection)?.kind === 'plan' ? 'login' : 'model';
}

/** @param {Row} row */
const signInLine = row => row.line ?? `Chat needs your ${row.group} sign-in on your Mac.`;

/** @param {Pick<Row, 'name' | 'input'>} row */
const photosOff = row => (row.input.includes('image') ? null : `${row.name} can't see photos.`);

/**
 * @param {ModelsRead} read
 * @param {Row | undefined} row
 * @returns {string | null}
 */
function actOf(read, row) {
  if (row === undefined) return CONNECT_MODEL;
  if (row.state === 'ready') return null;
  const connection = read.connections.find(each => each.id === row.connection);
  return connection?.kind === 'plan' ? `Sign in with ${connection.name}…` : OPEN_MODELS;
}

/**
 * @param {Pick<Row, 'leaves'>} row
 * @param {Pick<Privacy, 'level'>} privacy
 */
export const levelOf = (row, privacy) => (hides(row) ? privacy.level : levelKey('none'));

/** @param {Pick<Row, 'leaves'>} row */
const hides = row => row.leaves !== null;

/**
 * @param {Row} row
 * @returns {AskModel}
 */
function askModelOf(row) {
  const { id, name, input, thinking, state } = row;
  return { id, name, thinking, state, default: startOf(row), photos: input.includes('image'), photos_off: photosOff(row), hides: hides(row) };
}

/**
 * @param {Row[]} rows
 * @param {Picked | null} picked
 * @returns {{ model: string, name: string, thinking: string, login: 'ready' | 'missing', said?: string }}
 */
export function keptOf(rows, picked) {
  const row = picked?.row ?? rows[0];
  if (row === undefined) return { model: '', name: '', thinking: '', login: 'missing', said: NO_MODEL };
  if (picked === null) return { model: row.id, name: row.name, thinking: row.thinking[0] ?? '', login: 'missing', said: row.state === 'ready' ? NO_DEFAULT : row.line ?? NO_MODEL };
  return { model: row.id, name: row.name, thinking: picked.thinking, ...(row.state === 'ready' ? { login: 'ready' } : { login: 'missing', said: row.line ?? NO_MODEL }) };
}

const CLAUDE_UNREACHED = 'Claude didn\'t answer: this Mac can\'t reach it. Check that it\'s online.';
const CLAUDE_EXITED = 'Claude didn\'t answer: Chat\'s Claude Code stopped. Ask again.';

/**
 * @param {number | null} until
 * @param {Home} home
 */
function usedUp(until, home) {
  if (until === null) return 'Claude didn\'t answer: your plan is used up for now.';
  const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: home.dayAt(until).zone }).format(until);
  return `Claude didn't answer: your plan is used up for now. It resets at ${at}.`;
}

/**
 * @param {Earlier[]} messages
 * @param {string} question
 * @returns {{ text: string, images: Image[] }}
 */
function replayed(messages, question) {
  /** @type {Image[]} */
  const images = [];
  const lines = messages.flatMap(message => {
    if (message.role !== 'user') return tracedText(message) === '' ? [] : [`Your answer: ${tracedText(message)}`];
    const from = images.length + 1;
    images.push(...message.images ?? []);
    const shown = images.length < from ? '' : ` [its photos: ${from === images.length ? `image ${from}` : `images ${from} to ${images.length}`}]`;
    return [`Question: ${message.text}${shown}`];
  });
  if (lines.length === 0) return { text: question, images };
  return { text: `[The conversation so far, which you answered before:]\n\n${lines.join('\n\n')}\n\n[The question now:]\n\n${question}`, images };
}

/**
 * @param {string} text
 * @param {Image[]} images
 */
function piContent(text, images) {
  return images.length === 0 ? text : [{ type: /** @type {const} */ ('text'), text }, ...images.map(image => ({ type: /** @type {const} */ ('image'), data: image.data, mimeType: image.mimeType }))];
}

/** @param {Image} image */
const dataUrl = image => `data:${image.mimeType};base64,${image.data}`;
const UNREACHED = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|connection.?(?:refused|error|lost)|socket hang up|network.?error/iu;
const NO_CREDIT = /^402\b|"code":\s*402\b|insufficient credits/iu;

/**
 * @param {string} name
 * @param {string} detail
 */
function modelFailed(name, detail) {
  if (detail === TOO_LITTLE) return `${name} ${TOO_LITTLE}.`;
  if (NO_CREDIT.test(detail)) return `${name} didn't answer: the account it runs on is out of credits. Add credits, then ask again.`;
  if (UNREACHED.test(detail)) return `${name} didn't answer: this Mac can't reach it. Check that it's online.`;
  return `${name} didn't answer: ${detail}`;
}

const NO_TOKENS = /** @type {const} */ ({ input: 0, output: 0, cache_read: 0 });

/**
 * @param {{ usage: () => Tokens }} follow
 * @param {{ error: Ended, message: string }} [error]
 * @returns {Answered}
 */
function unfinished(follow, error) {
  return { end: error === undefined ? 'stopped' : 'failed', tokens: follow.usage(), ...(error === undefined ? {} : { error }) };
}

/**
 * @param {Turn} turn
 * @param {Taken[]} steps
 * @param {Handles} handles
 * @param {string} year
 */
function following(turn, steps, handles, year) {
  /** @type {Map<string, number>} */
  const calls = new Map();
  /** @type {Map<number, SubmissionRecord>} */
  const ended = new Map();
  /** @type {Map<string, boolean>} */
  const scripts = new Map();
  /** @type {Map<number, (record: SubmissionRecord) => void>} */
  const waiting = new Map();
  /** @type {string[]} */
  let blocks = [];
  let streamed = '';
  /** @type {Tokens} */
  let before = { input: 0, output: 0, cache_read: 0 };
  /** @type {Tokens} */
  let after = before;

  /** @param {string} whole */
  const finish = whole => {
    if (whole.startsWith(streamed) && whole.length > streamed.length) turn.send({ type: 'text', delta: whole.slice(streamed.length) });
    streamed = whole;
  };

  /** @param {readonly { type: string, text?: string }[]} content */
  const textBlocks = content => content.map(block => block.type === 'text' ? block.text ?? '' : '');

  return {
    finish,
    /** @param {import('@earendil-works/pi-durable').SnapshotEvent} snapshot */
    begin(snapshot) {
      before = after = tokensOf(snapshot.usage);
    },
    /** @param {readonly AgentEvent[]} batch */
    read(batch) {
      for (const event of batch) {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          blocks = textBlocks(event.message.content);
          streamed = '';
          finish(blocks.join(''));
        } else if (event.type === 'message_update') {
          for (const change of event.changes) {
            if (change.type === 'message') blocks = textBlocks(change.message.content);
            else if (change.type === 'text_delta') blocks[change.contentIndex] = (blocks[change.contentIndex] ?? '') + change.delta;
            else if (change.type === 'text_start' || change.type === 'thinking_start' || change.type === 'toolcall_start' || change.type === 'block') {
              blocks[change.contentIndex] = change.block.type === 'text' ? change.block.text : '';
            }
          }
          finish(blocks.join(''));
        } else if (event.type === 'message_end') {
          const message = event.entry.model?.[0];
          if (message?.role === 'assistant') finish(textOf(message));
        } else if (event.type === 'tool_execution_start' && event.toolName === 'codemode' && event.parentToolCallId === undefined) {
          scripts.set(event.toolCallId, false);
        } else if (event.type === 'tool_execution_start') {
          const args = /** @type {Record<string, any>} */ (event.args ?? {});
          const { going, done, failed } = stepWords(event.toolName, args, handles, year);
          steps.push({ name: event.toolName, words: done, failed, ms: 0, called: calledOf(event.toolName, args) });
          calls.set(event.toolCallId, steps.length);
          turn.send({ type: 'step', call: steps.length, name: event.toolName, words: going });
        } else if (event.type === 'tool_execution_end') {
          const end = endOf(event);
          const failedInside = scripts.get(event.toolCallId);
          if (failedInside !== undefined) {
            scripts.delete(event.toolCallId);
            if (end.error === undefined || failedInside) continue;
            const { going, failed } = stepWords('codemode', {}, handles, year);
            steps.push({ name: 'codemode', words: failed, failed, ms: end.ms, error: end.error });
            turn.send({ type: 'step', call: steps.length, name: 'codemode', words: going });
            turn.send({ type: 'step', call: steps.length, words: failed, ms: end.ms, error: end.error });
            continue;
          }
          const parent = event.parentToolCallId;
          if (!calls.has(event.toolCallId) && parent !== undefined && scripts.has(parent)) {
            const { going, done, failed } = phrased(VERB.using, ` ${event.toolName}`);
            steps.push({ name: event.toolName, words: done, failed, ms: 0, called: event.toolName });
            calls.set(event.toolCallId, steps.length);
            turn.send({ type: 'step', call: steps.length, name: event.toolName, words: going });
          }
          const call = calls.get(event.toolCallId);
          const step = call === undefined ? undefined : steps[call - 1];
          if (call === undefined || step === undefined) continue;
          if (end.error !== undefined && event.parentToolCallId !== undefined && scripts.has(event.parentToolCallId)) scripts.set(event.parentToolCallId, true);
          if (end.found !== undefined) Object.assign(step, { words: foundWords(step.words, end.found), found: end.found });
          if (end.gave !== undefined) step.gave = end.gave;
          if (end.called !== undefined) step.called = end.called;
          step.ms = end.ms;
          if (end.error !== undefined) Object.assign(step, { words: step.failed, error: end.error });
          turn.send({ type: 'step', call, words: step.words, ms: step.ms, ...(step.error === undefined ? {} : { error: step.error }) });
        } else if (event.type === 'usage_changed') after = tokensOf(event.usage);
        else if (event.type === 'submission' && (event.record.status === 'done' || event.record.status === 'unanswered')) {
          ended.set(event.record.id, event.record);
          waiting.get(event.record.id)?.(event.record);
        }
      }
    },
    /**
     * @param {number} id
     * @returns {Promise<SubmissionRecord>}
     */
    settled(id) {
      const record = ended.get(id);
      return record !== undefined ? Promise.resolve(record) : new Promise(done => waiting.set(id, done));
    },
    /** @returns {Tokens} */
    usage: () => ({ input: after.input - before.input, output: after.output - before.output, cache_read: after.cache_read - before.cache_read }),
  };
}

const UNFINISHED = 'The tool did not finish.';

/**
 * @param {Extract<AgentEvent, { type: 'tool_execution_end' }>} event
 * @returns {{ ms: number, error?: string, found?: number | string, gave?: string[], called?: string }}
 */
function endOf(event) {
  const message = event.entry?.model?.[0];
  /** @type {{ isError: boolean, durationMs?: number, details?: any } | undefined} */
  let result;
  let said = '';
  if (message?.role === 'toolResult') {
    result = message;
    said = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  } else if (event.result !== undefined) {
    result = event.result;
    const errors = event.result.diagnostics.filter(each => each.severity === 'error').map(each => each.message);
    const output = event.result.structuredOutput;
    said = errors.length > 0 ? errors.join('\n') : typeof output === 'string' ? output : '';
  }
  const ms = typeof result?.durationMs === 'number' ? Math.round(result.durationMs) : 0;
  const found = result?.details?.found;
  const gave = result?.details?.gave;
  const called = result?.details?.called;
  return {
    ms,
    ...(result === undefined || result.isError ? { error: unwrapped(said) || UNFINISHED } : {}),
    ...(typeof found === 'number' || typeof found === 'string' ? { found } : {}),
    ...(Array.isArray(gave) ? { gave: gave.filter(handle => typeof handle === 'string') } : {}),
    ...(typeof called === 'string' ? { called } : {}),
  };
}

/**
 * @param {string} words
 * @param {number | string} found
 */
function foundWords(words, found) {
  return `${words}: ${typeof found === 'number' ? found.toLocaleString('en-US') : found} found`;
}

const CODEX_EXITED = 'ChatGPT didn\'t answer: Chat\'s Codex stopped. Ask again.';
const UNREACHED_WORDS = 'ChatGPT didn\'t answer: this Mac can\'t reach it. Check that it\'s online.';
const CODE_MODE_OFF = /\bcode mode is unavailable\b/iu;
const TOOLLESS_WORDS = 'Chat couldn\'t read your records: Codex couldn\'t start the script it reads them with. Install Lifestream again.';
const UNREACHED_INFO = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected'];

/**
 * @param {any} error
 * @returns {number | null}
 */
function statusOf(error) {
  const info = error?.codexErrorInfo;
  if (info === null || typeof info !== 'object') return null;
  const status = Object.values(info)[0]?.httpStatusCode;
  return typeof status === 'number' ? status : null;
}

/** @param {any} error */
function unreachedOf(error) {
  const info = error?.codexErrorInfo;
  return info !== null && typeof info === 'object' && UNREACHED_INFO.some(name => name in info) && statusOf(error) === null;
}

/** @param {any} error */
function signedOutOf(error) {
  return error?.codexErrorInfo === 'unauthorized' || statusOf(error) === 401;
}

/** @param {any} error */
function codexFailed(error) {
  const info = error?.codexErrorInfo;
  const message = String(error?.message ?? 'unanswered');
  if (info === 'usageLimitExceeded') {
    const again = /try again (at [^.]+?|in [^.]+?)\.?$/iu.exec(message);
    return `ChatGPT didn't answer: your plan is used up for now.${again === null ? '' : ` Try again ${again[1]}.`}`;
  }
  if (info === 'serverOverloaded' || info === 'rateLimitExceeded') return 'ChatGPT didn\'t answer: it is busy right now. Ask again in a moment.';
  if (info === 'exited') return CODEX_EXITED;
  if (unreachedOf(error)) return UNREACHED_WORDS;
  return `ChatGPT didn't answer: ${message}`;
}

/** @param {ToolAnswer} answer */
function codexAnswer({ text, images, error }) {
  return {
    contentItems: [{ type: 'inputText', text }, ...images.map(image => ({ type: 'inputImage', imageUrl: `data:${image.mimeType};base64,${image.data}` }))],
    success: !error,
  };
}

/**
 * @param {Turn} turn
 * @param {Taken[]} steps
 * @param {Handles} handles
 * @param {string} year
 */
function streamFollowing(turn, steps, handles, year) {
  let streamed = '';
  /** @type {Tokens} */
  const tokens = { input: 0, output: 0, cache_read: 0 };
  /** @type {Map<number, number>} */
  const open = new Map();

  /** @param {string} whole */
  const finish = whole => {
    if (whole.startsWith(streamed) && whole.length > streamed.length) turn.send({ type: 'text', delta: whole.slice(streamed.length) });
    streamed = whole;
  };

  return {
    usage: () => ({ ...tokens }),
    /** @param {Tokens} used */
    used(used) {
      tokens.input += used.input;
      tokens.output += used.output;
      tokens.cache_read += used.cache_read;
    },
    message() {
      streamed = '';
    },
    /** @param {string} delta */
    delta(delta) {
      if (delta === '') return;
      streamed += delta;
      turn.send({ type: 'text', delta });
    },
    /** @param {string} text */
    completed(text) {
      finish(text);
    },
    /**
     * @param {string} name
     * @param {unknown} args
     * @param {(signal: AbortSignal) => Promise<{ text: string, images: Image[], found?: number | string, gave?: string[], called?: string }>} run
     * @returns {Promise<ToolAnswer>}
     */
    async call(name, args, run) {
      const written = args !== null && typeof args === 'object' ? /** @type {Record<string, any>} */ (args) : {};
      const told = stepWords(name, written, handles, year);
      /** @type {Taken} */
      const step = { name, words: told.done, failed: told.failed, ms: 0, called: calledOf(name, written) };
      steps.push(step);
      const call = steps.length;
      turn.send({ type: 'step', call, name, words: told.going });
      const at = Date.now();
      open.set(call, at);
      /** @type {string | undefined} */
      let failure;
      /** @type {number | string | undefined} */
      let found;
      /** @type {string[] | undefined} */
      let gave;
      /** @type {string | undefined} */
      let windowed;
      /** @type {ToolAnswer} */
      let answer;
      try {
        const { text, images, found: count, gave: given, called } = await run(turn.stopping.signal);
        found = count;
        gave = given;
        windowed = called;
        answer = { text, images, error: false };
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        answer = { text: failure, images: [], error: true };
      }
      if (!open.delete(call)) return answer;
      if (found !== undefined) Object.assign(step, { words: foundWords(step.words, found), found });
      if (gave !== undefined) step.gave = gave;
      if (windowed !== undefined) step.called = windowed;
      step.ms = Date.now() - at;
      if (failure !== undefined) Object.assign(step, { words: step.failed, error: failure });
      turn.send({ type: 'step', call, words: step.words, ms: step.ms, ...(failure === undefined ? {} : { error: failure }) });
      return answer;
    },
    end() {
      for (const [call, at] of open) {
        const step = steps[call - 1];
        if (step === undefined) continue;
        step.ms = Date.now() - at;
        Object.assign(step, { words: step.failed, error: UNFINISHED });
        turn.send({ type: 'step', call, words: step.words, ms: step.ms, error: UNFINISHED });
      }
      open.clear();
    },
  };
}

/** @type {Record<'readingOn' | 'reading' | 'searching' | 'lookingUp' | 'counting' | 'opening' | 'saving' | 'proposing' | 'running' | 'using', [string, string, string]>} */
const VERB = {
  readingOn: ['Reading on', 'Read on', 'read on'], reading: ['Reading', 'Read', 'read'], searching: ['Searching', 'Searched', 'search'],
  lookingUp: ['Looking up', 'Looked up', 'look up'], counting: ['Counting', 'Counted', 'count'], opening: ['Opening', 'Opened', 'open'],
  saving: ['Saving', 'Saved', 'save'], proposing: ['Proposing', 'Proposed', 'propose'], running: ['Running', 'Ran', 'run'], using: ['Using', 'Used', 'use'],
};

/**
 * @param {[string, string, string]} verb
 * @param {string} rest
 */
const phrased = ([going, done, failed], rest) => ({ going: `${going}${rest}`, done: `${done}${rest}`, failed: `Couldn’t ${failed}${rest}` });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {Handles} handles
 * @param {string} [year]
 * @returns {{ going: string, done: string, failed: string }}
 */
function stepWords(name, args, handles, year) {
  /** @param {unknown} handle */
  const called = handle => (typeof handle === 'string' ? handles.name(handle) : undefined);
  /** @param {unknown} text */
  const when = text => {
    const match = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/u.exec(text) : null;
    if (match === null) return String(text ?? '');
    const [, made, month, day, clock] = match;
    return `${Number(day)} ${MONTHS[Number(month) - 1]}${made === year || year === undefined ? '' : ` ${made}`}${clock === undefined ? '' : `, ${clock}`}`;
  };
  /** @param {string} text */
  const quoted = text => `“${clip(text, 80)}”`;
  if (args.cursor !== undefined) return phrased(VERB.readingOn, ` (${name})`);
  switch (name) {
    case 'search': {
      const scope = [...args.families ?? [], ...args.products ?? []].join(', ') || 'everything';
      return phrased(VERB.searching, ` ${scope}${args.query ? ` for ${quoted(args.query)}` : ''}`);
    }
    case 'search_people': return phrased(VERB.lookingUp, args.name === undefined ? ` ${called(args.id) ?? 'a person'}` : ` ${args.name}`);
    case 'count': return args.of === undefined ? phrased(VERB.reading, ' what the record measures')
      : phrased(VERB.counting, ` ${args.of}${args.by === undefined ? '' : ` by ${[args.by].flat().join(' and ')}`}`);
    case 'read': {
      if (typeof args.link === 'string') {
        let host = 'a link';
        try {
          host = new URL(args.link).host;
        } catch {}
        return phrased(VERB.opening, ` ${host}`);
      }
      if (args.chat !== undefined) return phrased(VERB.reading, ` the chat with ${called(args.chat) ?? 'a chat'}${args.from === undefined ? '' : `, ${when(args.from)}`}`);
      if (args.ref === undefined) {
        const sameDay = typeof args.from === 'string' && typeof args.to === 'string' && args.from.slice(0, 10) === args.to.slice(0, 10) && /T\d\d:\d\d/u.test(args.to);
        const to = args.to === undefined || args.to === args.from ? '' : sameDay ? `–${args.to.slice(11, 16)}` : ` to ${when(args.to)}`;
        return phrased(VERB.reading, ` ${when(args.from)}${to}`);
      }
      const refs = [args.ref].flat();
      return phrased(VERB.reading, ` ${refs.length === 1 ? called(refs[0]) ?? 'a record' : `${refs.length} things`}`);
    }
    case 'feedback': return phrased(VERB.saving, ' a note about Lifestream');
    case 'agents': return args.access === undefined ? phrased(VERB.reading, ' your agents’ access') : phrased(VERB.proposing, ' a change to an agent’s access');
    case 'codemode': return phrased(VERB.running, ' a script');
    default: return phrased(VERB.using, ` ${name}`);
  }
}

const MOST_TRACED = 24;
const MOST_HANDLES = 12;
const MOST_ARGS = 400;
const MOST_REFUSED = 160;
const BARE = /^[\p{L}\p{N}_.:@+\/-]+$/u;
const LAST = /^([1-9][0-9]{0,3})([mh])$/u;
const OFFSET = /(?:Z|([+-])(\d{2}):(\d{2}))$/u;

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ from: string } | null} [span]
 */
export function calledOf(name, args, span = null) {
  /** @param {unknown} value @returns {string} */
  const said = value => {
    if (typeof value === 'string') return BARE.test(value) ? value : JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(said).join(', ')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key, each]) => `${key}: ${said(each)}`).join(', ')}}`;
    return String(value);
  };
  const written = said(span === null ? args : windowOf(args, span));
  return `${name} ${written.length > MOST_ARGS ? `${written.slice(0, MOST_ARGS)}…}` : written}`;
}

/**
 * @param {Record<string, unknown>} args
 * @param {{ from: string }} span
 * @returns {Record<string, unknown>}
 */
function windowOf(args, span) {
  const last = typeof args.last === 'string' ? LAST.exec(args.last) : null;
  const offset = OFFSET.exec(span.from);
  const from_ms = Date.parse(span.from);
  if (last === null || offset === null || Number.isNaN(from_ms)) return args;
  const offset_ms = offset[1] === undefined ? 0 : (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  const to_ms = from_ms + Number(last[1]) * (last[2] === 'h' ? 3_600_000 : 60_000);
  const to = `${new Date(to_ms + offset_ms).toISOString().slice(0, 16)}${offset[0]}`;
  const brief = args.detail === undefined && args.chat === undefined ? { detail: 'brief' } : {};
  return Object.fromEntries(Object.entries(args).flatMap(([key, value]) => Object.entries(key === 'last' ? { from: span.from, to, ...brief } : { [key]: value })));
}

/**
 * @param {string} name
 * @param {unknown} args
 * @param {import('../hiding.mjs').Span | undefined} span
 * @returns {string | undefined}
 */
function windowCalled(name, args, span) {
  if (name !== 'read' || args === null || typeof args !== 'object' || !('last' in args) || span === undefined) return undefined;
  return calledOf(name, /** @type {Record<string, unknown>} */ (args), span);
}

/** @param {Asking} asking */
function sentOf(asking) {
  return `${asking.asked}\n${asking.question}`;
}

/**
 * @param {Taken} step
 * @returns {string | undefined}
 */
export function callLine(step) {
  if (step.called === undefined) return undefined;
  const found = step.found === undefined ? '' : ` (${typeof step.found === 'number' ? step.found.toLocaleString('en-US') : step.found} found)`;
  if (step.error !== undefined) return `${step.called} → refused: ${clip(step.error.split('\n')[0] ?? '', MOST_REFUSED)}`;
  const gave = runsOf(step.gave ?? []);
  return `${step.called}${gave === '' && found === '' ? '' : ` →${gave === '' ? '' : ` ${gave}`}${found}`}`;
}

/** @param {Step[]} steps */
export function stepsLine(steps) {
  const lines = steps.flatMap(step => step.line === undefined ? [] : [step.line]);
  if (lines.length === 0) return '';
  const more = lines.length > MOST_TRACED ? `\n… ${lines.length - MOST_TRACED} more` : '';
  return `[Steps of this answer:\n${lines.slice(0, MOST_TRACED).join('\n')}${more}]`;
}

/** @param {string[]} handles */
function runsOf(handles) {
  /** @type {[number, number][]} */
  const runs = [];
  for (const handle of new Set(handles)) {
    const n = Number(handle.slice(1));
    const last = runs.at(-1);
    if (last !== undefined && n === last[1] + 1) last[1] = n;
    else runs.push([n, n]);
  }
  const shown = runs.slice(0, MOST_HANDLES).map(([from, to]) => from === to ? `r${from}` : `r${from}–r${to}`);
  const left = runs.slice(MOST_HANDLES).reduce((sum, [from, to]) => sum + to - from + 1, 0);
  return `${shown.join(', ')}${left === 0 ? '' : `, ${left} more`}`;
}

/** @param {Message} message */
function tracedText(message) {
  const steps = message.steps ?? [];
  const more = steps.length > MOST_TRACED ? `; … ${steps.length - MOST_TRACED} more` : '';
  const line = stepsLine(steps);
  const trace = line !== '' ? line : steps.length === 0 ? '' : `[Steps of this answer: ${steps.slice(0, MOST_TRACED).map(step => step.words).join('; ')}${more}]`;
  if (trace === '') return message.text;
  return message.text === '' ? trace : `${message.text}\n\n${trace}`;
}

/**
 * @param {Message} message
 * @param {string} api
 * @param {{ provider: string, modelId: string }} model
 * @returns {import('@earendil-works/pi-ai').AssistantMessage}
 */
function earlierAnswer(message, api, model) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    role: 'assistant', content: [{ type: 'text', text: tracedText(message) }], api: /** @type {any} */ (api), provider: model.provider, model: model.modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost }, stopReason: 'stop', timestamp: message.at_ms,
  };
}

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  const words = text.replace(/\s+/gu, ' ').trim();
  return words.length <= max ? words : `${textHead(words, max - 1).replace(/\s+\S*$/u, '')}…`;
}

/** @param {string} question */
function opening(question) {
  return clip(question, MAX_TITLE);
}

/**
 * @param {Door} door
 * @returns {Promise<{ id: string, name: string | null, full: string | null, also: string[] } | null>}
 */
async function youOf(door) {
  /** @type {any} */
  let you;
  try {
    you = (await door.json('/v1/people', { id: 'me' })).person;
  } catch (error) {
    if (error instanceof DoorRefusal && ((error.status === 404 && error.code === 'PERSON_UNKNOWN') || error.status === 503)) return null;
    throw error;
  }
  return {
    id: you.id, name: you.by === 'none' ? null : you.call_name, full: you.full_name,
    also: you.also_called.map((/** @type {{ name: string }} */ each) => each.name),
  };
}

/** @param {import('@earendil-works/pi-ai').Message | undefined} message */
function textOf(message) {
  if (message?.role !== 'assistant') return '';
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
}

/**
 * @param {import('@earendil-works/pi-durable').UsageState} usage
 * @returns {Tokens}
 */
function tokensOf(usage) {
  const all = Object.values(usage.models);
  return {
    input: all.reduce((sum, each) => sum + each.input, 0),
    output: all.reduce((sum, each) => sum + each.output, 0),
    cache_read: all.reduce((sum, each) => sum + each.cacheRead, 0),
  };
}

/** @param {string} text */
function unwrapped(text) {
  return text.replace(/^<harness>\s*(?:\[error\]\s*)?/u, '').replace(/\s*<\/harness>$/u, '').trim();
}

/** @param {string} chat */
function cacheKeyOf(chat) {
  return `lifestream-ask-${chat}`;
}

/**
 * @param {string} text
 * @param {Handles} handles
 */
export function spelledOut(text, handles) {
  return text.replace(RANGED, (whole, space, inside) => {
    const items = String(inside).split(/\s*,\s*/u);
    if (!items.some(item => RANGE.test(item))) return whole;
    const named = items.flatMap(item => {
      const [, from, to] = RANGE.exec(item) ?? [];
      return from === undefined ? [item] : handles.within(Number(from), Number(to));
    });
    const once = [...new Set(named)];
    return once.length === 0 ? '' : `${space}[${once.join(', ')}]`;
  });
}

/**
 * @param {{ handle: string, ref: unknown }[]} refs
 * @param {Record<string, import('./conversations.mjs').Citation> | undefined} citations
 * @returns {Record<string, import('./conversations.mjs').Cited>}
 */
export function citedOf(refs, citations) {
  return Object.fromEntries(refs.flatMap(({ handle, ref }) => (typeof ref === 'string' && ref !== ''
    ? [[handle, citations?.[handle] ?? { ref }]] : [])));
}

/** @param {unknown} level */
function levelKey(level) {
  return JSON.stringify(level ?? null);
}

/**
 * @template T
 * @param {Wrapper} wrapper
 * @param {() => Promise<T>} read
 * @returns {Promise<T>}
 */
async function readAgain(wrapper, read) {
  for (let tries = 1; ; tries++) {
    try {
      return await read();
    } catch (error) {
      if (!wrapper.erased(error) || tries === READS) throw wrapper.erased(error) ? new HidingFailed('Lifestream could not hide this question. Ask again in a moment.') : error;
    }
  }
}

/**
 * @param {string} written
 * @param {Wrapper} wrapper
 * @param {Door} door
 * @returns {Promise<import('../hiding.mjs').Restored>}
 */
async function restoredAnswer(written, wrapper, door) {
  if (written === '') return { text: '', marks: [], unknown: [], refs: [] };
  try {
    return await wrapper.words(door, written);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    return { text: written, marks: [], unknown: [], refs: [] };
  }
}

/**
 * @param {Taken[]} steps
 * @param {Wrapper} wrapper
 * @param {Door} door
 * @returns {Promise<Step[]>}
 */
async function restoredSteps(steps, wrapper, door) {
  const written = steps.map(step => ({ step, line: callLine(step) }));
  const texts = written.flatMap(({ step, line }) => [step.words, ...(step.error === undefined ? [] : [step.error]), ...(line === undefined ? [] : [line])]);
  let back = texts;
  try {
    back = await wrapper.many(door, texts);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
  }
  let at = 0;
  return written.map(({ step, line }) => {
    const words = back[at++] ?? step.words;
    const error = step.error === undefined ? undefined : back[at++] ?? step.error;
    return { name: step.name, words, ms: step.ms, ...(error === undefined ? {} : { error }), ...(line === undefined ? {} : { line: back[at++] ?? line }) };
  });
}

/**
 * @param {string} text
 * @returns {number}
 */
export function releasable(text) {
  const open = text.lastIndexOf('[[');
  if (open >= 0 && !text.includes(']]', open) && text.length - open <= LONGEST_PLACEHOLDER) return open;
  return Math.min(...[CITING, PROVIDER_CITING, SPACES].map(held => held.exec(text)?.index ?? text.length));
}

/**
 * @param {string} text
 * @returns {string}
 */
export function narrated(text) {
  const lines = text.replace(CITED, '').replace(/[*`_]/gu, '').split('\n').map(line => line.replace(/^\s*(?:#{1,6}|>|[-+]|\d{1,9}[.)])\s+/u, '').trim());
  const line = lines.filter(Boolean).at(-1) ?? '';
  return (line.split(SENTENCE_END).at(-1) ?? '').trim().replace(/[.:…\s]+$/u, '');
}

/**
 * @param {Turn} turn
 * @param {{ many: (texts: string[]) => Promise<string[]>, cited: (text: string) => Promise<{ text: string, refs: Record<string, import('./conversations.mjs').Cited> }> }} restore
 * @param {Handles} handles
 * @param {(line: Record<string, unknown>) => void} log
 */
export function voiced(turn, restore, handles, log) {
  /** @type {AskEvent[]} */
  const queue = [];
  let arrived = '';
  let pending = '';
  let written = '';
  /** @type {Promise<void>} */
  let pumping = Promise.resolve();
  let running = false;
  /** @type {Set<string>} */
  const described = new Set();
  /** @type {Map<string, import('./conversations.mjs').Cited>} */
  const sent = new Map();

  /** @param {unknown} error */
  const why = error => (error instanceof Error ? error.message : String(error));
  /** @param {string[]} texts */
  const back = texts => restore.many(texts).catch(error => {
    log({ ask: 'words not put back', why: why(error) });
    return texts;
  });
  /**
   * @param {string} text
   * @returns {Promise<string>}
   */
  const cite = async text => {
    const fresh = [...new Set([...text.matchAll(CITED)].flatMap(([, list]) => String(list).split(/\s*,\s*/u)))].filter(handle => !described.has(handle));
    if (fresh.length === 0) return /** @type {string} */ ((await back([text]))[0]);
    const said = await restore.cited(text).catch(error => {
      log({ ask: 'citations not told early', why: why(error) });
      return null;
    });
    if (said === null) return /** @type {string} */ ((await back([text]))[0]);
    for (const handle of fresh) described.add(handle);
    for (const [handle, cited] of Object.entries(said.refs)) {
      if (sent.has(handle)) continue;
      sent.set(handle, cited);
      turn.send({ type: 'ref', handle, cited });
    }
    return said.text;
  };
  /** @param {string} text */
  const canonical = text => spelledOut(text.replace(PROVIDER_CITE, ''), handles);
  /** @param {string} text */
  const say = async text => {
    if (text === '') return;
    written += text;
    turn.send({ type: 'text', delta: await cite(text) });
  };
  /** @param {string} text */
  const heard = async text => {
    if (text === '') return;
    pending += text;
    const open = [...pending.matchAll(PARAGRAPH_BREAK)].at(-1);
    if (open === undefined) return;
    const begins = open.index + open[0].length;
    const out = pending.slice(0, begins);
    pending = pending.slice(begins);
    await say(out);
  };
  const pump = async () => {
    running = true;
    while (queue.length > 0) {
      const event = /** @type {AskEvent} */ (queue.shift());
      if (event.type === 'text') {
        arrived += event.delta;
        while (queue[0]?.type === 'text') arrived += /** @type {{ delta: string }} */ (queue.shift()).delta;
        const at = releasable(arrived);
        const out = arrived.slice(0, at);
        arrived = arrived.slice(at);
        await heard(canonical(out));
        continue;
      }
      if (event.type === 'step' && !('ms' in event)) {
        await heard(canonical(arrived));
        arrived = '';
        const narration = pending;
        pending = '';
        const [words = event.words, said = ''] = await back([event.words, ...(narration === '' ? [] : [narration])]);
        const phrase = narrated(said);
        turn.send({ ...event, words, ...(phrase === '' ? {} : { said: phrase }) });
        continue;
      }
      await heard(canonical(arrived));
      arrived = '';
      if (event.type === 'step') {
        const texts = [event.words, ...('error' in event && event.error !== undefined ? [event.error] : [])];
        const [words = event.words, error] = await back(texts);
        turn.send({ ...event, words, ...(error === undefined ? {} : { error }) });
      } else turn.send(event);
    }
    running = false;
  };
  /** @param {AskEvent} event */
  const push = event => {
    queue.push(event);
    if (!running) pumping = pumping.then(pump);
  };
  return {
    turn: { ...turn, send: (/** @type {AskEvent} */ event) => push(event) },
    async flush() {
      await pumping;
      await heard(canonical(arrived));
      arrived = '';
      const out = pending;
      pending = '';
      await say(out);
    },
    written: () => written,
    /**
     * @param {Record<string, import('./conversations.mjs').Cited>} refs
     * @returns {Record<string, import('./conversations.mjs').Cited>}
     */
    shown: refs => Object.fromEntries(Object.entries(refs).map(([handle, cited]) => {
      const early = sent.get(handle);
      return [handle, early !== undefined && 'kind' in early ? early : cited];
    })),
  };
}

/**
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 */
function pause(ms, signal) {
  return new Promise(done => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      done(undefined);
    }, { once: true });
  });
}

/**
 * @param {any} record
 * @returns {Words}
 */
function wordsRead(record) {
  const text = record?.text?.text;
  if (typeof text === 'string' && text !== '') return { words: text };
  const made = record?.transcribed;
  if (made?.state === 'done') return { failed: NO_SPEECH };
  if (made?.state === 'failed') return { failed: typeof made.line === 'string' ? made.line : 'Couldn\'t write out this voice note' };
  return { writing: true };
}

const SAVING = 'Chat is still saving this answer: ask again in a moment.';
const NOT_YET = 'Chat is still saving this conversation: ask again in a moment.';
const UNKEPT = 'Lifestream couldn\'t keep this question. Ask it again.';
const SEAL_REFUSED = 'Lifestream couldn\'t take this question. Try again.';

/**
 * @param {Message[]} messages
 * @param {string} audio
 * @returns {{ audio: string, ms: number } | Refused & { missing: unknown }}
 */
function stated(messages, audio) {
  const voice = messages.find(message => message.voice?.audio === audio)?.voice;
  return voice === undefined ? { refused: 409, error: 'This voice note isn\'t in Lifestream any more.', missing: { audio: [audio] } } : { audio, ms: voice.ms };
}

/**
 * @param {{ status: number, body: any }} answer
 * @returns {Refused & { missing?: unknown }}
 */
function refusedBy({ status, body }) {
  const words = typeof body?.message === 'string' ? body.message : 'Lifestream couldn\'t keep this question\'s files.';
  if (status === 409 && body?.missing !== undefined) return { refused: 409, error: words, missing: body.missing };
  if (status === 422) return { refused: 422, error: words };
  return { refused: 503, error: status === 0 ? 'Can\'t reach Lifestream.' : words };
}

/**
 * @param {string} chat
 * @param {import('./conversations.mjs').Absent['absent']} absent
 * @returns {Refused}
 */
const refusedAbsent = (chat, absent) => absent === 'erased' ? { refused: 410, error: 'erased' }
  : absent === 'waiting' ? { refused: 503, error: NOT_YET } : { refused: 404, error: `No conversation ${chat}.` };

/**
 * @param {{ listed: any, privacy: any }} reads
 * @returns {Voice}
 */
export function voiceRow({ listed, privacy }) {
  const member = (listed.connectors ?? []).find((/** @type {{ id: string }} */ each) => each.id === ASK_CONNECTOR)?.members
    ?.find((/** @type {{ key: string }} */ each) => each.key === VOICE_MEMBER);
  /** @type {ModelMenu | null | undefined} */
  const menu = member?.menu;
  const choiceOf = (/** @type {boolean} */ sent) => (/** @type {MenuRow} */ row) =>
    ({ value: row.value, words: row.account === null ? row.name : `${row.name} · ${row.account}`, sent });
  const choices = [...(menu?.rows ?? []).map(choiceOf(true)), ...(menu?.local?.rows ?? []).map(choiceOf(false))];
  const value = typeof member?.value === 'string' ? member.value : 'default';
  const route = typeof member?.route === 'string' ? member.route : null;
  const said = typeof member?.words === 'string' ? member.words : '';
  const hiding = !(privacy.chat === 'none' || (Array.isArray(privacy.chat) && privacy.chat.length === 0) || privacy.chat == null);
  const leaves = privacy.voice.leaves;
  return {
    ready: route !== null, words: choices.find(each => each.value === route)?.words ?? said,
    line: route !== null ? null : typeof member?.line === 'string' ? member.line : null,
    caution: typeof leaves === 'string' && hiding ? `Voice notes go to ${leaves} as they are: sound can't be hidden.` : null,
    value, choices,
  };
}

/**
 * @param {string} words
 * @param {boolean} spoken
 * @param {string[]} photos
 * @param {(photo: string) => Shot | undefined} takenOf
 * @param {string} zone
 * @returns {import('../pieces.mjs').Piece[]}
 */
function questionPieces(words, spoken, photos, takenOf, zone) {
  /** @type {any[]} */
  const pieces = spoken ? [{ text: `${VOICE_LINE}\n\n`, free: true }, { text: words, free: true }] : [{ text: words, free: true }];
  photos.forEach((photo, at) => {
    const line = photoLine(at + 1, takenOf(photo), zone);
    if (line === null) return;
    pieces.push({ text: `\n${line.before}`, free: true });
    if (line.place !== null) pieces.push({ text: line.place, is: 'place' }, { text: line.after, free: true });
  });
  return pieces.filter(piece => piece.text !== '');
}
