# The code's words

This page lists the words Lifestream's code uses, and what each one means. Code, tables, docs and
the home's status use these words and no others, one word for each thing. Pages for people who use
Lifestream use the words in the docs' word list instead.

## The home and its parts

| Word | What it means | Example |
|---|---|---|
| home | The folder that holds everything Lifestream keeps about one life. A file named `HOME.json` makes a folder a home. The word also names the one process that writes the folder's database, `home.db`. | `~/Lifestream` |
| door | The HTTP process that devices send to and readers read from. It writes the inbox, its own `door/` folder and some of the ledger, never `home.db`. | `127.0.0.1:4680` |
| machine directory | The folder on one computer that holds what is true of that computer: the releases, the pointer to its home, its caches. | `~/Library/Application Support/Lifestream` |
| release | One folder, built from one commit, that holds every program the home runs and the Node they run on. | `releases/<commit>/` |
| unit | The name of one device. | `macbook-pro-0001` |
| pass | A secret that a device or a reader shows the door, as `Authorization: Bearer <pass>`. The home keeps only its hash, in `config/principals.json`. The code calls that row a principal. Each pass has a kind and scopes, such as `read` or `deliver`. | a dashboard's `read` pass |
| custody | How far the home has received and imported a device's deliveries, for each pass and source. The door tells the device, so it knows what to send. | |
| runner | A program on one of the person's machines that runs model files for the home. It dials the door with its pass, which has the `run` scope. The home's calls reach it with the call pass, scope `call`. This link is the runner wire. A runner's routes name its machine. | `runner:runner-macbook-pro-0001/qwen3.5-4b` |
| station | One Chrome profile that runs the Chrome extension, as a device of the home. | `chrome-` and eight hex digits |
| errand | One piece of browser work a station does, in the person's own signed-in Chrome. | the WHOOP pages read |
| read routes | The door's routes that readers read the home through: records, extracts, days, search, blobs and others. Readers never open `home.db` or `days/`. | `GET /v1/days/2026-10-03` |
| page answer | What one page of an app shows, worked out by the home and served by the door at one route; the app lays it out and decides nothing it says. Its shape is `PAGES` in `packages/home/pages.ts`. | `GET /v1/page/person?id=person:0001` |
| feed | The door's stream of events, one for each change the home commits. | `GET /v1/feed` |
| Ask | The code's name for the page people see as Chat. | `/v1/ask` |
| form | Whether a home is plain or keyed. A keyed home's stores, files and blob names are encrypted; a plain home's are not. The folder's bytes say which, never whether a process holds a key. Pages for people say encrypted. | `formOf(root)` answers `keyed` |
| data key | The one key a keyed home's stores, sealed files and blob names are under, each by a key derived from it for its role. It is kept wrapped in `config/vault.json`. | data key 1 |
| slot key | This Mac's key to the vault: 32 bytes in its login Keychain, handed to the home and the door on fd 3. The vault's other slot opens with the recovery key. | the Keychain item `machine:<home id>` |
| recovery key | The key the person keeps, which opens the vault's recovery slot: shown once as 52 letters, with its number and the day it was made. | recovery key 2, made on 17 November 2026 |
| locked | A keyed home whose start opened no slot: it opens no store and waits for `unlock` or `recover`, and its door answers `503 LOCKED`. | |
| scratch | `<machine>/scratch/`, the one plain place a keyed home's working copies and sort spills live, on the Mac's own disk, emptied by each program at its start. | `scratch/call/call-…/` |

## How data arrives

