# Connectors

A connector brings one source of your data into Lifestream, such as your Gmail, your photos or your
WhatsApp chats. This page lists every connector, then says what they all share: how to add one,
their settings, how to pause one, and the messages they can show.

## Each connector's page

**Connectors** in the Lifestream window sorts connectors into sections, one for each kind of data.
Before you add any, it shows six first, under **Start with these**: iMessage, Calendar, Health,
Location, Photos and Screen.

The table lists every connector under its section, with a link to its page. **Where** says how its
data reaches Lifestream, as the **Where** filter on **Connectors** names it. **AI** names each thing
an AI model does with it; a connector with nothing there sends nothing to a model by itself.

| Section | Connector | What it brings in | Where | AI |
|---|---|---|---|---|
| Messages | [iMessage](./imessage.md) | The messages in Messages on your Mac | Mac, File | **Photo descriptions**, **Voice note transcripts** |
| | [WhatsApp](./whatsapp.md) | Your WhatsApp chats and calls | Mac, File | **Photo descriptions**, **Voice note transcripts** |
| Mail | [Gmail](./gmail.md) | Every email you send and receive | Online, File | **Email summaries** |
| Calls | [Calls](./calls.md) | Your phone and FaceTime calls | Mac, File | |
| Voice | [Audio](./audio.md) | The sound of your calls and meetings | Mac | |
| | **Dictation**: [Wispr Flow](./wispr-flow.md) and [Aqua Voice](./aqua-voice.md) | What you dictate | Mac | |
| | [Voice notes](./voice-notes.md) | The voice notes you record in the iPhone app | iPhone | **Voice note transcripts** |
| Calendar | [Calendar](./calendar.md) | The events in Apple Calendar | Mac | |
| | [Google Calendar](./google-calendar.md) | Your Google Calendar events | Online, File | |
| | [Reminders](./reminders.md) | The reminders in Apple Reminders | Mac | |
| Health | [Health](./health.md) | What Apple Health holds | iPhone, File | |
| | [WHOOP](./whoop.md) | Your sleep, recovery, strain and heart rate | Chrome | |
| Places | [Google Maps Timeline](./google-timeline.md) | The stays and trips Google Maps saved | File | |
| | [Location](./location.md) | Where you go | iPhone | |
| | [Motion](./motion.md) | How you move, and your steps | iPhone | |
| Photos | [Google Photos](./google-photos.md) | The photos and videos in a Google Takeout | File | **Photo descriptions** |
| | [Photos](./photos.md) | Your Apple Photos library | Mac, iPhone | **Photo descriptions** |
| Screen | [Keyboard and mouse](./input.md) | Your keys and clicks | Mac | |
| | [Mac events](./machine.md) | When your Mac sleeps, wakes and locks | Mac, iPhone | |
| | [Screen](./screen.md) | What is on your Mac's screen | Mac | **Screen summaries** |
| | [Screen Time](./screen-time.md) | Which app you were in, and when | Mac, iPhone | |
| Browsing | [Chrome](./chrome.md) | Your Chrome history | Mac | |
| | [Google activity](./google-activity.md) | What you searched, watched and looked up across Google | File | |
| | [Safari](./safari.md) | Your Safari history | Mac | |
| AI chats | [ChatGPT](./chatgpt.md) | Your conversations with ChatGPT | Chrome, File | **Chat summaries** |
| | [Claude](./claude-ai.md) | Your conversations at claude.ai | Chrome, File | **Chat summaries** |
| | [Claude Code](./claude-code.md) | Your Claude Code sessions | Mac | |
| | [Codex](./codex.md) | Your Codex sessions | Mac | |
| Notes | [Granola](./granola.md) | Your Granola meetings | Online | |
| | [Lifestream notes](./iphone-notes.md), with its [Camera](./camera.md) | The notes you write and the photos you take in the iPhone app | iPhone | **Photo descriptions** |
| | [Notes](./notes.md) | The notes in Apple Notes | Mac | |
| Listening | [Now playing](./now-playing.md) | What you listen to on your Mac | Mac | |
| | [Spotify](./spotify.md) | Every play in a Spotify export | File | |
| Code | [GitHub](./github.md) | Your commits, pull requests, issues and reviews | Online | |
| Check-ins | [Check-ins](./check-ins.md) | How you feel, and your reaction tests | iPhone | |
| Contacts | [Contacts](./contacts.md) | Your address book | iPhone, File | |

The values of **Where**:

| Where | How the data reaches Lifestream |
|---|---|
| **Mac** | Lifestream reads it on your Mac. |
| **iPhone** | Your iPhone sends it. |
| **Chrome** | The [Chrome extension](../chrome-extension.md) reads it in your own Chrome. |
| **Online** | Lifestream signs in to your account and reads it over the internet. |
| **File** | You hand in an export, as [Bring in your past from an export](../imports.md) says. |

**Imports**, the last section on **Connectors**, lists the exports you can hand in. A connector you
[add yourself](../add-a-connector.md) stands in the section of what it records, such as Money or
Social. [Battery](./battery.md), the iPhone app's own battery and crash reports, is not listed on
**Connectors**. [What leaves your Mac](../what-leaves-your-mac.md) says who receives what a model
reads.

## Add a connector

1. Open **Connectors**.
2. Click the connector you want.
3. Follow its step to connect. Each connector's page says what that step needs.

The connector is then connected. It brings in new data from now on, and your past at the same
time, newest first. A connector's page says when it works another way.

## Settings every connector has

Open **Connectors**, then the connector, to change these. A connector's window groups them in four
sections. Each connector's page gives its own defaults, and any setting only it has.

