# The phone's shipment

The phone ships one ZIP: `manifest.json`, one `<domain>.jsonl` per domain it records, and
the blobs those lines name as `blobs/<hex>`. The door seals it as the Mac's bundles are sealed:
the blobs go into the lane's blob store, every other member is a file of the delivery at
`bundle/<member>`, and the ZIP is not kept, so `blobs/` holds each photo, video and voice note
once; a file outside `bundle/` refuses the delivery (`BUNDLE_MANIFEST`). A file may instead travel
on its own before the bundle that names it, `PUT /v1/files/sha256:<hex>` from the byte the door
holds; the door stages it and links it into the lane when that bundle seals, so a sealed bundle
holds its staged files as if it carried them (the door's page, "A phone's files"). A bundle naming
a file neither it, the lane, the stage nor the home holds, past the files it states lost, is 409
`FILES_MISSING` with their names. A shipment derives one source
per domain file it carries; each derived source's delivery holds the same files, and its
connector reads only its own domain's file. A domain the home has no source for
(`iosBundleSources` names it with source null) lands nothing.

The phone is the shipment's lane, `phone:<unit>`, which names the delivery
(`phone:<unit>/<bundle id>`) and feeds every source the phone's pass delivers that states a lane:
its unit's, and its account's, named by the Apple ID it states at pairing. The owner's places,
which the pass also delivers, state none and are fed only by owner statements. `apple-health:<account>:cloud` is the
account's one copy, so every phone of the account feeds it, each with its own seals. Every row's `device` is that unit, a library photo's too; the
photos family reads none of it: a photo's camera is the cameras labeler's word on its file. Its `locator`
is `<domain>.jsonl line <n>`. The statement time is the manifest's `created_at`.

A recorder key is `<install id>:<sequence>`: the app install the manifest states and the
line's recorder sequence. Overlapping shipments restate the same records; a reinstall
opens new keys.

**A line is the unit of refusal.** The manifest and the members are the shipment's: a member that
does not match what the manifest states refuses the whole delivery, and a domain file whose line
count or last sequence is not its manifest's refuses the rest of it once its lines are read. Past
that, each connector reads its domain's lines one by one: a line it cannot read (not UTF-8, not
one JSON object, another domain's, mixing its clocks, a sequence not the manifest's for its place,
a kind it does not know, an instant core cannot read, a span that ends before it starts) is refused alone, named
`<domain>.jsonl line <n>`, and the next line is read. A line that only names a blob the home lacks
lands, its record wanting the blob.

| Domain | Source | Connector | Kind ← entry kind | Key | Time |
|---|---|---|---|---|---|
| `location` | `location:local:<unit>` | `location-ios-bundle` | `fix` ← fix; `gap` ← gap; `recorder` ← recorder_event, lifecycle | recorder key | captured wall clock, with its offset; a gap its own `start` to `end` |
| `motion` | `motion:local:<unit>` | `motion-ios-bundle` | `motion` ← activity; `sample` ← pedometer_day; `recorder` ← recorder_event | recorder key | captured wall clock |
| `usage` | `screen-time:local:<unit>` | `usage-ios-bundle` | `usage` ← activity_segment; `catalog` ← activity_catalog; `usage-event` ← shortcut_marker, monitor_callback; `recorder` ← usage_acquisition | recorder key | `observed_at`; a segment its `dateInterval` |
| `voice` | `voice-notes:local:<unit>` | `voice-ios-bundle` | `voice` ← voice_note | recorder key | `observed_at` |
| `camera` | `camera:local:<unit>` | `camera-ios-bundle` | `img` ← photo | recorder key | `observed_at` |
| `health` | `apple-health:<account>:cloud` | `health-ios-bundle` | `sample`, `workout`, `sample-uuid`, `state-of-mind`, `dose` ← sample; `medication` ← medication_list; `characteristic` ← characteristics; `recorder` ← recorder_event | below | below |
| `contacts` | `apple-contacts:<apple id>:<unit>` | `contacts-ios-bundle` | `contact` ← card, gone | the system's identifier for the contact | none |
| `photos` | `apple-photos:<apple id>:<unit>` | `photos-ios-bundle` | `img` ← asset; `img-file` ← resource_availability; `recorder` ← sweep | below | below |
| `checkin` | `checkin:local:<unit>` | `checkin-ios-bundle` | `report`, `vigilance`, `prompt` | recorder key | `observed_at` |
| `notes` | `notes:local:<unit>` | `notes-ios-bundle` | `note`, `folder` | its id | a note from `created` to `modified`; a folder none |
| `energy` | `energy:local:<unit>` | `energy-ios-bundle` | `energy` ← parts, power_state, metrickit_payload, metrickit_diagnostic | recorder key | a window its `window.start` to `window.end`; a MetricKit payload or diagnostic its `range_start` to `range_end`; a power state `observed_at` |
| `machine` | `machine:local:<unit>` | `machine-ios-bundle` ([machine](../macos-app/machine/machine.md)) | `machine-event` ← machine-event | recorder key | `observed_at` |

