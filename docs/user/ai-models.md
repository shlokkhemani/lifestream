# Choose which AI models read your data

AI models describe your photos, write out your voice notes, sum up your emails and screen, answer
in Chat, search your screen by meaning and find personal details to hide. This guide connects the
models you want, picks which model does each of these jobs, and turns them off. You set them in
**Settings** › **AI models**: press ⌘, in Lifestream on your Mac.

## Connections and uses

**AI models** holds two things. A connection is an account or an address that reaches models: your
ChatGPT or Claude plan, your OpenRouter key, the models on your Mac, or a custom address. Each
connection lists the models it reaches. A use is one job Lifestream gives a model, and each use runs
on one model.

Any model can do any use it fits. A use asks something of its model, and a model that cannot do it
is not offered for that use:

| Use | What its model must do | Until you pick a model |
|---|---|---|
| **Photos** | See pictures | **Off** |
| **Voice notes** | Hear audio | **Off** |
| **Text** | Read text | The first model that is ready, such as Claude Haiku 5.5 on your Claude plan |
| **Chat** | Read text, search your records, and hold 32,000 tokens or more | Claude Opus 5.5 at **Medium**, else GPT-6.2 Sol on your ChatGPT plan, else GPT-6 Luna through your OpenRouter key |
| **Search by meaning** | Find text by its meaning, on a Mac | **Off** |
| **Hiding details** | Find personal details, on a Mac | **Off** |

**Off** sends nothing. **Chat** has no **Off**: it always answers with a model. Lifestream picks a
model for **Text** once, as soon as a model that fits is ready, and for **Chat** whenever none is
picked and one that fits is ready. After that it never changes your pick: a model you pick, or
**Off**, stays.

OpenRouter is a service that sells access to many AI models, paid as you go. Another computer that
runs models for Lifestream has its own part, **On** *its name*.
[What leaves your Mac](./what-leaves-your-mac.md) names every receiver and what each one gets.

## Connect a ChatGPT or Claude plan

1. Open **Settings** › **AI models**. If Chat shows **Sign in with ChatGPT…**,
   **Sign in with Claude…** or **Connect a model…**, you can click that instead.
2. Under **Accounts**, click **Connect** beside **ChatGPT** or **Claude**. If the button says
   **Sign in**, click that. Lifestream first downloads the program the plan needs: Codex for
   ChatGPT, Claude Code for Claude. Its progress shows beside the plan.
3. Click **Open sign-in page**. Your browser opens OpenAI's or Anthropic's sign-in page.
4. Sign in:
   - For ChatGPT, type the code shown under **Your code** on OpenAI's page.
   - For Claude, approve on Anthropic's page. If it shows a code, paste it into
     **Code from Anthropic**, and press Return.

When it worked, the plan's line shows your account, and the plan's models are in the menus under
**Uses**. During setup, **Connect your AI** takes the same steps.

## Use an OpenRouter key

1. Make a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open **Settings** › **AI models**, and find **OpenRouter** under **Accounts**.
3. Paste the key into **OpenRouter key**, and click **Save**.

The line then says **Connected**, and the models OpenRouter offers are in the menus under **Uses**.
Lifestream keeps the key locked in your vault.

## Use a model on your Mac

Models on the Mac need a Mac with Apple silicon. On a Mac with an Intel processor, **On this Mac**
lists only Parakeet and Nemotron Speech.

1. Open **Settings** › **AI models**.
2. Under **Uses**, open the menu of the use, such as **Photos**.
3. Pick the model. A model not yet on your Mac says what picking it does, such as
   "Download Qwen 3.5 · 4.2 GB".

Picking a model on your Mac downloads it, in setup and in Settings alike. The line under the use
shows how far it is, such as "Downloading, 1.2 of 4.2 GB". To download a model before you pick it,
click **Download** beside it under **On this Mac**, and **Cancel** to stop it. When the model is
ready, it says **Downloaded**, and its button says **Remove**.

| Model | What it does | Needs a Mac with |
|---|---|---|
| Qwen 3.5 | Describes photos and sums up text | 16 GB of memory |
| Parakeet | Transcribes voice notes in English | 8 GB of memory |
| Nemotron Speech | Transcribes voice notes in English, Hindi and more languages | 8 GB of memory |
| EmbeddingGemma 2 | Finds moments on your screen by meaning, for **Search by meaning** | 8 GB of memory |
| Privacy Filter | Finds personal details to hide, for **Hiding details** | 8 GB of memory |

Privacy Filter is not listed under **On this Mac**: it downloads when you pick it for
**Hiding details**, and is removed when you pick another model or **Off**.

Each model's line gives its size and what it does. The model your Mac's memory suits best for a use
says so, such as "suggested for this Mac's 24 GB". A model too large for your Mac says
"Needs a Mac with 16 GB", and has no **Download**.

While your Mac runs on battery, a model on it works only on today's and yesterday's items. The rest
waits until your Mac is plugged in, and the connector says so, such as "1,200 photos wait until
MacBook Pro is plugged in". This is **Save battery**, under your Mac's models, on unless you turn it
off. Turn it off to run everything on battery.