| Word | What it means | Example |
|---|---|---|
| connector | One thing a person sets up, such as Gmail or Screen. It is declared once beside its code, in its `connector.ts`: its sources, readers, acquirers, words and settings. | Gmail, WhatsApp |
| source | One container of observations: one copy of one account's data, named once as `<product>:<account>:<copy>`. Its parts are stored beside the name. | `whatsapp:+15550000001:iphone-aa01` |
| owner source | A source that holds the person's own word, such as their people, their places or their Chat conversations. The home keeps it under no device. | `places:local:<home>` |
| acquirer | Code that fetches from a provider and returns files for the home to seal as a delivery. | the Gmail IMAP poll |
| cursor | Where a poll stands with its provider: a few fixed fields, at most 16 KiB. It holds nothing whose size follows how many items the provider has. | the newest `updated_at` sealed; a page token |
| poll memory | What a poll remembers of single items: one small row an item, in named parts (an entry is one key and its value in a part), kept by the home. Only the poll's own call reads and changes it, and its changes commit with the call's cursor. In prose, "a poll's memory"; "memory" alone is the heap. | each conversation fetched, with its update time |
| reader | Code that reads one source's deliveries and returns rows. A source's row names its reader in `sources.connector`. A program that reads the home through the door, such as the dashboard, is also called a reader. | `whatsapp-db` |
| labeler | Code that runs after its inputs land, or after the extracts it reads change. It delivers what it finds as a source of its own. | the faces labeler |
| bundle | A ZIP file a device sends to the door. | the Mac's WhatsApp changes |
| delivery | One sealed set of files with its manifest, as the home keeps it. | a Mac delta sealed at 14:00 |
| seal | To write a delivery into `inbox/` whole, with its manifest. A sealed delivery never changes. | |
| inbox | The folder `inbox/`, where every delivery is kept as it arrived. | |
| read-through | The newest moment a source is known to have been read up to. | the Mac's screen, read through 15:40 |
| blob | A file's bytes, named by their SHA-256. | a photo |
| import kind | What one import window takes and what a handed-over file is checked against: a connector's own export (its id), or a kind several connectors read, declared in `packages/connect/imports/`. The code says "kind" where no record kind is near. | `google-takeout`, `spotify` |
| import | One export of one account as the company made it: every file of one kind, account and stamp. The home gives each an opaque id. | one Spotify zip; a Takeout's parts |
| file (of an import) | One thing the person handed over: a zip, a `.tgz`, a folder or a single file. It travels as one delivery stating `import: {kind}`. | `my_spotify_data.zip` |
| member | One file inside a file of an import, by its path there. | `Takeout/Mail/All mail Including Spam and Trash.mbox` |
| product | One part of an import one reader reads, by the company's name. A connector's own export has one. | Mail, My Activity |
| stamp | What an import's files state that makes them one import. | a Takeout's `<made>`, `20261027T103000Z` |
| leaves | The member patterns a reader passes over knowingly: a file holding only these holds nothing Lifestream reads yet. | Spotify's `**/ReadMeFirst_*.pdf` |
| let go | The home removed its copy of an import's file. The records read from it stay. | **Let go**, **Skip it** |
| handed file | A `file` record of an upload source, a file the person shared from the phone or dropped in the Mac's drop folder with no kind named. The home looks at its members once it holds its blob, and seals it as the import of the kind that claims them. | a Spotify zip shared from Files |

## Records

| Word | What it means | Example |
|---|---|---|
| record | One thing a source names, by its source, kind and key. | message `msg` / `3EB0A1` |
| kind | What sort of thing a record is, as its connector declares. | `msg`, `chat` |
| version | One distinct content of a record, named by the SHA-256 of its canonical JSON. | the message with status "read" |
| statement | One row that says "this source said this record was this version, or gone, at this time". | one `statements` row |
| land | To write a reader's row as a statement, which moves the record's head when it is the newest. | `land` in `packages/core/records.ts` |
| head | A record's current version. | |
| erasure | The owner's deletion of a thing. It is absolute. | `lifestream erase` |

## Work the home does

