# Voice notes

The Voice notes connector brings in the voice notes you record in the iPhone app. Your iPhone sends
each note to Lifestream, where a model can write down what you said.

## What it brings in

- The sound of each voice note.
- When it started and ended, and how long it is.
- Where you were: the last point the Location connector recorded, if Location is on.

Voice notes has no past to bring in. It keeps only the notes you record in Lifestream, not those in
Apple's Voice Memos.

## Before you start

- Lifestream on your iPhone, [paired with your Mac](../pair-your-iphone.md).

## Record a voice note

1. On your iPhone, open **Timeline**, or any day in it.
2. Tap **+** at the top, then **Voice note**. The first time, iOS asks to use the microphone: allow
   it.
3. Speak. The panel shows **Recording**, the time, and the level of your voice.
4. Tap **Stop** to save the note, or **Cancel** to throw it away.

A note also ends and is saved when you leave Lifestream, when a call comes in, or when it reaches
30 minutes. A note shorter than half a second is not kept.

Your iPhone sends the note to Lifestream the next time iOS wakes the app.

## Where it shows up

- **Timeline** shows each note as its length, the place, when it is one of your places, and what
  you said, such as "Voice note, 38 s at Home: Book the table for Friday." Open a note to play it
  and read the whole transcript.
- **Search** finds a note by the words of its transcript.
- **Chat** reads your notes when a question needs them.

## What a model reads

A model writes **Voice note transcripts**: the words of each voice note, in the language you spoke.

- **Sends:** only the sound of the note and its length.
- **Never sends:** when or where you recorded it.
- **Hidden first:** nothing, because sound can't be hidden. So a note goes to a model off your Mac
  only once you set the transcripts' **Personal details** to **Don't hide**, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says.
- **By default:** the model chosen for **Voice notes** in **Settings** › **Default models**, for your
  notes from 30 days before you added Voice notes. It is **Off** until you pick one. Your ChatGPT or
  Claude plan does not transcribe.
- **To stop it:** set **Voice note transcripts** to **Off**.

Only a model that hears audio is offered for it, such as:

- **Gemini 3.8 Flash** or **Scribe v2**, through an OpenRouter key. Your notes then go to
  OpenRouter and on to Google or ElevenLabs, as they are.
- A speech model that runs on your own computer, such as **Parakeet** for English or **Nemotron
  Speech** for many languages. Download one under **Settings** › **Providers**.

Open a note that has no transcript to see why. When a model is ready, **Transcribe now** there
transcribes that note.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Of the [settings every connector has](./README.md#settings-every-connector-has), Voice notes has
only **AI**: your iPhone decides when to send, and there is no past to bring in.

## Problems and fixes

These are the messages only Voice notes shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Microphone Access Off**\
iOS does not let Lifestream use the microphone. Tap **Open Settings**, and turn on
**Microphone** for Lifestream.

**Connect a model that takes audio**\
No model that takes audio is ready for the transcripts, so notes wait. Pick one for **Voice notes**
in **Settings** › **Default models**, from the models in [What a model reads](#what-a-model-reads), or
set **Voice note transcripts** to **Off**.

**The microphone did not start recording.**\
Lifestream could not start the microphone, and kept nothing. Record the note again.