**Location, motion, usage, voice, camera, energy, check-ins.** Content is
`{type, content: <the line>}`, the line every member as the phone wrote it; `type` names the
payload (`location.fix`, `motion.pedometer-day`, `checkin.report`, …). A line states the
seconds elapsed in the process that took it (`captured.elapsed_seconds`) and that process's
id (`process_instance_id`), or a boot's clock (`boot_id` with `captured.monotonic_seconds`),
read as stated: the phone sends every line as recorded. A line mixing the two clocks is refused by every
connector, as that line's refusal; the door takes its bundle, which it checks only whole. A voice or camera
line names one blob, which the shipment carries or an earlier one did; the row lists it. A
blob neither holds lands wanting it: the door took the row only as a file the phone stated lost.
An entry kind the connector does not know refuses its line. A location gap (`location.gap`)
is its own kind, apart from the recorder's diagnostic events, and is timed by the span it
states, so a reader of a time range finds the gaps over it and reads no event: a day holds
about thirty gaps among seven thousand events. One without `start` and `end`, or ending
before it starts, refuses its line.

**Energy.** What each part of the app costs. Every entry is one `energy` record, its type
naming the entry kind: `energy.parts`, `energy.power-state`, `energy.metrickit`,
`energy.metrickit-diagnostic`. A window or
a payload whose span ends before it starts, or states none, refuses its line.

