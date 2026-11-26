// @ts-check
/** @import { Route } from './router.mjs' */
/** @import { Door } from '../door.mjs' */
import { NO_TOKEN } from '../door.mjs';
import { statusError } from '../errors.mjs';
import { fromPage, readBody } from '../http.mjs';
import { reply } from './router.mjs';

const ACTS = new Set(['try', 'skip', 'let-go', 'read', 'ignore', 'dismiss']);

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function jsonBody(req) {
  try {
    return JSON.parse(await readBody(req, 4_096, 'That act is too long.'));
  } catch (error) {
    if (/** @type {{ status?: number }} */ (error).status) throw error;
    return null;
  }
}

/**
 * @param {Door | null} door
 * @returns {Route[]}
 */
export function connectorRoutes(door) {
  return [{
    method: 'GET', path: '/api/start/cost',
    handle: async () => {
      if (!door) throw statusError(NO_TOKEN, 503);
      const { position: _position, ...cost } = /** @type {Record<string, unknown>} */ (await door.json('/v1/start/cost'));
      return reply(cost);
    },
  }, {
    method: 'GET', path: '/api/processing/range',
    handle: async ({ url }) => {
      if (!door) throw statusError(NO_TOKEN, 503);
      const { position: _position, ...step } = /** @type {Record<string, unknown>} */ (await door.json('/v1/processing/range',
        { connector: url.searchParams.get('connector') ?? '', value: url.searchParams.get('value') ?? '' }));
      return reply(step);
    },
  }, {
    method: 'POST', path: '/api/refresh',
    handle: async ({ req }) => {
      if (!fromPage(req, { json: true })) return reply({ error: 'Refresh now is pressed on the page.' }, 403);
      const body = await jsonBody(req);
      if (typeof body?.connector !== 'string' || !body.connector) return reply({ error: 'Invalid act.' }, 400);
      if (!door) throw statusError(NO_TOKEN, 503);
      const answer = await door.act('/v1/refresh', JSON.stringify({ connector: body.connector }));
      if (answer.status !== 200) throw statusError('Lifestream did not take that act.', 502);
      return reply(JSON.parse(answer.text));
    },
  }, {
    method: 'POST', path: '/api/act',
    handle: async ({ req }) => {
      if (!fromPage(req, { json: true })) return reply({ error: 'An act is pressed on the page.' }, 403);
      const body = await jsonBody(req);
      /** @param {unknown} value */
      const named = value => typeof value === 'string' && value.trim() !== '';
      const choose = body?.do === 'choose';
      if (typeof body?.need !== 'string' || !body.need || !(ACTS.has(body.do) || choose)
        || (body.of !== undefined && (choose || !named(body.of)))
        || body.product !== undefined || (choose ? !named(body.account) : body.account !== undefined)) {
        return reply({ error: 'Invalid act.' }, 400);
      }
      if (!door) throw statusError(NO_TOKEN, 503);
      const act = choose
        ? { need: body.need, do: 'choose', account: body.account.trim() }
        : { need: body.need, do: body.do, ...body.of === undefined ? {} : { of: body.of } };
      const answer = await door.act('/v1/act', JSON.stringify(act));
      if (answer.status !== 200) throw statusError('Lifestream did not take that act.', 502);
      return reply(JSON.parse(answer.text));
    },
  }];
}