| Word | What it means | Example |
|---|---|---|
| job | One piece of work that is due. | `plan messages` |
| run | One execution of an import, a family, a repair or another operation, kept as a row. | |
| lane | In the home's loop, a queue of jobs of one priority: `live`, `polls`, `planning`, `history` and `backfill` (`LANE` in `packages/home/jobs.ts`). | |
| family | Code that turns records into extracts, asks and day lines. | messages, screen, health |
| extract | A row a family derives from records. It costs nothing, the same records always give the same row, and it can be built again at any time. | one chat on one day |
| day | One civil day, by default from 04:00 to 04:00 in the home's time zone. | `2026-10-03` |
| the clock | The home's days sent as data: one table of day starts with the zone of each, from 1970 to ten years ahead (`packages/home/home-clock.ts`, `GET /v1/clock`). A reader files a moment under a day by looking it up, and works out no day itself. | `{ id, zone, start_hour, runs }` |
| day file | The files the home writes for one day under `days/`. Its lines are cited by number ([the day file](../user/day-file.md)). | `[2026-10-03 L12]` |
| atom | One thing a day file prints: a message, a reading or a heading. It names its record or item, when it has one. | `07:12 Person A: message 157` |

## Models

| Word | What it means | Example |
|---|---|---|
| item | One thing a family asks a model about. | a photo, a voice note |
| prompt | What a family asks a model, by a stable name and a whole version. Its text is edited freely. Its version moves only when an answer's meaning does, and each version states its answer type (`text` or a JSON Schema object) and the older versions whose answers it keeps. | `photo-caption` 9 |
| ask | What a family asks a model about one item: a row of `asks` that names its prompt and the version it is asked under, its work and its time, but no model. It is `pending` until a model answers it (`done`) or its tries run out (`given-up`). | a photo's caption owed |
| enrichment | A model's description of one item, kept by its exact input. | a photo caption |
| work | One kind of model work a connector declares on its items, named `<connector>/<work>`. Each connector sets it with `llm.<work>`, and the level its items leave at with `privacy.<work>`. | `camera/photos` |
| route | One model as one transport reaches it, named `<transport>:<model>`. In code it is a `ModelRoute`, never a bare `Route`, which is a connector's sign-in. What serves an ask is the one answer of `serving`: the model the person chose for that item (a row of `item_routes`), else the setting of the ask's work, within its range. | `openrouter:openai/gpt-6-luna` |
| transport | One way the home reaches a model. A person reads it as a connection: an account or an address that lists its models, each with its abilities (what it takes in and gives back, whether it calls tools, how much it holds, its thinking levels). | `claude`, `codex`, `openrouter`, `runner`, `address` |
| use | One place Lifestream uses a model, with the need a model must meet for it (`MODEL_USES`, `packages/model/uses.ts`): the three a work declares and three of the home's own. `unfit` (`fit.ts`) says whether a model fits a use, and if not, why. Each use has one default, `model.defaults.<use>`. | `pictures`, `audio`, `text`, `chat`, `search`, `hiding` |
| range | How far back a connector's model work reaches (`llm.range`). Its start is the first day an ask is sent for. | thirty days before the connector was set up |
| call | One process that sends one model request and writes the ledger. The home starts one for each request. | |
| ledger | The file `replies/replies.db`: every model request, attempt and reply. It is never rebuilt. | |

## Search and readers

The door's four search routes (`/v1/search`, `/v1/count`, `/v1/people/search`, `/v1/read`) and
the readers that ask them. door.md holds the routes.

