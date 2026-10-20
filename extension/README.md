# Back Row Sync (Chrome extension)

Watch Netflix, Prime Video, JioHotstar, YouTube or any page with a video in sync with a Back Row room. Everyone uses their own account; the extension only keeps the players together.

## Install (no store needed)
1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension` folder.
4. Pin "Back Row Sync" from the puzzle-piece menu.

## Use
- **Host:** open the film, click the extension, type your name, then **Start a party on this tab**. Copy the code.
- **Friends:** open the same film on their own account, click the extension, type the code, then **Join**.
- Play, pause or seek on any synced tab and everyone follows (the host can let everyone control).

## Files
- `manifest.json`: what the extension is and what it may access.
- `background.js`: the service worker that holds the one live connection to the Back Row server.
- `content.js`: runs inside the video tab. It finds the `<video>` and keeps it in sync.
- `page-netflix.js`: seeks through Netflix's own player, because Netflix breaks if a page sets the position directly.
- `popup.html/css/js`: the small window that opens when you click the icon.
- `lib/`: Socket.IO client and the shared sync maths (`sync-core.js`).
- `dev/harness.html`: a test page that runs `content.js` without installing the extension.
