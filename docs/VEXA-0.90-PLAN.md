# Vexa 0.90 — development plan (from the Phase 1 audit)

## What the audit found

**Version.** `package.json` already says **0.6.0** (the README status line still says 0.5.0). 0.90 builds on 0.6.0.

**Architecture (kept).** Electron 45.2.3 / Chromium 156. The main process owns all state; each window is a
`VexaWindow` (`src/main/window.js`) with one `WebContentsView` per tab, a browser-UI renderer
(`src/renderer/chrome`), a transparent popup layer (`src/renderer/overlay`) and a status bubble. The UI is a thin
renderer: main pushes a `state` snapshot, the UI sends whitelisted commands (`chrome:cmd`, `overlay:cmd`).
Internal pages are `vexa://` pages (`src/pages/*`) with a strict CSP and a preload API that main re-checks on
every call (`vexa:api`, `src/main/ipc.js`). Data is JSON in the profile, written atomically (`store.js`).

**Working today (preserved, all covered by the 42-check e2e suite + 20 unit tests):** tabs (pin, drag, tear-off,
move between windows), omnibox with history/bookmark suggestions + inline autocomplete, bookmarks, history,
downloads, find/zoom/print, Vexa Shields, New Tab wallpapers + Customize drawer, private windows, session restore,
password manager (OS keystore), contact autofill, encrypted folder sync, unpacked extensions, default-browser
registration, HTTP auth prompts, Vexa Search (beta, offline index at `vexa://search`, has `/api/suggest`).

**Placeholders / gaps found:**
- No sidebar, no workspaces, no command palette, no reader mode, no collections.
- Address-bar suggestions never use Vexa Search's own `/api/suggest`; no search history; no keyword shortcuts.
- Google sign-in: Vexa *claims to be "Google Chrome"* in Client Hints and `navigator.userAgentData` on Google
  hosts — an identity spoof, undocumented as a choice. Shields' cross-site cookie blocking also strips cookies from
  Google Identity Services iframes on third-party sites ("Sign in with Google" buttons).
- DRM: `scripts/use-widevine.js` switches to castlabs ECS; marked untested.
- "Customise" (British spelling) in the UI and docs; the product uses US English elsewhere.

**Architectural limits that shape the work:**
- `VexaWindow.tabs` is one flat list — Spaces need per-space tab lists without breaking the many callers that read
  `win.tabs` (IPC lookups, downloads, context menus, session save).
- Tab views are laid out full-width under the chrome; a sidebar / research panel needs horizontal insets.
- The browser UI can't play sound into the page's audio graph — good: UI sounds play in the chrome renderer's own
  `AudioContext`, so they can never mix with, duck or pause website audio.
- `shortcuts.js` is static; the Command Center shortcut must be configurable.

## Plan (built in this order, each stage tested before the next)

1. **Settings schema** — new validated keys: `atmosphere`, `focus`, `searchShortcuts`, `searchHistory` flag,
   `commandCenterKey`, `googleCompat`, `allowGoogleSignInButtons`, New Tab `widgets`/`layout`; migrations for old files.
2. **Spaces** (`spaces.js` + window refactor) — `win.tabs` becomes the *current space's* list; `win.allTabs()` for
   lookups. Space definitions are global (name, icon, color, accent/theme, wallpaper, pinned sites, startup pages,
   isolated flag). Isolated Spaces use their own `persist:space-<id>` partition, configured exactly like the default
   session (Shields, permissions, downloads, preload). Session restore stores tabs per space; old files still load.
3. **Sidebar** — left rail in the browser UI: Spaces, the space's pinned sites, Collections, Command Center,
   Focus; position/width/visibility configurable. Tab views get an x-inset.
4. **Atmosphere** (`atmosphere.js`, chrome `sound engine`) — 5 presets, accent/theme tokens applied to the browser
   UI, popups and internal pages, tab animations, background effects, browser wallpaper; procedural sound profiles
   synthesised with Web Audio (no bundled audio files), per-category on/off + volume, imported audio files
   (mp3/wav/ogg/flac/m4a/webm, ≤ 2 MB, ≤ 10 s, copied into the profile), preview before applying. Lives in the
   New Tab **Customize** drawer, next to the wallpapers.
5. **Command Center** (`command-center.js`, overlay) — Ctrl+Space; providers for actions, tabs (all windows),
   Spaces, bookmarks, history, downloads, collections, settings sections, themes; fuzzy scoring; a rule-based
   intent parser and a `registerProvider` hook for a future Nova AI provider (not required).
6. **Search** — Vexa Search suggestions in the omnibox, opt-out search history, keyword shortcuts
   (`@vexa`, `@g`, `@yt`, `@w`, `@gh`, `@nova`…) and scope filters (`@tabs`, `@bookmarks`, `@history`,
   `@collections`), all editable in Settings → Search.
7. **Focus** — reader view (`vexa://reader`, extracted in an isolated world, re-sanitised), minimal UI mode, focus
   sessions (timer + their own Space), distraction blocking with a "stay focused" panel, per-site preferences,
   research panel (notes + clip selection into a Collection).
8. **Collections** (`collections.js`, `vexa://collections`) — links, articles, images, videos, notes, files,
   screenshots; covers, favorites, search, drag-and-drop ordering and import, JSON export/import, sync of the text
   parts.
9. **New Tab** — widget layout (search, favorites, top sites, recent, collections, Spaces, clock, weather opt-in,
   Shields stats), reorderable in Customize.
10. **Compatibility** — Google: honest Chromium identity by default with the Chrome-brand mode as a documented,
    switchable compatibility option; GIS buttons exempted from cross-site cookie stripping (user-switchable).
    DRM: written report; keep the castlabs opt-in path.
11. **Release** — 0.90.0 metadata, release notes, README, tests (unit + e2e for every new system), build check.
