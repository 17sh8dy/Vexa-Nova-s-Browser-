# Vexa — the Nova browser

Vexa is Nova's desktop web browser: a real Chromium-engine browser with its own
interface, privacy defaults and violet Nova identity.

> Status: **0.1.0, first working version.** Core browsing is complete and covered by
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

Produces `dist\Vexa-Setup-0.1.0.exe` (installer) and `dist\Vexa-Portable-0.1.0.exe`.
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
    url.js           address-bar resolution (pure, unit tested)
    shortcuts.js     keyboard bindings
    context-menu.js  page / tab / bookmark context menus
    ipc.js           IPC entry points with sender checks
  preload/         chrome.js (browser UI bridge), internal.js (vexa:// pages bridge)
  renderer/        browser UI (chrome/), popup layer (overlay/), shared tokens + icons
  pages/           vexa:// pages: newtab, settings, history, bookmarks, downloads, shared/
build/             app icons (svg / png / ico)
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

The end-to-end suite (22 checks) covers navigation, search, error handling, tabs, popups,
bookmarks, suggestions, find, zoom, downloads, menus, history, settings, permission prompts,
privacy headers and cookie blocking, clearing data, private windows, and restarting with
session restore. It opens a real Vexa window while it runs.

---

## Known limitations

These are honest gaps in 0.1.0 — none of them are presented as working in the UI:

* **No DRM (Widevine).** Netflix, Disney+, Spotify's web player and similar protected video won't play. Stock Electron doesn't ship Widevine.
* **Google sign-in may refuse** with "This browser or app may not be secure". Google blocks some embedded-Chromium browsers. Other sites sign in normally.
* **No extensions, sync, password manager or form autofill.**
* **HTTP basic-auth prompts** aren't implemented yet. Sites that need them show their 401 page.
* **Location:** you can allow location access, but Chromium's location service needs a Google API key, so sites won't get a position.
* **Third-party cookie blocking** works at the network level using an approximate site check (not the full Public Suffix List). It stops cookies being sent or set on cross-site requests, but third-party iframes can still use `document.cookie` within their own frame.
* **Clear browsing data** clears all time. There's no time-range picker yet.
* **Tabs can't be dragged** between windows. Vexa can't yet register itself as the default browser.
* **Testing:** 0.1.0 was developed and tested on Linux, not Windows: the automated suite plus visual checks. The Windows-specific pieces (title-bar buttons, installer) are standard Electron, but should get a first look on Windows.
