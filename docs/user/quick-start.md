# Quick start

This guide sets up Lifestream on your Mac, pairs your iPhone, and ends with a first answer from
Chat and today on Timeline. Lifestream keeps what it gathers in a folder on your Mac, or on a drive
you choose, and nowhere else.

## Before you start

- A Mac with Apple silicon and macOS 14.2 or later.
- Space for Lifestream. It plans for about 3 GB a week from your Mac and 5 GB more from an iPhone.
- An iPhone with iOS 26 or later, on the same Wi-Fi as your Mac or connected to it through
  Tailscale, an app that links your own devices over the internet. You can leave the iPhone out
  and pair it later.
- A paid ChatGPT or Claude plan, or an OpenRouter key, if you want Chat to answer questions about
  your life.

## Install the Mac app

1. On [trylifestream.com](https://trylifestream.com), click **Download for Mac**.
2. Open the disk image, and drag Lifestream into Applications.
3. Open Lifestream from Applications.

Lifestream opens its setup. Click **Get started**, then **Continue**, then **Set it up**.

## Choose where Lifestream lives

1. Choose **This Mac** to keep Lifestream in `~/Lifestream`, or **An external drive**. An external
   drive must stay plugged in.
2. Click **Continue**. Lifestream is always encrypted:
   [How Lifestream keeps your data safe](./keep-your-data-safe.md#encryption) says what that
   protects.
3. Setup shows your recovery key. Click **Copy** or **Save as file**, keep the key away from this
   Mac, then click **Continue**. Lifestream makes its folder only once you do.

> [!WARNING]
> An encrypted Lifestream opens only with this Mac's key or your recovery key. If you lose both,
> nobody can open your Lifestream. Keep the recovery key somewhere other than this Mac.

4. If Lifestream asks you to allow it in Login Items, click **Open Login Items** and turn
   Lifestream on. Lifestream then opens when you log in, so your Mac keeps recording after a
   restart.

## Say your name

Lifestream asks your name once, so it knows which person in your life is you.

1. On **Your name**, check **Full name** and **What should Lifestream call you?**. Lifestream
   fills them from your Mac account.
2. Click **Continue**.

Your own WhatsApp, iMessage and Gmail accounts join you by themselves when they arrive. On
**People**, the **You** card at the side opens your own page. To change your name later, open your
page and click **Edit**.

## Let Lifestream read your Mac

The next three screens each ask macOS for a permission. Allow the ones you want. When System
Settings asks for your Mac's password, type it. A screen you skip with **Set up later** or
**Skip** waits in the sidebar under **Finish setting up**.

1. On **Mac Sources**, click **Give Full Disk Access**. macOS opens System Settings. Turn on
   Lifestream in the list. Lifestream comes back to the front: click **Continue**. It can now
   read your messages, notes, calls and the history of other apps on this Mac.
2. On **Your photos**, click **Allow** beside **Photos**, then **Allow access to all Photos**.
   Lifestream finds the people in your photos unless you turn off **Recognise people in your
   photos**. Click **Continue**.
3. On **Your Mac Screen, Clicks, and Audio**, click **Allow** for each thing you want Lifestream
   to record: **Audio**, **Keyboard and mouse** and **Screen**.
4. To keep an app or a site out from the start, such as your bank, click **Edit** beside **Not
   recorded**. Type an app's name in **Add an app**, or a site in **Add a site, like mybank.com**,
   then click **Done**. Password managers are on the list already.
5. Click **Continue**.

Each **Allow** on the third screen opens a prompt from macOS:

- **Audio** asks twice, for the microphone and for your Mac's sound. Click **Allow** both times.
- **Keyboard and mouse** opens System Settings at **Accessibility**. Turn on Lifestream in the list.
- **Screen** asks first. Click **Open System Settings**, turn on Lifestream, then click
  **Quit & Reopen**. Lifestream opens again on the same screen, and macOS asks once more. Click
  **Allow**.

Lifestream starts to read each app you allow, newest first. [Choose what is
recorded](./choose-what-is-recorded.md) says how to change the list later.

## Pair your iPhone

If you do not have your iPhone with you, click **Skip** and pair it later.

1. On **Connect your iPhone**, scan the first code with your iPhone's Camera. It opens
   TestFlight. Install Lifestream from there.
2. On your Mac, click **Pair it**. The pairing code shows under **Pair it with this Mac**.
3. Open Lifestream on your iPhone, and tap **Set up**.
4. Tap **Scan the code**, and scan the code on your Mac. If you cannot scan it, type the eight
   digits shown beside the code instead. Your iPhone then asks if your Mac shows a second code.
   Tap **Yes** if it does.
5. If the **Apple ID** field is empty, type your Apple ID. Your iPhone sends Health, Photos and
   Contacts only once it has your Apple ID. Tap **Pair**.

   Lifestream uses your Apple ID as a label: it marks your Health, Photos and Contacts as your
   Apple account's, the same account as on your Mac. It does not sign in to Apple with it.
6. Tap **Allow** or **Not now** on each screen that asks for a permission, such as **Location**
   and **Health**.
7. Tap **Start**. Your iPhone asks for Face ID or your passcode, then opens Timeline.
8. On your Mac, click **Continue**.

Your iPhone sends what it records to Lifestream while it is on the same Wi-Fi as your Mac, or
while both are connected through Tailscale.

## Skip the extension and accounts for now

The next two screens add the Chrome extension, and the accounts that need a password, such as
Gmail. Click **Skip**, then **Skip for now**. You can add both later from **Connectors**.

## Connect your AI

This step is optional. Skip it, and nothing is sent to an AI.

1. On **Connect your AI**, click **Connect** beside the plan you pay for, Claude or ChatGPT.
   Lifestream downloads the program it uses for that plan, then asks you to sign in.
   [Connect a ChatGPT or Claude plan](./ai-models.md#connect-a-chatgpt-or-claude-plan) says each
   step of the sign-in.
2. Choose whether **Hide personal details** is on. It is on unless you turn it off.
   **How it works** shows what it replaces.
3. Once the plan's line shows your account, click **Continue**. To skip the step, click
   **Not now**.

Connecting a plan gives Chat its model: Claude Opus 5.5 on your Claude plan, else GPT-6.2 Sol on
your ChatGPT plan. It also gives **Text** its model, which sums up your emails, long AI-chat
messages and screen. So those items, and what Chat reads to answer you, go to that plan's company:
Anthropic for Claude, OpenAI for ChatGPT. [What leaves your Mac](./what-leaves-your-mac.md#what-is-hidden-before-sending)
says what hiding replaces.

## Make your pictures and audio searchable

Photos and voice notes go to no model until you pick one.

1. Beside **Describe photos and screenshots**, pick where a model reads your photos: **Off**, a plan
   you connected, or **On this Mac**. Each choice names its model, or what it needs first, such as
   **Connect Claude first**.
2. Beside **Turn voice into text**, pick **Off** or **On this Mac**.
3. Click **Continue**. A model on this Mac downloads in the background.

You can change both later under **Uses** in **Settings** › **AI models**, as
[Choose which AI models read your data](./ai-models.md#pick-a-model-for-each-use) says.

## See your day

1. On **You’re all set**, click **Get started**. Lifestream opens Chat and a short tour.
2. Ask Chat a question, such as "What did I do this morning?"
3. Click **Timeline** in the sidebar to see today.

## What the first hour looks like

Lifestream records from now on, and brings in your past at the same time. You can use it at once.

- **Today fills first.** Each connector brings in what is new, and your screen is recorded from the
  moment you allowed it.
- **Your past arrives newest first.** Each connector works back through your past, so last week
  shows before last year. A large mailbox can take several days. Open a connector on
  **Connectors** to see how far it has come.
- **Places need your iPhone.** Where you were comes from your iPhone's location. Today's stays fill
  in as your iPhone records where you go.
- **Some parts wait for a model.** Summaries of your screen time come as the model you connected
  reads them. Photo descriptions and voice note transcripts come once you pick a model for
  **Photos** and **Voice notes**: a ChatGPT or Claude plan does not write out voice notes.
- **Names come later.** Places asks you to name a place once you have stayed there on 3 days, or for
  an hour in one day. People asks when it is not sure two names are one person.

## Next

- [Connectors](./connectors/README.md), to add Gmail, WhatsApp and the rest.
- [What leaves your Mac](./what-leaves-your-mac.md), to see what goes to a model, and how to stop it.
- [Timeline](./timeline.md), to read a day.
