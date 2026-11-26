# google-places

The google-places labeler and the connector that reads what it delivers. It asks Google's Places
API (New), with the owner's one Google key, about the places the home owes a name, and keeps each
answer as Google gave it, so the suggester names a spot from what Google said around it. It also asks Google the name
of each Timeline place ID the home holds no name for. Beside it, `typedSearch` is the typed search
the home asks while a person types a name (below); it keeps nothing.

## Source

`google-places:<home>:nearby`, where `<home>` is the home machine's unit (the `unit` setting), as
the cameras labeler's is. The labeler writes its deliveries; nothing else ships
to this source. Its facts name the source and its connector (`sources`), so the home makes the
source with the first delivery. Product `google-places` (Google Places).

| Kind | Key | Content | Time |
|---|---|---|---|
| `answer` | `<request>:<lat5>,<lon5>:<radius>`: the request, the centre asked about to five decimals, the radius in metres (`nearby:48.85661,2.35222:150`) | `{type: "google-places.answer", places?: [...]}`, Google's answer as it gave it beside its type: each place's `id`, `displayName`, `location`, `types` and `primaryType`; no `places` when Google found none | the asking |

An answer is asked once and kept: it is never asked again, and never `gone`.

## The key

The vault item `google-places`, typed in
the Mac app's window or `lifestream secret set google-places`. The labeler declares it
(`Labeler.secrets`), and the home answers its helper's request for it and no other. With no key
stored, an empty one, or the vault locked, a run asks nothing and delivers nothing. Sealing the key
makes the labeler run at once (home.ts), and that run asks what is owed. A key Google refuses (401,
403, or 400 naming the API key: `keyRefused`, the labeler's and the typed search's one rule) rests
the labeler `refused`; the home keeps that key's value, as the vault stores it, refused in its
memory (home.ts `#refusedKeys`), and while the vault holds the same value no labeler run is handed it and no typed
search asks with it, whichever of the two Google refused; a new key sealed is tried at once.

## The typed search

