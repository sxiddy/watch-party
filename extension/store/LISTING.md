# Chrome Web Store submission: Back Row Sync

Upload `back-row-sync.zip` (build it with `python extension/store/build.py`) at the
Chrome Web Store Developer Dashboard, then paste the text below into each field.

## Store listing

**Name:** Back Row Sync

**Summary (132 characters max):**
Watch Netflix, Prime Video, JioHotstar or YouTube in sync with friends. Everyone plays on their own account.

**Category:** Entertainment

**Language:** English

**Description:**
Back Row Sync keeps everyone's video at the same second, so a group can watch a film together from different places.

How it works:
1. Open a film on Netflix, Prime Video, JioHotstar or YouTube.
2. Click Back Row Sync, type your name and press "Start a party on this tab".
3. Send your friends the room code. Each of them opens the same film on their own account, clicks Back Row Sync and joins with the code.
4. When anyone presses play, pauses or skips, everyone's video follows.

It also works with the Back Row website (watchpartyvinnovate.vercel.app), where the room has chat, reactions and a member list.

Back Row Sync never shares or streams the film itself. Each person needs their own access to the streaming service. Only short messages such as "pause at 12:04" are sent between viewers.

**Icon:** `icons/icon128.png`
**Screenshots:** at least one, 1280×800 or 640×400 (for example, the popup open over a YouTube video with the "Back Row CODE · 2 watching" badge showing).

## Privacy practices tab

**Single purpose:**
Synchronises video playback (play, pause and position) between friends watching the same title on supported streaming sites.

**Permission justifications:**
- `storage`: remembers the viewer's display name and current room, so the room survives the background worker restarting.
- `scripting`: adds the sync script to the streaming tab when the user starts or joins a party.
- `alarms`: wakes the background worker regularly so the connection to the room isn't lost.
- Host permissions (netflix.com, primevideo.com, amazon.com/.in/.co.uk, hotstar.com, youtube.com): needed to find and control the video player on those sites.
- Host permission (watchpartyvinnovate-sync.onrender.com): the Back Row server that relays play, pause and seek between the people in a room.

**Remote code:** No. All code is included in the package.

**Data usage:**
- Collected: the display name the user types, plus the room code and playback position/state.
- Not collected: account details, passwords, payment info, browsing history, location, or the content being watched beyond the tab's title.
- Used only to run the watch party. Not sold, not used for ads, not shared with third parties.
- Tick the certifications: not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

**Privacy policy (paste as a page, or host it and give the link):**
Back Row Sync sends the display name you choose, your room code, the title of the tab you start a party on, and your play/pause/position to the Back Row server, only so other people in your room can stay in sync. It does not read or send passwords, account details or browsing history. Rooms are held in the server's memory and are deleted after 30 minutes with no one connected. Nothing is sold or shared with anyone outside your room.

## Before you submit
- You need a Chrome Web Store developer account (one-time US$5 fee, paid by you).
- Review usually takes a few days. If it's rejected, the email says which rule; the usual fix is a clearer permission justification.
