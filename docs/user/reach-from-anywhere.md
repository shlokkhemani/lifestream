# Reach Lifestream when you are away

Set up Tailscale on your Mac and your iPhone, so your iPhone sends to Lifestream when it is not on
your Mac's Wi-Fi. Tailscale is an app that links your own devices over the internet. Without it,
your iPhone reaches Lifestream only on the same Wi-Fi as your Mac, and keeps what it records until
it is back.

## Before you start

- Your iPhone paired with your Mac. [Pair your iPhone](./pair-your-iphone.md) says how.
- A Tailscale account.

## Set up Tailscale

1. On your Mac, install Tailscale from
   [tailscale.com/download/mac](https://tailscale.com/download/mac), and sign in.
2. On your iPhone, install Tailscale from the App Store, and sign in to the same account.
3. Turn Tailscale on, on both.

Lifestream needs nothing else. Lifestream gives your iPhone your Mac's Tailscale address each time
your iPhone reaches it. If you paired your iPhone before your Mac had Tailscale, your iPhone learns
the address the next time it reaches Lifestream on your Mac's Wi-Fi. On your iPhone, open
**Connectors** › **Lifestream**: the **Mac** row says when it last reached Lifestream, such as
**Last reached 14:02**.

To check that it works, turn off Wi-Fi on your iPhone and open **Connectors** › **Lifestream**. If it
shows **Can't reach Lifestream**, read the next section.

Lifestream answers only while your Mac is awake, wherever your iPhone is.
[When your Mac sleeps](./your-home.md#when-your-mac-sleeps) says what happens meanwhile.

## What your iPhone sends on cellular

On cellular or a phone's hotspot, your iPhone sends what it records now at any size, a batch of
photos too. Your past, such as older photos and your first Health read, waits for Wi-Fi.
**Settings** › **Mobile data** changes this: **Everything, including my past** sends your past too,
and **Only small sends** keeps every send of 50 MB or more for Wi-Fi. With Low Data Mode on, only
sends under 50 MB go, whatever you chose. **Connectors** › **Lifestream** then says **Large sends
wait for Wi-Fi · Settings › Mobile data** or **Large sends wait: Low Data Mode is on**, and its **Send
now** sends them on any network. [Photos](./connectors/photos.md) says what waits for
photos.

## If your iPhone cannot reach Lifestream

A strip at the top of every page says **Can't reach Lifestream**, the problem under it, and since
when, such as **since 14:02**. It shows at once when your iPhone has no network, and after about 20
seconds when Lifestream does not answer. The page under it says only what it is missing, and fills
in by itself once Lifestream answers. While Lifestream is starting, the strip says **Lifestream is
starting** instead, and goes once it answers.

Tap the strip to see the path to Lifestream, a line each: **This iPhone online**, **Tailscale on
this iPhone** once your iPhone knows your Mac's Tailscale address, and **Your Mac**. The line that
broke says what to do. Do it, then tap **Try again**.

| The line under **Can't reach Lifestream** says | What to do |
|---|---|
| **Tailscale is off** | Turn it on in the Tailscale app, or join your Mac's Wi-Fi. |
| **Not on your Mac's Wi‑Fi** | Lifestream answers only on your Mac's Wi-Fi. Join it, or set up Tailscale on both to reach it from anywhere. If Tailscale is set up, check that it is on and signed in on your Mac, then join your Mac's Wi-Fi once, so your iPhone learns the address. |
| **Your Mac isn't answering** | Check that your Mac is awake, on the same Wi-Fi or on Tailscale, with the same account on both, and that Lifestream runs on it. |
| **This iPhone is offline** | Nothing to do. Lifestream is read again once your iPhone is back online. |

Anything you change while the strip shows says **Not sent**. Tap **Try again** once Lifestream
answers.

## Let an agent reach Lifestream

Your iPhone needs no internet address. Agents such as Claude, ChatGPT and Muse do: they reach
Lifestream from their own servers. When you connect one, Lifestream puts its agent address on the
internet through Tailscale, as
[Connect an agent](./connect-an-agent.md#your-internet-address) says.

While the address is on, Lifestream keeps it on. If Tailscale stops serving it, Lifestream sets it
up again within five minutes. If it can't, because Tailscale is signed out, closed or already serves
something else at that address, **Connectors** shows **Agents can't reach Lifestream from the internet**
and says what to do.

An app on another of your devices on Tailscale needs no internet address. It uses a **Key**, the
secret an app sends with each request, as
[Connect an agent](./connect-an-agent.md#connect-another-agent) says. Use a **Key** only over
Tailscale or on this Mac: on your Wi-Fi, the **Key** and every answer travel unencrypted.

## What Tailscale carries

Tailscale encrypts the connection between your devices from end to end. While your agent address
is on the internet, Tailscale's Funnel also carries an agent's requests from there to your Mac.
Only the addresses an agent needs are on the internet.
[How Lifestream keeps your data safe](./keep-your-data-safe.md#what-listens-on-your-network) says
what each address answers. Tailscale's own privacy policy says what Tailscale itself keeps.

## Next

- [Pair your iPhone](./pair-your-iphone.md)
- [Connect an agent](./connect-an-agent.md)
