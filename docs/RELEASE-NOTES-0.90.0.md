**Vexa 0.90.0 — The Experience Update** (Windows 10/11, 64-bit)

Vexa now has its own sound and visual identity, workspaces, one box for everything, a focus
mode, a personal library, and a New Tab page you arrange yourself.

### New: Vexa Atmosphere
Open **Customize** on the New Tab page (or *Customize Vexa…* in the menu).

- **Five presets**, each a complete setup of colors, motion, background effect, sounds and wallpaper:
  **Midnight** (subtle and dark), **Cyber** (neon, with mechanical keys), **Aurora** (gradients and
  ambient light), **Arcade** (playful sounds, springy tabs), **Minimal** (quiet and still).
- **Colors**: six interface themes and your own accent color, applied to the whole browser, its
  menus and Vexa's own pages.
- **Motion and effects**: tab animations (smooth, springy, fade, none), animated background effects
  (glow, aurora, neon grid, star field), interface transitions, and your wallpaper behind the tab strip.
- **Sounds** for typing, mouse clicks, opening, closing and switching tabs, page loads,
  notifications, startup and shutdown. You get five sound profiles, an on/off switch and a volume for
  every sound, and a preview button. You can also **import your own sounds** (MP3, WAV, OGG, FLAC,
  M4A/AAC or WebM, up to 2 MB and 8 seconds).
  Sounds are off unless you turn them on or pick a preset that has them. They play inside Vexa's own
  interface, never in web pages, so they don't mix with, lower or pause a site's audio.
- **Sidebar**: Spaces, the Space's pinned sites, Collections, Focus and the Command Center, on the
  left or right, as icons or with names (Ctrl+Shift+E; right-click it for options).

### New: Spaces
Separate sets of tabs (Work, Gaming, Research…) in every window. Each Space can have its own name,
icon, color, look, wallpaper, pinned sites and startup pages. Switch from the sidebar, the Command
Center or **Ctrl+Shift+1…9**. Save a Space's tabs as a session and reopen it later.
Make a Space **isolated** to give it its own cookies, logins and site storage, for example to be
signed in to two accounts at once.

### New: Command Center — Ctrl+Space
One box to open sites, search, jump to any tab in any window, switch Spaces, and find bookmarks,
history, downloads, collections, settings and themes. It also runs browser actions. You can type
what you want: "switch to work", "focus on essay for 25 min", "save this page to Recipes", "dark
mode". You can change the shortcut in Settings → General (for example, if a code editor you use
needs Ctrl+Space).

### New: Smarter address bar and Vexa Search
- **Search shortcuts**: `@yt lo-fi`, `@w Ada Lovelace`, `@gh electron`, `@nova` (Nova's own sites
  through Vexa Search), and your own. Edit them in Settings → Search.
- **Filters**: `@tabs`, `@bookmarks`, `@history`, `@collections`, `@spaces` search only what's on
  your computer.
- **Switch to tab**, your **recent searches**, and word completions from the built-in, offline
  **Vexa Search** index. All of these stay on your device.

### New: Vexa Focus
- **Reader view (F9)**: just the article, in your choice of font, size, width and theme (light,
  sepia, dark). You can set a site to always open in Reader view.
- **Focus sessions**: a Space for one task, with a timer and fewer distractions. Distracting sites
  (you set the list) show a *Stay focused* page with *Allow for 5 minutes*. Other tabs are muted.
  When the session ends, keep its tabs as a Space, save them to a collection, or move them back.
- **Minimal interface (Ctrl+Shift+F)** hides tabs, sidebar and bookmarks.
- **Research panel**: a collection beside the page. Save the page, clip selected text, or write notes.

### New: Collections
A personal internet library at `vexa://collections`. Save pages, articles, images, videos, notes,
files and screenshots from the collection button in the address bar, the right-click menu,
**Ctrl+Shift+S**, or by dragging them onto the page. Collections have names, descriptions,
covers, favorites, search, drag-and-drop ordering, and import/export. Their text syncs with Sync.
Files stay on each device.

### New: New Tab layouts and widgets
Choose a **Centered** or **Dashboard** layout. Arrange and toggle the widgets: search, favorites
(your own pinned sites), most visited, recently visited, collections, Spaces, and an optional weather
widget (off by default; it contacts open-meteo.com only after you turn it on and choose a city).

### Compatibility
- **Google sign-in**: the existing compatibility mode is now a setting
  (Settings → Compatibility), and it is documented. **"Sign in with Google" buttons on other sites
  now work** even with cross-site cookie blocking on. See `docs/COMPATIBILITY.md`.
- **Protected video (Netflix, etc.)**: still not available in the standard build. The report
  explains why and what an official Widevine build would take.

### Fixes and changes
- "Customise" is now spelled "Customize".
- The Google host check used by the compatibility mode no longer matches look-alike domains.