- **Comes from** lists the Macs, iPhones and accounts the connector reads.
- **Settings** holds **Check every**: how often Lifestream checks for new data.
- **AI** lists each thing an AI model does with the connector, such as **Email summaries**.
  - Click one to choose its **Model**: **Default**, a model that fits it, or **Off**; **More**
    finds one the menu does not list by its name or id. **Default**, which names its model,
    is the model set for its use under **Settings** › **Default models**, such as **Text**
    for **Email summaries**. Below **Model**, **Personal details** says what Lifestream hides
    before a model off your Mac reads an item.
  - **Read back to** sets which data a model reads: **New only**, **Last 30 days**, **Last year**,
    **All time**, or a date you pick. Each choice says how much it would read and, for a paid
    model, about what it would cost. While your data is still arriving, or Lifestream is still
    going through it, a choice says what it has found **so far**, or **Counting…**.
- **History** says how far your past has come in. **Starts from** is the day before which the
  connector brings in nothing, text and files alike: **All time**, or a date you pick. Until you
  pick one, it follows Lifestream's start, six months before the day you set Lifestream up. Moved
  earlier, it brings in what it left out; moved later, it brings in nothing older, and what is
  already in stays. A file you hand in comes in whole. **Catch up every** sets how fast your past
  comes in, such as **Every minute**.

A connector shows only the settings that fit it. A connector your iPhone sends has no **Check
every**: your iPhone decides when to send. A connector that brings in its whole past with its first
read has no **Catch up every**, and may have no **History** at all. A connector that no model reads
has no **AI** section.

## Pause or disconnect a connector

- **Pause** at the foot of a connector's window stops it reading until you click **Resume**. A
  pause stays until you resume it.
- **Pause** under **History** pauses only your past. New data still comes in. On your iPhone it is
  **Pause catching up**.
- For a connector your Mac records, such as Screen, the button is **Pause reading**: it stops
  Lifestream reading it, and your Mac goes on recording. To stop your Mac recording, click
  **Pause recording** in the menu bar menu.
- **Disconnect** stops the connector. Lifestream asks **Disconnect** *the connector*?, and then the
  connector stops. Everything it already brought in stays in Lifestream. On Screen, Keyboard and mouse, or Audio,
  **Disconnect** also stops your Mac recording it. For Screen, the menu bar menu then says **Not
  recording: Screen is turned off in Connectors**.

To bring a disconnected connector back, open it on **Connectors** and click **Connect**.

## Full Disk Access

macOS keeps the data of some apps behind one permission, Full Disk Access. These connectors need
it: iMessage, WhatsApp, Calls, Calendar, Reminders, Notes, Safari, Now playing and Screen Time. A
connector you [add yourself](../add-a-connector.md) may need it too.

You allow it once for all of them: on **Mac Sources** when you set up Lifestream, or from the window
of any of them. Each of their pages gives the steps.

To take it back, turn Lifestream off in **System Settings** › **Privacy & Security** › **Full Disk
Access**. Every connector that needs it then stops. To stop only one of them, disconnect it instead.

## Messages every connector can show

A connector shows a short line under its name on **Connectors**. These lines mean the same for every
connector. A connector's page lists the lines only it shows. A part of a line in italics changes,
such as the name of your Mac.

**Allow** *a permission*\
The device named under it does not let Lifestream use a permission the connector needs, such as
**Allow Full Disk Access**. On your Mac, click **Allow**, then turn Lifestream on in the list that
System Settings opens. On your iPhone, open **Connectors**, tap the connector, then tap **Allow**.

*A permission* **is limited**\
The device allows only part of what the connector needs. Allow full access in the same way.

**Waiting for internet**\
Your Mac is offline. The connector goes on when it is back online.

**Waiting for your passwords to unlock**\
Your vault is locked. Unlock it in Lifestream.

**Waiting for disk space on** *your Mac*\
The disk that holds Lifestream has less than 5 GB free, so the connector's past waits. New data
still comes in. Free some space, and the connector goes on by itself. Nothing already in Lifestream
is lost. [Lifestream's folder and its disk](../your-home.md#when-the-disk-fills) says what happens
at each step.

**Waiting for Wi-Fi**\
Your Mac is on a phone's hotspot, or on a network with Low Data Mode on, so the connector's past
waits. New data still comes in. **Connectors** also shows **Lifestream is on a hotspot** or **Low
Data Mode is on**. On a hotspot, **Everything, including my past** on this Mac's **Mobile data**
page lets the past come over it too; Low Data Mode holds the past whatever you choose. The connector
goes on by itself once your Mac joins another Wi-Fi, or Low Data Mode is off.

**Waiting for power**\
Your Mac is on battery, and this work waits until it is plugged in. To run it on battery, turn off
**Save battery** in **Settings** › **Providers**.

**Couldn't reach** *the connector* **· tries again at** *a time*\
A moment's failure. Lifestream tries again at the time shown.

**Couldn’t read** *the connector*\
Reading it failed several times in a row. Its page says the usual causes. Fix the cause, then
click **Try now**.

**Couldn't send** *the connector*\
Lifestream did not take what your Mac or iPhone sent for this connector, for an hour or more. The
device keeps that data, sends nothing more of the connector meanwhile, and builds it again and sends
it once an hour. Nothing is lost: a device deletes data only after Lifestream has brought it in.
For a connector your Mac sends, the menu bar menu says why, such as **Lifestream didn't take what
this Mac sent**. To try again at once, click **Sync now** in that menu.

**Sign in to** *the connector* **again**\
The account no longer accepts Lifestream's sign-in. Click **Sign in** and sign in again.

**Nothing new since** *a time*\
The connector works, and has had nothing new since then.
