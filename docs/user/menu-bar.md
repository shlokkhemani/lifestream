# The menu bar menu

Lifestream's icon in your Mac's menu bar opens a short menu. It says whether your Mac is recording
and when it last sent what it recorded to Lifestream. From it you pause recording, sync now, and
open the Lifestream window or **Settings**. The menu is there while the Mac app runs, even with its
window closed. Lifestream is in the Dock too while it runs: click it to open the window.

## What the menu holds

From the top, the menu shows:

- **The recording line**, such as **Recording**, and under it what your Mac saved, such as
  *N* **frames saved ·** *N* **gaps**.
- **Open Lifestream**, which opens the Lifestream window. Before setup is done, it says **Set up
  Lifestream…** and opens the setup.
- **Pause recording**, or **Start recording** while recording is paused. See [Choose what is
  recorded](./choose-what-is-recorded.md#pause-all-recording-on-your-mac).
- **The sync line**, such as **Lifestream: synced 14:02**: when your Mac last sent what it recorded
  to Lifestream.
- One line for each thing that needs you, such as **Recovery key not saved…**. Click it to fix it.
- **Allow** *N* **permissions…**, when Lifestream lacks a permission it needs on this Mac. Click it
  to open **Settings** › **This Mac**.
- **What's new in** *version*, for a day after an update.
- **Sync now**, which sends what your Mac recorded to Lifestream at once instead of at the next
  sync.
- **Settings…**, which opens **Settings**.
- **Quit Lifestream**, which quits the Mac app. Your Mac records nothing until you open it again.

The Lifestream window's own **Recording** menu has **Pause recording** and **Sync now** too.

## What its lines mean

### The recording line

| The line says | What it means |
|---|---|
| **Recording** | Your Mac records your screen, and your keys, clicks and audio where you allowed them. |
| **Starting recording** | Lifestream has just opened, and recording begins in a moment. |
| **Recording paused** | You paused recording. Click **Start recording** to go on. |
| **Not recording: Screen is turned off in Connectors** | You disconnected the Screen connector. Connect it again on **Connectors** to record your screen. |
| **Not recording · Mac idle** | Recording waits while nobody uses your Mac. It goes on by itself when you come back. |
| **Not recording · private window or app** | The window in front is a private browser window, a password field, or an app or site you keep out. See [Choose what is recorded](./choose-what-is-recorded.md). |
| **Not recording · browser not answering** | Screen cannot read which site is in front, so it records nothing until the browser answers. This shows only while you keep a site out. |
| **Screen Recording needs access** | macOS no longer lets Lifestream record the screen. Open **Settings** › **This Mac** and allow **Screen Recording**. See [What the Mac asks to allow](./mac-permissions.md). |
| **Not recording** | The disk that holds what your Mac records is full. Free some space. See [When your Mac or iPhone fills](./your-home.md#when-your-mac-or-iphone-fills). |
| **Not recording · screen unavailable** | macOS did not hand Lifestream the screen, such as while the displays change. Lifestream tries again by itself. |

The line under the recording line can end with **keys and clicks not recorded**, **microphone
access needed** or **system audio access needed**. Each names a permission macOS no longer gives
Lifestream. Allow it in **Settings** › **This Mac**.

### The sync line

| The line says | What it means |
|---|---|
| **Lifestream: synced** *a time* | Your Mac sent what it recorded at that time. It syncs again by itself. |
| **Lifestream: syncing…** | Your Mac is sending now. |
| **Lifestream: not synced yet** | Your Mac has not sent anything yet, such as right after setup. |
| **Older photos and history wait for Wi-Fi**, or **Low Data Mode is on, so only small new sends go** | Your Mac is on a phone's hotspot, or on a network with Low Data Mode on. What it records now still goes; its past waits until it joins another Wi-Fi. **Everything, including my past** in **Settings** › **Mobile data** sends the past over the hotspot too; Low Data Mode holds it whatever you choose. |
| **Importing history on battery.** | Your Mac sends your past while it runs on battery. |
| **Waiting for space on Lifestream's disk** | Lifestream has no room yet for something your Mac holds, such as a large export. Your Mac sends it once there is room. See [When the disk fills](./your-home.md#when-the-disk-fills). |
| **This Mac's clock is ahead of Lifestream's. Set the time automatically in System Settings.** | Turn on **Set time and date automatically** in **System Settings** › **General** › **Date & Time**. |
| **This Mac couldn't read what it recorded. Check that its disk has space.** | Free some space on your Mac. |
| **This Mac couldn't read one of its apps. Lifestream tries again at the next sync.** | Lifestream tries again by itself. |
| **Lifestream didn't take what this Mac sent** | Lifestream refused what your Mac sent. Your Mac keeps it and sends it again. Click **Sync now** to try at once. The connector's line on **Connectors** says more. |

If Lifestream does not answer, the sync line says why instead, such as **Lifestream isn't
running** or **Lifestream's drive isn't connected**.
[Problems and fixes](./problems.md#when-a-device-cant-reach-lifestream) says what each means.

## Next

- [Choose what is recorded](./choose-what-is-recorded.md)
- [Problems and fixes](./problems.md)
