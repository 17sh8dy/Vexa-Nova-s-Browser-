# Vexa — the Nova browser

Vexa is Nova's desktop web browser: a real Chromium-engine browser with its own
interface, privacy defaults and violet Nova identity.

> Status: **0.5.0.** Core browsing is complete and covered by
> automated end-to-end tests. See [Known limitations](#known-limitations) for what
> isn't there yet.

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

Produces `dist\Vexa-Setup-0.5.0.exe` (installer) and `dist\Vexa-Portable-0.5.0.exe`.
The exe isn't code-signed, so Windows SmartScreen will warn ("More info → Run anyway").

---

## What works

| Area | Details |
|---|---|
| **Browsing** | Chromium engine (via Electron 45 / Chromium 156), one sandboxed process per tab |
| **Address bar** | URLs, bare domains (`github.com` → https), `localhost:3000` (→ http), file paths, search queries; suggestions from history + bookmarks; inline autocomplete; `Alt+Enter` opens in a new tab, `Ctrl+Enter` adds `www.` + `.com` |
| **Navigation** | Back, forward, reload / stop, hard reload, home, loading spinner + progress sweep |
| **Errors** | Branded error panel for DNS failures, offline, refused / timed-out connections, certificate errors (never bypassed), crashes — with Try again / Go back |
| **Tabs** | New, close, switch, drag to reorder, middle-click close, reopen closed tab (with its history), duplicate, close others / to the right, mute, audio indicator, favicons |
| **Links & popups** | `target=_blank` / Ctrl+click / middle-click open tabs next to the opener; `window.open` keeps `window.opener` (so sign-in flows work); sized popups open as small windows |
| **Bookmarks** | Star / `Ctrl+D`, bookmarks bar (toggle), folders, manager page with search, edit, move, drag-to-reorder, import / export (standard HTML format used by Chrome, Edge and Firefox) |
| **History** | Recorded per visit, grouped by day, search, delete one / many, top sites on the New Tab page |
| **Downloads** | Saved to your Downloads folder (or ask each time), progress ring on the toolbar, downloads panel, full page with pause / resume / cancel / retry / open / show in folder |
| **Find / zoom / print** | Find bar with match count, per-site zoom with indicator, system print dialog, view source, DevTools |
| **Settings** | Startup behaviour, home page, theme (system / light / dark), search engine (DuckDuckGo default, Google, Bing, Brave, Ecosia, Startpage), bookmarks bar, download location, privacy, permissions |
| **Privacy** | Private windows (in-memory session, nothing saved), Do Not Track + Global Privacy Control, third-party cookie blocking, clear browsing data, clear on exit, per-site permission prompts (camera, mic, location, notifications, …) with remembered decisions |
| **Persistence** | Settings, bookmarks, history, downloads list, open tabs (restored lazily on startup), window size/position |
| **Passwords & autofill** | Offers to save logins after you sign in (never in private windows, "Never for this site" supported); fills a site's login automatically when you have exactly one saved, or via right-click → *Fill saved password*; manager in Settings (show / copy / edit / delete / add, CSV import & export); right-click → *Autofill contact details* from a saved profile (no payment cards). Passwords are encrypted with the OS keystore (Windows DPAPI, macOS Keychain, libsecret/kwallet) — if the OS can't encrypt, nothing is stored |
| **Sync** | Server-less: one end-to-end encrypted file (scrypt → AES-256-GCM, passphrase you choose) in a folder you point at OneDrive / Dropbox / Google Drive / Syncthing. Syncs bookmarks, passwords, autofill details and main settings; history, tabs and downloads stay per device |
| **Extensions** | *Load unpacked* Chrome extensions from Settings (content scripts, background workers, storage, …) |
| **Windows & tabs** | Drag a tab off the strip to tear it into its own window, or onto another window's strip to move it there — the live page moves, it isn't reloaded. Also *Move tab to new window / to window ▸* in the tab menu |
| **Default browser** | Settings → *Make Vexa the default*. Registers Vexa with Windows (per-user, no admin rights) and opens Default apps, where Windows requires **you** to confirm the choice; macOS/Linux use the system protocol-handler API. Installer builds register at every start and clean up on uninstall |
| **Sign-in prompts** | HTTP Basic / Digest / proxy authentication dialog, with saved logins offered and optional "Save this login" |
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
a ~100 MB install and no Widevine DRM in stock Electron.

* **Main process** (`src/main`) owns all state. The UI is a thin renderer: main pushes a
  state snapshot, the UI sends commands back over a whitelisted IPC bridge.
* **Internal pages** live under the privileged `vexa://` scheme (`newtab`, `settings`,
  `history`, `bookmarks`, `downloads`), served from `src/pages` with a strict CSP. The tab
  preload exposes the `vexa` API *only* on `vexa://` pages and the main process re-checks
  the caller's URL on every call — websites get nothing.
* **Data** is JSON in the profile folder, written atomically (temp file + rename) with
  debouncing — no native database dependency.
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
    psl.js + data/   Public Suffix List lookup used by third-party-cookie blocking
    url.js           address-bar resolution (pure, unit tested)
    shortcuts.js     keyboard bindings
    context-menu.js  page / tab / bookmark context menus
    ipc.js           IPC entry points with sender checks
  preload/         chrome.js (browser UI bridge), internal.js (vexa:// pages bridge + in-page password/autofill glue), auth.js
  renderer/        browser UI (chrome/), popup layer (overlay/), HTTP sign-in dialog (auth/), shared tokens + icons
  pages/           vexa:// pages: newtab, settings, history, bookmarks, downloads, shared/
build/             app icons (svg / png / ico), installer.nsh
scripts/           use-widevine.js (opt-in DRM build)
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

The end-to-end suite (32 checks) covers navigation, search, error handling, tabs, popups,
bookmarks, suggestions, find, zoom, downloads, menus, history, settings, permission prompts,
privacy headers and cookie blocking, clearing data (including time ranges), private windows,
restarting with session restore, the password manager (save → encrypted on disk → auto-fill),
contact-details autofill, HTTP sign-in prompts, moving a live tab between windows, loading an
unpacked extension, and sync between two separate profiles. It opens real Vexa windows while it runs.

> If your terminal sets `ELECTRON_RUN_AS_NODE` (the VS Code extension host does), unset it before
> `npm run test:e2e` — otherwise Electron starts as plain Node and the app never opens.

---

## Protected video (DRM / Widevine)

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

* **DRM** is opt-in and untested (see above).
* **Google sign-in:** Vexa now presents itself to Google as plain Chrome (user agent, Client Hints headers and `navigator.userAgentData` on Google's own hosts). That is the standard fix and removes the usual "This browser or app may not be secure" block, but Google decides this on its own signals and can change it at any time — **not verified against a live Google login**. If it still refuses, sign in with a different method or use a passkey/app-password; other sites are unaffected.
* **Extensions:** only *unpacked* extensions load, and Electron implements only part of the Chrome extension API — no toolbar popups, no extension-managed tabs/windows, no Chrome Web Store installs, no `.crx` files. Extensions are not loaded in private windows.
* **Passwords:** logins are detected on the top-level page only (not inside login iframes), and *Show*/*Copy* in Settings does not ask for your Windows password first. Anyone using your unlocked Windows account can read them, as with any browser without a master password.
* **Sync** has no server and no live push: it syncs on start, every 5 minutes and shortly after changes. Passwords merge per entry; bookmarks, settings and autofill details are replaced as a whole by whichever device changed them last, so edits made on two devices between syncs can overwrite each other. A forgotten passphrase can't be recovered.
* **Tab dragging:** moving a tab between windows by the menu is covered by automated tests; the mouse-drag gesture itself relies on the real cursor position and has not been exercised by an automated test, so give it a try by hand. Tabs can't move between a private and a normal window (they use separate sessions).
* **Default browser:** Windows deliberately requires you to confirm the choice in Settings → Default apps; Vexa can register and open that page but cannot finish it for you. Dev runs (`npm start`) register the dev Electron binary.
* **Location:** works once you paste a Google API key (with the Geolocation API enabled) in Settings → Site permissions and restart. Without one, sites can't get a position.
* **Third-party cookie blocking** now uses the full Public Suffix List, but still works at the network level: third-party iframes can read/write `document.cookie` within their own frame.
* **Clear browsing data:** the time range applies to history and the download list. Chromium can't clear cookies, site data or the cache by time range, so those are only cleared for *All time* (with a range chosen they're skipped, not over-deleted).
* **Testing:** the automated suites pass on Windows 11 (unit tests and 32 end-to-end checks). Installer builds (`npm run dist:win`) were not rebuilt or run as part of this change.
