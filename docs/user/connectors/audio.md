# Audio

The Audio connector records the sound of your calls and meetings on your Mac. The Mac app records
only while another app, such as a call app, is using the microphone, and sends each recording to
Lifestream.

## What it brings in

While another app uses the microphone, the Mac app records two tracks at the same time:

- Your microphone: what you say.
- Your Mac's sound: everything your Mac plays, which on a call is the other people. It is all of
  your Mac's sound, so music or a video playing at the same time is in it too.

With each recording, it keeps which apps were using the microphone and which were playing sound,
the microphone's name, the volume of your speakers and microphone, how loud each second was, and
when a camera was on.

Lifestream never turns a microphone on. It records only a microphone another app is already
using, and stops when that app stops using it. Each recording is cut into files of up to 10
minutes.

Audio has no past to bring in. It records from the moment you allow it.

Where the law asks, tell the other people on a call that you record it.

The Mac app keeps its own copy in `~/Library/Application Support/Lifestream Screen/audio` until
Lifestream has it and the recording is more than 7 days old.

## Before you start

- Lifestream on your Mac, allowed to use the microphone and System Audio Recording. The steps
  below allow them.

## Add Audio

During setup, Lifestream asks on **Your Mac Screen, Clicks, and Audio**: click **Allow** beside
**Audio**. To add it later:

1. Open **Connectors**, then **Audio**.
2. Click **Allow** on each line under **To connect**: one for the microphone, one for System
   Audio.
3. When macOS asks, allow Lifestream. If you refused before, System Settings opens instead: find
   **Lifestream** in the list, and turn its switch on.

Audio is then connected. The next time an app uses the microphone, the menu bar menu says
**Recording ·** and the app's name, such as **Recording · Zoom**, once it has recorded 20 seconds.

## Where it shows up

Lifestream keeps the recordings, and Audio's window counts them. Timeline, Search, People and Chat
do not use them, and you cannot play them in Lifestream.

## What a model reads

No AI model reads Audio, so its window has no **AI** section. Lifestream does not transcribe these
recordings, and sends them to no model.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Audio has none of the [settings every connector has](./README.md#settings-every-connector-has), and
none of its own.

What it records follows Screen's **Apps and sites** list (see
[Screen](./screen.md#settings)). If an app that uses the microphone is at **Activity only** or
**Never**, Audio records nothing while it uses it. If an app that plays sound is at one of them,
Audio records only your microphone while it plays. A site's setting does not count here: a browser
follows the setting of the browser app.

**Pause reading** stops Lifestream reading Audio, and your Mac goes on recording, as [Pause or
disconnect a connector](./README.md#pause-or-disconnect-a-connector) says. To stop your Mac
recording sound, click **Disconnect** in Audio's window, or click **Pause recording** in the menu
bar menu, which stops all recording.

To stop recording one use of the microphone, click **Stop recording** under **Recording · Zoom**
in the menu bar menu. What was recorded before you clicked stays. The menu then says **Not
recording · Zoom**, and nothing is recorded while that app uses the microphone, until it has been
off the microphone for two minutes. Other apps record as before, unless they share the microphone
with that app.

## Limits

- Audio records only calls that use your Mac's microphone, not a call on your iPhone.
- Lifestream does not tell a call from other uses of the microphone, such as dictation. It records
  every use.

## Problems and fixes

These are the lines only Audio shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Microphone needs access**\
An app is using the microphone, and Lifestream may not use it, so your side is not recorded.
Allow the microphone as in [Add Audio](#add-audio).