- `parts` is one window of the app's own accounting, at most about fifteen minutes long, and
  one per stretch on screen. The app reads its process's kernel counters
  (`task_info(TASK_POWER_INFO_V2)`) at every start and end of a part's work and credits what
  accrued since the last read to the set of parts that had work open meanwhile. `accounts`
  lists those sets (`parts`, `[]` for the app's other work: its screens, notes, and anything
  not yet a part) with the CPU time (`cpu_ns`, `cpu_p_ns` on performance cores), the
  kernel's CPU-energy estimate (`energy_nj`, null when `energy_stated` is false: the kernel
  kept none) and the wakeups. The accounts sum to the process's counters over the window,
  stated in `process.start` and `process.end`; parts open together share an account and are
  never split. A part waiting on a part it called is paused, so the called part's work is its
  own. `intervals` counts each part's intervals begun in the window, `open` names the parts
  still open at its end. Outside the process nothing is counted in joules: `holds` states how
  long hardware was held at each setting (`location.precise` and `location.keepalive` at
  their desired accuracy in metres, `camera`, `microphone`, `foreground`), `wakes` the
  callbacks iOS delivered while the app was not active, by trigger, and `transfers` the
  bytes each part's network tasks moved, by interface (`cellular` or `other`). Work after
  the last window of a process that iOS ends is in no window; MetricKit's daily CPU time is
  the total the windows are measured against. A window also states `build` (the commit the app
  was built from, `unknown` when not stamped), `threads` (the window's CPU by thread: `main`,
  each named thread, `other` for dispatch's unnamed workers, `ended` for threads that ended in
  it) and `counts` (the window's work counters, each left out at 0: `photo_passes`,
  `photo_passes_walk` with no bookmark, `photo_assets_snapshotted`; `photo_whole_reads_full` (whole reads begun under
  Full access) and `photo_stated_unlisted` (the photos the phone stated live that such a read's list lacks: a measure,
  nothing is stated `gone` from it); `location_checks_<woke_by>`
  (the still-checks by what started them: `adaptive_timer`, `motion`, `geofence_exit`, `recording_quiet`, the
  last a check begun at recording's deadline, when no fix came for the settle time), `location_recording_restarts`
  (the recording manager stopped and started at that deadline with nowhere to check against, or after its check went
  unanswered while Core Motion last said walking or a vehicle),
  `location_checks_no_fresh_fix` (the checks that ended with no fix made since their start, each a
  silence the home may read), `location_check_late_lt1s`, `_1to5s`, `_5to15s` and `_ge15s` (how late the timer that
  started or ended a check acted against the time it was armed for) and `location_check_pair_late_ge15s` (a check whose
  start and end were 15 s late or more together, which the still watch's bound assumes never happens), `motion_mode_changes`; `geofence_armed_locked` and `geofence_armed_unlocked` (settles
  whose catch geofence the monitor took at once, the phone locked or not), `geofence_deferred` (settles left owed),
  `geofence_armed_at_unlock` (owed circles armed at an unlock or a launch's setup); `health_delivery_refused` (types whose background delivery
  ask was refused), `health_sweeps` (types swept), `health_pages` (pages written, each one transaction; a sweep that
  finds nothing writes none), `health_samples`, `health_deletions`; `store_transactions` and
  `store_transactions_<cause>` (write transactions, counted as attempts before each begins, so a failed one counts, and
  attributed to what began it: the domain of a durable append, `location`, `health` and the rest, with the waiting
  readings it saves too; `flush` for a save of waiting readings alone; `anchor` for a reader's mark set alone; `other`
  for facts, the ledger and custody), `store_level_bytes` and `store_level_rows_<domain>` (the store's size, a level
  sampled once a process in its first window, not a count: the database and its WAL, and each domain's newest
  sequence, its row count since no row is deleted; a day's reading is the latest sample in it), `store_waited`
  (readings that waited to be saved), `store_flushes_<cause>` (`timer`, `cap`, `durable`, `status`,
  `call`), `store_dropped` (readings lost because the store was full and could not save),
  `file_syncs`;
  `ship_passes`, `exchanges`, `bundles_sealed`; `send_cause_<cause>_<battery|power>`, each pass by why its send was
  due, so they sum to `ship_passes`: the first event's name (`visit`, `exit`, `moving`, `settled`, `power`,
  `background`, `network`, `saved`, `shared`, `read`), `fix` or `entry` for unsent work whose interval ended, `held`
  for a held bundle's hour, `ask_<reason>` for an ask (`wake`, `processing`, `foreground`, `manual`) and
  `ask_refresh` for a Refresh now's send of one stream; `unlocks`, the
  phone unlocked (each one an `ask_wake`); `network_updates_same`, path updates that changed no road and were not
  told). The parts are `location`, `motion`, `health`, `photos`,
  `contacts`, `usage`, `shipping`, `checkin`, `places` and `energy`.
- `power_state` is the phone's battery level and state, Low Power Mode, thermal state and
  background refresh, recorded when one changes. The battery is the whole phone's.
- `metrickit_payload` is MetricKit's daily payload, its JSON bytes kept as `json_base64`:
  the app's CPU, GPU, location, network and screen time for the range, and per part
  (`signpostMetrics`, category `Parts`) the count, durations, CPU time, memory and disk writes
  of its intervals, a paused parent's whole interval included. The app states each payload
  it is handed, the past ones again at each start, so one range can be stated more than once.
- `metrickit_diagnostic` is a MetricKit diagnostic payload (crashes, CPU and disk-write
  exceptions, hangs, with their call stacks), its JSON bytes kept as `json_base64`, stated the
  same way.

**Health.** A sample of any type is a `sample` record keyed by the fingerprint of its seven
identity strings and a `sample-uuid` record keyed by HealthKit's lowercase UUID, which states
the identity the UUID named (`connect/health/apple/apple.md` has the sample rules); a workout is
the same, its kind `workout`, its value its activity type (`workout_activity_type`, named), its
detail its `duration_seconds`, `total_distance` (metres) and `total_energy` (kilocalories), each
HealthKit's number and unit, `workout_statistics` (each type's sum, average, minimum and maximum
in its own unit) and `workout_events`, in the one shape the export's workout reads to
(`apple.md`, **A workout**); an earlier phone states `total_distance_description` instead. A quantity is
HealthKit's number in the unit HealthKit documents for its type (`quantity_value`,
`quantity_unit`: the phone's `HealthUnits`, the home's `NATIVE_UNITS`, one table), keyed as the
export's spelling of the same measure keys (`apple.md`, **Unit**); an earlier phone states its
description instead (`quantity_description`, `72 count/min`, whose `%` prints a fraction as a
percent). Every other
member a sample line states beside the identity, time, source, device and metadata is its
content's `detail`, as stated: a correlation's `correlation_objects` (its member samples' lines,
less their archives), an electrocardiogram's `electrocardiogram` (classification, symptoms,
average heart rate, sampling frequency and `voltages`), a heartbeat series' `heartbeat_series`
(`count` and `beats`). The voltages and the beats are each a blob the shipment carries,
`application/x-ndjson`, one `[seconds from start, microvolts]` of its one lead or `[seconds from
start, preceded by a gap]` per line; the line names it `{hash, bytes, type}`, and the record keeps
it as its version's blob, never in its content. The phone reads a page of 20 such samples at a
time, each series stored before the next is read; an audiogram's `audiogram` (its sensitivity points
and each one's tests), a scored assessment's `scored_assessment` (score, answers, risk). A
`deleted_sample` names a UUID and is never lost: it states `sample-uuid:<uuid>` gone whether or
not the home holds it, and its sample `gone` when the identity is known, through the shipment's
samples, then the source's `sample-uuid` record, unless the shipment also states a live sample
under the same identity (HealthKit's rewrite: delete 303, insert 305). One shipment, one final
state per sample. HealthKit reports deletions of samples no sweep captured (older than the first
sweep's start, inserted and deleted between two sweeps): each lands its UUID's tombstone, one
`gone` head with no version. A sample line whose UUID stands gone in the home (its deletion landed
before a later code read the line) lands as one this shipment deletes: its identity row, then its
sample and its UUID gone, not live (see **Order** below). A deletion whose type differs from the
sample it names is refused, and the sample lands. A workout's deletion states its `workout` gone. One corner is
accepted, a double fault: a sample refused under one code, whose deletion states a wrong type,
lands the UUID's tombstone; under a later code the sample is withheld, though its deletion would
have been refused for the mismatch.
A recorder event is `{type: health.recorder, content: <the line>}` timed by the captured
clock. A workout route lands nothing: a route has no record yet.

**State of Mind and medication doses.** A sample of `HKDataTypeStateOfMind` is a
`state-of-mind` record; one of `HKMedicationDoseEventTypeIdentifierMedicationDoseEvent` is a
`dose` record. Each is keyed by HealthKit's lowercase UUID: Apple's export states neither type
(its DTD has no element for them), so no fingerprint has to agree with a second reader, and
they have no `sample-uuid` record. Content is `{type: health.state-of-mind | health.dose,
...<the sample payload>}`, every member the phone stated but `secure_archive_base64` (the
phone's archive of the whole object, not a field of it), timed by its own start and end. A
start or end that is not an RFC 3339 instant refuses its line. A bundle may carry a dose or a
`medication_list`; the connector lands them.

- `state_of_mind`: `kind`, `valence`, `valence_classification`, `labels`, `associations`,
  HealthKit's raw integers as the phone read them (`HKStateOfMind.h` names them: kind 1
  momentary emotion, 2 daily mood; classification 1 very unpleasant to 7 very pleasant;
  label 1 amazed to 38 satisfied; association 1 community to 18 weather). An integer
  outside those lists is kept.
- `medication_dose_event`: `log_status` (1 not interacted, 2 notification not sent, 3
  snoozed, 4 taken, 5 skipped, 6 not logged), `schedule_type` (1 as needed, 2 scheduled),
  `scheduled_date_rfc3339`, `scheduled_dose_quantity`, `dose_quantity`, `unit` (HealthKit's
  unit string), `medication_concept_identifier` (`domain` and the phone's secure archive of
  HealthKit's opaque identifier) and `medication`: the concept that identifier names in the
  person's medication list when the phone could read it (`display_text`, `general_form`,
  `related_codings` of `system`, `version`, `code`), else null. The nickname, schedule and
  archived flag belong to the list, never to a dose.
- A deletion of either type states its record `gone`, whether or not the shipment or the source
  holds it; one whose type differs from the sample it names is refused, and the sample lands.

**The medication list.** HealthKit's list of the person's medications has no anchor and
states no deletion, so a bundle carries it whole, one `medication_list` entry. Each
medication is a `medication` record, content `{type: health.medication, nickname,
is_archived, has_schedule, concept, concept_identifier}`, with no time. Its key is the
fingerprint (`shared/fingerprint.ts`) of its concept's `display_text`, `general_form` and
`related_codings`, the codes in canonical order: HealthKit's own identifier is opaque, and a
renamed or archived medication keeps its key. A medication a later list lacks is never gone.
An entry whose concept does not state those members is refused alone, named
`health.jsonl line <n>.payload.medications[<i>]`; the list's other medications land.

**Characteristics.** Each sweep states the person's characteristics whole, one `characteristics`
line: `{characteristics: [{identifier, value}]}`, a fact for each of date of birth, biological sex,
blood type, Fitzpatrick skin type, wheelchair use and activity move mode that Health lets the app
read, its value HealthKit's (a date of birth's `YYYY-MM-DD`, an enumeration's integer), null where
Health holds none (not set). A fact Health refuses is left out of the line, never stated null. Each
fact is a `characteristic` record keyed by its identifier, content `{type: health.characteristic,
identifier, value}`, with no time, its value as the export's `Me` spells it
(`connect/health/apple/characteristics.ts`): the export's record of the same fact is the same bytes. A
later line restates; a fact it lacks is never gone. A fact that does not read is refused alone,
named `health.jsonl line <n>.payload.characteristics[<i>]`.

**Contacts**. The phone writes only what
changed since its last whole read. A `card` line, `{id, card, serializer, photo?}`, is the
`contact` record keyed by `id`, the system's own identifier (`CNContact.identifier`), so an edit
is a new version of the same record: `{type: contacts.card, card, photo?}`, the card as
`CNContactVCardSerialization` wrote it, one vCard, never parsed, and `photo`
`{hash, bytes, media_type}` when the contact has an image, the image bytes the system gives as
their own blob, which the record keeps (a photo a later line names again is not carried again).
A `gone` line, `{id}`, states the record gone; the phone states one only after a whole read under
full access. A card states no time. Access entries land nothing. No blob's bytes are read: a line
whose card is not one vCard, whose serializer is another, or whose carried photo is not the size
it states is refused alone.

**Photos.** Every entry of the library is read by the one entry reader the Mac's library
shares ([apple](../photos/apple/apple.md)): an asset, image or video, dated or not, is `img`
keyed `<local identifier>:<modification>`, the modification in UTC basic form with its
significant fraction (`20261003T031105.123451Z`, or `null`), content
`{type: photos.apple.asset, content: <PhotoKit payload>}` (its `cloud_identifier` among it, as
stated), timed by its creation date, or untimed when it states none. An availability is `img-file`
(never `img`: it is no photo taken, and the connector counts `img` alone)
keyed `<asset key>:<sha256 bindings digest>`, content `{type: photos.apple.availability,
content}`, timed by the captured clock; its `snapshot_replay_key` must name its snapshot
(`photos:<local identifier>:<modification>`), or its line is refused. Its own replay key is
not read: the key is the entry reader's digest. A resource with no file whose
`not_local_reason` is `not_found` or `download_failed` is the phone saying it cannot fetch it. A
`gone` states the asset or availability it names gone. A sweep is `recorder`, `{type: photos.apple.recorder, content: <the
line>}`. A resource's blob is the shipment's or the home's, or the row lands wanting it: a photo
copy the phone cleared once the home had imported it, which a restored home lacks. The door takes
such a row only as one of the files the bundle states `lost` for the photos source, so the version
links a file the home does not hold and the delivery keeps the phone's words. The phone asks
`GET /v1/photos/wanted?source=` which files to send (door.md).

**Places.** No domain: the owner's places are the home's ([places](../places/places.md)). The
phone writes each edit through the door as owner statements of `places:local:<home>` and reads
the list back from `GET /v1/places`. A `places.jsonl` derives no source, as any domain the home
has none for.

**Notes.** The notes the person writes in the app: `{type: notes.note | notes.folder, content:
<the line>}`, keyed by the note's or folder's id, the newest entry of an id in a shipment its
state. A note's line names its rich-text archive (`rich`) and each attachment's bytes (`blob`),
blobs the shipment carries or the home holds; one neither holds (a file the phone stated lost)
is named all the same, and the note's record wants it. A line refused once its id is read (an
instant that does not read) takes the earlier line of the same id in the shipment with it. A note the
person purged, and a folder deleted, state the record gone; a note in Recently Deleted stays live
with its `deleted_at`.

**Order.** Health deletions read what earlier shipments landed. The door takes a phone bundle
only when each source's seal is the next after its `received` (409 `STALE` otherwise), and the
home imports one source's deliveries one at a time, in the order the door sealed them, a seal
never before the one it follows (a seal whose nudge was lost is found by the inbox index, and the
later one waits for it). A deletion is never refused for a sample the home lacks: its tombstone lands, and a
shipment a later code reads again (its sample's line refused before) finds the UUID standing gone
and lands the sample gone, whichever shipment came first.

**Ledger.** Each
derived source's seal carries a range of one domain's sequence under one install.
1. **Order:** the domain's sequence, which never goes back within an install.
2. **Reuse:** none: no domain row is ever deleted, and a trigger in `capture.sqlite` refuses it.
3. **Rebuilds:** the install id. A reinstall, or a restore from backup (the capture folder is
   kept out of backups), is a new install whose sequences start at 1.
4. **Late arrivals:** none behind the cursor; an entry about the past gets a new sequence.
5. **Edits:** entries are immutable; a change arrives as a new entry (`deleted_sample`, a
   contact's `card` or `gone`).
6. **Lost:** photo copies the phone cleared after an earlier import (Photos' copies, contacts'
   photos), stated as `lost` when a restore or a home paired since asks for their entries again. A
   file only a version its record has moved past names (a contact restated with its photo now, a
   contact gone) is lost to no one: the stream counts the files its records' heads name.

## Its adapters

One file a family (`adapter-<family>.ts`), merged in `index.ts`: `adapter-photos.ts`, the in-app
camera's photos adapter (a copy one record, its file the payload's blob, its place the payload's
`location` with its accuracy; it ranks 3 and holds the paired phone's own photos);
`adapter-physical.ts`, the physical family's (the location's, the motion's and the check-ins');
`adapter-voice.ts`, the voice family's.

**Physical** (`adapter-physical.ts`; [physical](../../families/physical/)): a `fix`
record (`location`) is one Core Location fix: its own time (`timestamp_rfc3339_utc`), latitude,
longitude, horizontal accuracy, altitude and speed (a negative speed is none). Its evidence is the
phone's witness, which it declares: `Phone`, rank 10, observed. A `motion` record (`motion`) is
one Core Motion activity: a live update's start and its six flags; a seven-day sweep restates
history and is no reading. A `report` and a `vigilance` record (`checkin`) are a check-in's answers
(form, items, note) and a reaction-time test (whether it completed, each trial's outcome and
reaction time), at the time each was observed. The vertical accuracy, course, capture context,
motion confidence, question wording and trial spacing are not read.

**Voice** (`adapter-voice.ts`, `voice-notes`): a `voice` record is one note the phone recorded
(`voice.note`): the audio's hash and media type, the duration, the start and end, and the
location's latitude and longitude ([voice](../../families/voice/)). The capture clocks,
boot and process ids, sequence, encoder, microphone, end reason, and the location's accuracy and
fix time are not read: when they tick, nothing is written.