`typedSearch({key, endpoint}, point, q)` asks Google's Autocomplete (`POST
/v1/places:autocomplete`) for the places near a point whose names match the words typed: one round
trip, a bias of 1.5 km around the point and the point as the origin, at most five place
predictions, each `{id: "google:<place ID>", name, types, distance_m}` (`distance_m` null when
Google states none). `q` is trimmed; under 2 characters (an empty one, a card's first ask, which
learns how the key stands) Google is asked nothing; over 100 is refused. It answers `answered`, `refused` (the key itself, `keyRefused`) or `unreachable` (no
network, 4 s passed, any other refusal). Only the home process calls it (`places-search`, which
the door relays a device's words to); nothing of its answer is stored, so R4's keys gain no request. Before it asks, it states the
request to `lookup` (`{receiver: "Google", request: "autocomplete", points: 1, chars}`, the words'
length), which the home writes as a `lookup` row of the outbound log; a
statement that throws sends nothing.

## What the labeler reads

No extract, and of the records only its own answers and the lookup's names: what it owes is what the home's `places` job prepared, the `owed` row of
this machine's Places file ([home/places.ts](../../../home/places.ts)), handed to it by the
home's registry as the cameras labeler is handed its unit: connect does not import the families,
and the one fold of To name is the one the list shows. None before the job's first run: it asks
nothing until then. The `places` event, which says the file moved, makes it due
(`Labeler.events`); so do its own delivery's landing, the key sealed and the home's start. Every
run reads its answers, however old.

A names delivery feeds two sources: its own, which reads no row of it, and the account's lookup.
The home starts no run while any row of its newest delivery waits to import, whichever source the
row is for (import.ts `labelKind`), and the commit that lands, supersedes or gives up the last of
those rows, the lookup's or its own, makes it due (due.ts): a run never asks again while the names it paid for wait in the lookup's
import, queued, paused or failing. While that import is stopped, the labeler does not run at all,
nearby answers included; it runs again when that import does.

## What it asks, and never beyond

1. **Each spot in To name, in the asking order.** A hidden spot is never one, nor a spot inside a
   named place. For each:
   - `nearby`: Google's 20 nearest within 150 m (`rankPreference` `DISTANCE`);
   - `venues`: the 10 most popular big places within 300 m (malls, hospitals, campuses, stadiums,
     stations, subway stations, parks, beaches, temples, churches, mosques, synagogues, hotels);
   - then `airport` (5 km) or `beach` (1.5 km), the one most popular (`includedPrimaryTypes`,
     `rankPreference` `POPULARITY`), when a neighbour's name in the first two says one
     (families' [shared/suggest.ts](../../../families/shared/suggest.ts) `bigHints`).

   The field mask is `places.id,places.displayName,places.location,places.types,places.primaryType`:
   no more than the suggester reads.
2. **Then each Timeline place ID no Google name holds yet**: Place Details, field mask
   `id,displayName,location`, for one account a run. Each name lands in that account's
   `google-maps:<account>:lookup` as a `google.place` statement, as an export's names do
   ([places](../../places/places.md), `google-place-names`). The names' delivery states the lookup
   source beside its own, so the home makes an account's lookup with its first names, an owner
   source on no lane (import.ts `index`). An ID whose name the lookup already holds (a live
   `place` record, one seek an ID) is not asked: Places prepares `owed` again only after the names
   land, so `owed` may still name it. An ID Google does not know (404) is not asked again while
   the helper runs.

A request answered by an answer whose centre lies within 40 m is never asked again, however old
the answer: a spot's centre moves a little as stays join it, and Google answers the same spot the
same way, so an answer asked again would land as the same version and leave its time unchanged. The answers are held by
request and by band of latitude, so a spot finds its own among a few; their places are read only
for a spot whose two answers around are both held, to ask its hints. The suggester takes an answer
asked within 120 m of the point it is asked about (a spot's reach and these 40 m). A run asks at most 60 requests (`PER_RUN`); the landing of
its delivery wakes the next run for the rest. A home asks Google at most 500 times in any 24 hours
(`PER_DAY`), both kinds of request together, counted from the `lookup` rows of the outbound log
(`GooglePlacesSettings.looked`, registry-home.ts `lookupsOf`), so a restart forgets none: a run
that finds none left asks nothing and delivers nothing, and the next `places` event or start after
the 24 hours asks the rest.

## One run

1. **Read**, before the first await: the key, what is owed, the held answers' keys and times, what the last 24 hours asked,
   each owed spot's plan (the requests it lacks; its hints, when its answers around are held), and
   the IDs to ask: one account's, up to 60, none the lookup holds.
2. **Ask** each spot's requests in order, keeping each answer. Before each, the labeler states it to
   its settings' `lookup` (`Lookup`: `searchNearby` with one point, or `place` with the ID's length
   in characters), which the home writes as one `lookup` row of the outbound log
   (registry-home.ts `lookupWriter`); a statement that throws ends the run as a refusal does, and
   that request is never sent. Nothing owed, all held or none left today: the run delivers nothing.
3. **Deliver** the answers as one `google-places.ndjson` (facts `{answers, owed, sources}`); or,
   with no answer owed, the names as one `statements.ndjson` (facts `{statements, device, owed,
   sources}`, the lookup source beside its own), which this connector reads as no row.

A request Google refuses (a bad key, a quota) or that does not reach it ends the run: what was
answered before it lands, and the labeler rests (`LabelerUnavailable`, `unreadable`); its message
names the status and never the key.

## The connector

`google-places` reads `google-places.ndjson`, one canonical line per answer:

```
{"at_ms":1792497600000,"content":{"places":[…],"type":"google-places.answer"},"key":"nearby:48.85661,2.35222:150","kind":"answer"}
```

Every line is read and checked before its first row is given: a line that is not JSON, holds
other members, names a key of no request or a centre not to five decimals, states no asking time,
or another type refuses the whole delivery. A delivery without the file (the labeler's names)
yields no row.

## Cost

About three requests a spot, Nearby Search at about $32 per 1,000. The first run on the first home
owes about 154 spots, about $15; after that, new spots only. The Timeline's place IDs cost Place
Details, about $17 per 1,000 IDs, each once: about $5 for the owner's home (about 290 IDs), more for
a home of years of Timeline, at most 60 a run.

## Tests

[e2e.test.ts](./e2e.test.ts): the labeler against a fake Google on loopback (what it asks, the
hints, nothing twice however old, at most `PER_DAY` a day, nothing with no key, the bound, a refusal, a refused key
resting `refused` and a new one tried, the Timeline's names, an account's first lookup, each request stated
to `lookup` before it is sent and none sent when the statement throws) and the connector's refusals. The home's side (a hidden spot never asked about, the key typed later, an
unhidden spot asked about, the typed search with no key, one character, an unreachable Google, a
refused key asked no more by the search or the labeler until another is sealed, each request's
`lookup` row written before it is asked) is
[home/suggest.e2e.test.ts](../../../home/suggest.e2e.test.ts).
