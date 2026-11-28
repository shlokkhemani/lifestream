# Apple's activity log: `screen-time:<apple id>:<unit>`, `now-playing:<apple id>:<unit>`

**Reads** the Mac's copy of Apple's activity log (Biome), one stream per source, as the Mac app
ships it (its store declared in `store.ts`, read by `macos-app/Sources/Shipping/Stores/BiomeEngine.swift`): the SEGB segment files of
`~/Library/Biome/streams/restricted/<stream>/`, raw, at their places in the stream with `.segb`
after the name (the log's own names have none). macOS syncs
each of the person's devices' copies here, so one source holds every device's records.

| Source | Stream | Connector |
|---|---|---|
| `screen-time:<apple id>:<mac unit>` | `App.InFocus`: every app coming into and leaving focus | `biome-app-in-focus` |
| `now-playing:<apple id>:<mac unit>` | `Media.NowPlaying`: every play, pause and track change | `biome-now-playing` |

| Kind | Key | Content | Time |
|---|---|---|---|
| `app-focus` | `<device sync id>:<field 4, µs basic form>:<field 6>:<in\|out>` (`0000BBBB-…:20260901T211320.75Z:com.example.maps:in`) | `biome.app-in-focus`: `format`, `written`, `fields` | field 4 |
| `now-playing` | `<device sync id>:<field 2, µs basic form>:<field 3>` (`0000BBBB-…:20260901T211320.125Z:1`) | `biome.now-playing`: `format`, `written`, `fields` | field 2 |

## What a delivery holds

- `local/<segment>.segb`: this Mac's own records. The facts state this Mac's sync id as
  `local_device`; a delivery with a local segment and no `local_device` is refused.
- `remote/<device sync id>/<segment>.segb`: another device's records, synced. The folder names the
  device. Which device each sync id is, the owner attests; the key keeps the id, so a record
  has one key from any copy.
- `local/tombstone/…` and `remote/<id>/tombstone/…`: the log's own record of what its retention
  deleted. Shipped, never read: they state storage housekeeping, not the person's acts.
- A delivery carries only the segments whose bytes changed since the home last took them, so
  it states what those segments hold and nothing about the others.

## The segment

A 32-byte header (`SEGB`, the entry count, the creation time), the records from offset 32, and
an index of 16-byte entries growing down from the end: each states its record's end, its state
and the time it was written. A record is a CRC-32 of its protobuf, a u32 the log writes per
stream (10 for App.InFocus, 1 for Media.NowPlaying: `format`), then the protobuf.

| Entry state | Means | Row |
|---|---|---|
| 1 | written | one row |
| 3 | deleted by the log's retention (about four weeks): bytes and CRC zeroed in place | none, and never `gone`: retention is not the person deleting |
| 4 | the segment is closed; its time names the next segment | none |

Any other state, an index past the records, or a written record whose CRC fails refuses that
segment, named by its path, after the records before it; a protobuf that does not read refuses
its record alone (`<segment>:entry <n>`). The other segments are read. The Mac app ships
only segments that read whole, so a segment caught mid-write waits for the next bundle.

## Content

`fields` is the protobuf, every field it states, keyed by field number; the connector names
none and drops none. With no schema, a field's JSON follows its wire type: a varint is a number
(a decimal string past 2^53), a 64-bit field a double (`{"fixed64": hex}` when not finite), a
32-bit field `{"fixed32": n}`, a length-delimited field UTF-8 text (`{"base64": …}` when it is
not). Media.NowPlaying's field 14 is a message and kept as one. A field stated twice is a list.
`written` is the index entry's time, seconds since 2001.

What the fields hold, as measured:

| Stream | Field | Holds |
|---|---|---|
| App.InFocus | 1 | the transition's reason, when stated (lock, unlock, the app it came from) |
| | 3 | 1 coming into focus (`in`), 0 leaving it (`out`) |
| | 4 | the time, seconds since 2001 (double); always equal to `written` |
| | 6 | the bundle id |
| | 9, 10 | the app's version and build |
| | 2 | 1, or 3 (meaning unknown) |
| | 11, 12, 13 | small whole numbers, meaning unknown |
| Media.NowPlaying | 2 | the time, seconds since 2001 (double); `written` follows it by milliseconds |
| | 3 | the state: 0 unknown, 1 playing, 2 paused, 3 the previous item changed, 4 interrupted (MediaRemote's) |
| | 8 | the title of the track or episode |
| | 5 | the artist, or a podcast's author |
| | 4 | the album; none for a podcast |
| | 6 | the length in whole seconds |
| | 10 | the media type, when stated (`MRMediaRemoteMediaTypePodcast`, `kMRMediaRemoteNowPlayingInfoTypeAudio`, `…Video`) |
| | 11 | an id, when stated, meaning unknown |
| | 14 | the output route: two numbers and `Speaker` or a device address |
| | 15 | the app's bundle id (`com.spotify.client`, `com.atebits.Tweetie2`) |
| | 13, 20, 21 | whole numbers, 0 in every record measured, meaning unknown |

At a track change the log writes two entries within a millisecond: state 1 with the new item,
then state 3 with the previous item (its own title and length). The pair is sometimes written
again as the metadata settles.

The time's µs is read from the double's six-decimal spelling; the key and the record's time
come from that one spelling. A record missing a part of its key (or whose time is not a time)
is keyed `<device sync id>:<fingerprint of its fields>` and lands, without a time when it states
none; none was measured. A record that states no field at all is refused alone.

## Rules

- One key stated twice in a delivery (the log writes the same record twice now and then) is one
  record.
- A record is written once. Retention zeroes it; nothing else changes it. Absence never states
  `gone`.
- The Mac app ships at most one bundle per stream every 5 minutes on power, 15 on battery and 30
  in Low Power Mode, so a phone's records reach the home up to that long after the Mac holds
  them, and the Mac holds them when the phone syncs: hours to
  days after they happened.


## What the families read

Three adapters, one file a family. Each reads the
device as the sync id the key starts with.

- **Phone** (`adapter-phone.ts`, `screen-time`): an `app-focus` record is a focus change, field 3
  (1 coming into focus, 0 leaving) and field 6 (the bundle id), at the record's time
  ([phone](../../families/phone/)). The reason (field 1), the app's version and build and
  the fields whose meaning is unknown are not read.
- **Listening** (`adapter-listening.ts`, `now-playing`): a log (`player: false`), one entry a
  record. Field 3 is MediaRemote's state: 1 playing; 3 the previous item changed, naming that item;
  0 unknown, 2 paused, 4 interrupted. Field 8 the title of the track or episode, 5 the artist or a
  podcast's author, 4 the album (none for a podcast), 6 the length in whole seconds, 15 the app's
  bundle id ([listening](../../families/listening/)). The output route, the media
  type, the ids and the write time are not read.
  A play Spotify casts to a TV states field 5 as `Listening on <the TV's name>` and field 8 as
  `<title> • <artist>`, often with ` • Video Available` after it: when field 5 begins
  `Listening on `, the item's title is field 8's first ` • ` part and its artist the second, and a
  last part `Video Available` is Spotify's label, not the item's. So a cast play and the phone's
  entry of it are one item, never a track whose artist is a TV. The record is unchanged.
- **Health** (`adapter-health.ts`, `screen-time`): a `usage` record of an hourly segment
  (`segmentInterval.kind` `hourly`) is the hour's `totalActivityDuration` and each category's,
  summed under its `localizedDisplayName` (two `System` tokens print once), with the line's
  `captured.wall_rfc3339` as when the phone captured it ([health](../../families/health/)).
  A category with no display name is `unnamed`: its token is opaque and never matched to a name.
  The segment's `lastUpdatedDate`, build, query window, apps, web domains, pickups and
  notifications, and the usage `catalog` (what is installed, not what was used), are not read.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds the hashes of the segments it carried and its fetch instant. `BiomeDomainTests` hold each answer.

1. **Order.** No ordered item: the log rewrites a segment in place through a mapping (4 of 5 measured), so a segment ships when its bytes are not a hash a seal up to `received` carried. At most one bundle every 5 minutes on power, 15 on battery and 30 in Low Power Mode (`BiomeEngine.spacing`), from the newest seal's fetch instant.
2. **Reuse.** Not applicable.
3. **Rebuilds.** Biome is per macOS user: a new user is a new log.
4. **Late arrivals.** Synced devices' segments appear under `remote/<device>/` at any time, and a segment gains records: the hashes, not a name or a time, decide.
5. **Edits.** A changed segment ships again whole.
6. **Lost.** A restore ships again the segments the rolled-back seals carried. Biome deletes old segments on its own schedule, and what it deleted cannot be named, so nothing is stated.
