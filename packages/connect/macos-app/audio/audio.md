# Audio recordings: `audio:local:<unit>`

**Reads** each sealed recording the Mac app ships: `<stem>.json` beside `<stem>.m4a`, the stem the
first sample's instant in basic form, the track, then `-2`, `-3`. The audio must be the bytes the
sidecar states: a sidecar that does not read, or whose audio the delivery does not carry as stated,
is refused alone, named by its path, and the next recording is read.

| Kind | Key | Content | Time |
|---|---|---|---|
| `mic-recording` | `at` in basic form (`20260930T100000.12Z`), `:1`, `:2` for a stem's `-2`, `-3` | `audio.recording`: the sidecar without `at` (until, track, detected_at, latency_ms?, part, ended_by, device, room with levels, camera, audio, session?, loudness?) | `at` to `until` |
| `sound-recording` | the same | the same, track `sound`, no device | `at` to `until` |

`ended_by` is one of a closed list: `holders_gone`, `part_limit`, `recorder_stopped`, `stopped`
(the person stopped recording that use of the microphone in the menu bar), `withheld`, `setting_off`,
`device_changed`, `failed`, `interrupted`; a sidecar with any other is refused.

Each record names its audio's blob. The connector counts its `mic-recording` alone (`counts`): every
moment recorded has one, and its `sound-recording` beside it is the same moment's other track.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds the recordings it carried, by their stems, and how many of them this Mac has since deleted. `AudioDomainTests` hold each answer.

1. **Order.** A stem is the instant its recording began: a label, never the order. A seal takes every shippable recording no seal up to `received` carried; a recording that began after one still open waits for it.
2. **Reuse.** No.
3. **Rebuilds.** Deleting the spool loses nothing the home holds.
4. **Late arrivals.** A recording a crash left open is sealed at the next launch and ships then, whatever its stem.
5. **Edits.** None.
6. **Lost.** A recording leaves once a seal up to `imported` carried it and it began more than seven days ago. After a restore below, the next bundle states `<n>` `recordings, up to that many: this Mac deleted them after an earlier import`, and the same seal sealed again states it again.
