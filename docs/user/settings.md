# Settings

**Settings** holds every setting of Lifestream that is not a connector's. This page lists each one
by the page it is on, with what it changes and its default.

To open Settings, press ⌘, in Lifestream on your Mac, or click your name at the bottom of the
sidebar and choose **Settings**. **Settings…** is also in the menu bar menu. The rows in the side
column of **Connectors** (Lifestream, each Mac and iPhone, the Chrome extension) open their page of
Settings too.

Settings lists its pages on the left in four groups: **Lifestream**, **Devices**, **Models** and
**App**. Type in **Search** at the top of the list to find a setting by its name.

Only the Mac that runs Lifestream changes these settings. On another Mac, each page shows its
values in words and says where to change them.

A connector's own settings are in its window on **Connectors**.
[Connectors](./connectors/README.md#settings-every-connector-has) lists the settings every
connector has, and each connector's page lists its own. The iPhone app has no settings page: its
connectors' settings are on **Connectors** too.

## Lifestream

### General

| Setting | What it changes | Default |
|---|---|---|
| **Status** | Shows whether Lifestream runs, and when it last checked. If something is wrong, it shows the problem and the button that fixes it. | |
| **Pause Lifestream** | Stops everything Lifestream does until you resume. New data from your devices is kept and waits. | Off |
| **Activity log** | **Open log** opens everything Lifestream did, line by line. | |
| **Paused right now** | Lists each other pause, such as a connector you paused. **Resume** ends it. | |

### Storage

Storage shows what Lifestream's disk holds, as the Mac's own Storage settings do. At the top is
Lifestream's size, and the free space on its disk. The bar under it splits the disk: your five
largest connectors in colour, **Other connectors** for the rest, **Index and AI** (search,
summaries and model answers), the disk's other files, and free space. Point at a part to light it
in the bar, its key, the chart and its rows.

- **Growth** says how fast the disk fills and when it is full at that rate, such as **Drive fills by
  about 2.1 GB a day. At this rate it is full around 11 May 2027.** It waits for a week of
  readings first. The chart under it shows Lifestream's size by day, its rate a dashed line ahead.
- **What uses the space** lists your five largest connectors and **Index and AI**, each with its
  size and what it added this week. **Show** *N* **more connectors** lists the rest. Click a
  connector to open its window.

While Lifestream counts what it holds, Storage says **Counting…** and how much is counted so far,
and the bar shows **Not yet counted**. Each figure only rises until the count ends.

When you erase a connector, its files leave the disk at once. Its text moves into **Index and AI**,
since Lifestream's database keeps its size and reuses the space for new data.

| Setting | What it changes | Default |
|---|---|---|
| **Folder** | Shows the folder Lifestream keeps your data in. **Show in Finder** opens that folder. [Move Lifestream's folder](./move-your-home.md) says how to move it. | |
| **Space kept free** | Below this much free space, Lifestream keeps taking new data, but history and imports wait. | 5 GB |

### Day and time

| Setting | What it changes | Default |
|---|---|---|
| **Time zone** | The time zone your days, times and the Timeline follow. | The Mac's time zone at setup |
| **A day starts at** | Anything before this hour counts as the night before, so a late night stays one day. | 4:00 AM |

Settings shows these two, but does not change them. To change one, run a command in Terminal on
the Mac that runs Lifestream, such as:

```sh
lifestream settings set day.day_start_hour 5
```

The time zone is `day.zone`, such as `Europe/Lisbon`. Lifestream uses the new value from its next
start. It then lays out every day again, which takes a while for a long history.

### Recovery key

| Setting | What it changes | Default |
|---|---|---|
| **Recovery key** | Says whether your recovery key is saved, and on which day. Its button opens Lifestream's own **Recovery key** window, the only place the key shows. | Saved, from setup |

[Check where your key stands](./recovery-key.md#check-where-your-key-stands) says what each state
means and what to click.

## Devices

### This Mac

With more than one Mac, this page is called **Macs**, and each Mac has a part under its name, this
Mac's first.

| Setting | What it changes | Default |
|---|---|---|
| **Name** | How the Mac shows in Lifestream and on your other devices. **Rename…** changes it, in at most 64 characters. | The Mac's name at pairing |
| **Open at login** | Lifestream opens when you log in, so this Mac records and syncs after a restart. If you turned Lifestream off in Login Items, this opens Login Items, where you turn it on. | On, from setup |
| **Records** | Lists each connector this Mac sends. Each opens its connector's window. | |
| **Permissions** | Lists each permission Lifestream asks macOS for. **Allow** asks for one, **Allow all** for every missing one. [Mac permissions](./mac-permissions.md) says what each is for. | |
| **Command line** | Says whether the command `lifestream` works in new terminal windows, for your coding agent. For a shell Lifestream writes no file for, it gives the command's full path, and adding `~/.local/bin` to your shell's PATH is yours to do. **Remove** takes the command away, with the lines it added to your shell's files; **Install** puts it back. [Add a connector with your coding agent](./add-a-connector.md#the-lifestream-command) says what it changes. | Installed, from setup |
| **Agent prompt** | The line that asks your coding agent to add a connector, with a copy button beside it. | |
| **Uninstall Lifestream** | **Uninstall…** removes the app from this Mac. Its folder is kept unless you choose to erase it. | |

### iPhone

With more than one iPhone, this page is called **iPhones**.

| Setting | What it changes | Default |
|---|---|---|
| Each iPhone | Shows its status and the connectors it sends. Each connector opens its window. **Remove** on **This iPhone** stops the iPhone recording once it has synced. Its history stays in Lifestream. | |
| **Pair an iPhone** | Under **Add an iPhone** once one is paired. **Show code** shows a code that the iPhone app scans. The code works only while it is shown. [Pair your iPhone](./pair-your-iphone.md) says how. | |
| **Removed** | Lists the iPhones you removed. Their history stays in Lifestream. | |

### Chrome extension

| Setting | What it changes | Default |
|---|---|---|
| Each browser | Shows each Chrome profile that the extension runs in, and its status. | |
| **Connect another browser** | **Connect** adds another Chrome profile, or Chrome on another Mac. With no extension yet, this is **Add to Chrome**. | |
| **Reads in Chrome** | Lists each site the extension reads in your own signed-in Chrome. Each opens its connector's window. | |

[The Chrome extension](./chrome-extension.md) says what it does.

## Models

### AI models

[Choose which AI models read your data](./ai-models.md) says how to use these. The page lists your
connections first, then **Uses**.

#### On this Mac

This part lists the models that run on your Mac. A part for each other Mac that runs models takes
that Mac's name, such as **On Mac mini**. Each model has **Download**, then **Cancel** while it
downloads, **Remove** once it is ready, or **Try again** if the download failed. Picking a model
under **Uses** downloads it too. The hiding model is not listed here: it downloads when you pick it
for **Hiding details**.
[Use a model on your Mac](./ai-models.md#use-a-model-on-your-mac) lists the models.

| Setting | What it changes | Default |
|---|---|---|
| **Run models** | Off, the Mac holds its models' work until you turn it on again. It shows once a model is ready. | On |
| **Save battery** | On battery, the Mac's models work only on today's and yesterday's items. The rest wait until it is plugged in. | On |

#### Accounts

| Setting | What it changes | Default |
|---|---|---|
| **ChatGPT** | Connects your ChatGPT plan. **Connect** downloads Codex, then signs you in. **Sign out** disconnects it. | Not connected, unless you connected it during setup |
| **Claude** | Connects your Claude plan in the same way. **Connect** downloads Claude Code, then signs you in. | Not connected, unless you connected it during setup |
| **OpenRouter** | Paste a key from openrouter.ai/keys into **OpenRouter key** and click **Save**. Lifestream keeps the key in your vault. **Remove** deletes it. | Not set |

#### Custom address

| Setting | What it changes | Default |
|---|---|---|
| **Custom address** | A server you run yourself, at an address that takes requests the way OpenAI's API does, such as Ollama's or LM Studio's. It lists its own models. **Add address** sets its **Address**. **Remove** stops using it. | Not set |

#### Uses

Each use is the model one job runs on. Its menu lists the models that fit it. Picking a model on
your Mac that isn't downloaded yet downloads it, and the use's line shows how far it is.

| Setting | What it changes | Default |
|---|---|---|
| **Photos** | The model for **Photo descriptions**, or **Off**. | Off |
| **Voice notes** | The model for **Voice note transcripts** and Chat's voice notes, or **Off**. | Off |
| **Text** | The model for **Email summaries**, **Chat summaries** and **Screen summaries**, or **Off**. | The first model that is ready for text |
| **Chat** | The model Chat answers with. | Claude Opus 5.5, else GPT-6.2 Sol, else GPT-6 Luna through OpenRouter, once one is ready |
| **Thinking** | Under **Chat**: how long Chat's model thinks before it answers. | Medium |
| **Search by meaning** | The model that finds moments on your screen by meaning, or **Off**. It lists only models that run on a Mac. | Off |
| **Hiding details** | The hiding model, which finds names Lifestream has never seen, or **Off**. It lists only models that run on a Mac. | Off |

### Privacy

**Privacy** sets what Lifestream hides before an item leaves your Mac for a model or an agent, and
shows what left. [What leaves your Mac](./what-leaves-your-mac.md#what-is-hidden-before-sending) says
what hiding replaces and what it misses.

| Setting | What it changes | Default |
|---|---|---|
| **Hide personal details** | **Hide what Lifestream knows** replaces numbers, addresses, links, passwords and the names in People. **Don't hide** sends each item as it is. | Hide what Lifestream knows |
| **Hiding model** | Shows the model chosen for **Hiding details** in **AI models**, which also finds names Lifestream has never seen. **Choose** or **Change** opens **AI models**. | Off |
| **Chat** | What Chat hides when it asks a model: **Hide all**, **Keep names** or **Don't hide**. If Chat's voice notes go to a company, the row says so: sound can't be hidden. | **Hide all**, or **Don't hide** when **Hide personal details** is **Don't hide** |
| **Links** | What a link keeps: **Hide sign-in parts and codes** keeps its site and its path, **Hide everything after the site** keeps its site alone, **Don't hide** leaves it as it is. | Hide sign-in parts and codes |
| **Always hide** | Words hidden wherever they appear. **Edit** adds or removes one. | None |
| **Never hide** | Words that leave as they are when a detail is exactly one of them. **Edit** adds or removes one. | None |

Under them, **What hiding can't do** lists its limits. **What left Lifestream today** lists each
company that got something today, with how many items and how many details were hidden. **Earlier**
covers the 13 days before. Click **View**, then an item, to see **What was sent**.

### Search by meaning

**Search by meaning** lets [Search](./search.md#search-by-meaning) find a moment on your screen by
what it was about, not only by its words. It runs on a Mac only, and nothing leaves it.

| Setting | What it changes | Default |
|---|---|---|
| **Model** | Shows the model chosen for **Search by meaning** in **AI models**, such as **EmbeddingGemma 2**. **Choose** or **Change** opens **AI models**. Download the model under **On this Mac** first. Once one is chosen, this Mac reads your screen's text for meaning, newest day first. Word search works either way. | Off |
| **When it runs** | **Only when plugged in and idle**, so it never slows you down or spends your battery. | Only when plugged in and idle |

While a model is chosen, **Searchable** says how much of your screen it has read, and **On disk**
how much space it keeps.

## App

### Appearance

| Setting | What it changes | Default |
|---|---|---|
| **Theme** | **System** follows your Mac's appearance. **Light** and **Dark** keep one. | System |

### Updates

| Setting | What it changes | Default |
|---|---|---|
| **Version** | Shows the version you run. **Check for Updates…** looks for a new one now. While an update waits, **Restart to Update** installs it. | |
| **Install updates automatically** | Lifestream restarts into an update when you lock your screen. Off, each update waits for you to click **Restart to Update**. | On |

A build that you made yourself does not update itself: **Updates** shows its version alone.
[Update Lifestream](./update.md#the-mac-app) says when updates install.

### Advanced

| Setting | What it changes | Default |
|---|---|---|
| **Model calls at once** | The most model calls Lifestream makes at the same time. It applies at once. | 8 |
| **Background work** | How many jobs Lifestream runs side by side. **Automatic** picks a number from the Mac's processor. | Automatic |
| **Largest upload** | A device's single upload above this size is refused. | 69 GB |
| **Port** | Where apps and agents on this Mac and on Tailscale reach Lifestream. | 4680 |
| **Local network port** | Where your iPhone reaches Lifestream on the same Wi-Fi. | 4682 |

Settings shows **Background work**, **Largest upload** and the two ports, but does not change them.
They apply only when Lifestream restarts, and a changed port stops your paired devices from finding
Lifestream.

## Next

- [Choose which AI models read your data](./ai-models.md)
- [Connectors](./connectors/README.md), for the settings of each connector.
- [Uninstall Lifestream](./uninstall.md), for what the uninstall removes.
