# Photos

The Photos connector brings the photos and videos in your Apple Photos library into Lifestream. It
reads the library on your Mac, the library on your iPhone, or both, and keeps a photo that is in
both only once.

## What it brings in

- Every photo and video in the library, with when and where you took it.
- The original file of each one, the file of its newest edit, and the video of a Live Photo.
- Each edit you make later, and each photo you delete. A deleted photo leaves your Timeline, but
  its files stay in Lifestream.

With iCloud Photos on, your Mac and your iPhone hold the same library. Lifestream shows each photo
once, and asks your Mac for its files first.

Your past is your library from the connector's start on, newest first: each device lists every
photo, then sends the files Lifestream lacks of those taken from the start on. On your iPhone, **New photos go at once, the rest on Wi-Fi.** On either
device, the files of older photos wait while it is on cellular or a phone's hotspot, unless its
**Mobile data** choice is **Everything, including my past**, and on a network with Low Data Mode
on, whatever the choice. While the Mac that runs Lifestream is on a hotspot, your other devices'
older photos wait for Wi-Fi too; that Mac sends its own on any network. **Bring in all photos**
sends them on any network. They also wait while the device, or the
disk that holds Lifestream, has less than 5 GB free. A file only iCloud holds is downloaded while the device is plugged in.

## Before you start

- For your Mac's library: Lifestream on your Mac. It reads the System Photo Library.
- For your iPhone's library: Lifestream on your iPhone, [paired](../pair-your-iphone.md).
- Full access to your photos on each device. With only some photos allowed, only those come in.

## Add Photos

1. Open **Connectors**, then **Photos**.
2. Under **To connect**, click **Allow**, and allow Lifestream when macOS asks. This reads your
   Mac's library.
3. To read your iPhone's library too, [pair your iPhone](../pair-your-iphone.md) if you have
   not. It asks for **Photos, Full Access** during its setup.
4. If you skipped that ask, open **Connectors** on your iPhone, tap **Photos**, then tap **Allow**.

Photos is then connected, and its window lists each device under **Comes from**.

## Where it shows up

- **Timeline** shows each photo at the time you took it, in a row named **Photo** or **Photos**.
  Photos taken within a minute of each other share one row.
- **Search** finds a photo by the words of its description.
- **Places** shows, on a place's page, the photos you took while you were there.
- **People** shows the photos a person is in, once you turn on faces and name them. The guide
  [Name the people in your photos](../name-people.md) says how.
- **Chat** finds photos by their descriptions, and can look at a photo when a question needs it.

A video's tile shows a play mark and its length. A Live Photo's tile shows its still.

## Look at a photo or a video

Click a photo on any page, or tap it on your iPhone, and it opens full size. Use the arrows to go
to the photo before or after it, and **Info** to see when and where you took it.

- **A photo** shows the right way up, as you took it. A copy you take of it, with **Copy Image**
  on your Mac, is the right way up too.
- **A video** plays at once, with its sound. Your Mac shows the player's own controls. Your
  iPhone shows a bar at the foot of the video: play and pause, the time, a slider to move through
  it, and sound on or off.
- **A Live Photo** shows its still with a **LIVE** mark. On your Mac, rest the pointer on **LIVE**,
  or hold the mouse down on the photo, and its moment plays without sound. On your iPhone, press
  and hold the photo, and it plays with its sound.

If a video cannot play in this browser, Lifestream says **This video can't play here.** and offers
**Download**. If Lifestream does not answer, it says **This video can't play right now.** and plays
once Lifestream answers again.

## What a model reads

A model writes **Photo descriptions**, so you can search your photos by what is in them. It
describes only photos a camera took, not screenshots, videos or saved images. Of several photos
taken within a minute of each other, it describes the first and the last.

- **Sends:** the photo, at most 1,536 pixels on its longer side.
- **Never sends:** any text with the photo: not the time, the place or the file name.
- **Hidden first:** every face is covered, and text with a personal detail is filled in. If you
  turned on faces, the cover on each person you named holds a placeholder in place of their name.
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says more.
- **By default:** the **Default** model, for your photos from 30 days before you added Photos. To
  describe older photos, change **Read back to** under **AI**. If that model runs at a company,
  your photos go to that company.
- **To stop it:** set **Photo descriptions** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Of the [settings every connector has](./README.md#settings-every-connector-has), Photos has no
**Check every**, and no **Back to** or **Catch up every** under **History**: it always reads your
whole library. Under **Comes from**, turn a device off to stop reading its library.

On your iPhone, Photos' page has rows of its own:

- **Bring in all photos** sends every photo Lifestream still lacks, now, and downloads from iCloud
  without waiting for the charger. Tap **Stop bringing in photos** to stop it. If your iPhone cannot
  reach Lifestream, it waits, and goes on by itself once Lifestream answers.
- **Clear photo copies** removes the copies your iPhone made of photos Lifestream has. Your photo
  library is not touched.
- **Chosen photos**, when you allowed only some photos, changes which ones Lifestream may read.

## Limits

- If your library cannot give a photo's file, because iCloud lost it or its download failed,
  the photo comes in without it. Your iPhone counts these under **Without a file**.

## Problems and fixes

These are the messages only Photos shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Photos is limited**\
The device lets Lifestream read only the photos you chose, and Lifestream does not see when you
delete one. Allow full access to bring in the rest.

**Couldn't send Photos**\
The line under it says **Open Lifestream on** a device. That device could not read its library
for an hour. Open Lifestream on it to see why.

**A photo pass failed, so bringing in your photos stopped. Try again later.**\
Your iPhone could not read its library. Tap **Bring in all photos** again later.

*Your iPhone's name* **is almost full. Older photos wait until it has 5 GB free.**\
**Bring in all photos** waits for space on your iPhone. Free some space, and it goes on by itself.
The same line with **is full** means your iPhone has less than 1 GB free.

**The next photo is too large for the space left on** *your iPhone's name*\
The next photo would take your iPhone under 5 GB free. Free some space, and it goes on by itself.

**Lifestream is holding older photos back for now. Bring them in once it takes them.**\
Lifestream is not taking your past now: its disk is almost full, your Mac is on a hotspot or Low
Data Mode, or the past of Photos is paused. Tap **Bring in all photos** again once that changes.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Photos as you would any
connector. To also take back its access, turn Lifestream off in **System Settings** › **Privacy &
Security** › **Photos** on your Mac, and set its Photos access to None in iOS Settings.
