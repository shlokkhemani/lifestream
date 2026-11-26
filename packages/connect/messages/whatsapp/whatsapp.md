# WhatsApp

Reader `whatsapp-db`. Source `whatsapp:<phone>:<unit>`: one replica of one account's
WhatsApp database on one device. The Mac's replica and a phone backup's are two sources; the
same message in both is two records.

## What it reads

A delivery holds:

- `chats.sqlite`: WhatsApp's `ChatStorage.sqlite`, whole (a phone backup) or what changed in it
  (the Mac, when it changed, `kind: "changes"`).
- `calls.sqlite`: WhatsApp's `CallHistory.sqlite`, whole (a phone backup) or what changed in it
  (the Mac, when it changed).
- `business.sqlite` (the Mac, when it changed): what changed in `Biz/Biz.sqlite`, the app's own list
  of business accounts, of which only `ZWABIZVERIFIEDNAMEDATA` travels: each business's id, its
  phone's JID, the name WhatsApp verified and the level it verified it at, and the certificate,
  which rides in the file and is never stated. No business profile (address, hours, description,
  website) leaves the Mac. Measured on one owner's Mac, 12 Nov 2026: 956 businesses; 596 of 1,180
  one-to-one chats were with one.
- `media.json` (optional): the blob index the device wrote, media pointer to blob hash and size.
  The media bytes travel as the source's blobs.

A delivery may hold any of the three stores (one with none states nothing). They are
independent files, each a part: one that does not open as SQLite, whose schema this code does
not read, or that breaks part way through its pages (one in WAL mode, copied without its log,
would) is that file's refusal, the rows it gave before keeping, and the other is read.
A media index that does not read refuses the delivery, since the chats' rows name its blobs. It states every message, every chat and every pushname
the file holds, every call and every business, table by table: a chat renamed with no new message is stated.
A message's media item, group member and parent, and a chat's group, are read by lookup. The Mac's
changes carry a thread whole, so a reply whose parent the file does not hold is one whose parent the store lost: it
lands as its row says, stating the raw `ZPARENTMESSAGE` and no parent stanza (an older Mac's
delta carried a reply's parent for lookup without its own, and there such a parent is skipped).
It states nothing about a row the file does not hold. A delivery
from an older Mac (a nightly snapshot, or a delta stating `after` and `through`) holds whole rows
too and is read the same way, for one release more.

A phone backup comes on the import road (imports/imports.md, "Each kind": the iPhone backup): the
Mac pulls `chats.sqlite`, `calls.sqlite` and `media.json` out into a `whatsapp/` folder, its rows
`**/whatsapp/chats.sqlite`, `**/whatsapp/calls.sqlite` and `**/whatsapp/media.json` (this
connector's `export`), for `whatsapp:<number>:<unit>` on the `upload` road, the unit the phone's.
Its account is the backup's `OwnJabberID` made a number by this store's account rule
(`store.ts` `account`), as a Mac's is. The media bytes are the folder's carried blobs.

Every table the connector reads states its known columns (`columns`); a file that lacks one fails
the import with the table and the columns named, and a column a later WhatsApp adds is lawful and
unread: `lifestream report` names it.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `msg` | `<chat>:<ZSTANZAID>`; a message with no session, or whose session row is gone, `unattached:<ZFROMJID>:<ZSTANZAID>` | `whatsapp.msg`: the `ZWAMESSAGE` columns, the session JID at message time, the parent's stanza (a parent the store lost: null, and `ZPARENTMESSAGE` verbatim), the `ZWAMEDIAITEM` columns, the group member's JID, and a `{hash, bytes, role}` per media pointer the index names | `ZMESSAGEDATE` |
| `chat` | `<chat>` | `whatsapp.chat`: the `ZWACHATSESSION` columns and its `ZWAGROUPINFO` columns | the newest message the delivery states in it; none when it states none |
| `pushname` | the JID, in its one spelling | `whatsapp.pushname`: `ZJID` and `ZPUSHNAME` verbatim; a row missing either states nothing | none |
| `call` | `ZCALLIDSTRING` | `whatsapp.call`: the `ZWACDCALLEVENT` columns, its `ZWAAGGREGATECALLEVENT` columns, and the aggregate's participants | `ZDATE` |
| `business` | `ZJID` (the business's LID), in its one spelling | `whatsapp.business`: `ZJID`, `ZPHONENUMBERJID`, `ZNAME` and `ZVERIFICATIONLEVEL` verbatim; a row with no `ZJID` states nothing | none |

`<chat>` keeps a chat's key across WhatsApp's move from phone JIDs to LIDs: a one-to-one
session on a phone JID whose `ZCONTACTIDENTIFIER` states a LID is keyed by that LID; any other
one-to-one session by its own JID; a group, broadcast or community by its JID verbatim. A JID's
one spelling is core's (`packages/core/handles.ts` `canonicalJid`): the digits of a phone (7 to
15, no leading zero) or of a LID, then the lower-case domain; a JID that is neither is kept
verbatim. A chat key or an unattached sender
holding a colon is refused: it would make the key ambiguous.

A group's `chat` says whether it is archived (`ZARCHIVED`): the labels read it, and a group
archived on every copy is quiet while the stream's `groups_archived` is on
([labels](../../../families/labels/)).

**Fields.** Under a Groups heading, the home's own (`home`, handed to no device), which People
folds the groups by and a change to which queues People: `groups_archived` (archived groups
are quiet, on by default), `groups_quiet_after` (the silence after which a group is quiet: 30
days, 90 by default, 6 months, a year, never), `groups_talk` (whose group messages count toward
them: on days the owner wrote there, by default; every group; none).

Times are Apple-epoch seconds (`apple-s`). A date of zero or `NULL` is the column's "unset": the
record states no time. Participants are in canonical order
(`connect/shared/order.ts`).

Every row carries the replica's unit as `device` and its table row as `locator`.

## Its adapters

`adapter-messages.ts` (`whatsappMessages`, version 2) reads a `msg` record for the messages family
(`packages/core/inputs/messages.ts`): the key's chat and stanza, `ZISFROMME`, `ZFROMJID`,
`group_member_jid`, `ZTEXT`, `ZMESSAGETYPE`, `ZGROUPEVENTTYPE`, the forwarded bit (256) of
`ZFLAGS`, `parent_stanza_id`, `session_jid`, the media item's `ZMOVIEDURATION`, `ZTITLE`,
`ZVCARDNAME`, `ZVCARDSTRING`, `ZLATITUDE`, `ZLONGITUDE`, and the blob of role
`ZWAMEDIAITEM.ZMEDIALOCALPATH`. Every other field is never read. It makes no chat line of a status
post or a broadcast (their sessions are not chats), of a call's entry in its chat (`ZMESSAGETYPE`
59: the calls family prints the call), or of a message with no chat. A row of a kind it does not
name is read by what it holds: the file its media item states the type of (`ZVCARDSTRING`: a GIF,
type 11, and a round video message, type 54, are `video/mp4`) as that file; else its words alone;
else, with no words and nothing it carries, it is the app's own notice (an encryption or security
notice, types 10, 19, 66) and no chat line. A contact card (type 4) prints its name and every number its
vCard (`ZVCARDSTRING`) states (`TEL`), so the line says what was shared.

