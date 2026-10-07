# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Zbiornik Inbox: a small macOS Electron app that shows messages and notifications from zbiornik.com. It is plain JavaScript (CommonJS in the main process, a vanilla DOM script in the renderer). There is no bundler, framework, TypeScript, linter or test suite. UI strings and code comments are in Polish, so keep them that way.

## Commands

```sh
npm install
npm start              # run in dev (electron .)
ZB_DEBUG=1 npm start   # verbose: logs every AJAX call, cookies, request/response headers, writes a netlog to the temp dir, opens DevTools in the login window
npm run dist           # build universal .dmg into dist/
npm run dist:arm       # Apple Silicon-only .dmg (faster)
```

Builds are signed ad-hoc only (`identity: "-"`). After installing, remove the quarantine flag with `xattr -dr com.apple.quarantine "/Applications/Zbiornik Inbox.app"`. Only `main.js`, `preload.js` and `renderer/**` are packaged (see `build.files` in package.json). Any new top-level file has to be added there.

## Architecture

**The main process (`main.js`) owns all state and every network call.** The renderer is a pure view:
- `main.js` holds a single `state` object. `push()` sends the whole object to the renderer over the `state` IPC channel and updates the Dock badge (unread threads + unseen notification groups). Every state change has to be followed by `push()`.
- `preload.js` exposes `window.zb` (getState/onState/onGoto/refresh/loadMore/login/logout) through `contextBridge`. The handlers are the `ipcMain.handle(...)` calls at the bottom of `main.js`. A new action needs changes in all three places.
- `renderer/renderer.js` re-renders the view from `S` (the latest state) on every update. It builds the DOM with the `el()` helper and `textContent`, never with innerHTML. The CSP in `index.html` blocks inline scripts and styles.

**Session and auth:**
- All windows share the Chromium partition `persist:zbiornik`. The renderer needs the site's cookies to load thumbnails, and the login window sets those cookies.
- The app pretends to be a regular Chrome on macOS: it sets the UA and `sec-ch-ua*` headers through `onBeforeSendHeaders` for `*.zbiornik.com`. Don't let "Electron" leak into requests. The site sits behind Cloudflare, and `zbFetch` treats a 403 Cloudflare challenge differently from an expired session.
- Logging in opens a real browser window on `https://zbiornik.com/`. When a `token` cookie appears or the window navigates, `tryFinish()` checks the token by calling `getThreads()` against the user's subdomain (e.g. `karynka.zbiornik.com`). It then saves that subdomain as `SITE` in `userData/settings.json`.
- `zbFetch` throws `NeedLogin` when there is no token, on 401/403, or when the response isn't JSON. `refresh()` turns that into `state.needLogin`, and the renderer then shows the login box.

**Data flow:**
- `refresh()` runs at startup and every 60 s. It fetches `ajax/?command=getThreads` and `getNotifications` in parallel. The notification call uses `offset`/`limit`: pages of 21, up to 210 re-fetched on each refresh (`notifLoaded` remembers how far "load more" went).
- Raw API objects are normalized in `parseThread` / `parseNotification`. Notifications are then grouped by `type|groupTime|nicks` in `groupNotifications`, and the renderer only ever sees the groups.
- `notifyNew()` shows macOS notifications only for keys that weren't there on the previous refresh. The first refresh only primes the `known` sets. More than 3 new items collapse into one summary notification.

**Window behavior:** closing the main window hides it, and the app keeps polling in the background. It is a single-instance app. External links open in the default browser, and in-app navigation is blocked.

## Notification types

On first sight of each notification `type` id, `main.js` logs its shape to the terminal (`[powiadomienia] typ N: ...`). Add human-readable names to `TYPE_LABELS` at the top of `renderer/renderer.js`. Unknown types are shown as `typ N`.
