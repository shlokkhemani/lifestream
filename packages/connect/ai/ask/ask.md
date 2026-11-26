# Ask: `ask:local:<home>`

The person's conversations with Ask, the model that reads their life and answers, cited. An owner source: the home keeps it under no
device, and the Ask server writes it through the door with its own pass. `<home>` is the home's
unit, the `unit` setting.

## What it reads

Each turn is two owner-statements acquisitions, the question's at Send and the answer's once it
ends (done, stopped or failed); a title written after it is a third. Each is read by the one statements reader (`shared/statements.ts`), as the owner's places are
([places](../../places/places.md), "What it reads"): `PUT /v1/acquisitions/ask:local:<home>/<made-at>.<12
hex>`, a stored ZIP of `statements.ndjson` and `manifest.json` (feeder `owner-statements`,
`complete`, `fetched_at` the instant it was made, facts `{statements: <n>, blobs_carried: <n>}`:
the Ask server carries no file; the door's seal links into the delivery each file a question names,
"Its files" below).
It is written with the Ask server's pass, `<machine>/ask/door-token`, which the home's start keeps
with `deliver` on this source and nothing else (`home/lifecycle.ts` `passAsk`); that pass reads
nothing. Each states the conversation again and its one message, the question's first, the
answer's after:

```
{"kind":"chat","key":"1792396847000-3fa9c2","content":{"type":"ask.chat","title":"Sleep last week","at_ms":1792396861000}}
{"kind":"msg","key":"1792396847000-3fa9c2:0001","content":{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":1,"at_ms":1792396847000,"role":"user","text":"How did I sleep last week?"}}
{"kind":"msg","key":"1792396847000-3fa9c2:0002","content":{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":2,"at_ms":1792396861000,"role":"assistant","text":"About 7 h a night [r1].","refs":{"r1":{"ref":"row.WyJyb3ciLHsiYnkiOlsibW9udGgiXSwiZnJvbSI6IjIwMjYtMDktMDEiLCJtZWFzdXJlIjoic2xlZXAiLCJvZiI6ImRheXMiLCJvcCI6ImF2ZyIsInRvIjoiMjAyNi0xMC0zMSJ9LHt9LFtdLDU4XQ","kind":"row","asked":"avg of sleep over days, by month","n":58}},"steps":[{"name":"count","words":"Counted days","ms":40,"line":"count {of: days, measure: sleep, op: avg, by: month} → r1"}],"model":"gpt-6-luna","ms":14000,"end":"done"}}
```

The door reads the bundle with `ask-home` before it seals it: one line that does not read, or
whose files break the kind's rule ("Its files"), is 422 `STATEMENTS_BAD`, naming the line, and
nothing is sealed, so the Ask server's own E2E meets every shape this page refuses. Every row's
device is the pass's unit, `ask`.

A question with photos, then one spoken (its text `""`), the note's audio with its length:

```
{"kind":"msg","key":"1792396847000-3fa9c2:0003","content":{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":3,"at_ms":1792396900000,"role":"user","text":"Where was this?","photos":["sha256:1f…","sha256:9c…"]}}
{"kind":"msg","key":"1792396847000-3fa9c2:0005","content":{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":5,"at_ms":1792396960000,"role":"user","text":"","voice":{"audio":"sha256:4b…","ms":38412}}}
```

## Its files

A question's photos and its voice note's audio are its record's blobs, kept forever with it: the
row names them (`blobs`), the audio as `audio/wav` (`media`), a photo with no media type, its kind
being in its bytes (a media type decides only how the store spells a blob, and an image is stored
as it is). The import stores each before the row lands, and `/v1/blobs` serves them. The kind's
rule (`StatementKind.picture`), which the door runs before it seals over the blobs the bundle
carries, those its stage keeps (`Pictures.staged`) and those the home holds:

- each blob a question names is carried (its bytes the hash it is named by), staged, or held;
- a photo carried or staged is a JPEG (`FF D8 FF`), a PNG, a HEIC or HEIF (`ftyp` brand `heic`,
  `heix`, `heim`, `heis`, `hevc`, `mif1` or `msf1`) or a WebP (`RIFF…WEBP`), by its first bytes;
