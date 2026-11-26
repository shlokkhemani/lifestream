// @ts-check
import { createServer } from 'node:http';
import { createModels, fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createHandler } from '../../server.mjs';

const faux = fauxProvider({ models: [{ id: 'faux-1', reasoning: true }] });
faux.setResponses([process.env.ASK_HOLD === '1' ? () => new Promise(() => undefined) : fauxAssistantMessage(process.env.ASK_ANSWER ?? '')]);
const models = createModels();
models.setProvider(faux.provider);
const base = Number(process.env.ASK_NOW_MS);
const began = Date.now();
const handler = createHandler({
  door: String(process.env.ASK_DOOR),
  ask: { reach: () => ({ models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }), machine: String(process.env.ASK_MACHINE), now: () => base + Date.now() - began },
  log: () => undefined,
});
const server = createServer(handler);
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}` })}\n`);
});
