# Screen

The Screen connector records what is on your Mac's screen, so Timeline can say what you did at your
Mac and when. The Mac app takes a picture of your screen every 2 seconds, reads the text on it, and
sends it to Lifestream every 5 minutes.

## What it brings in

- A picture of your screen, kept as video.
- The text on it, read from the picture. If Lifestream may use Accessibility, which the
  Keyboard and mouse connector asks for, it also reads the window in front as the app holds it.
- The app, the window title and the site in front, at each moment.

Screen records from the moment you allow it, and has no past to bring in. It does not record
while your Mac is locked or its display is asleep, or after you stop using the keyboard and mouse
for **Pause when idle for**. It never records a password field, or an app or site you set to
**Never**.

The Mac app keeps its own copy in `~/Library/Application Support/Lifestream Screen` until
Lifestream has it and the day is more than 7 days old.

## Before you start

- Lifestream on your Mac, allowed to use Screen Recording. The steps below allow it.

## Add Screen

During setup, Lifestream asks on **Your Mac Screen, Clicks, and Audio**: click **Allow** beside
**Screen**. To add it later:

1. Open **Connectors**, then **Screen**.
2. Beside **Allow Screen Recording on** *your Mac's name*, click **Allow**. System Settings
   opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. When macOS asks, choose **Quit & Reopen**. Lifestream opens again on the same page.

Recording starts at once. The menu bar menu then says **Recording**.

## Where it shows up

- **Timeline** shows one block for each sitting, titled with the apps you used and their minutes,
  such as "Screen: Safari 40 min, Mail 5 min". A sitting is one stretch at your Mac with no break
  longer than 5 minutes. Open a block to see its summary, the time per task, and the apps, sites,
  people and projects in it.
- **Search** finds a sitting by the words of its summary and its steps.
- **Chat** reads these summaries when a question needs them.

## What a model reads

A model writes **Screen summaries**: what you did in each sitting, for which task, with whom, and
whether you were at the Mac.

- **Sends:** for each part of a sitting, the apps, window titles and sites in front, and when; your
  Mac's events, such as sleep, wake and lock, from [Mac events](./machine.md); what you typed and
  clicked, from [Keyboard and mouse](./input.md); and the text on your screen.
- **Never sends:** the pictures, or the keys of a password field.
- **Hidden first:** the personal details in each part, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says. A model under **Local** runs on your own machines, and nothing leaves.
- **By default:** the **Default** model, like every other connector's. If that model is your
  ChatGPT or Claude plan, the text on your screen and what you typed go to OpenAI or Anthropic.
- **To stop it:** set **Screen summaries** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Screen has the [settings every connector has](./README.md#settings-every-connector-has), but
**Capture every** takes the place of **Check every**: how often it takes a picture. It is
**Every 2 seconds**.

It has three settings of its own:

- **Text reading**: how Lifestream reads the text in each picture. **Skip unchanged frames**, the
  default, reuses the text of a picture that did not change. **Every frame** reads every picture in
  full.
- **Pause when idle for**: how long you stop using the keyboard and mouse before recording pauses.
  It is 5 minutes.
- **Apps and sites**: how much of each app and site is recorded. **Record** keeps everything.
  **Activity only** keeps the app and the time, never the screen. **Never** keeps nothing. Type an
  app's name or a site, such as `mybank.example`, to add it at **Never**. **Other app…** adds an app
  from your disk at **Activity only**.

Password managers (Keychain Access, Passwords, 1Password, Bitwarden, LastPass, Dashlane, KeePassXC
and Proton Pass) are at **Never** from the start, and listed first, so you can change them. The note
under the list says whether private windows are kept out on your Mac, as password fields always are.
[Choose what is recorded](../choose-what-is-recorded.md#private-windows-and-password-fields) says when they are.

**Pause reading** stops Lifestream reading the screen, and your Mac goes on recording, as [Pause or
disconnect a connector](./README.md#pause-or-disconnect-a-connector) says. To stop recording, click
**Pause recording** in the menu bar menu, and **Start recording** to go on.

## Limits

- Screen records only the display that holds the window in front, not your other displays.
- Without a model, Timeline shows each sitting's apps and length, not what you did.

## Problems and fixes

These are the messages only Screen shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Allow Screen Recording on** *your Mac's name*\
macOS does not let Lifestream record the screen. Follow [Add Screen](#add-screen). The menu bar
menu says **Screen Recording needs access** for the same cause.

**Not recording: your Mac's disk is full**\
Your Mac has less than 1 GB free. Free some space, and recording goes on by itself.

**Not recording · browser not answering**\
The page in front in your browser has not answered for 10 seconds. Recording goes on when it
answers.

**Not recording · screen unavailable**\
Your Mac could not capture the screen for 10 seconds. Recording goes on by itself when it can.

**Not recording · Mac idle**\
Screen does not record at these times, as [What it brings in](#what-it-brings-in) says.

**Not recording · private window or app**\
Screen does not record a password field, an app or site set to **Never**, or a private window it can
tell apart, as [Choose what is recorded](../choose-what-is-recorded.md#private-windows-and-password-fields) says.

**Needs a model for long text**\
The model set for **Screen summaries** cannot take a whole part of a sitting. The model Lifestream
downloads for you, Qwen 3.5, is too small for it, so the **Screen summaries** menu does not offer
it. Choose your ChatGPT or Claude plan, a model through a key, or a model you run yourself at a
**Custom address** (see [Choose which AI models read your data](../ai-models.md)). Or set **Screen
summaries** to **Off**.
