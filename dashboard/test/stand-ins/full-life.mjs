// @ts-check
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { tsImport } from 'tsx/esm/api';
import { crc32, deflateSync } from 'node:zlib';
import { scene } from '../../public/kit-gallery-scenes.js';
import { answerPicture, PICTURE_ROUTE } from './pictures.mjs';
import { clockFor } from './clock.mjs';
import { askReady } from './ask-ready.mjs';

export const FULL_DAY = '2026-10-17';
export const FULL_WORDS = 'river';
export const FULL_PERSON = 'person:person-d';
export const FULL_PERSON_NAME = 'Person D';

export const ZONE = 'Europe/Lisbon';
const CLOCK = clockFor(ZONE, 4, { first: '2026-01-01', last: '2026-12-31', id: 'full-life-lisbon' });
const at = (/** @type {string} */ clock, days = 0) => {
  const [hour, minute] = clock.split(':').map(Number);
  return Date.UTC(2026, 9, 17 + days, hour - 1, minute);
};
const PHONE = 'location:local:iphone-aa01';
const WHATSAPP = 'whatsapp:+15550000009:iphone-aa01';
const MAIL = 'gmail:person-a@example.com:cloud';
const AREA = { city: 'Lisbon', city_id: null, region: 'Lisbon', country: 'Portugal', country_code: 'PT' };

const SITES = /** @type {const} */ ({
  flat: { slug: 'fixture-river-flat', name: 'River Flat', point: { latitude: 38.7139, longitude: -9.1334 } },
  cafe: { slug: 'fixture-corner-cafe', name: 'Corner Cafe', point: { latitude: 38.7108, longitude: -9.1428 } },
  hall: { slug: 'fixture-climbing-hall', name: 'Climbing Hall', point: { latitude: 38.7268, longitude: -9.1503 } },
  bar: { slug: 'fixture-noodle-bar', name: 'Noodle Bar', point: { latitude: 38.7090, longitude: -9.1365 } },
  gallery: { slug: 'fixture-gallery', name: 'Salt Gallery', point: { latitude: 38.7046, longitude: -9.1600 } },
});

/** @type {[keyof typeof SITES, string, string][]} */
const STAYS = [['flat', '07:10', '09:05'], ['cafe', '09:20', '10:15'], ['hall', '10:40', '12:30'], ['bar', '12:55', '14:00'],
  ['gallery', '14:30', '16:45'], ['flat', '17:10', '22:40']];
/** @type {[string, string, number][]} */
const MOVES = [['Walking', 'walking', 1100], ['Road vehicle', 'road_vehicle', 2800], ['Road vehicle', 'road_vehicle', 3400],
  ['Walking', 'walking', 2100], ['Road vehicle', 'road_vehicle', 3100]];

/** @type {[number, number][][]} */
const WAYS = [
  [[38.71441, -9.13508], [38.71334, -9.13573], [38.71266, -9.13567], [38.7118, -9.13585], [38.71028, -9.13523], [38.7094, -9.13487],
    [38.70896, -9.13648], [38.70836, -9.13895], [38.708, -9.14006], [38.70797, -9.14201], [38.70913, -9.14194], [38.71035, -9.14203],
    [38.7105, -9.14236], [38.71062, -9.14294]],
  [[38.71175, -9.14293], [38.7129, -9.14325], [38.7154, -9.14482], [38.71601, -9.14726], [38.71656, -9.14801], [38.71711, -9.14925],
    [38.71773, -9.15148], [38.71869, -9.15306], [38.71992, -9.15419], [38.72034, -9.15393], [38.72113, -9.15244], [38.72276, -9.15151],
    [38.72501, -9.15351], [38.72573, -9.15218], [38.72586, -9.15159], [38.72659, -9.15015]],
  [[38.72659, -9.15015], [38.72586, -9.15159], [38.72519, -9.15089], [38.72458, -9.14945], [38.71643, -9.14229], [38.71608, -9.1422],
    [38.7153, -9.14152], [38.71473, -9.1408], [38.71437, -9.13995], [38.70865, -9.13777], [38.70896, -9.13648]],
  [[38.70896, -9.13648], [38.70836, -9.13895], [38.708, -9.14006], [38.70801, -9.14126], [38.70751, -9.14272], [38.7077, -9.14338],
    [38.70671, -9.1435], [38.70642, -9.14399], [38.70663, -9.15485], [38.70641, -9.15593], [38.70461, -9.16001]],
  [[38.70461, -9.16001], [38.70641, -9.15593], [38.70663, -9.15485], [38.70642, -9.14399], [38.70671, -9.1435], [38.7077, -9.14338],
    [38.70751, -9.14272], [38.70801, -9.14126], [38.708, -9.14006], [38.70836, -9.13895], [38.70896, -9.13648], [38.7094, -9.13487],
    [38.71028, -9.13523], [38.7118, -9.13585], [38.71266, -9.13567], [38.71334, -9.13573], [38.71441, -9.13508]],
];

