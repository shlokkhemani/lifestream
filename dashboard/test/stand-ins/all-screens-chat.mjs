// @ts-check

const CHAT = '1792396847000-aaa001';
const LONG = '1792396847000-aaa002';
const RUN = '1792396847000-aaa003';
const OLD = '1792396847000-aaa004';

/** @param {any} shared */
export function chatScreens({ day, FULL_DAY, ago, ready }) {
  const atoms = day.atoms;
  const said = atoms.filter((/** @type {any} */ atom) => atom.family === 'messages');
  const mail = atoms.filter((/** @type {any} */ atom) => atom.family === 'mail');
  const stays = atoms.filter((/** @type {any} */ atom) => atom.family === 'physical');
  const photos = atoms.filter((/** @type {any} */ atom) => atom.family === 'photos');
  const ref = (/** @type {any} */ atom, /** @type {string} */ title, more = {}) => ({ ref: `line.${Buffer.from(JSON.stringify(['line', FULL_DAY, atom.unit, atom.item ?? null, 'rev1'])).toString('base64url')}`,
    kind: 'line', day: FULL_DAY, ...(atom.start_ms === null ? {} : { at: new Date(atom.start_ms).toISOString().replace(/:\d\d\.\d{3}Z$/u, '+00:00') }), title, ...more });
  const refs = {
    r1: ref(said[0], 'Person D, about the wall'), r2: ref(said[1], 'Your reply to Person D'), r3: ref(stays[2], 'At Climbing Hall'),
    r4: ref(mail[0], 'Tickets for the river walk'), r5: ref(said[2], 'Person D, the window seat'), r6: ref(stays[4], 'At Salt Gallery'),
    r7: ref(said[4], 'Person E, the prints'), r8: ref(mail[1], 'Lab invoice, October'),
    r9: ref(photos[2], 'A photo at Climbing Hall', { kind: 'photo', image: `sha256:${String(photos[2].item).replace('photo:', '').replace('sha256:', '')}` }),
  };
  const steps = [{ name: 'search', words: 'Searched messages for “wall”', ms: 820 }, { name: 'read', words: 'Read 17 Oct', ms: 240 },
    { name: 'search', words: 'Searched mail for “tickets”', ms: 610 }];
  const user = (/** @type {number} */ n, /** @type {string} */ text, /** @type {number} */ at) => ({ chat: CHAT, n, at_ms: at, role: 'user', text });
  const said1 = (/** @type {number} */ n, /** @type {string} */ text, /** @type {number} */ at, more = {}) => ({ chat: CHAT, n, at_ms: at, role: 'assistant', text, refs, steps,
    end: 'done', ms: 14_000, model: 'synthetic-terra', thinking: 'high', ...more });
  const t = ago(0, 2);
  const conversation = { chat: CHAT, title: 'That Saturday in Lisbon', messages: [
    user(1, 'What did I do on the Saturday I went climbing?', ago(2, 5)),
    said1(2, 'You spent **17 Oct** moving across Lisbon. You started with coffee at Corner Cafe, then went to Climbing Hall [r1, r3] from about 10:40 to 12:30, where you sent a new route on your third go.\n\nAfter noodles you went to Salt Gallery [r6] to see the prints Person E had brought back [r7], and were home by ten past five.', ago(2, 5)),
    user(3, 'Who was I with at the wall?', ago(0, 3)),
    said1(4, 'Person D [r1, r2]. They asked that morning whether you were still on, you said yes and to meet at the corner by half nine, and they asked you to save them the window seat [r5].\n\nThe group chat was talking about the same session while you were there [r1, r2, r5, r7].', ago(0, 3)),
    user(5, 'Did I book anything for the river walk?', t),
    said1(6, 'Yes. Two tickets arrived by mail at 12:20 from Person F [r4], and a separate lab invoice came later that evening [r8]. Here is the photo you took at the hall the same day [r9].', t),
    user(7, 'Thanks. And what was the invoice for?', t + 60_000),
    said1(8, 'It was for printing at the lab, the same prints Person E mentioned at 09:48 [r7, r8].', t + 60_000),
  ] };
  const longText = '## A month in short\n\nOctober was **mostly Lisbon**, with one long weekend in Porto. You kept to a steady rhythm of mornings at the Corner Cafe and climbing twice a week [r3].\n\n'
    + '### Where the time went\n\n| Place | Visits | Hours |\n| --- | ---: | ---: |\n| River Flat | 31 | 412 |\n| Climbing Hall | 8 | 16 |\n| Corner Cafe | 12 | 9 |\n| Salt Gallery | 2 | 4 |\n\n'
    + '### Who you saw\n\n1. **Person D**, nearly every climbing day [r1, r2]\n2. **Person E**, about the prints [r7]\n3. **Person G**, on Sundays at the river\n\n'
    + '### Worth following up\n\n- The lab invoice is still in your inbox [r8]\n- You told Person F you would go back for the broth\n- The river walk tickets are for a Sunday [r4]\n\n'
    + '> Same. Sunday at the river?\n\nThat line came up in three separate conversations, so it may be a standing plan rather than a one-off.\n\n'
    + 'If you want to check the exact times, the day page holds them: `17 Oct, 10:40 to 12:30`. '
    + 'A longer note on the same theme follows so the reading column can be judged at full length. '.repeat(6)
    + '\n\n'
    + 'You also mentioned the gallery twice that week [r6], once to Person E and once to Person H, and both times it was about going back for the second room, which you had not seen. '.repeat(4);
  const long = { chat: LONG, title: 'How was October?', messages: [
    { chat: LONG, n: 1, at_ms: ago(1), role: 'user', text: 'How was October? Give me the whole picture.' },
    { chat: LONG, n: 2, at_ms: ago(1), role: 'assistant', text: longText, refs, steps, end: 'done', ms: 62_000, model: 'synthetic-terra', thinking: 'high' }] };
  const asked = (/** @type {string} */ chat, /** @type {string} */ title, /** @type {any[]} */ tail, more = {}) => ({ chat, title, messages: [
    { chat, n: 1, at_ms: ago(0, 1), role: 'user', text: 'Who did I message most last week?' }, ...tail], ...more });
  const failed = (/** @type {string} */ kind, /** @type {string} */ error = '') => asked(RUN, 'Who did I message most?', [{ chat: RUN, n: 2, at_ms: ago(0, 1), role: 'assistant', text: '', steps: steps.slice(0, 1), end: 'failed', failed: kind, error, ms: 4000 }]);
  const chats = { chats: [
    { chat: CHAT, title: conversation.title, first_ms: ago(2), last_ms: t + 60_000, messages: 8 },
    { chat: RUN, title: 'Who did I message most?', first_ms: ago(0, 5), last_ms: ago(0, 5), messages: 2 },
    { chat: LONG, title: long.title, first_ms: ago(1), last_ms: ago(1), messages: 2 },
    { chat: OLD, title: 'Trips this year', first_ms: ago(3), last_ms: ago(3), messages: 4 },
    { chat: 'c5', title: 'The name of the noodle place', first_ms: ago(5), last_ms: ago(5), messages: 2 },
    { chat: 'c6', title: 'When did I last see Person K?', first_ms: ago(12), last_ms: ago(12), messages: 2 },
    { chat: 'c7', title: 'What did the lab charge in September, and was it more than in August?', first_ms: ago(40), last_ms: ago(40), messages: 6 },
    { chat: 'c8', title: 'Books people recommended', first_ms: ago(80), last_ms: ago(80), messages: 2 },
    { chat: 'c9', title: 'Porto weekend plan', first_ms: ago(400), last_ms: ago(400), messages: 2 }] };
  const base = [{ url: 'api/ask/chats', json: chats }, { url: 'api/ask/chat\\?chat=' + CHAT, json: conversation }, { url: 'api/ask/chat\\?chat=' + LONG, json: long },
    { url: 'api/ask/stop', json: { stopped: true } }, { url: 'api/ask$', method: 'GET', json: ready }];
  const running = { url: 'api/ask/chat\\?chat=' + RUN, json: asked(RUN, 'Who did I message most?', [], { running: { n: 2 } }) };
  const at = (/** @type {any} */ conv) => [{ url: 'api/ask/chat\\?chat=' + RUN, json: conv }, ...base];
  const open = (/** @type {string} */ chat) => `#view=ask&chat=${chat}`;
  const follow = (/** @type {any[]} */ lines) => [running, { url: 'api/ask/events', lines, open: true }, ...base];
  const stepping = [{ type: 'chat', chat: RUN, n: 2 }, { type: 'step', call: 1, name: 'search', words: 'Searched messages for “last week”' },
    { type: 'step', call: 1, words: 'Searched messages for “last week”', ms: 700 }, { type: 'step', call: 2, name: 'people', words: 'Counting who you wrote to' }];
  const writing = [...stepping, { type: 'step', call: 2, words: 'Counted who you wrote to', ms: 400 }, { type: 'text', delta: 'Last week you wrote to **Person D** the most, 42 messages, mostly about climbing. After them came Person E with 19 and ' }];
  const S = (/** @type {string} */ name, /** @type {string} */ title, /** @type {string} */ hash, /** @type {any} */ stub, more = {}) => ({ section: 'Chat', name, title, hash, stub, ...more });
  const fresh = [{ url: 'api/ask/chats', json: { chats: [] } }, { url: 'api/ask$', method: 'GET', json: { ...ready, starters: [
    { kind: 'places', question: 'Where have I been today?' }, { kind: 'sleep', question: 'How did I sleep last night?' },
    { kind: 'people', question: 'Who did I talk to most this week?' }] } }];
  const askDown = [{ url: 'api/ask$', method: 'GET', status: 503, json: { error: 'Chat isn’t answering on your Mac', code: 'ASK_DOWN' } }];
  const out = ready.models.find((/** @type {{ state: string }} */ each) => each.state !== 'ready');
  const signedOut = [{ url: 'api/ask$', method: 'GET', json: { ...ready, default: { model: out.id, thinking: out.default, shown: out.id }, said: out.line,
    act: `Sign in with ${out.group}…` } }];
  return [
    S('chat-home', 'Chat, home with past conversations', '#view=ask', base),
    S('chat-home-min', 'Chat, home with past conversations, the window at its smallest', '#view=ask', base, { width: 900, height: 600 }),
    S('chat-fresh', 'Chat, a fresh home offering its starters', '#view=ask', fresh),
    S('chat-fresh-min', 'Chat, a fresh home offering its starters, the window at its smallest', '#view=ask', fresh, { width: 900, height: 600 }),
    S('chat-conversations', 'Chat, the conversations drawer open over a conversation', open(CHAT), base, { run: `await S.click('.ak-bar [data-ask-action="chats"]');` }),
    S('chat-home-typed', 'Chat, home with a long question typed', '#view=ask', base, { run: `await S.type('.ak textarea', 'Tell me everything about the weekend in Porto, who I saw, where we ate and what it cost, and whether I told anyone about it afterwards. Then compare it with the weekend before, and list anything I said I would follow up on.');` }),
    S('chat-pick-menu', 'Chat, the pick chip’s menu open', '#view=ask', base, { run: `await S.click('.ck-pick .ck-fmenu__btn');` }),
    S('chat-model-menu', 'Chat, the pick chip’s models', '#view=ask', base, { run: `await S.click('.ck-pick .ck-fmenu__btn'); await S.click('.ck-pick .ck-flist__more');` }),
    S('chat-thread', 'Chat, a conversation of several turns with citations', open(CHAT), base),
    S('chat-thread-top', 'Chat, the same conversation from its first turn', open(CHAT), base, { run: `await S.scroll('.ak-stage', 0);` }),
    S('chat-steps-open', 'Chat, an answer’s steps opened', open(CHAT), base, { run: `await S.click('[data-ask-steps="3"]');` }),
    S('chat-cite-open', 'Chat, a citation open in the moment panel', open(CHAT), base, { run: `await S.click('[data-ask-cite^="3 "]'); await S.until('.ck-inspector__body'); await S.sleep(900);` }),
    S('chat-cite-menu', 'Chat, the +N sources menu open', open(CHAT), base, { run: `await S.scroll('.ak-stage', 0); await S.click('.ck-cites .ck-fmenu__btn');` }),
    S('chat-edit-question', 'Chat, a question being edited', open(CHAT), base, { run: `await S.click('[data-ask-edit="3"]');` }),
    S('chat-long', 'Chat, a long answer (headings, table, lists, quote)', open(LONG), base),
    S('chat-running-first', 'Chat, a question just asked, nothing back yet', open(RUN), follow([{ type: 'chat', chat: RUN, n: 2 }])),
    S('chat-running-steps', 'Chat, an answer in progress, working through steps', open(RUN), follow(stepping)),
    S('chat-running-writing', 'Chat, an answer in progress, words streaming', open(RUN), follow(writing)),
    S('chat-stopped', 'Chat, an answer stopped part way', open(RUN), at(asked(RUN, 'Who did I message most?', [{ chat: RUN, n: 2, at_ms: ago(0, 1), role: 'assistant', text: 'Last week you wrote to **Person D** the most, 42 messages, mostly', steps, end: 'stopped', ms: 9000, refs: {} }]))),
    S('chat-failed-model', 'Chat, answer failed: the model did not answer', open(RUN), at(failed('model', 'ChatGPT didn’t answer: you’re offline.'))),
    S('chat-failed-door', 'Chat, answer failed: not sent', open(RUN), at(failed('door'))),
    S('chat-failed-restart', 'Chat, answer failed: Chat restarted', open(RUN), at(failed('restart'))),
    S('chat-failed-lost', 'Chat, answer failed: connection lost', open(RUN), at(failed('other'))),
    S('chat-unreachable', 'Chat, Chat unreachable on this Mac (home)', '#view=ask', [...askDown, ...base]),
    S('chat-unreachable-thread', 'Chat, Chat unreachable with a conversation open', open(CHAT), [...askDown, ...base]),
    S('chat-signed-out', 'Chat, ChatGPT sign-in needed (home)', '#view=ask', [...signedOut, ...base]),
    S('chat-signed-out-thread', 'Chat, ChatGPT sign-in needed with a conversation open', open(CHAT), [...signedOut, ...base]),
    S('chat-reading', 'Chat, loading: home', '#view=ask', [{ url: 'api/ask', hold: true }, { url: 'api/life/places', hold: true }], { raw: true, run: `await S.sleep(2600);`, whole: false }),
    S('chat-thread-reading', 'Chat, loading: a conversation', open(CHAT), [{ url: 'api/ask/chat\\?', hold: true }, ...base], { raw: true, run: `await S.sleep(2600);`, whole: false }),
    S('chat-thread-failed', 'Chat, a conversation that could not be read', open(CHAT), [{ url: 'api/ask/chat\\?', status: 500, json: { error: 'The conversation could not be read.' } }, ...base]),
    S('chat-list-failed', 'Chat, the conversations could not be read', '#view=ask', [{ url: 'api/ask/chats', status: 500, json: { error: 'Your conversations could not be read.' } }, ...base.slice(1)]),
  ];
}
