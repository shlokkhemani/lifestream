// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

export const DOOR_PROVIDER = 'lifestream';
export const UNSTATED_WINDOW = 32_000;
export const LEFT_OUT = 'left out to fit this model';
export const TOO_LITTLE = 'holds too little text for this';
const MAX_ANSWER = 16_384;
const SAFETY = 4_096;
const LEVELS = /** @type {const} */ (['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** @type {import('@earendil-works/pi-ai').OpenAICompletionsCompat} */
const COMPAT = {
  supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, supportsUsageInStreaming: true, supportsFinishReason: true,
  maxTokensField: 'max_tokens', requiresToolResultName: false, requiresAssistantAfterToolResult: false, requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false, thinkingFormat: 'openai', openRouterRouting: {}, vercelGatewayRouting: {}, chatTemplateKwargs: {},
  chatTemplateArgs: {}, zaiToolStream: false, supportsThinkingTokenBudget: false, supportsStrictMode: false, supportsOpenAIGrammarTools: false,
  supportsMidConvoSystemMessages: false, supportsMidConvoToolAdditions: false, sendSessionAffinityHeaders: false, sessionAffinityFormat: 'openai',
  supportsLongCacheRetention: false,
};

/**
 * @typedef {{ id: string, connection: string, model: string, name: string, input: string[], tools: boolean, thinking: string[], context_tokens: number | null,
 *   chat: 'door' | 'program' | null, group: string, leaves: string | null, state: 'ready' | 'waiting' | 'unavailable', line: string | null }} Row
 * @typedef {import('@earendil-works/pi-ai').Message} Message
 */

/** @param {Pick<Row, 'context_tokens'>} row */
export const windowOf = row => row.context_tokens ?? UNSTATED_WINDOW;

/** @param {number} window */
export const answerRoom = window => Math.min(MAX_ANSWER, Math.floor(window / 4));

/** @param {unknown} value */
const sizeOf = value => Math.ceil(JSON.stringify(value ?? '').length / 4);

/**
 * @param {readonly Message[]} messages
 * @param {number} window
 * @returns {Message[]}
 */
export function fitted(messages, window) {
  const kept = [...messages];
  const sizes = kept.map(sizeOf);
  const total = () => sizes.reduce((sum, size) => sum + size, 0);
  const newest = kept.findLastIndex(message => message.role === 'user');
  const always = kept.reduce((sum, message, at) => sum + (message.role === 'system' || at >= newest ? /** @type {number} */ (sizes[at]) : 0), 0);
  if (always > window) throw new RangeError(TOO_LITTLE);
  for (let at = 0; at < newest && total() > window; at++) {
    const message = /** @type {Message} */ (kept[at]);
    if (message.role !== 'toolResult') continue;
    kept[at] = { ...message, content: [{ type: 'text', text: LEFT_OUT }] };
    sizes[at] = sizeOf(kept[at]);
  }
  while (total() > window) {
    const first = kept.findIndex(message => message.role === 'user');
    const next = kept.findIndex((message, at) => at > first && message.role === 'user');
    if (next < 0) break;
    const turn = kept.map((message, at) => at < next && message.role !== 'system');
    for (let at = kept.length - 1; at >= 0; at--) {
      if (!turn[at]) continue;
      kept.splice(at, 1);
      sizes.splice(at, 1);
    }
  }
  return kept;
}

/**
 * @template {(model: any, context: any, options?: any) => import('@earendil-works/pi-ai').AssistantMessageEventStream} Stream
 * @param {Stream} ask
 * @param {number} window
 * @returns {Stream}
 */
function budgeted(ask, window) {
  return /** @type {Stream} */ ((model, context, options) => {
    let messages;
    try {
      messages = fitted(context.messages, window - answerRoom(window) - sizeOf(context.tools) - SAFETY);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const refused = createAssistantMessageEventStream();
      refused.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'error', errorMessage: TOO_LITTLE, timestamp: Date.now() } });
      refused.end();
      return refused;
    }
    return ask(model, { ...context, messages }, options);
  });
}

/**
 * @param {Row} row
 * @param {{ door: string, machine: string }} at
 * @returns {{ models: import('@earendil-works/pi-ai').Models, model: { provider: string, modelId: string } }}
 */
export function doorModels(row, { door, machine }) {
  const window = windowOf(row);
  const api = openAICompletionsApi();
  const models = createModels();
  models.setProvider(createProvider({
    id: DOOR_PROVIDER, name: 'Lifestream', baseUrl: `${door}/v1`,
    auth: { apiKey: { name: 'Chat\'s pass', resolve: async () => ({ auth: { apiKey: readFileSync(join(machine, 'ask', 'door-token'), 'utf8').trim() }, source: 'Chat\'s pass' }) } },
    models: [{
      id: row.id, name: row.name, api: 'openai-completions', provider: DOOR_PROVIDER, baseUrl: `${door}/v1`,
      input: row.input.includes('image') ? ['text', 'image'] : ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      reasoning: row.thinking.length > 0, thinkingLevelMap: Object.fromEntries(LEVELS.map(level => [level, row.thinking.includes(level) ? level : null])),
      contextWindow: window, maxTokens: answerRoom(window), compat: COMPAT,
    }],
    api: { stream: budgeted(api.stream, window), streamSimple: budgeted(api.streamSimple, window) },
  }));
  return { models, model: { provider: DOOR_PROVIDER, modelId: row.id } };
}