const NAMES = [['person-d', 'Person D', '+15550000014', 212, 1, 40], ['person-e', 'Person E', '+15550000015', 96, 2, 41],
  ['person-f', 'Person F', '+15550000016', 61, 3, 42], ['person-g', 'Person G', '+15550000017', 44, 4, 43],
  ['person-h', 'Person H', '+15550000018', 30, 5, 44], ['person-i', 'Person I', '+15550000019', 21, 6, 45],
  ['person-j', 'Person J', '+15550000020', 12, 7, 46], ['person-k', 'Person K', '+15550000021', 8, 8, 47]];
const OTHERS = /** @type {[string, string, number][]} */ ([['L', '2026-10-16', 34], ['M', '2026-10-14', 9], ['N', '2026-10-12', 57],
  ['O', '2026-10-09', 3], ['P', '2026-10-07', 18], ['Q', '2026-09-02', 120], ['R', '2026-08-21', 6], ['S', '2026-07-30', 41],
  ['T', '2026-06-11', 2], ['U', '2026-05-25', 15], ['V', '2026-04-08', 73], ['W', '2026-03-19', 4], ['X', '2026-02-02', 28],
  ['Y', '2026-01-15', 11], ['Z', '2025-12-20', 64], ['AA', '2025-11-03', 5], ['AB', '2025-09-17', 22], ['AC', '2025-07-08', 1],
  ['AD', '2025-05-29', 37], ['AE', '2025-04-14', 8], ['AF', '2025-02-06', 13], ['AG', '2025-01-11', 2], ['AH', '2024-11-23', 19],
  ['AJ', '2024-08-05', 7], ['AK', '2024-05-17', 45], ['AL', '2024-03-02', 3]]);
const GROUP = { chat: '120363000000000099@g.us', title: 'Climbing Tuesdays' };
/** @param {string} phone */
const jidOf = phone => `${phone.slice(1)}@s.whatsapp.net`;
/** @param {string} phone */
const chatOf = phone => `whatsapp:${jidOf(phone)}`;

const TALK = /** @type {[number, [string, string, string][]][]} */ ([
  [0, [['08:12', 'Person D', 'Are we still on for the wall this morning?'], ['08:14', '', 'Yes. Coffee first, I will be at the corner by half nine.'],
    ['08:15', 'Person D', 'Perfect, save me the window seat.']]],
  [1, [['09:48', 'Person E', 'The prints came back from the lab, want to see them at the gallery?'], ['09:52', '', 'Today works, after lunch.']]],
  [2, [['13:20', 'Person F', 'Noodle place was as good as you said'], ['13:21', '', 'Told you. Get the broth next time.']]],
  [3, [['19:05', '', 'Home now. Thanks for today.'], ['19:30', 'Person G', 'Same. Sunday at the river?'], ['19:31', '', 'Sunday at the river.']]],
]);
const GROUP_TALK = /** @type {[string, string, string][]} */ ([['11:02', 'Person D', 'New route on the left wall, try the blue one'],
  ['11:06', 'Person H', 'Saw it, the start is brutal'], ['11:40', '', 'Sent it on the third go']]);
const SHOTS = /** @type {[string, number][]} */ ([['09:41', 7], ['09:42', 3], ['11:15', 5], ['11:52', 0], ['11:53', 4], ['13:10', 1], ['13:12', 2],
  ['15:05', 6], ['15:22', 5], ['15:48', 3], ['20:15', 6]]);

/**
 * @param {Uint8ClampedArray} pixels
 * @param {number} width
 * @param {number} height
 */
