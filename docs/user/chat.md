# Chat with your life

Chat answers questions about your life from what Lifestream holds. Each answer cites the messages,
emails, photos and days it used, so you can open them and check.

## Before you start

- Lifestream on your Mac. Chat runs there, and the iPhone app asks it there.
- A model that can chat, connected in **Settings** › **Providers**: a ChatGPT or Claude plan, a
  model through your OpenRouter key, or a model on another server, such as one your Mac runs.
  [Connect a ChatGPT or Claude plan](./ai-models.md#connect-a-chatgpt-or-claude-plan) gives the
  steps. A free ChatGPT plan cannot answer in Chat.

Chat answers with the model chosen for **Chat** in **Settings** › **Default models**. Lifestream chooses
one whenever none is chosen and a model that fits is ready: Claude Opus 5.5 at **Medium** on your
Claude plan, else GPT-6.2 Sol on your ChatGPT plan, else GPT-6 Luna through your OpenRouter key. To
ask one question of another model, pick it in Chat's model menu. The menu lists the suggested models
and the ones in use; **More** finds any other model that fits Chat by its name or id.

## Ask a question

1. Click **Chat** in the sidebar.
2. Type your question where it says **Ask anything**, and press Return.

While Chat works, the line under your question says what it is doing, such as "Searching messages
for "dinner"". When the answer starts, the line says how long Chat thought, such as "Thought for
9s". Once the answer is done, click the line to see each thing Chat read.

Ask a follow-up in the same conversation, such as "and in March?". Chat keeps the person, place and
dates of the answer before, and changes only what your new question changes.

To change a question, point at it and click **Edit**. Your words go back in the box, and you send
them as a new question. A voice note can't be edited.

## Follow an answer back to your data

An answer cites what it used with small numbers in the text. Point at a number to see what it
cites and its day. Click it to open that message, email or page in a panel over Chat. Where an
answer cites more than two things in one place, it shows the first two and a count, such as "+3":
click the count for the rest. A photo the answer cites shows in the answer.

A voice note the answer cites, from WhatsApp, iMessage or the iPhone app, shows under its sentence
as a bar with its length, who said it and when. Click play to hear it, one note at a time, or the
name under it to open the note in its conversation.

In the panel, the arrows step through every item the answer cites. **Open day** opens Timeline at
that moment. Press Esc to close the panel.

To see what the model got, click the eye beside **Copy** under an answer. Each hidden detail then
shows as the placeholder that replaced it, such as `[[Person 1]]`, and a photo as the covered
picture the model saw. Click the eye again to go back. The eye shows only where the model got
something hidden or added.

## Ask about a photo or out loud

To ask about a photo, click **+** in the box and choose **Photos…** or **Files…** (⌘O), paste one
with ⌘V, or drop photos on Chat: up to ten, each up to 25 MB. If the model you picked can't see
photos, the **+** menu is greyed and says so, such as "qwen3.5:9b can't see photos.": pick another
model.

To ask out loud, click the microphone and talk. Click the square or the arrow to send, or click
**×** or press Esc to throw the note away. Lifestream writes out what you said under the note, with
the model chosen for **Voice notes** in **Settings** › **Default models**. While no model is chosen, the
microphone records nothing: it says **Choose a model for Voice notes**, with **Open Providers**. A note you throw away is deleted from Lifestream.

## Stop an answer

While Chat answers, the send button becomes a square. Click it, or press ⌘., to stop. The answer
keeps what it wrote so far, and ends with "Stopped". Closing the window does not stop an answer:
Chat finishes it and keeps it.

## Go back to a past conversation

On the Mac, click the clock at the top left of Chat. Your conversations open under it, newest
first; type to find one by its title. Click one to open it and ask more. To start a new one, click
**New conversation** at the top right, or press ⌘N.

## Pick the model

Under the box, a chip names the model and how long it thinks, such as **Claude Opus 5.5 · Medium**.
Click it:

- **Thinking** picks how long Chat thinks before it answers.
- **Model** lists the models you can use now, each by its name, the ones on your own machines
  under **Local**, then **More** to find any other model that fits Chat.
- **Voice** picks the model that writes out your voice notes in Chat, from the models that hear
  audio, each by its name.
- **Reset to default** goes back to Lifestream's choice.

Lifestream keeps your pick until you clear it, even while its plan is signed out. While your pick
isn't ready, the line over the box says what it needs, and Chat asks nothing until you pick another
model or set it up.

## Choose what Chat hides

Beside the model chip, a second chip says how much Chat hides of what it sends: **Hide all**,
**Keep names** or **Don't hide**. A new conversation starts at **Chat** in **Settings** ›
**Privacy**. Click the chip, under **Sensitive information**, to change it for this conversation.
The change applies from your next question.

A model that stays on your Mac gets your conversation as it is, since nothing leaves. For such a
model the chip is not shown.

## Chat on your iPhone

Chat is the first tab of the iPhone app, with **Ask anything** at the bottom. You ask, stop and
follow numbers as on the Mac. If your iPhone has a passcode, Chat opens after Face ID or the
passcode. The iPhone asks Chat on your Mac, so it works while your iPhone can reach Lifestream, on
the same Wi-Fi as your Mac or through Tailscale.

- To see your conversations, tap the clock at the top left.
- Under **Ask anything**, tap the model to pick another **Model** or **Thinking**. Your iPhone keeps
  its own pick, apart from your Mac's.
- To ask about a photo, tap **+** and choose **Photo Library**, **Take Photo** or **Choose File**. A
  photo you take in Chat is not saved to your library.
- To ask out loud, tap the microphone. Your note is not added to the iPhone's voice notes. If you
  leave the app or take a call, the recording stops and waits for you to send it.

A question you send while Lifestream is away waits on your iPhone, and goes once Lifestream
answers.

## How Chat answers

Chat leads with the answer, then the detail that names it: the person, the place, the date. If it
is not sure, it says so in one line after the answer.

A name can fit more than one person, such as two contacts called Sam. Chat chooses by what
Lifestream shows: the person the conversation is already about, or the one you were in touch with
at the time you ask about. It answers for that person, then says in one line who the other is and
what the answer would be for them. If nothing points to one person, Chat answers for each, or asks
you which one you mean.

Chat counts and adds up with Lifestream's own totals, never by adding up search results. Each
number says what it counts and what it leaves out. A day with no value, such as a night your watch
did not record, is left out and never counted as zero. If Lifestream holds two ways to measure
something, such as time asleep and time in bed, Chat gives both, each named.

If Chat finds nothing, it says what it searched and the nearest thing it did find. If your question
asks about days Lifestream does not hold, Chat says Lifestream does not reach them. A follow-up
reuses what the answer before it read.

## What Chat sends

Your question, the conversation so far and each thing Chat reads to answer, photos included, go to
the company of the model you picked, with personal details hidden. A model that stays on your Mac
gets them as they are.
[What leaves your Mac](./what-leaves-your-mac.md#what-chat-sends) says what is hidden, and what
happens to photos and voice notes.

When Chat shows a message instead of an answer, [Problems and fixes](./problems.md#chat) says what
it means and what to do.

## Next

- [Connect an agent](./connect-an-agent.md), to let Claude, ChatGPT or Muse read Lifestream in their
  own apps.
- [Pair your iPhone](./pair-your-iphone.md), to use Chat on your iPhone.