| Word | What it means | Example |
|---|---|---|
| search reader | Who asks a search route: the **person** (a device, the dashboard), **Ask** (the person's own model, one conversation at a time) or an **agent** (an outside model under a grant). Not a connector's reader. | an Ask turn |
| entry | One thing said, in the record's index: a record with the day lines that print it, or a day line that prints no indexed record. | one message |
| collection | A set of facts one family states and `count` counts: the tool's `of`. | `payments`, `calls`, `days` |
| fact | One thing in a collection. | one call, one civil day |
| key | What a fact is grouped and filtered by. Never a record's key. | `payee`, `app` |
| measure | A number a fact states, with its unit and rules. | a payment's `amount` |
| reading | One way the record measures a thing. | time asleep, time in bed |
| list | One labelled part of a search's answer. | `record`, `screen`, `goto` |
| hit | One result in a list. | a message |
| window | A hit of the `screen` list: one window (its machine, app, site and name) on one civil day. | a page in Chrome on 3 Oct |
| kinds | The person's first screen of a search (`/v1/search/kinds`): top hits, then each family with its count and its best three. | Messages 9,200 |
| track | A row of the listening kind: one track and artist with its plays. | "Riverside", 31 plays |
| sitting | As a search row, the screen kind's: one stretch at one Mac, its summary and the windows that matched in it. | a morning at the Mac |
| stretch | The whole civil days of screen text one call reads: the newest 366 with no dates, at most 366 with dates or after a `next`. Always read whole. | |
| ref | The address of one thing `read` opens. The door makes it and only the door reads inside it. | |
| handle | A ref's short name in one reader's table: what a model is given and cites. | `r7` |
| search cursor | An answer's `next`: where one list goes on. Passed back as `cursor`, alone or with the arguments it was given for. Not a poll's cursor. | |
| the way out | The one module a model reader's call passes, `way-out.ts`: its in, row and out faces. The privacy filter is always called so. | |
| level | What a reader has hidden. | `all`, `names`, `none`, a list of types |
| table | A reader's placeholders and handles: one per Ask conversation, one per grant. | `chat:<id>`, `grant:<id>` |
| epoch | A number the home moves when an erasure starts and when it ends. A read begun under one epoch never answers under another. | |
| skill | `mcp/SKILL.md`: how to work with the four tools. Ask's prompt carries it and every agent is given it. | |
| walk | One statement over one index between two bounds, to a limit; each row it returns is a row it visited. | |
| meter | What counts the rows a read walks, against a budget (`work.ts`). | 30,000 rows a search page |
| scan | A search's walk of its matches in time order; it knows how it ended and where it stopped. | |
| capped | A list stopped at its budget before the end of what was asked. | |
| reached | How far a capped list got: `{side, at, whole}`. | |
| fits | The range a count refused for size names: asked over it, the same count answers. | |
| pending | A day of the range whose newest render the index does not hold yet. | |
| as_of | The newest statement of `home.db` an index had read when it answered. | |
| layer | A part of `index.db` with its own format number. | `words`, `facts` |

"Filter" keeps its plain meaning: a parameter that narrows a call (`from`, `person`, `place`).

## Agent access

[agent-access.md](./agent-access.md) holds the rules these words name.

| Word | What it means | Example |
|---|---|---|
| access | Everything one model reader may read: its allows, its time limit and its hiding. Ask's reader is `ask`, an agent's its pass id. | Claude's access |
| line | One numbered part of an access: an allow, the overall time limit, or the hiding. | `2. WhatsApp · past 24 hours` |
| allow | A line that lets a reader read: a reach, its own time limit and an end. | |
| reach | What an allow covers: everything but some categories, one category but some accounts, or one account. | `{type: "mail", but: []}` |
| category | A connector's type, one of core's `TYPES`, printed by its name there. | Mail, Health |
| account | One product at one account, `<product>:<account>`: a source's name less its copy. | `gmail:person-a@example.com` |
| one-off | An allow that ends by itself at its `until_ms`. | WhatsApp for 1 hour |
| gate | An access compiled for one request, on that request's clock. A full access has none. | |
| rests on | Said of a thing and each account its content was made from. A record rests on its own account. | a stay joined from a phone and a Mac |
| unresolved | Said of a thing whose row states no accounts. Only an open allow reads it. | |
| withheld | Not served, because the reader's access does not allow it. | |
| outside | What an answer states when the gate withheld something the ask matched. | |
| access request | One ask for more, by an agent or by Chat for an agent, waiting on the person's tap. | Instinct wants WhatsApp for 1 hour |
| reader call | One request of a model reader to a tool's route: a row of the history (`calls`). Not a model call. | a `search` |
| session | A reader's calls from one MCP `initialize`, or under 30 minutes apart. | |
