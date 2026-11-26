// @ts-check
/** @import { FinishItem } from './kit/finish-card.js' */
/** @import { Seen } from './flows/model.js' */
import { accountsIn, browserOf, extensionOn, modelOf, phoneOf, sessionOf } from './flows/model.js';
import { SETTINGS_PROVIDERS } from './connectors/settings.js';

export const FINISH_HIDDEN = 'finish.hidden';

export const ACCOUNTS = 'Add more connectors';

/**
 * @param {Seen} seen
 * @param {boolean} asked
 * @param {boolean} [agent]
 * @returns {FinishItem[]}
 */
export function finishItems(seen, asked, agent = false) {
  const accounts = accountsIn(seen);
  const unset = accounts.find(each => !each.set_up) ?? accounts[0];
  const browser = browserOf(seen, sessionOf(true, 'dialog')).name;
  return [
    { id: 'ask', title: 'Ask your first question', done: asked, href: '#view=ask', flow: '' },
    { id: 'iphone', title: 'Connect your iPhone', done: phoneOf(seen).paired, href: '', flow: 'phone' },
    { id: 'browser', title: `Add Lifestream to ${browser}`, done: extensionOn(seen.report), href: '', flow: 'browser' },
    ...unset ? [{ id: 'accounts', title: ACCOUNTS, done: accounts.some(each => each.set_up),
      href: `#dialog=${encodeURIComponent(unset.id)}`, flow: '' }] : [],
    { id: 'agent', title: 'Connect an agent', done: agent, href: '#view=agents', flow: '' },
    { id: 'model', title: 'Connect your AI', done: modelOf(seen).connected, href: `#dialog=${SETTINGS_PROVIDERS}`, flow: '' },
  ];
}
