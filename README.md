# Vexa — the Nova browser

Vexa is Nova's desktop web browser: a real Chromium-engine browser with its own
interface, privacy defaults and violet Nova identity.

> Status: **0.91.0** — Google sign-in investigation and compatibility fixes, simpler Settings, and a
> New Tab page made for exploring. Release notes: [docs/RELEASE-NOTES-0.91.0.md](docs/RELEASE-NOTES-0.91.0.md)
> (0.90, the Experience Update: [docs/RELEASE-NOTES-0.90.0.md](docs/RELEASE-NOTES-0.90.0.md)).
> See [Known limitations](#known-limitations).

---

## Run it

### Option A: from source (recommended for development)

Requirements: **Node.js 20 or newer** (LTS) and Git. Nothing else — there are no native modules to compile.

```powershell
cd D:\Dev\Vexa
npm install        # downloads Electron (~100 MB) the first time
npm start          # launches Vexa
```

### Option B: in VS Code

1. `File → Open Folder…` → `D:\Dev\Vexa`
2. Open a terminal (`Ctrl+``) and run `npm install` once.
3. Press **F5** (`Vexa: Main process`) to launch Vexa with the debugger attached to the main process.
   Use the **`Vexa: Debug everything`** compound to also attach to the browser UI and pages.
   Tasks (`Terminal → Run Task…`) cover start, tests and building the installer.

> **About "Go Live" / Live Server:** Vexa is a desktop application, not a website.
> Opening its HTML files through Go Live (or any web server) will not work — the UI
> depends on Electron APIs that only exist inside the app. Always launch it with
> `npm start` or F5.

### Option C: build a Windows installer

```powershell
npm run dist:win
```

Produces `dist\Vexa-Setup-0.91.0.exe` (installer) and `dist\Vexa-Portable-0.91.0.exe`.
The exe isn't code-signed, so Windows SmartScreen will warn ("More info → Run anyway").

---

## What works

| Area | Details |
|---|---|
| **Browsing** | Chromium engine (via Electron 45 / Chromium 156), one sandboxed process per tab |
| **Address bar** | URLs, bare domains (`github.com` → https), `localhost:3000` (→ http), file paths, search queries; suggestions from history + bookmarks; inline autocomplete; `Alt+Enter` opens in a new tab, `Ctrl+Enter` adds `www.` + `.com` |
| **Navigation** | Back, forward, reload / stop, hard reload, home, loading spinner + progress sweep |
| **Errors** | Branded error panel for DNS failures, offline, refused / timed-out connections, certificate errors (never bypassed), crashes — with Try again / Go back |
| **Tabs** | New, close, switch, drag to reorder, middle-click close, reopen closed tab (with its history), duplicate, close others / to the right, mute, audio indicator, favicons; **pin / unpin** from the tab's right-click menu (pinned tabs sit at the left as icons, stay pinned after a restart, and are kept by *Close other tabs*) |
| **Links & popups** | `target=_blank` / Ctrl+click / middle-click open tabs next to the opener; `window.open` keeps `window.opener` (so sign-in flows work); sized popups open as small windows |
| **Bookmarks** | Star / `Ctrl+D`, bookmarks bar (toggle), folders, manager page with search, edit, move, drag-to-reorder, import / export (standard HTML format used by Chrome, Edge and Firefox) |
| **History** | Recorded per visit, grouped by day, search, delete one / many, top sites on the New Tab page |
| **Downloads** | Saved to your Downloads folder (or ask each time), progress ring on the toolbar, downloads panel, full page with pause / resume / cancel / retry / open / show in folder |
| **Find / zoom / print** | Find bar with match count, per-site zoom with indicator, system print dialog, view source, DevTools |
| **Settings** | Startup behaviour, home page, theme (system / light / dark), search engine (DuckDuckGo default, Google, Bing, Brave, Ecosia, Startpage), bookmarks bar, download location, privacy, permissions |
| **Vexa Shields** | On by default, all local: blocks third-party ads and trackers (Vexa's own curated host lists), cross-site cookies, fingerprinting (canvas / WebGL / audio readings farbled per site and session), upgrades http:// to https:// with automatic fallback, warns before phishing/scam sites (bundled list), strips click-tracking parameters (`utm_*`, `fbclid`, `gclid`, …) and blocks popups opened without a click. Shield button next to the address bar shows what was blocked on the page, with a per-site on/off switch and per-protection overrides; defaults and the list of customized sites live in Settings → Shields. Private windows keep their per-site changes in memory only |
| **New Tab page** | *Customize* drawer: Vexa wallpaper gallery (9 original pieces), your own JPG / PNG / WebP (up to 20 MB, file picker or drag-and-drop, kept in the profile), change automatically (every new tab / hour / day, from the gallery, your images or both), blur / brightness / overlay, show or hide shortcuts, greeting, clock and the Shields stats widget, reset to the default look. Text colour adapts to the image's brightness |
| **Privacy** | Private windows (in-memory session, nothing saved), Do Not Track + Global Privacy Control, clear browsing data, clear on exit, per-site permission prompts (camera, mic, location, notifications, …) with remembered decisions |
| **Persistence** | Settings, bookmarks, history, downloads list, open tabs (restored lazily on startup), window size/position |
| **Passwords & autofill** | Offers to save logins after you sign in (never in private windows, "Never for this site" supported); fills a site's login automatically when you have exactly one saved, or via right-click → *Fill saved password*; manager in Settings (show / copy / edit / delete / add, CSV import & export); right-click → *Autofill contact details* from a saved profile (no payment cards). Passwords are encrypted with the OS keystore (Windows DPAPI, macOS Keychain, libsecret/kwallet) — if the OS can't encrypt, nothing is stored |
| **Sync** | Server-less: one end-to-end encrypted file (scrypt → AES-256-GCM, passphrase you choose) in a folder you point at OneDrive / Dropbox / Google Drive / Syncthing. Syncs bookmarks, passwords, autofill details and main settings; history, tabs and downloads stay per device |
| **Extensions** | *Load unpacked* Chrome extensions from Settings (content scripts, background workers, storage, …) |
| **Windows & tabs** | Drag a tab off the strip to tear it into its own window, or onto another window's strip to move it there — the live page moves, it isn't reloaded. Also *Move tab to new window / to window ▸* in the tab menu |
| **Default browser** | Settings → *Make Vexa the default*. Registers Vexa with Windows (per-user, no admin rights) and opens Default apps, where Windows requires **you** to confirm the choice; macOS/Linux use the system protocol-handler API. Installer builds register at every start and clean up on uninstall |
| **Sign-in prompts** | HTTP Basic / Digest / proxy authentication dialog, with saved logins offered and optional "Save this login" |
| **Vexa Atmosphere** (0.90) | In the New Tab *Customize* drawer (Atmosphere / Sounds tabs). Five presets that are real configurations — Midnight, Cyber, Aurora, Arcade, Minimal — plus 6 interface palettes, a custom accent color, tab animations (smooth / springy / fade / none), background effects (glow, animated aurora, neon grid, star field), interface transitions, wallpaper behind the tab strip. Applies to the browser UI, popups and vexa:// pages; a Space can override palette, accent, effect and wallpaper. **Sounds** for 9 categories (typing, clicks, tab open / close / switch, page loaded, notifications, startup, shutdown), 5 procedurally synthesised profiles, per-category on/off + volume, previews, and **imported sounds** (MP3/WAV/OGG/FLAC/M4A/WebM, ≤ 2 MB, ≤ 8 s, decoded and checked before saving, kept in the profile, never served on a URL). Sounds play in the browser UI's own AudioContext, never in web pages; the context suspends when idle |
| **Spaces** (0.90) | Named workspaces with their own tabs in every window, icon, color, look, wallpaper, pinned sites (sidebar), startup pages and saved sessions. Sidebar, Command Center or `Ctrl+Shift+1…9`; tab menu → *Move tab to Space*. **Isolated** Spaces use their own persistent storage partition (cookies, logins, storage, cache), configured exactly like the default session (Shields, permissions, downloads). Session restore keeps tabs per Space |
| **Command Center** (0.90) | `Ctrl+Space` (configurable): websites, searches, tabs in all windows, Spaces, saved sessions, bookmarks, history, downloads, collections, settings sections, themes and ~40 browser actions, with fuzzy matching and keyboard navigation. Understands simple phrases without AI ("switch to work", "focus on essay for 25 min", "save this page to Recipes"). `commandCenter.registerProvider()` is the hook for a future Nova AI provider |
| **Search** (0.90) | Keyword shortcuts (`@g`, `@yt`, `@w`, `@gh`, `@mdn`, `@vexa`, `@nova` = Nova's sites via Vexa Search's new `in:nova` filter, plus your own) and scope filters (`@tabs`, `@bookmarks`, `@history`, `@collections`, `@spaces`); "Switch to tab"; recent searches (local, never synced, off in private windows, cleared with history); word completions from the offline Vexa Search index |
| **Focus** (0.90) | Reader view (`F9`, extracted in an isolated world and rebuilt element by element on `vexa://reader`, which may only call `reader.*`); per-site "always Reader"; minimal interface (`Ctrl+Shift+F`); focus sessions with their own Space, timer, muted other tabs and a "Stay focused" panel for sites on your distraction list (allow for 5 minutes); research panel (a collection beside the page with notes and *Clip selection*) |
| **Collections** (0.90) | `vexa://collections`: links, articles, images, videos, notes, files and screenshots with names, descriptions, covers, favorites, search, drag-and-drop reordering and dropping files / links onto the page, move between collections, JSON export / import (files embedded). Save from the address-bar button, `Ctrl+Shift+S`, the right-click menu or the Command Center. Text syncs; files stay per device; executables are only revealed in their folder, never launched |
| **New Tab layouts** (0.90, 0.91) | Centered or Dashboard; reorderable widgets: search, favorites (your own tiles, drag to reorder), most visited, recently visited, collections and Spaces (off by default since 0.91 — both are in the sidebar), weather (opt-in, open-meteo.com). Explore chips under the search box insert your keyword shortcuts or open the Command Center |
| **Clear data time range** | Last hour / 24 hours / 7 days / 4 weeks / all time for history and the download list (see limitations for cookies and cache) |

### Keyboard shortcuts

| Action | Shortcut |
|---|---|
| New tab / window / private window | `Ctrl+T` / `Ctrl+N` / `Ctrl+Shift+N` |
| Close tab / window | `Ctrl+W` / `Ctrl+Shift+W` |
| Reopen closed tab | `Ctrl+Shift+T` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` (also `Ctrl+PgDn` / `Ctrl+PgUp`) |
| Go to tab 1–8 / last tab | `Ctrl+1` … `Ctrl+8` / `Ctrl+9` |
| Focus address bar | `Ctrl+L`, `Alt+D`, `F6` |
| Reload / hard reload | `Ctrl+R`, `F5` / `Ctrl+Shift+R`, `Ctrl+F5` |
| Back / forward / home | `Alt+←` / `Alt+→` / `Alt+Home` |
| Bookmark page / bookmarks bar / manager | `Ctrl+D` / `Ctrl+Shift+B` / `Ctrl+Shift+O` |
| History / downloads / settings | `Ctrl+H` / `Ctrl+J` / `Ctrl+,` |
| Clear browsing data | `Ctrl+Shift+Delete` |
| Find / next / previous | `Ctrl+F` / `Enter`, `F3` / `Shift+Enter`, `Shift+F3` |
| Zoom in / out / reset | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| Print / view source | `Ctrl+P` / `Ctrl+U` |
| Full screen / DevTools | `F11` / `F12`, `Ctrl+Shift+I` |
| Command Center | `Ctrl+Space` (or Ctrl+Shift+Space / Ctrl+Shift+K / off — Settings → General) |
| Switch to Space 1–9 | `Ctrl+Shift+1` … `Ctrl+Shift+9` |
| Reader view / minimal interface | `F9` / `Ctrl+Shift+F` |
| Save page to a collection / toggle sidebar | `Ctrl+Shift+S` / `Ctrl+Shift+E` |

---

## Architecture

```
┌──────────────────────── BrowserWindow (one per Vexa window) ────────────────────────┐
│  Browser UI  (src/renderer/chrome)  — tab strip, toolbar, bars, error panel          │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Active tab: WebContentsView (sandboxed, one per tab)                        │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│  Popup layer (src/renderer/overlay) — transparent view for menu / downloads /        │
│  address suggestions, attached only while open · status bubble for link hovers      │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Why Electron (and not Tauri/WebView2 or CEF):** a browser has to *own* its engine —
per-tab views, download control with pause/resume, cookie/cache/storage clearing,
permission prompts, find-in-page, in-memory private sessions, printing, DevTools.
Electron exposes all of that from Chromium directly. Tauri's WebView2 backend only
supports multiple webviews behind an unstable flag and gives far less control over
downloads, storage and permissions; CEF would mean a C++ codebase. The trade-offs are
a large install (~180 MB from 0.5.5, which bundles the Vexa Search index) and no Widevine
DRM in stock Electron.

* **Main process** (`src/main`) owns all state. The UI is a thin renderer: main pushes a
  state snapshot, the UI sends commands back over a whitelisted IPC bridge.
* **Internal pages** live under the privileged `vexa://` scheme (`newtab`, `settings`,
  `history`, `bookmarks`, `downloads`), served from `src/pages` with a strict CSP. The page
  preload exposes the `vexa` API *only* on `vexa://` pages and the main process re-checks
  the caller's URL on every call — websites get nothing. The preload is registered on the
  *session* (`registerPreloadScript`, http/https/vexa URLs only), so it also runs in tabs that a
  page opened itself with `target=_blank` / `window.open` (from 0.6.0; before that those tabs
  had no preload at all).
* **Vexa Shields** (`shields-rules.js` pure + unit tested, `shields.js` live state) sits in the
  session's `webRequest` hooks, so every request of every tab passes through it. The ad /
  tracker / fingerprinter lists are Vexa's own short curated lists of well-known third-party hosts
  (not EasyList), so coverage is narrower than a filter-list blocker. The phishing / scam list is a
  snapshot of The Block List Project (public domain) shipped in `src/main/data/shields/`; refresh it
  with `node scripts/update-shield-lists.js` before a release. Nothing is downloaded at run time.
  Fingerprinting protection is injected into the page's world before its scripts run.
* **Vexa Search (beta)** is Nova's own search engine (`Vexa Search/`), offered as
  "Vexa Search (Beta)" in Settings → Search. It runs in the main process and is served at
  `vexa://search/`; its index ships with the app (`resources/vexa-search/`), so searching works
  offline and queries never leave the computer. The results page shows text from the web, so it
  is deliberately *not* privileged: the preload and the IPC check both exclude `vexa://search`.
  Rebuild the shipped index with `node "Vexa Search/tools/export-index.js"` before `npm run dist`.
* **Data** is JSON in the profile folder, written atomically (temp file + rename) with
  debouncing. The only database is Vexa Search's read-only index (Node's built-in `node:sqlite`).
* **Security:** every renderer runs with `sandbox: true`, `contextIsolation: true`, no Node
  integration; `<webview>` tags are blocked; certificate errors are never bypassed.

```
src/
  main/            main process
    main.js          entry: app lifecycle, vexa:// scheme registration, single instance
    app-controller.js windows, session save/restore, data fan-out, quit handling
    window.js        a browser window: layout, tabs, popups, commands, shortcuts
    tab.js           a tab: WebContentsView + navigation/loading/error state
    sessions.js      vexa:// protocol, privacy headers, cookie blocking, permissions, clear data
    settings.js, history.js, bookmarks.js, downloads.js, store.js   data stores
    passwords.js, autofill.js   password manager (OS-keystore encrypted) and contact details
    sync.js          encrypted folder sync · extensions.js  unpacked extensions
    default-browser.js  default-browser registration · auth-prompt.js  HTTP sign-in dialog
    psl.js + data/   Public Suffix List lookup (third parties, per-site Shields)
    shields-rules.js, shields.js   Vexa Shields: lists + matching (pure), per-site state + counts
    wallpapers.js, image-type.js   New Tab wallpapers: gallery, uploads, rotation
    atmosphere.js    Atmosphere presets, imported sounds, the resolved look per window / Space
    spaces.js        Space definitions, saved sessions, isolated partitions
    command-center.js, fuzzy.js, intents.js   Command Center providers, fuzzy matching, phrase rules (pure, unit tested)
    focus.js, reader.js   focus sessions + distraction blocking, Reader extraction
    collections.js   Collections store, files, screenshots, export / import, sync data
    search-history.js, weather.js   recent searches; opt-in New Tab weather
    url.js           address-bar resolution (pure, unit tested)
    shortcuts.js     keyboard bindings
    context-menu.js  page / tab / bookmark context menus
    ipc.js           IPC entry points with sender checks
  preload/         chrome.js (browser UI bridge), internal.js (vexa:// pages bridge + in-page password/autofill glue), auth.js
  renderer/        browser UI (chrome/: chrome.js + panels.js for sidebar / research / Atmosphere), popup layer
                   (overlay/: menus, suggestions, Command Center, Save to Collection, Space editor, Focus),
                   HTTP sign-in dialog (auth/), shared/ (tokens, icons, palettes.js, sound-engine.js)
  pages/           vexa:// pages: newtab (+ customize.js), settings, history, bookmarks, downloads,
                   collections, reader, shared/
build/             app icons (svg / png / ico), installer.nsh
scripts/           use-widevine.js (opt-in DRM build), update-shield-lists.js (dangerous-site list),
                   make-wallpapers.js (regenerates the New Tab gallery SVGs)
test/              unit tests, end-to-end runner, local test site
```

Your profile (settings, history, bookmarks, cookies, cache) is stored in
`%APPDATA%\Vexa` on Windows. Settings → About has a button that opens it.
To run against a throwaway profile: `set VEXA_PROFILE=C:\temp\vexa-test && npm start`.

---

## Tests

```powershell
npm test            # unit tests (address-bar resolution etc.)
npm run test:e2e    # launches the real app against a local test site and drives it
```

The end-to-end suite (50 checks; 1 new in 0.91 for sign-in popups; 7 new in 0.90 for the Command Center, Spaces incl. isolated cookies,
address-bar keywords and search history, Atmosphere looks + sounds + imported audio, New Tab layouts, Collections + Reader
sandboxing, and Focus sessions) covers navigation, search, error handling, tabs, popups,
bookmarks, suggestions, find, zoom, downloads, menus, history, settings, permission prompts,
privacy headers and cookie blocking, clearing data (including time ranges), private windows,
restarting with session restore, the password manager (save → encrypted on disk → auto-fill),
contact-details autofill, HTTP sign-in prompts, moving a live tab between windows, loading an
unpacked extension, and sync between two separate profiles. It opens real Vexa windows while it runs.

> If your terminal sets `ELECTRON_RUN_AS_NODE` (the VS Code extension host does), unset it before
> `npm run test:e2e` — otherwise Electron starts as plain Node and the app never opens.

---

## Protected video (DRM / Widevine)

The full investigation (EME, Widevine, VMP, Media Foundation / PlayReady, codecs, licensing) and the
Google sign-in analysis are in **[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)**. In short:

Stock Electron ships without Widevine, so Netflix, Disney+, Spotify's web player and similar
sites won't play protected video. Vexa can run on the Widevine-enabled Electron build published by
castlabs, but this is **opt-in** because it swaps the Electron binary for a third-party fork:

```powershell
npm run use-widevine        # edits package.json to the castlabs "+wvcus" build and reinstalls
npm start                   # Vexa now downloads the Widevine CDM on first start (Settings → About shows it)
npm run use-stock-electron  # go back
```

Vexa already waits for the Widevine component at startup when it is present. Spotify's web player
and most Widevine-L3 sites should work as-is. **Netflix, Disney+, Prime Video and similar need the
packaged app to be VMP-signed** with a free castlabs EVS account (see castlabs' "EVS" docs) before
they will play. *Status: this path is wired up but has not been run yet, so treat it as untested until you've
tried it once.*

---

## Known limitations

Things that were limitations in 0.1.0 and are now handled are described under *What works*.
What remains, honestly:

* **DRM** is opt-in and untested (see above). Vexa makes no claim of Netflix compatibility.
* **Google sign-in — unsupported until verified.** 0.90 testers were refused (*"This browser or app may not be secure"*). 0.91 fixes what Vexa itself did wrong: it now sends the standard Client Hints with Chromium's honest values (Electron sends none), the optional Chrome-brand mode (*Settings → Compatibility*, on by default, Google's hosts only) adds "Google Chrome" to Chromium's real brand list instead of a hand-written one, and fingerprinting protection no longer alters Google's sign-in pages. A real sign-in has **not** been tested on 0.91 — see [docs/GOOGLE-SIGNIN-TESTING.md](docs/GOOGLE-SIGNIN-TESTING.md). Google may still refuse Vexa for reasons Electron can't honestly change (`window.chrome` is empty); that's documented in docs/COMPATIBILITY.md rather than worked around. "Sign in with Google" buttons on other sites keep their `accounts.google.com/gsi` cookies despite cross-site cookie blocking (switchable). There is no "sign in via the system browser" handoff, because that would sign the *other* browser in, not Vexa.
* **Atmosphere:** imported sounds and the sound/visual settings sync, but the imported sound *files* stay on the device where you imported them (other devices fall back to the profile sound). "Notification" sounds cover Vexa's own notices (downloads finished, permission prompts, focus timer) — Vexa can't hear a website's Web Notifications. The title-bar window-control area on Windows stays a solid color even when a background effect or wallpaper is on. Interface sounds and effects have been exercised by automated tests; how they *sound* and *look* still needs a human's judgement.
* **Spaces:** extensions run only in the default session, so isolated Spaces don't get unpacked extensions. Tabs can't be dragged between Spaces with the mouse (use the tab menu); dragging tabs between windows keeps each tab's Space. Private windows have no Spaces.
* **Command Center:** phrase understanding is a fixed set of rules, not AI; anything else falls back to fuzzy matching and web search. `Ctrl+Space` is taken before web pages see it — code editors in the browser that use it need another Command Center key (Settings → General).
* **Reader view** uses a heuristic extractor: it works on typical article pages and refuses pages it can't find an article in. It shows text and images only (no embedded video, tweets or interactive content). The extracted article lives in memory, so a restored Reader tab offers a link back to the original instead.
* **Collections:** sync carries names, notes, links and metadata, not the files themselves. Export bundles are capped at 300 MB of files. Image saving from the right-click menu fetches the image again in the page's session.
* **Focus:** the timer runs while Vexa is open (a quit ends the session; its Space stays as an ordinary Space). Distraction blocking applies to the window running the session.
* **Weather** (New Tab, opt-in): uses open-meteo.com; this is a network request Vexa makes on your behalf, so it's off until you turn it on. NovaLegal's Vexa Terms ("Your data stays on your computer") should mention it before release.
* **Extensions:** only *unpacked* extensions load, and Electron implements only part of the Chrome extension API — no toolbar popups, no extension-managed tabs/windows, no Chrome Web Store installs, no `.crx` files. Extensions are not loaded in private windows.
* **Passwords:** logins are detected on the top-level page only (not inside login iframes), and *Show*/*Copy* in Settings does not ask for your Windows password first. Anyone using your unlocked Windows account can read them, as with any browser without a master password.
* **Sync** has no server and no live push: it syncs on start, every 5 minutes and shortly after changes. Passwords merge per entry; bookmarks, settings and autofill details are replaced as a whole by whichever device changed them last, so edits made on two devices between syncs can overwrite each other. A forgotten passphrase can't be recovered.
* **Tab dragging:** moving a tab between windows by the menu is covered by automated tests; the mouse-drag gesture itself relies on the real cursor position and has not been exercised by an automated test, so give it a try by hand. Tabs can't move between a private and a normal window (they use separate sessions).
* **Default browser:** Windows deliberately requires you to confirm the choice in Settings → Default apps; Vexa can register and open that page but cannot finish it for you. Dev runs (`npm start`) register the dev Electron binary.
* **Location:** works once you paste a Google API key (with the Geolocation API enabled) in Settings → Site permissions and restart. Without one, sites can't get a position.
* **Third-party cookie blocking** now uses the full Public Suffix List, but still works at the network level: third-party iframes can read/write `document.cookie` within their own frame.
* **Vexa Shields ad and tracker blocking** uses Vexa's own short host lists, not EasyList-style filter lists: it stops the big ad networks and trackers but not ads a site serves from its own domain, and there is no cosmetic filtering (empty ad slots can remain). Some sites detect it and ask you to allow ads; turn Shields off for that site from the shield button. Fingerprinting protection covers canvas, WebGL, Web Audio and the CPU count in the page and its same-origin frames — not fonts, Web Workers or cross-origin frames. The dangerous-site list is a snapshot taken at build time: new phishing sites appear daily, so it can't be complete. Popup blocking needs a click or key press in the tab within 5 seconds, one popup per gesture (as in Chromium).
* **New Tab wallpapers:** drag-and-drop of an image onto the New Tab page is wired up but the drop gesture itself hasn't been exercised by an automated test (uploading through the same code path is).
* **Clear browsing data:** the time range applies to history and the download list. Chromium can't clear cookies, site data or the cache by time range, so those are only cleared for *All time* (with a range chosen they're skipped, not over-deleted).
* **Updates:** Vexa has **no auto-update and no update check** (`"publish": null`, no updater code). Users only get a new version by downloading it from https://vexa.shadylabs.workers.dev, and nothing in the app tells them one exists yet. See *Roadmap*.
* **Testing (0.90.0):** on Windows 11, 25 unit tests and 49 end-to-end checks pass. `npm run pack` builds, and the packaged `Vexa.exe` was driven through the Command Center, Spaces, Atmosphere presets, New Tab widgets and Collections. The NSIS / portable installers (`npm run dist:win`) were not built for this release yet. The weather widget was checked once against the live Open-Meteo API. Not tested: a live Google account sign-in, DRM playback, and how the sounds and effects actually *feel* — that needs a person.

---

## Roadmap

### Getting users onto the newest version (not built yet)

Pick one. Option A is the minimum and should ship first; Option B can follow.

**A. Link to the website in Settings → About (minimum).**
A "Get the newest version" link in Settings → About (next to the version number) that opens
https://vexa.shadylabs.workers.dev/#download in a new tab. No background network request, so the
privacy model and NovaLegal's Vexa Terms ("no update check") stay true as written.

**B. Auto-updates, the usual Electron way.**
`electron-updater` with GitHub Releases as the feed (`publish: { provider: "github" }`, which makes
`npm run dist` produce `latest.yml`), checking on startup and offering *Restart to update*. Before
building it:
* Only the **NSIS installer** can self-update. The **portable** build can't, so it still needs the
  website link from option A.
* Installers are **not code-signed**, so Windows SmartScreen will still warn, and an updater should
  verify what it downloads (electron-updater checks the sha512 in `latest.yml`; Atlas's updater, which
  also signs its manifest, is a model to copy).
* Each update would download the whole app (~174 MB), mostly the bundled Vexa Search index. Moving the
  index to its own download, or relying on blockmap differential updates, keeps updates small.
* An update check contacts GitHub, so it is a **new network request**: add a setting to turn it off,
  and update NovaLegal (Vexa Terms "Your data stays on your computer" says *no update check*, plus the
  Vexa entry in `data/products.js`) **before** release.

  TODO: Build a setting (Developer Mode) or something of like to that name, it should add a FPS Counter, show how much Memory the tab is taking when they hover over it. OFF By Defualt. 
  Make the page alot simpilar, dont downgrade the backend but like LET THEM EXPLORE, not everything has to be on the new tab page. Add Auto Updates like my other apps.
