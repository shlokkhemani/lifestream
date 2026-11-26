# Problems and fixes

Find what you see, then read what it means and what to do. Every line below is quoted as the Mac
app, the Lifestream window or the iPhone app shows it. Where another page already explains a
problem in full, this page links to it.

## Find what you see

| What you see | Where to read about it |
|---|---|
| Timeline is empty, or a day looks thin | [Timeline is empty or thin](#timeline-is-empty-or-thin) |
| Your iPhone isn't sending, or a strip says **Can't reach Lifestream** | [When a device can't reach Lifestream](#when-a-device-cant-reach-lifestream) |
| A number on **Connectors** in the sidebar, or a dot on the iPhone's Connectors button | [What Connectors asks of you](#what-connectors-asks-of-you) |
| A connector's line, such as **Couldn’t read** or **Sign in to** a connector **again** | [Messages every connector can show](./connectors/README.md#messages-every-connector-can-show) |
| A line in the menu bar menu, such as **Not recording** | [The menu bar menu](./menu-bar.md#what-its-lines-mean) |
| Chat doesn't answer, or shows a message instead | [Chat](#chat) |
| An import or an iPhone backup stops | [Imports](#imports) |
| **Lifestream is locked**, or **Passwords are locked on this Mac** | [Keys and encryption](#keys-and-encryption) |
| The disk is full or almost full | [When the disk fills](./your-home.md#when-the-disk-fills) |
| A message in Search | [Search your life](./search.md#what-you-might-see) |
| An iPhone doesn't pair | [Pair your iPhone](./pair-your-iphone.md#if-it-does-not-pair) |
| A device and Lifestream are on different versions | [Update Lifestream](./update.md#when-a-device-and-lifestream-are-on-different-versions) |
| Nothing on this page helps | [If nothing here helps](#if-nothing-here-helps) |

## Timeline is empty or thin

Timeline shows what your connectors brought in for each day. If a day looks emptier than you
expect, check these in order:

1. **Lifestream has only just started.** Each connector brings in today first and then your past,
   newest first. Older days fill in last. Open the connector on **Connectors** to see how far its
   past has come.
2. **Your iPhone does not send.** A day's places and moves come from your iPhone's
   [Location](./connectors/location.md) connector. If your iPhone is not paired, or cannot reach
   Lifestream, the day has no stays. See
   [When a device can't reach Lifestream](#when-a-device-cant-reach-lifestream).
3. **Your Mac was asleep or off.** Lifestream runs only while your Mac is awake. Your devices keep
   what they record meanwhile, and send it later.
4. **A connector is paused or needs you.** Its line on **Connectors** says why.
5. **A model has not read it yet.** Photo descriptions and summaries of your time at the screen
   need an AI model. **Photos** and **Voice notes** are **Off** until you pick a model for them, and
   a ChatGPT or Claude plan does not write out voice notes. Until a model is ready, those parts stay
   out. See [Choose which AI models read your data](./ai-models.md#pick-a-model-for-each-use).

A day starts at 4:00 in the morning, so what you did between midnight and 4:00 is on the day
before. A day with nothing in it says **Nothing recorded this day.**

## When a device can't reach Lifestream

Your iPhone, and a Mac that sends to Lifestream on another Mac, keep what they record while they
cannot reach Lifestream, and send it later. Nothing is lost. The strip at the top of the iPhone app
and of the Lifestream window says what is wrong. Click or tap it to see the path to Lifestream, one
line each, with the line that broke and what to do.

| You see | What it means and what to do |
|---|---|
| **Can't reach Lifestream** | Lifestream did not answer. On your iPhone, the line under it names the cause: **This iPhone is offline**, **Tailscale is off**, **Not on your Mac's Wi‑Fi** or **Your Mac isn't answering**. [If your iPhone cannot reach Lifestream](./reach-from-anywhere.md#if-your-iphone-cannot-reach-lifestream) says what to do for each. |
| **Lifestream isn't running** · **Nothing is read or saved** | Lifestream on this Mac has stopped. Click **Start Lifestream**. |
| **Lifestream's drive isn't connected** · **Connect its drive and it starts again** | Lifestream's folder is on an external drive that is not plugged in. Plug it in. See [When your drive is unplugged](./your-home.md#when-your-drive-is-unplugged). |
| **Lifestream needs an update**, or **Update Lifestream on this iPhone** | The device and Lifestream are on different versions. See [Update Lifestream](./update.md#when-a-device-and-lifestream-are-on-different-versions). |
| **Lifestream no longer knows this iPhone** · **Pair it again to send** | Tap **Pair again**, and [pair it again](./pair-your-iphone.md#pair-again). |
| **Lifestream is back** | Lifestream answers again. The device sends what it kept. |

## What Connectors asks of you

When Lifestream needs you, the sidebar shows a number beside **Connectors**: *N* **things need
you**. On the iPhone, a dot shows on the Connectors button at the top of each tab. The lines stand
at the top of **Connectors**, each with the button that fixes it. A line that is only advice has
**Dismiss · comes back if it gets worse**.

A connector's own line, such as **Sign in to** Gmail **again**, is on
[Messages every connector can show](./connectors/README.md#messages-every-connector-can-show). The
others are these.

| You see | What it means and what to do |
|---|---|
| **Lifestream's disk fills in about** *N* **days**, **Photos need** *an amount* **more**, **Lifestream's disk is almost full** or **Lifestream's disk is full** | The disk that holds Lifestream runs out of room. Click **Free up space**. [When the disk fills](./your-home.md#when-the-disk-fills) says what waits at each step. |
| *A device's name*'s **disk is almost full**, or *a device's name*'s **disk is full** | Your Mac or iPhone itself runs out of room. Free some space on it. See [When your Mac or iPhone fills](./your-home.md#when-your-mac-or-iphone-fills). |
| **Lifestream is on a hotspot** · **History waits for Wi-Fi · Mobile data, in the Mac app's Settings** | Your Mac is on a phone's hotspot. New data still comes in, and your past waits until your Mac joins another Wi-Fi. To send it over the hotspot, open **Settings › Mobile data** in the Mac app and choose **History comes over the hotspot too**. |
| **Low Data Mode is on** · **History waits · turn Low Data Mode off on the Mac that runs Lifestream** | Your Mac's network has Low Data Mode on. New data still comes in, and your past waits until Low Data Mode is off, whatever you chose for mobile data. |
| **Lifestream's database is missing** or **Lifestream's database is damaged** · **Put back a copy from a backup** | Lifestream finds no database in its folder, or a damaged one, so it reads and keeps nothing. If you moved the folder by hand, put it back where it was, click **Check again**, then [move Lifestream's folder](./move-your-home.md) the way that page says. Otherwise, [put a copy back](./back-up.md#put-a-copy-back) from your backup. |
| **Another app holds Lifestream's database open** · **Close it and Lifestream catches up** | Close the other program, such as a database viewer. See [When another program holds the folder open](./your-home.md#when-another-program-holds-the-folder-open). |
| *Chrome* **is asking to connect** | The Chrome extension waits for your yes. If you just added it, click **Connect**. If you did not, leave it. See [Add the Chrome extension](./chrome-extension.md). |
| **Agents can't reach Lifestream from the internet** | Tailscale cannot offer Lifestream to your agents away from this Mac. The line under it says why, such as **Tailscale serves something else at its address**. Click **Open Tailscale** where it shows. See [Let an agent reach Lifestream](./reach-from-anywhere.md#let-an-agent-reach-lifestream). |
| **Passwords aren't set up** · **Make a recovery key to keep them** | Lifestream has no vault yet for the passwords your connectors need. Click **Make key**, and keep the recovery key it shows. |
| **Recovery key not saved** | You have not confirmed that you saved your recovery key. Click **Save key**. Without it, a lost Mac loses what the key opens. See [Keep your recovery key](./recovery-key.md). |
| **This Mac's disk isn't encrypted** · **Turn on FileVault** | Turn on FileVault in **System Settings** › **Privacy & Security**. |
| **Lifestream's disk isn't encrypted**, or **Lifestream encrypts its files itself** | Lifestream's folder is on a disk that is not encrypted. Move Lifestream to an APFS (Encrypted) disk, as the line says. See [Move Lifestream's folder](./move-your-home.md). |
| **Other accounts can read Lifestream**, or **Other accounts can delete or replace Lifestream's files** | Lifestream's disk ignores who owns each file. In the disk's **Get Info** in Finder, turn off **Ignore ownership on this volume**. If the disk is ExFAT or FAT, move Lifestream to an APFS disk. |
| **Other accounts can open Lifestream's folder** · **Run the fix in Terminal** | Click **Copy fix**, paste the command in Terminal, and press Return. |

## Chat

| You see | What it means and what to do |
|---|---|
| **Sending** | Lifestream or Chat did not answer when you sent the question. It stays in the thread and goes by itself once they answer. |
| **Try again** under a question | Chat refused the question before it started, such as while it needed your sign-in. **Try again** sends the same question again. While an answer is being written, it waits for that answer first. |
| **Sign in to Claude again**, **Chat needs your Claude sign-in on your Mac.**, or the same for ChatGPT | The plan of Chat's model is signed out. Click **Sign in with Claude…** or **Sign in with ChatGPT…**, and sign in again. On your iPhone, sign in from Lifestream on your Mac. |
| Another line over the box, such as **Add the key for OpenRouter** | The model you picked isn't ready, and the line says what it needs. Chat asks nothing until it is ready, or until you pick another model. Click **Open AI models** to set it up. |
| *A model* **isn't offered now. Asking** *another model*. | No connection lists the model you picked any more, so Chat asks Chat's model instead. Pick another model. |
| **Chat needs a model: choose one in Settings › Default models.** | No model that fits Chat is connected. Click **Connect a model…**. |
| **Chat has no default model: choose one from the menu.** | No model is chosen for **Chat**. Pick one in Chat's model menu, or for **Chat** in **Settings** › **Default models** on your Mac. |
| **This model's connection changed: ask again.** | Where the model sends your data changed while Chat asked it, so Chat sent nothing. Ask again. |
| **Chat needs a paid ChatGPT plan.** | A free ChatGPT plan cannot answer in Chat. Use a paid plan, Claude or an OpenRouter key. |
| **ChatGPT didn't answer: your plan is used up for now.** or the same for Claude | Your plan's limit is reached. Ask again after the time shown, or pick another model. |
| *A model* **didn't answer: the account it runs on is out of credits. Add credits, then ask again.** | The account behind the model, such as your OpenRouter key, has no money left on it. Add credits, such as on openrouter.ai, then ask again. |
| *A model* **holds too little text for this.** | The model's context window cannot hold your question with what Chat must send. Pick another model, or, for a model on another server, run it with a larger context window. |
| **Not saved yet: Chat can't write to your Mac's disk. It keeps trying.** | This shows under an answer. Chat answered, but could not write the answer to your Mac's disk, so Lifestream does not have it yet. Free some space on your Mac. Chat saves the answer once there is room. Asking again would ask the model twice. |
| **Recent chats are not saved to Lifestream yet.** | An answer has waited an hour for Lifestream to take it. Chat keeps trying, and the line goes once Lifestream has it. |
| **Chat restarted before it finished.** | Lifestream restarted, such as for an update, during the answer. Click **Try again**. |
| **Lifestream can't read this picture.** | This shows under a question you sent. Lifestream could not read one of its photos, so Chat took that photo out of the question. Click **Try again** to send the rest. |
| **Lifestream couldn't prepare your photo for the model. Try again.** | Lifestream could not make the photo ready to send, so Chat did not send it. Click **Try again**. |
| **Lifestream has too many unsent photos: send or remove some.** | Photos you added but have not sent fill the space Lifestream keeps for them. Send your questions, or remove photos with their **×**. Photos you never send are deleted from Lifestream after a day. |
| **Too large to send: over 25 MB.** | Pick a smaller photo. |
| **Choose a model for Voice notes** | No model writes out your voice notes. Pick one in the **Voice** row of Chat's model menu, or for **Voice notes** in Settings › AI models on your Mac. |
| **Voice notes are turned off** | Voice notes are **Off** for Chat. Pick a model in the **Voice** row of Chat's model menu. |
| **Couldn't write out your voice note** | Lifestream kept the note but could not write it out. Click **Try again**. |
| **Your voice note had no words in it.** | The note held no speech. Record it again. |
| **Lifestream couldn't take this question in time. Ask it again.** | Lifestream did not take the question within ten minutes. Ask it again. |
| **Not sent** | The question did not reach Lifestream. The strip at the top says why. Click **Try again** once Lifestream answers. |
| **Chat isn't answering on your Mac** | Lifestream answers, but Chat on your Mac does not. Click **Try again** in a moment. |
| **This conversation was erased.** | The conversation was erased on Lifestream, from another device or with `lifestream erase`. Its questions, photos and voice notes are gone from this window too, and a note of it that was playing stops. Start a new conversation. |

## Imports

These are the lines an import's window shows, on [Bring in your past from an export](./imports.md).

| You see | What it means and what to do |
|---|---|
| **Couldn’t open it** · **Download it again** | The file is damaged or incomplete. Download it again from the company's email. |
| **This isn’t a Spotify export** · **Choose the zip Spotify emailed you** | The file is not this export. Check that you dropped it on the right window. |
| **Nothing in it Lifestream reads** · **not sent** | The file holds only things Lifestream does not read, such as a Claude export's account file without your conversations. Your Mac does not send it. |
| **Too large to send** · **over 64 GB** | The file is larger than Lifestream takes at once. Make a new export with smaller files. |
| **Waiting** · **plug in your Mac** | Your Mac is on battery, and the file is over 1 GB. Sending goes on when you plug it in. |
| **Waiting** · **needs 12 GB free on this Mac** | Your Mac needs room for a copy of the file, and keeps 5 GB free besides. Free some space. |
| **Waiting** · **Lifestream needs 40 GB free** | The disk that holds Lifestream needs room for twice the file, and keeps 5 GB free besides. Free some space there. |
| **Waiting for disk space on** your Mac **· your files are kept** | The disk that holds Lifestream has less than 5 GB free, so Lifestream reads nothing more of the import. Free some space there, and it goes on by itself. |
| **Can't find it** · **Choose it again** | The file moved or changed before your Mac sent it. Click **Choose again** and choose it where it is now, or click **Remove**. |
| **Reading your Takeout's mail** · **new mail waits** | A Takeout's mail goes into the same Gmail connector as the mail Lifestream reads when you sign in, so new mail waits until the Takeout's mailbox is read. An email that comes both ways is kept once. |
| **came as HTML · next time choose JSON: it holds more** | My Activity came as HTML, which holds less. In your next Takeout, choose **JSON** under **My Activity**. |

### An iPhone backup

These are the lines an iPhone backup can show under **Backups on this Mac**, besides the steps of
reading it.

| You see | What it means and what to do |
|---|---|
| **Not encrypted: your calls aren't in it. iMessage and WhatsApp are.** | Finder made the backup without a password. To bring in your calls, turn on **Encrypt local backup** in Finder and back up again. |
| **Work iPhone · Backing up in Finder…** | Finder is still making the backup. When it's done, the row offers **Read it**. |
| **No backup on this Mac yet. Follow the steps above, then come back.** | Make a backup in Finder, as [Get the export](./imports.md#get-the-export) says. |
| **Lifestream can't see your backups.** | Lifestream needs Full Disk Access to see them. Click **Open Privacy Settings** and turn on Lifestream. |
| **Read it** on a backup your Mac was reading | Lifestream quit before it was done. Click **Read it** to start again. |
| **Waiting for Lifestream** | Your Mac asked Lifestream which photos and files it has, and Lifestream did not answer. Your Mac asks again by itself. |
| **Your iPhone started a new backup. Read it when it's done.** | Finder began a new backup while Lifestream read the old one, so Lifestream stopped. When Finder is done, the new backup has its own row. Click **Read it** there. |
| **WhatsApp couldn't be read from this backup.** | One part of the backup did not read. The other parts still come in. Click **Read it again**. |
| **WhatsApp is too large to send to Lifestream.** | That part of the backup, with its photos and files, is more than Lifestream takes at once. The other parts still come in. |
| **WhatsApp didn't reach Lifestream.** | That part of the backup was lost on your Mac before Lifestream took it. Click **Read it again** to send it. |
| **Waiting** · **needs 14 GB free on this Mac** | Your Mac needs that much free space to take the backup's messages and files out before it sends them. Free some space, and it goes on by itself. |

## Keys and encryption

[How Lifestream keeps your data safe](./keep-your-data-safe.md) says what the keys are and what
encryption protects. [Unlock Lifestream](./recovery-key.md#unlock-lifestream) gives the steps to
unlock it.

| You see | What it means and what to do |
|---|---|
| **Lifestream is locked** · **Unlock it.** | An encrypted Lifestream cannot read its key from this Mac's Keychain, so nothing in it opens. Open the Lifestream window. Click **Allow** if it shows, or type your recovery key and click **Unlock**. |
| **Lifestream is locked: unlock it on your Mac.** | Chat or an agent says this while an encrypted Lifestream is locked. Unlock it on the Mac it runs on. Your devices keep what they record meanwhile. |
| **Passwords are locked on this Mac** | Lifestream is not encrypted, and only its vault is locked. Click it, then **Allow**, or type your recovery key. |
| **This Mac couldn't keep Lifestream's key** | Lifestream is open, but nothing can read it until this Mac keeps its key in the Keychain. The window says why. Fix what it names, then click **Try again**. |
| **Lifestream couldn't keep its key in your Mac's Keychain:** … **Nothing was made.** | Setup could not make the key for an encrypted Lifestream, and the message says why. Fix what it names, then click **Set up** again. |
| **Lifestream can't open what this Mac records** · **Click Allow.** | macOS did not let Lifestream read the key that encrypts what this Mac records, so this Mac records and sends nothing. Click it, then **Allow**. |
| **macOS didn't let Lifestream read its key. Click Allow again, and when macOS asks, choose Always Allow.** | You chose **Deny** when macOS asked. Click **Allow** again, type your login password, and choose **Always Allow**. |
| **Lifestream couldn't make a new key in this Mac's Keychain. Click Allow to try again.** | Click **Allow**. |
| **Lifestream couldn't open what this Mac recorded and hadn't sent yet, so it started again. Lifestream keeps everything it already received.** | The key that encrypts what this Mac records was gone from your Keychain. What this Mac had not sent is lost. This Mac reads and sends its apps' history again from the start, and Lifestream takes nothing twice. |
| **Pair this Mac again** | This Mac sends to Lifestream on another computer, and its pairing was lost with the key above. Make a pairing code in Lifestream there, then type in Terminal on this Mac: `~/.local/bin/lifestream home --name <Lifestream's address> --code <the code>`. |
| **This Mac already holds recordings. Uninstall Lifestream on this Mac, keeping your Lifestream data, then set it up again. Uninstall deletes what this Mac recorded and has not sent.** | A Mac that recorded for a Lifestream that is not encrypted cannot start sending to an encrypted one. Do as it says: [Uninstall Lifestream](./uninstall.md), keeping its folder, then set it up again. |
| **Lifestream can't read which key opens what this Mac records. Uninstall Lifestream on this Mac, keeping your Lifestream data, then set it up again.** | A file of this Mac's is damaged. Do as it says. |
| **Lifestream is encrypted, and only Lifestream opens it while it runs. Open Lifestream, then run this again.** | A `lifestream` command in Terminal needs Lifestream running to read an encrypted folder. Open Lifestream on your Mac, then run the command again. |

## If nothing here helps

Open an issue, as [Contributing](../../CONTRIBUTING.md#the-best-way-to-help-open-an-issue) says.
Search the open issues first: someone may have seen the same thing. In your issue, give:

- what you did, what you expected and what happened instead;
- the message the app showed, word for word;
- the version of Lifestream, from **Settings** › **Updates** › **Version**, and of macOS or iOS. On
  your iPhone, open **Connectors**, then **This iPhone**: the version is under **About**.

Lifestream's logs, in `~/Library/Logs/lifestream`, say what it did and when. They can name your
accounts and files, so read a log before you paste any of it into an issue, and never paste your
messages, emails or other data. A security problem is never a public issue: follow
[SECURITY.md](../../SECURITY.md).

## Next

- [Chat with your life](./chat.md)
- [Bring in your past from an export](./imports.md)