function png(pixels, width, height) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        rows[y * (width * 3 + 1) + 1 + x * 3 + channel] = pixels[(y * width + x) * 4 + channel];
      }
    }
  }
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))]);
}

const clamp = (/** @type {number} */ value) => Math.min(1, Math.max(0, value));
/** @param {number} from @param {number} to @param {number} value */
const smooth = (from, to, value) => {
  const t = clamp((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};
/** @param {number[]} a @param {number[]} b @param {number} t */
const mix = (a, b, t) => a.map((value, index) => value + (b[index] - value) * t);

const GROUNDS = [[196, 208, 214], [224, 208, 188], [176, 190, 178], [206, 196, 212], [226, 214, 196], [184, 200, 214], [214, 200, 192], [190, 204, 196]];
const SKINS = [[226, 186, 158], [176, 124, 92], [238, 204, 178], [136, 92, 66], [214, 170, 134], [196, 146, 112], [232, 196, 166], [156, 108, 80]];
const HAIRS = [[52, 40, 34], [24, 22, 24], [132, 92, 56], [30, 26, 28], [76, 54, 42], [188, 160, 120], [96, 60, 44], [40, 34, 34]];
const CLOTHES = [[58, 76, 96], [188, 92, 66], [66, 92, 78], [214, 208, 198], [92, 74, 110], [46, 50, 60], [150, 120, 84], [86, 110, 130]];

/**
 * @param {number} seed
 * @param {number} [size]
 */
function portrait(seed, size = 640) {
  const pick = (/** @type {number[][]} */ list) => list[seed % list.length];
  const [ground, skin, hair, cloth] = [pick(GROUNDS), pick(SKINS), pick(HAIRS), pick(CLOTHES)];
  const long = seed % 3 === 1;
  const edge = 0.02;
  /** @param {number} x @param {number} y @param {number} cx @param {number} cy @param {number} rx @param {number} ry @param {number} [soft] */
  const blob = (x, y, cx, cy, rx, ry, soft = 0.5) => 1 - smooth(1 - soft, 1 + soft, Math.hypot((x - cx) / rx, (y - cy) / ry));
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const x = (column + 0.5) / size - 0.5;
      const y = (row + 0.5) / size - 0.5;
      const light = 1 - 0.3 * Math.hypot(x + 0.22, y + 0.3);
      let colour = ground.map(value => value * (1.04 - 0.3 * smooth(-0.5, 0.6, y + x * 0.3)));
      colour = mix(colour, ground.map(value => Math.min(255, value * 1.2)), 0.5 * blob(x, y, -0.3 + (seed % 3) * 0.1, -0.28, 0.2, 0.26, 0.9));
      colour = mix(colour, ground.map(value => value * 0.72), 0.5 * blob(x, y, 0.36, -0.1, 0.16, 0.42, 0.8));
      if (long) colour = mix(colour, hair, 1 - smooth(0, edge, Math.hypot(x / 0.19, (y - 0.08) / 0.3) - 1));
      const shoulders = (Math.abs(x) / 0.5) ** 2.6 + (Math.abs(y - 0.62) / 0.4) ** 2.6 - 1;
      colour = mix(colour, cloth.map(value => value * (1.1 - 0.42 * smooth(-0.3, 0.35, x + 0.2))), 1 - smooth(0, edge, shoulders));
      const neck = Math.min(Math.max(Math.abs(x) - 0.072, y - 0.25, 0.04 - y), (Math.hypot(x / 0.088, (y - 0.25) / 0.026) - 1) * 0.03);
      colour = mix(colour, skin.map(value => value * (0.8 - 0.2 * smooth(0.2, 0.1, y))), 1 - smooth(0, 0.012, neck));
      const head = Math.hypot(x / 0.136, (y + 0.03) / 0.176) - 1;
      const lit = 1.1 - 0.3 * smooth(-0.08, 0.16, x + 0.04 * y);
      colour = mix(colour, skin.map(value => value * lit), 1 - smooth(0, edge, head));
      const crown = Math.hypot(x / 0.148, (y + 0.07) / 0.176) - 1;
      const fringe = y + 0.095 - 0.04 * Math.sin(x * 12 + seed);
      colour = mix(colour, hair.map(value => value * (1.16 - 0.3 * smooth(-0.1, 0.16, x))), (1 - smooth(0, edge, crown)) * (1 - smooth(-0.008, 0.008, fringe)));
      const grain = (Math.sin(column * 12.9898 + row * 78.233 + seed) * 43758.5453 % 1) * 3;
      const at = (row * size + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) pixels[at + channel] = colour[channel] * light + grain;
      pixels[at + 3] = 255;
    }
  }
  return png(pixels, size, size);
}

