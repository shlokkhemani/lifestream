# Search your life

Search finds a message, an email, a photo, a song, a page, a person, a place or a day by its
words, across everything Lifestream holds. Use it when you know something happened but not when.

## Search on your Mac

1. Click **Search** in the sidebar, or press ⌘K.
2. Type what you remember in **Search everything**, such as a word from a message or a person's
   name.
3. Click a result. The right side of the window shows it, such as a message in its moment or a
   song with its plays.
4. To open the result, press Return. A person opens on People, a place on Places, and a
   conversation on People or its day on Timeline.

The Up and Down arrow keys move through the results, and the right side follows. Esc clears your
words, and a second Esc leaves Search.

## Search on your iPhone

1. Tap the magnifier at the top of any tab.
2. Type in **Search your life**.
3. Tap a result to open it.

Before you type, Search shows your last searches under **Recent**: five on your Mac, ten on your
iPhone. Choose one to search it again. Your iPhone also shows people and places under **People**
and **Places**.

## Read the results

Search shows your results in groups, the same on your Mac and your iPhone.

**Top hits** comes first. It holds the best matches: a person whose name holds your words, with
how many messages you share; a place whose name holds them, with how many days you were there;
and the day or month your words name. Open a person to see their page on People, a place to see
it on Places, and a day or a month to see it on Timeline.

Search reads these words as a day or a month: **today**, **yesterday**, a date such as **14 oct**
or **2026-10-14**, and a month such as **march 2025**. A date or a month without a year means the
last one, today included.

A group follows for each type of thing your words found, such as **Messages**, **Mail**,
**Photos**, **Mac** or **Listening**, with how many match. Each group shows its first few results.
Click **See all** to see every result of that type, newest first, each with its date.

## Narrow the results

A row of chips sits under the field. **All** shows every type, with how many things match in
total. The other chips are the types, each with its count. Choose a chip to see every result of
that type, as **See all** does. Choose **All** to go back.

A count that ends in **+**, such as **2,000+**, means at least that many match. Search stopped
counting there.

**Any time**, at the end of the chips, narrows the results to **This month**, **This year**, or
an earlier year, back to the year of the oldest thing your words match.

When you see all of a type that holds things still to come, such as your calendar, **Upcoming**
and its count sit at the top. Choose it to see the things to come, soonest first. Choose
**Up to today** to go back.

## What each result opens

On your iPhone, a result opens the thing itself:

- **A message or an AI chat** opens the conversation at that moment.
- **An email** opens the email.
- **A photo** opens the photo.
- **Anything else** opens its day on Timeline, at its moment.

Two types work the same on your Mac and your iPhone:

- **Mac** shows a stretch of time at your Mac in which your words appeared on screen. Its first
  line is what you were doing. Its second line says how many windows it held, then the first app
  and the words that match. Open it to see each window that holds your words. Choose a window to
  see that minute, or **Open the day** to see that time on Timeline.
- **Listening** shows each song that matches your words, most played first, with how many times
  you played it. Open a song to see its plays: how many in all, a bar for each month, the first
  and last time, and every play with its day, time and app.

## Search by meaning

Search by meaning finds a moment on your screen by what it was about, not only by its words. Ask
for "that article about sleep I read last week", and Search can find it even when those words were
never on the screen. Its results join the **Mac** group, beside the ones that match your words.

It is off until you pick a model for **Search by meaning** in **Settings** › **Default models**,
such as EmbeddingGemma 2, once you download it under **Local models** in **Providers**.
[Settings](./settings.md#search-by-meaning) lists its settings. Your Mac then reads your screen's
text with that model, newest day first. It runs only while your Mac is plugged in and idle, and nothing leaves your Mac. A
search with every word in quotes matches words only.

## How to write a search

Search matches words in any case, with or without accents. Every word you type must match.

| Type | To find |
|---|---|
| `dinner friday` | Everything with both words. |
| `dent` | Words that start with "dent", such as "dentist". Only the last word you type works this way, once it has 3 letters. |
| `"see you there"` | The words together, in that order. |
| `dinner -work` | Everything with "dinner" and without "work". |
| `lunch OR dinner` | Everything with either word. Write OR in capitals. |

If few things in Lifestream hold a word of four letters or more, Search also looks for close
spellings of it that Lifestream holds. A word in quotes is matched only as you typed it.

## What you might see

| Search says | What it means |
|---|---|
| **Search is getting ready: 40% read.** | Lifestream is preparing Search, such as when it first starts. Results appear when it is done. |
| **Still reading 3 days, the newest 14 Nov.** | Lifestream has not yet read some days into Search. The results do not hold those days yet. |
| **Nothing matches “…”.** | No thing holds all your words. Try another spelling, or fewer words. |
| A type with no count, and a line in place of its results | Lifestream could not count that type for these words, and the line says why. |
| **Can't reach Lifestream.** | Your Mac or your iPhone cannot reach Lifestream. Search keeps your last results, and searches again when Lifestream answers. [When a device can't reach Lifestream](./problems.md#when-a-device-cant-reach-lifestream) says what to do. |

## What Search cannot find

Each connector's page says what Search finds of it, under "Where it shows up". Some connectors are not
in Search, such as [Google activity](./connectors/google-activity.md), [GitHub](./connectors/github.md)
and [Lifestream notes](./connectors/iphone-notes.md). Chat can read them when a question
needs them.

Search does not look inside a photo. It finds a photo by the words of its description, which an
AI model writes.

## Next

- [Chat with your life](./chat.md), to ask a question instead of searching for words.
- [Connectors](./connectors/README.md), to add the connectors Search reads.