- the audio carried or staged is one WAV of 16 kHz mono 16-bit PCM with the canonical 44-byte
  header (`RIFF`, `WAVE`, a 16-byte `fmt ` chunk, then `data` to the end) and nothing else, and its
  samples give `ms`: their length at 16 kHz rounded up to a whole millisecond (`voiceMs`, which
  the door's join of a note's seconds states its `ms` by).

- each picture an answer's `seen` names (`photos`, "Kinds and keys") is carried, staged or held, as
  a question's photo is: the home made it, so its kind is not read again; the row names it as
  `image/jpeg`, so the import stores it with the answer and erasing the conversation erases it.

A held file was checked when it first landed. A line that breaks the rule is 422 `STATEMENTS_BAD`
naming it. A file a question names that neither the stage nor the store holds refuses its seal,
409 `FILES_MISSING` with what is missing, before any line is read for the rule; the Ask server
passes it on, and the device sends the file and asks again.

## Its adapter

`adapter.ts` gives the ai family its ai adapter (`packages/core/inputs/ai.ts`), with neither
`copy` (one copy, the home's: its own source names its units) nor `gist` (an answer is a model's
already, printed whole and never asked), and with `voice`: its questions may be voice notes. `turn`
reads a `msg`'s `role` and `text`: a question as typed, its photos counted as its `images` and a
voice note as its `voice` (`{audio, ms}`), an answer's words without its `[rN]` citation handles;
`title` reads a `chat`'s `title`, its time its last turn's. An answer's `refs`, `steps` (their `line` too), `access`, `model`, `ms`, `end` and `error` are not
read. A stopped answer prints the words written before it stopped; a failed one the words
written, and no line when none were. Ask's own search tool leaves out hits from `ask:` sources,
so it never cites its own earlier answer.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `chat` | `<chat>` | `{type: "ask.chat", title, at_ms}` | `at_ms`: its last turn's instant |
| `msg` | `<chat>:<n>` | `{type: "ask.msg", chat, n, at_ms, role, text, seen?, refs?, steps?, access?, model?, thinking?, ms?, thought_ms?, end?, error?, failed?}` | `at_ms`: the instant the message was made |

A row's time is its content's `at_ms` (`StatementKind.time`), read through core's `instant`; the
statement is stated at the delivery's `fetched_at`, as every owner statement is. Every member not
named here is refused.

- **`<chat>`** matches `^[0-9]{13}-[0-9a-f]{6}$`: the made-at in ms, a dash, six random hex
  digits, minted by the Ask server when a conversation begins, so keys sort in time.
- **A chat:** `title` 1 to 200 characters, never null: the question's opening words until the
  model's title for it replaces them; `at_ms` ms since the epoch. It is stated again with each turn, so its newest version holds the newest
  title and its last turn's instant.