/** @param {Buffer} bytes */
const hexOf = bytes => createHash('sha256').update(bytes).digest('hex');

/** @param {number} seed */
const photo = seed => png(scene(seed, 640, 640), 640, 640);

const { dayPage } = await tsImport('../../../packages/families/index.ts', import.meta.url);
const { dayBody } = await tsImport('../../../packages/home/page-days.ts', import.meta.url);
const { peopleBody } = await tsImport('../../../packages/home/page-people.ts', import.meta.url);

/** @param {{ door: { url: string }, people?: (list: any) => any }} options */
export async function fullLife({ door, people: shapePeople = list => list }) {
  /** @type {Map<string, Buffer>} */
  const pictures = new Map();
  /** @param {Buffer} bytes */
  const keep = bytes => {
    const hex = hexOf(bytes);
    pictures.set(hex, bytes);
    return hex;
  };
  const scenes = new Map(SHOTS.map(([, seed]) => [seed, keep(photo(seed))]));
  const faces = NAMES.map(([, , , , seed]) => keep(portrait(Number(seed) - 1)));

  /** @type {any[]} */
  const pieces = [];
  /** @type {any[]} */
  const physical = [];
  const name = (/** @type {keyof typeof SITES} */ site) => ({ words: SITES[site].name, area: AREA });
  STAYS.forEach(([site, from, to], index) => {
    const [start_ms, end_ms] = [at(from), at(to)];
    const unit = `stay/${PHONE}/${start_ms}`;
    pieces.push({ start_ms, end_ms, kind: 'stay', level: 'place', point: SITES[site].point, from: null, to: null, how: 'observed',
      by: 'Phone', units: [unit], walks: [], silences: [], names: { point: name(site), from: null, to: null } });
    physical.push({ family: 'physical', unit, start_ms, end_ms, local_start: from, local_end: to, flags: [], text: `At ${SITES[site].name}` });
    const next = STAYS[index + 1];
    if (!next) return;
    const [words, mode, metres] = MOVES[index];
    const [leaves, arrives] = [end_ms, at(next[1])];
    const trip = `trip/${PHONE}/${leaves}`;
    const turns = [SITES[site].point, ...WAYS[index].map(([latitude, longitude]) => ({ latitude, longitude })), SITES[next[0]].point];
    turns.slice(1).forEach((to, step) => {
      const [starts, ends] = [step, step + 1].map(part => Math.round(leaves + (arrives - leaves) * part / (turns.length - 1)));
      pieces.push({ start_ms: starts, end_ms: ends, kind: 'move', level: 'place', point: null, from: turns[step], to, how: 'observed',
        by: 'Phone', units: [trip], distance_m: Math.round(metres / (turns.length - 1)),
        legs: [{ distance_m: Math.round(metres / (turns.length - 1)), end_ms: ends, mode, motion: null, start_ms: starts, stated: null }],
        names: { point: null, from: name(site), to: name(next[0]) } });
    });
    physical.push({ family: 'physical', unit: trip, start_ms: leaves, end_ms: arrives, local_start: to, local_end: next[1], flags: [],
      text: `${words}, ${SITES[site].name} → ${SITES[next[0]].name}, ${(metres / 1000).toFixed(1)} km` });
  });
  const window = { start_ms: at('04:00'), end_ms: at('04:00', 1) };
  pieces.unshift({ start_ms: window.start_ms, end_ms: at('07:10'), kind: 'gap', from: SITES.flat.point, to: SITES.flat.point, units: [],
    level: null, point: null, how: null, names: { point: null, from: null, to: null } });
  pieces.push({ start_ms: at('22:40'), end_ms: window.end_ms, kind: 'gap', from: SITES.flat.point, to: SITES.flat.point, units: [],
    level: null, point: null, how: null, names: { point: null, from: null, to: null } });

  /** @type {Map<string, any>} */
  const extracts = new Map();
  /** @type {any[]} */
  const said = [];
  /**
   * @param {string} chat
   * @param {string} title
   * @param {[string, string, string][]} lines
   */
  const talk = (chat, title, lines) => {
    const unit = `${FULL_DAY}:whatsapp:${chat}`;
    const messages = lines.map(([clock, who, text], index) => {
      const key = `${chat}:F${index}`;
      said.push({ family: 'messages', unit, start_ms: at(clock), end_ms: null, local_start: clock, local_end: null, flags: [],
        text: `${who || 'the user'}: ${text}`, record: { source: WHATSAPP, kind: 'msg', key }, block: { key: `whatsapp:${chat}`, title } });
      const named = NAMES.find(person => person[1] === who);
      return { at: at(clock), key, source: WHATSAPP, text,
        from: who ? { id: named ? jidOf(String(named[2])) : who, kind: 'jid' } : { id: 'me', kind: 'me' } };
    });
    extracts.set(unit, { family: 'messages', unit, reading: `sha256:${'0'.repeat(64)}`, code: '4',
      content: { chat, day: FULL_DAY, messages, network: 'whatsapp' }, start_ms: messages[0].at, end_ms: messages.at(-1).at,
      days: [FULL_DAY], items: [] });
  };
  for (const [person, lines] of TALK) talk(jidOf(String(NAMES[person][2])), String(NAMES[person][1]), lines);
  talk(GROUP.chat, GROUP.title, GROUP_TALK);
  const mails = [['12:20', 'Person F', 'Tickets for the river walk'], ['18:02', 'Person E', 'Lab invoice, October']].map(([clock, who, subject], index) => ({
    family: 'mail', unit: `${MAIL}/${FULL_DAY}`, start_ms: at(clock), end_ms: null, local_start: clock, local_end: null, flags: [],
    text: `Mail in Inbox from ${who}: “${subject}”`, record: { source: MAIL, kind: 'mailmsg', key: `full-${index}` } }));
  const shots = SHOTS.map(([clock, seed], index) => ({ family: 'photos', unit: `burst/${at(clock.slice(0, 4) + '0')}`, start_ms: at(clock) + index,
    end_ms: null, local_start: clock, local_end: null, flags: [], text: 'Image', item: `photo:${scenes.get(seed)}`,
    block: { key: `burst/${at(clock.slice(0, 4) + '0')}`, title: 'Photos' } }));
  const atoms = [...physical, ...said, ...mails, ...shots].sort((a, b) => a.start_ms - b.start_ms)
    .map((atom, index) => ({ n: index + 1, ...atom }));
  const count = (/** @type {string} */ family) => atoms.filter(atom => atom.family === family).length;
  const families = { mail: count('mail'), messages: count('messages'), photos: count('photos'), physical: count('physical') };
  const file = { day: FULL_DAY, zone: ZONE, day_start_hour: 4, window, renderer: 'stand-in', inputs: `sha256:${'1'.repeat(64)}`,
    counts: { total: atoms.length, per_family: families },
    coverage: Object.keys(families).map(family => ({ family, sources: [{ source: PHONE, read: 'through' }] })),
    atoms, accounts: {}, sent: [], sleep: {}, groups: [`whatsapp:${GROUP.chat}`] };
  const fileText = JSON.stringify(file);
  const fileTag = `"${hexOf(Buffer.from(fileText))}"`;

  /**
   * @param {(typeof NAMES)[number]} entry
   * @param {number} index
   */
  const listed = ([slug, label, phone, messages, , ], index) => ({
    by: 'contact', call_name: label, card: true, chats: [{ count: Number(messages), key: chatOf(String(phone)) }],
    days_count: Math.round(Number(messages) / 3), entity: 'person', first_ms: Date.UTC(2024, 2 + index, 4), full_name: null,
    handles: [{ id: `phone:${phone}`, kind: 'phone', network: null, words: String(phone), from: null }], hidden: false, id: `person:${slug}`,
    last_30: Math.round(Number(messages) / 4), last_day: index < 4 ? 3 : 0,
    last_ms: index < 4 ? at('19:31') - index * 3_600_000 : Date.UTC(2026, 8, 20 - index), mails_from: index < 3 ? 4 : 0, mails_to: 0, me: false, name: label,
    networks: ['whatsapp'], organised: true, person: slug, photo: { card: `sha256:${faces[index]}` }, received: Math.ceil(Number(messages) / 2),
    relationship: null, score: Number(messages), sent: Math.floor(Number(messages) / 2), show: 'name' });
  /**
   * @param {(typeof OTHERS)[number]} entry
   * @param {number} index
   */
  const other = ([letters, day, messages], index) => ({
    ...listed([`person-${letters.toLowerCase()}`, `Person ${letters}`, `+155500001${String(index).padStart(2, '0')}`, messages, 0, 0], NAMES.length + index),
    last_30: index < 5 ? 1 : 0, last_day: 0, last_ms: Date.parse(`${day}T18:00:00Z`), mails_from: 0,
    first_ms: Date.parse(`${day}T18:00:00Z`) - (messages + 30) * 3 * 86_400_000,
    photo: index % 2 ? null : { card: `sha256:${keep(portrait(NAMES.length + index))}` } });
  const people = [...NAMES.map(listed), ...OTHERS.map(other)];
  const sited = Object.values(SITES);
  const where = pieces.map(piece => {
    const site = piece.kind === 'stay' ? sited.find(each => each.point === piece.point) : undefined;
    return { ...piece, place: site ? { slug: site.slug, name: site.name } : null, spot: null };
  });
  const page = dayBody(FULL_DAY, dayPage(file, { where, places: sited.map(site => ({ slug: site.slug })), people,
    calls: [], groups: [`whatsapp:${GROUP.chat}`], sent: [] }, null));
  /** @param {(address: string) => Promise<any>} doors */
  const everyone = async doors => {
    const held = await doors('/v1/people');
    return { ...held, people: [...people, ...held.people], position: '0:0',
      organise: { ...held.organise, organised: held.organise.organised + people.length },
      chats: [...people.map(person => ({ chat: person.chats[0].key.slice('whatsapp:'.length), first_ms: person.first_ms, group: false,
        key: person.chats[0].key, label: person.name, last_ms: person.last_ms, mine: person.sent, network: 'whatsapp', total: person.score })),
      { chat: GROUP.chat, first_ms: Date.UTC(2025, 1, 2), group: true, key: `whatsapp:${GROUP.chat}`, label: GROUP.title, last_ms: at('11:40'),
        mine: 12, network: 'whatsapp', quiet: null, total: 140, word: null }, ...held.chats] };
  };
  /** @param {ReturnType<typeof listed>} person */
  const whole = person => {
    /** @type {Record<string, number>} */
    const days = { [FULL_DAY]: person.last_day || 2 };
    const seed = person.score;
    for (let index = 1, day = 3; index < person.days_count && day < 560; index += 1) {
      days[new Date(at('12:00') - day * 86_400_000).toISOString().slice(0, 10)] = 1 + (index * seed) % 9;
      day += 1 + (index * 7 + seed) % 5;
    }
    return { ...person, days, names_seen: [person.name], record: null, suggestions: [] };
  };

  /** @param {string} clock */
  const instant = clock => `${FULL_DAY}T${clock}+01:00`;
  const hits = [
    { ref: 'record:full:mail:full-0', day: FULL_DAY, at: instant('12:20'), family: 'mail', product: 'gmail',
      title: 'Tickets for the river walk', from: 'Person F', snippet: 'Your two tickets for the «river» walk on Sunday are attached.' },
    ...[[3, 'Same. Sunday at the «river»?', '19:30'], [3, 'Sunday at the «river».', '19:31']].map(([person, snippet, clock], index) => ({
      ref: `record:full:message:${index}`, day: FULL_DAY, at: instant(String(clock)), family: 'messages', product: 'whatsapp',
      title: String(NAMES[Number(person)][1]), from: String(NAMES[Number(person)][1]), snippet: String(snippet),
      chat: chatOf(String(NAMES[Number(person)][2])), chat_title: String(NAMES[Number(person)][1]) })),
    ...STAYS.filter(([site]) => site === 'flat').map(([, from], index) => ({ ref: `line:${FULL_DAY}:physical:${index}`, day: FULL_DAY,
      at: instant(from), family: 'physical', title: 'River Flat', snippet: 'At «River» Flat' })),
  ].sort((one, other) => other.at.localeCompare(one.at));

  const personHits = TALK[0][1].map(([clock, who, text], index) => ({ ref: `record:full:message:person-${index}`, day: FULL_DAY,
    at: instant(clock), family: 'messages', product: 'whatsapp', title: FULL_PERSON_NAME, from: who || 'the user', snippet: text,
    chat: chatOf(String(NAMES[0][2])), chat_title: FULL_PERSON_NAME })).reverse();

  /**
   * @param {any[]} found
   * @param {{ people: { ref: string, name: string }[], places: { ref: string, name: string }[] }} named
   */
  const answered = (found, named) => {
    /** @type {Record<string, number>} */
    const families = {};
    for (const hit of found) families[hit.family] = (families[hit.family] ?? 0) + 1;
    const as_of = `${FULL_DAY}T23:00+01:00`;
    return { record: { as_of, total: found.length, hits: found, spread: { families, months: { [FULL_DAY.slice(0, 7)]: found.length } }, next: null },
      screen: { as_of, meaning: 'off', hits: [], next: null }, goto: { ...named, day: null, month: null } };
  };

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async function answer(request, response) {
    const url = new URL(request.url ?? '', 'http://door');
    const path = url.pathname;
    /** @param {unknown} body */
    const json = body => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const headers = /** @type {Record<string, string>} */ ({});
    for (const name of ['authorization', 'content-type', 'if-none-match', 'last-event-id', 'range']) {
      if (request.headers[name]) headers[name] = String(request.headers[name]);
    }
    /** @type {Buffer[]} */
    const body = [];
    for await (const chunk of request) body.push(chunk);
    /** @param {string} address */
    const doors = async address => (await fetch(`${door.url}${address}`, { headers: { authorization: headers.authorization ?? '' } })).json();
    const position = '0:0';

    if (path === '/v1/clock') return json(CLOCK);
    if (path === `/v1/days/${FULL_DAY}`) {
      if (request.headers['if-none-match'] === fileTag) return void response.writeHead(304, { etag: fileTag }).end();
      response.writeHead(200, { 'content-type': 'application/json', etag: fileTag });
      return void response.end(fileText);
    }
    if (path === '/v1/page/day' && url.searchParams.get('day') === FULL_DAY) {
      return json({ ...await doors(request.url ?? ''), ...page });
    }
    if (path === '/v1/page/days') {
      const held = await doors(request.url ?? '');
      const from = url.searchParams.get('from') ?? '0000';
      const to = url.searchParams.get('to') ?? '9999';
      if (from > FULL_DAY || to < FULL_DAY || url.searchParams.has('after') || held.days.some((/** @type {any} */ each) => each.day === FULL_DAY)) return json(held);
      const counts = { total: atoms.length, families: Object.entries(families).map(([family, count]) => ({ family, count })) };
      return json({ ...held, days: [...held.days, { day: FULL_DAY, counts }].sort((a, b) => a.day.localeCompare(b.day)) });
    }
    if (path === '/v1/days' && !url.searchParams.has('limit')) {
      const from = url.searchParams.get('from') ?? '0000';
      const to = url.searchParams.get('to') ?? '9999';
      const held = await doors(request.url ?? '');
      if (from <= FULL_DAY && to >= FULL_DAY && !url.searchParams.has('after')) {
        const days = [...held.days, { day: FULL_DAY, total: atoms.length, families }].sort((a, b) => b.day.localeCompare(a.day));
        return json({ ...held, days });
      }
      return json(held);
    }
    if (path === '/v1/connectors') {
      const held = await doors(request.url ?? '');
      const well = (/** @type {string} */ words) => ({ state: 'ok', words });
      return json({ ...held, needs: [], badge: { ...held.badge, needs: 0 }, connectors: held.connectors.map((/** @type {any} */ each) => each.set_up
        ? { ...each, line: each.line === 'Nothing yet' ? 'Last session 17 Oct' : each.line, health: { ...each.health, state: 'ok' } } : each),
      extension: { ...held.extension, health: well('In Chrome') }, devices: [
        { unit: 'macbook-pro-0001', name: 'MacBook Pro', kind: 'mac', retired: false, health: well('Recording'), streams: [] },
        { unit: 'iphone-aa01', name: 'iPhone', kind: 'phone', retired: false, health: well('Sent 2 minutes ago'), streams: [] }] });
    }
    if (path === '/v1/ask') return json(askReady([{ id: 'synthetic-terra', name: 'Synthetic Terra', thinking: ['high'], default: 'high', group: 'ChatGPT' }]));
    if (path === '/v1/ask/chats') return json({ chats: [] });
    if (path === '/v1/where' && url.searchParams.get('from') === FULL_DAY && url.searchParams.get('to') === FULL_DAY) {
      return json({ position, zone: ZONE, day_start_hour: 4, from_ms: window.start_ms, to_ms: window.end_ms, pieces });
    }
    if (path === '/v1/labels') {
      const points = url.searchParams.getAll('point');
      const sites = Object.values(SITES);
      const placed = points.map(point => sites.find(site => point.startsWith(`${site.point.latitude},${site.point.longitude}`)));
      if (points.length && placed.every(Boolean)) {
        return json({ position, names: [], chats: [], places: placed.map((site, index) => [Number(points[index].split(',')[0]),
          Number(points[index].split(',')[1]), /** @type {any} */ (site).slug, /** @type {any} */ (site).name]) });
      }
    }
    if (path === '/v1/extracts' && extracts.has(url.searchParams.get('unit'))) {
      return json({ position, extracts: [extracts.get(url.searchParams.get('unit'))] });
    }
    if (path === '/v1/people' && !url.searchParams.has('q')) {
      const id = url.searchParams.get('id');
      const found = people.find(person => person.id === id);
      if (found) return json({ position, person: whole(found) });
      if (!id) return json(await everyone(doors));
    }
    if (path === '/v1/page/people') {
      const held = await doors(request.url ?? '');
      return json({ ...held, ...peopleBody(shapePeople(await everyone(doors)), new Map(), held.today, { zone: ZONE, day_start_hour: 4 }) });
    }
    if (path === '/v1/people/photos' && people.some(person => person.id === url.searchParams.get('id'))) {
      const shown = [...scenes.values()].slice(0, 6).map((hex, index) => ({ image: hex, face: `${hex}:104,30,168,104`, box: [104, 30, 168, 104],
        at_ms: at('11:15') - index * 86_400_000 * 9, crop: null, camera: true }));
      return json({ position, photos: shown, total: shown.length });
    }
    const words = path === '/v1/search' ? url.searchParams.get('query') : null;
    if (words === FULL_WORDS) return json(answered(hits, { people: [], places: [{ ref: 'place:river-flat', name: 'River Flat' }] }));
    if (words === FULL_PERSON_NAME) return json(answered(personHits, { people: [{ ref: FULL_PERSON, name: FULL_PERSON_NAME }], places: [] }));
    const card = path === '/v1/people/card' ? /^sha256:([0-9a-f]{64})$/u.exec(url.searchParams.get('hash') ?? '')?.[1] : undefined;
    const blob = /^\/v1\/blobs\/sha256:([0-9a-f]{64})$/u.exec(path)?.[1];
    const held = pictures.get(card ?? blob ?? '');
    if (held) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(held.length) });
      return void response.end(held);
    }
    const asking = PICTURE_ROUTE.exec(path);
    if (asking && pictures.has(asking[1])) {
      return void await answerPicture(asking[1], url, request, response, async () => pictures.get(asking[1]) ?? null);
    }
    const passed = await fetch(`${door.url}${request.url}`, {
      method: request.method, headers, body: body.length ? Buffer.concat(body) : undefined,
    }).catch(() => null);
    if (!passed) return void response.writeHead(502).end();
    /** @type {Record<string, string>} */
    const back = {};
    passed.headers.forEach((value, name) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) back[name] = value;
    });
    response.writeHead(passed.status, back);
    if (!passed.body) return void response.end();
    const stream = Readable.fromWeb(/** @type {any} */ (passed.body));
    response.once('close', () => stream.destroy());
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  const server = createServer((request, response) => {
    answer(request, response).catch(() => response.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', () => done(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    close: () => new Promise(done => {
      server.closeAllConnections();
      server.close(() => done(undefined));
    }),
  };
}