A chat is a group when its JID is a group's (`@g.us`); a one-to-one chat's member is its JID.
Keys are `<chat>:<stanza>` (`keyed: "chat"`): a phone JID's chat the labels pair with a LID is
shown as the LID's, and the day prints one copy of a message both key. Its label kinds are `chat`,
`pushname` and `business`, its labels' ids WhatsApp ids (`labels.ids: "jid"`): `label` says what one names
(a shell its partner's ids or its group by `ZPARTNERNAME`, a one-to-one shell's one LID and one
phone JID paired, a group's `ZARCHIVED`; a push name its JID; a business its `ZJID` and
`ZPHONENUMBERJID` as a business's account at `ZVERIFICATIONLEVEL` with the name WhatsApp verified
(`ZNAME`), naming and pairing no id: People judges and offers by it, `labelText` their search words (a
business's its verified name),
`labelId` the id a handle is named by (a phone's JID) and `self` the owner's own JID a source's
account is, which takes no name of the app's. `images`, what the faces labeler reads: a photo or a
sticker (`ZMESSAGETYPE` 1, 20 or 15, whatever its session) by its `ZWAMEDIAITEM.ZMEDIALOCALPATH`
blob, and its sender as a `jid` (`ZFROMJID` unless it names a group, else the chat) when the chat
is one-to-one, the session no status or broadcast, and the owner did not send it.

`adapter-calls.ts` (`whatsappCalls`, version 2) reads a `call` record for the calls family
(`packages/core/inputs/calls.ts`): the call event's `ZDATE`, `ZDURATION`, `ZGROUPJIDSTRING` and
`ZOUTCOME`, the aggregate's `ZINCOMING`, `ZMISSED` and `ZVIDEO`, each
participant's `ZJIDSTRING`. An incoming call is missed only when WhatsApp states it missed; one
answered on another device (`ZOUTCOME` 5, which a Mac states for a call the phone took) is
answered, its length unknown, as this copy holds no duration for it; any other is not answered
(declined, or rung out). It is video when the aggregate states `ZVIDEO` 1, else voice. Every
snapshot restates the bytes sent and received, the participants' outcomes, the missed reason and
the link token: none is read.

## Ledger

How the Mac keeps custody of this source: a memory of
each store, per pass, holding every row sent by table, key, fingerprint and seal, and the media
sent. `DifferencesTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every row whose fingerprint the memory does not hold.
   Messages of the last 7 days (`ZMESSAGEDATE`) go live; older ones in history pages, newest first.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** The identity is `Z_METADATA.Z_UUID`. Logging out and in, or relinking the Mac,
   makes a new store with a new `Z_UUID` and every message renumbered: the memory starts again,
   the whole store ships, and records keyed by stanza id merge.
4. **Late arrivals.** History synced from the phone gets new ids and ships as any new row, into
   a page when it is older than the live span.
5. **Edits.** An edit, a deletion for everyone, a reaction or a receipt (`ZWAMESSAGEINFO`), a
   media item downloaded later, a chat or group renamed, and a call changed each change a row's
   fingerprint, and the row ships with what it pulls: a message with its media, its per-message
   rows and its thread; a chat with its group. A message keeps its chat's JID as it stood when
   the message shipped: a chat changed later ships with its group and restates no message.
6. **Lost.** Expiring messages delete old rows: the ids between the memory's highest message and
   the store's lowest are stated lost, once. A row the app deletes ships nothing. After a restore,
   what the rolled-back seals sent ships again, their media too.