- **A message:** its key is `<chat>:<n>`, `<n>` four digits from `0001`, agreeing with its `chat`
  and `n` (1 to 9,999). `role` is `user` or `assistant`.
  - A question (`user`) holds exactly `type`, `chat`, `n`, `at_ms`, `role` and `text`, and may
    hold `photos`, 1 to 10 distinct blobs `sha256:<64 hex>` in the order attached, and `voice`,
    `{audio, ms}`: the note's audio, a blob, and its length in whole milliseconds, 1 to 600,000.
    `text` is the words as typed, not empty; in a question with `voice` it is `""`, the question
    being the note. The note's words are never in the record: they are the ai family's ask of it
    ("What a model does").
  - An answer (`assistant`) holds those, its `text` the Markdown the model wrote with its `[rN]`
    handles (possibly empty, when it stopped or failed before a word), and may hold `refs`, each
    cited handle `r<n>` to the door's citation of its ref (`packages/home/search-contract.ts`
    `citation`, served by restore beside the answer's words and by `/v1/describe`), kept exactly as
    the door made it: its `ref` (opaque, the door's to read), its `kind`, the words a capsule shows
    and where it opens (`opens`: Days on a `day`, at a `focus` when the day prints one and a window's
    minute as `span`; People or Places at an `id`, a listed chat with the `person` an app with no chat
    page opens; or `read`). A thing (`record`, `message`, `turn`, `line`, a `photo` with its
    `image`) may hold `day`, `at`, `title`, `chat` and `chat_title` (one no day prints opens through
    `read`); a `record`, `message` or `line` that is a voice note may hold `voice`, `{audio, record}`
    and optional `{seconds, from, mine}`, the note's blob and its own record ref, whose `audio` is no
    file of the answer, so a kept answer holds back no erasure of the note; a screen `window` holds `day`, `app`, `title` and may hold `at`; a count's `row` its
    `asked` and `n`; a `person`, a `chat` or a `place` its `name`; a ref that named nothing held is
    `gone` with its `why`, and opens nothing. Where restore described none, the
    handle keeps `{ref}` alone, which a surface describes when it draws it. `seen`, on a `done` or
    `stopped` answer only, is what the model read and wrote that turn, kept when the turn hid
    something: `asked`, spans over the question's words as the person sees them (a voice question's
    written words, which `spoken` then holds), `answered`, spans over this answer's `text`, and
    `photos`, one per question photo, the picture the model got (a blob) or `null` when nothing on
    it was drawn. A span is `{start, end, placeholder}`, those words sent or written as the
    placeholder (zero-width: the model read it there, with no words of the person's), or a
    zero-width `{start, end, added}`, plain text the model read there; offsets are UTF-16 code units,
    the spans sorted and never overlapping; `answered` holds placeholders only, within `text`. The reader holds
    their shape; that they rebuild the text the model read is the Ask server's check. The reader holds each to
    the contract's members and their forms, read from its shape, and keeps every word as written
    (empty, or `«»`); a citation the contract does not define is refused, its line with it.
    [test/citable.json](./test/citable.json) holds what the door makes beyond its contract fixture
    and what the contract refuses. `steps`, each `{name, words, ms, error?, line?}`, the tools it used: `line` a call's line in
    the steps line a follow-up reads (`[Steps of this answer: …]`), its arguments as the model wrote them and the handles
    it gave or its refusal, restored as `words` is, on a step of a call alone; `access`, in order, each change
    the turn made to a reader's access through Chat's `agents` tool, as the door answered it (`AccessChange`:
    `narrowed` with its `reader`, `words` and `undo`, `unchanged` with its `reader` and `words`, or `asked`
    with the request's `snapshot`, whose `id` is the change's), kept whole for the app's line and card;
    `model`, the model's id; `thinking`, how hard it thought (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`
    or `max`); `ms`, whole milliseconds it took; `end`, `done`, `stopped` or
    `failed`; and, on a `failed` answer only, `error`, what failed, and `failed`, its kind: `login`,
    `door`, `model`, or `restart` (the Ask server closed mid-turn).

The ai family reads both kinds as its third provider ([ai](../../../families/ai/)): day lines for both sides, Find text for the
questions (a voice note's words once written), the answers and the titles, and no gist asked of an
answer, which is already a model's.

## What a model does

Two works, each the stream's own setting:

- **`chats`** (`AI_CHATS`), the ai family's long turns: an Ask question is typed, so this asks
  only of a question of 4,000 characters or more.
- **`voice`** (`ASK_VOICE`, "Voice notes"): each voice note's words, one ask per note
  (`askVoiceNote`, item `voice:<audio hex>`), asked by the home the moment the note is sent and
  stated again by the family's plan, which the ledger answers with the same one call. The work is
  `as_is`: on a route that leaves (Scribe v2 on OpenRouter) the audio goes as it is, whatever Chat's
  privacy level, its row saying "Sent as it is". With its setting unset it is served by the Voice
  notes default, and with that Off no note is written out.
The person's Find finds their past answers; Ask's own search tool leaves out hits from `ask:`
sources, so Ask never cites its own earlier answer.
