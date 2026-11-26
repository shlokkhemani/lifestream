// @ts-check
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/**
 * @typedef {{ n: number, tool: string, via?: string, args: unknown, restored?: unknown, answer?: string, images?: number, chars?: number, start_ms: number, end_ms?: number, ms?: number, error?: string }} TracedCall
 * @typedef {{ ms: number, type: string, call?: number, name?: string, words?: string, said?: string, error?: string, message?: string }} TracedEvent
 * @typedef {{ chat: string, n: number, connection: string, model: string, answered_model?: string, thinking: string, question: string, question_hidden?: string, prompt?: string, prompt_sha256?: string, first_step_ms: number | null, first_text_ms: number | null, first_answer_ms: number | null, total_ms: number, end: string, error?: string, failed?: string, text: string, written?: string, tokens?: { input: number, output: number, cache_read: number }, calls: TracedCall[], events: TracedEvent[] }} TurnTrace
 */

/** @param {string} text */
export const sha256 = text => createHash('sha256').update(text).digest('hex');

/** @param {{ chat: string, n: number, connection: string, model: string, thinking: string, question: string, prompt?: string }} turn */
export function openTracer({ chat, n, connection, model, thinking, question, prompt }) {
  const begun = performance.now();
  const at = () => Math.round(performance.now() - begun);
  /** @type {TracedCall[]} */
  const calls = [];
  /** @type {TracedEvent[]} */
  const events = [];
  /** @type {number | null} */
  let firstStep = null;
  /** @type {number | null} */
  let firstText = null;
  /** @type {number | null} */
  let answerAt = null;
  let system = prompt;
  /** @type {Partial<TurnTrace>} */
  let ended = {};
  let finished = false;

  return {
    /** @param {string} text */
    prompted(text) {
      system = text;
    },
    prompt: () => system,
    /** @param {import('./ask.mjs').AskEvent} event */
    event(event) {
      const ms = at();
      if (event.type === 'text') {
        firstText ??= ms;
        answerAt ??= ms;
        return;
      }
      if (event.type === 'step' && 'name' in event) {
        firstStep ??= ms;
        if (event.said !== undefined) firstText ??= ms;
        answerAt = null;
        events.push({ ms, type: 'step', call: event.call, name: event.name, words: event.words, ...(event.said === undefined ? {} : { said: event.said }) });
      } else if (event.type === 'step') {
        events.push({ ms, type: 'step_end', call: event.call, words: event.words, ...(event.error === undefined ? {} : { error: event.error }) });
      } else if (event.type === 'waiting') events.push({ ms, type: 'waiting', words: event.words });
      else if (event.type === 'error') events.push({ ms, type: 'error', error: event.error, message: event.message });
      else if (event.type === 'done') events.push({ ms, type: 'done' });
    },
    /**
     * @param {string} tool
     * @param {unknown} args
     * @param {string} [via]
     */
    call(tool, args, via) {
      /** @type {TracedCall} */
      const call = { n: calls.length + 1, tool, ...(via === undefined ? {} : { via }), args: copy(args), start_ms: at() };
      calls.push(call);
      const end = () => {
        call.end_ms = at();
        call.ms = call.end_ms - call.start_ms;
      };
      return {
        /** @param {unknown} back */
        restored: (/** @type {unknown} */ back) => { call.restored = copy(back); },
        /** @param {{ text: string, images: unknown[] }} ran */
        answered(ran) {
          end();
          call.answer = ran.text;
          call.images = ran.images.length;
          call.chars = ran.text.length;
        },
        /** @param {unknown} error */
        failed(error) {
          end();
          const said = error instanceof Error ? error.message : String(error);
          call.error = said;
          call.answer = said;
          call.chars = said.length;
        },
      };
    },
    /** @param {Partial<TurnTrace>} kept */
    ended(kept) {
      ended = { ...ended, ...kept };
    },
    /** @returns {TurnTrace | null} */
    finish() {
      if (finished) return null;
      finished = true;
      return {
        chat, n, connection, model, thinking, question,
        ...(system === undefined ? {} : { prompt: system, prompt_sha256: sha256(system) }),
        first_step_ms: firstStep, first_text_ms: firstText, first_answer_ms: answerAt,
        total_ms: at(), end: 'failed', text: '',
        ...ended,
        calls, events,
      };
    },
  };
}

/** @param {unknown} value */
function copy(value) {
  try {
    return structuredClone(value);
  } catch {
    return String(value);
  }
}

/** @typedef {ReturnType<typeof openTracer>} Tracer */