To stop your Mac running its models for a while, turn off **Run models** under them. Their work
waits until you turn it on again.

## Use a model at your own address

The address must take requests the way OpenAI's chat API does, as Ollama's and LM Studio's do.

1. Open **Settings** › **AI models**, and click **Add address** beside **Custom address**.
2. In **Address**, type the address, such as `http://127.0.0.1:11434/v1`.
3. Click **Save**.

**Custom address** then shows the address, and the menus under **Uses** list the models it serves.
Click **Remove** to stop using it.

Lifestream takes a model at your address to read text only, and never picks one for a use by itself.
For Chat, run the model in that server with a context window of 32,000 tokens or more: Chat sends
it that much, with room for its answer, since the address does not say how much its model holds.
The row says **Chat needs the server to run a context window of 32,000 tokens or more**.

A model at an address on this Mac keeps your data on this Mac. Lifestream hides nothing in what it
sends to such a model, since nothing leaves.

## Pick a model for each use

Under **Uses**, each use has a menu. It lists the models suggested for the use and the ones in use,
each by its name. Models that run on your own machines, on a Mac's runner or at your custom address,
are under **Local**; the rest are above it. A menu lists only the models you can use now: a model
whose account isn't signed in, or that your Mac is too small for, isn't listed. A model your Mac
can run but hasn't downloaded yet is listed, and picking it downloads it. When one model comes
through two accounts, each row names its account after the model, such as **Opus 5.5 OpenRouter**.
To pick another model, choose **More** and type part of its name or id: it lists up to 20 models
that fit the use, or **No matches**.

Under **Chat**, **Thinking** picks how long Chat's model thinks before it answers, such as
**Medium**.

Each use serves these settings:

| Use | What it serves |
|---|---|
| **Photos** | **Photo descriptions** |
| **Voice notes** | **Voice note transcripts**, and the voice notes you send in Chat |
| **Text** | **Email summaries**, **Chat summaries**, **Screen summaries** |
| **Chat** | Each question you ask in Chat with no model of its own picked |
| **Search by meaning** | [Search by meaning](./settings.md#search-by-meaning) |
| **Hiding details** | The **Hiding model** in [Privacy](./settings.md#privacy) |

To turn **Photos**, **Voice notes**, **Text**, **Search by meaning** or **Hiding details** off,
pick **Off** in its menu.

While **Voice notes** is **Off**, Chat's voice button says **Choose a model for Voice notes**. A
voice note sent to a model off your Mac goes as it is: Lifestream cannot hide personal details in a
voice.

If the model a use names no longer fits it, or can't be used now, the use says why, such as
**GPT-6 Luna can't hear audio** or **Sign in to Claude again**, and the menu doesn't list it. Its
work waits until you pick another model.

## Pick a model for one connector

Open **Connectors**, then the connector. Under **AI**, click a job, such as **Email summaries**. Its
**Model** is **Default**, a model that fits the job, or **Off**. **Default** follows the job's use in
**AI models**, and names its model, such as **Default · Qwen 3.5**, or **Default · None** when the
use has none. The menu lists the models suggested for the job and the ones in use, local ones
under **Local**. To pick another, choose **More** and type part of its name or id: it lists up to
20 models that fit the job. [Connectors](./connectors/README.md#settings-every-connector-has) says how these
settings and **Read back to** work.

A model that sends what it reads away gets each item with its personal details hidden, unless you
change that, as [What leaves your Mac](./what-leaves-your-mac.md#what-is-hidden-before-sending)
says. **Screen summaries** need a model that takes a whole sitting's text: Qwen 3.5 is too small
for it, so its menu does not offer it. [Screen](./connectors/screen.md#what-a-model-reads) says what
a screen summary sends.

## Keep your data on your Mac

In every model menu, the models under **Local** run on your own machines: a Mac's runner, or the
server at your custom address. Every model above **Local** sends what it reads to the company that
runs it, such as OpenAI. To keep a connector's items on your machines, give each of its jobs a
model under **Local**, or set it to **Off**. **Search by meaning** and **Hiding details** only offer
models that run on a Mac.

## Turn models off

- To stop one job of one connector, click it under the connector's **AI**, and set **Model** to
  **Off**.
- To stop using a plan, click **Sign out** beside it under **Accounts**. To stop using a key or a
  custom address, click **Remove**.
- To stop the models on your Mac, turn off **Run models** under them, or click **Remove** beside
  each one.

A use or setting that names a model you signed out of or removed keeps it, and says
*the model* **isn't offered now** when no connection lists it. Its work waits until the model is
back, or until you pick another one. Lifestream never moves it to another model by itself.

## Next

- [Chat with your life](./chat.md#pick-the-model), to pick the model for one question.
- [Connectors](./connectors/README.md#settings-every-connector-has), to set what a model does with a connector.
- [Settings](./settings.md), for every setting in **Settings**.
