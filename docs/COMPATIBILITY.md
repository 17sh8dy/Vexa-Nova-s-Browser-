# Vexa compatibility report: Google sign-in and protected video

Vexa 0.90 · Electron 45.2.3 · Chromium 156. Written November 2026.

This report covers what was investigated, what Vexa now does, and what has **not** been verified.
Nothing here bypasses a security check, a content-protection system, or a site's own rules.

---

## 1. Google sign-in

### Why sign-in fails in Electron-based browsers

When you sign in at `accounts.google.com`, Google decides whether the browser is safe. If it isn't
sure, it shows *"Couldn't sign you in — This browser or app may not be secure."* Google doesn't
publish how it decides. From what is public (Google's 2019 announcement that it would block sign-in
from embedded browser frameworks) and from looking at Vexa's own behavior, these are the signals:

| Signal | What Electron does by default | Effect |
|---|---|---|
| **User-agent string** | Adds `Electron/45.x` and the app's name (`vexa/0.x`) to the Chrome UA | A plain signal that this is an *embedded framework*, so Google blocks it. Vexa has always removed these two tokens (`cleanUserAgent()` in `src/main/sessions.js`). What's left is accurate: Vexa really is Chromium 156. |
| **Client Hints** (`Sec-CH-UA`, `navigator.userAgentData`) | Lists the brands `Chromium` + `Not.A/Brand`, with no browser brand | Google's checks look for a known browser brand. Brave, Vivaldi and Opera report their own brands and are recognized. Google has no way for a new browser to get registered. |
| **Embedded webviews / OAuth in a WebView** | — | Google's OAuth policy (`disallowed_useragent`) rejects sign-in pages shown *inside an app's own WebView* for that app's own login. Vexa isn't doing that: each tab is a top-level browsing context, the same as Chrome's. |
| **Popups and `window.opener`** | Depends on the app | Vexa keeps `window.opener` for `window.open` popups (needed for "Sign in with Google" popups) and opens sized popups as real windows. |
| **Third-party cookies** | Allowed in stock Electron | Vexa Shields blocks cross-site cookies by default. That broke Google Identity Services (GIS) buttons on *other* sites, because the button's `accounts.google.com/gsi/…` iframe needs your Google cookies. |
| **Cookie persistence** | Normal | Vexa uses the persistent default session (and `persist:` partitions for isolated Spaces), so sign-ins survive restarts. Private windows forget them on purpose. |
| **FedCM** | Not exposed by Electron 45 | GIS falls back to its iframe/popup flow, which works once the cookies above get through. |

**Conclusion.** Google doesn't block Vexa *because it's embedded*: a Vexa tab is a full browser
context. What triggers the block is the browser identity Vexa reports (the Electron token, and a
brand list with no browser Google knows). On top of that, Vexa's own cookie blocking was breaking GIS
buttons. That second problem was a configuration issue, and it is now fixed.

### What Vexa 0.90 does

1. **Honest base identity, always.** The UA is Chromium's own string without `Electron/x` or `vexa/x`.
   No other site is ever told Vexa is anything else.
2. **Compatibility mode for Google, on by default and switchable**
   (Settings → Compatibility → *Present the Chrome brand to Google*). Only on Google's own hosts
   (`google.*`, `youtube.com`, `gstatic.com`, `googleusercontent.com`), Client Hints and
   `navigator.userAgentData` add the "Google Chrome" brand. This is the one place Vexa claims to be
   Chrome, and it is a deliberate choice that we document openly:
   * *Consequence (benefit):* Google treats Vexa like the Chromium browser it is, so normal sign-in works.
   * *Consequence (cost):* it is a misstatement of the product name, made to one company's servers.
     Google could treat it as a policy violation or change its checks at any time. Google might also
     send code that assumes real Chrome features (the Chrome Web Store, Chrome Sync). Vexa has no
     extension store, and Chrome Sync isn't offered to Vexa.
   * Turn it off and Vexa reports only the honest brands everywhere. Google sign-in is then likely
     to be refused. Other sign-in methods (passkeys, "Sign in with Microsoft/Apple", app passwords)
     aren't affected.
3. **"Sign in with Google" buttons on other sites** (Settings → Compatibility, on by default).
   Like Brave's *"Allow Google login buttons on third-party sites"*, Shields lets your Google
   cookies reach `https://accounts.google.com/gsi/*` and `/o/oauth2/*` when they're embedded on
   another site. Nothing else Google loads on third-party pages (ads, analytics, fonts, maps) gets
   this exception. Code: `isGoogleSignInButton()` in `src/main/sessions.js`.
4. **No interception.** Vexa never reads, stores or forwards Google passwords or tokens beyond its
   normal password manager, which only offers to save what you type yourself. It doesn't proxy, script
   or alter Google's login pages, apart from the `userAgentData` brand list in point 2.

### Why there is no "sign in through the system browser" handoff

The RFC 8252 pattern (open the system browser, then return to the app through a redirect) lets a
*native app* sign in to **its own backend**. Vexa has no Google-backed account of its own. The
Google session a *website* needs has to live in Vexa's own cookie jar. A sign-in finished in Edge or
Chrome leaves its cookies in Edge or Chrome, and no supported way exists to move them into another
browser. Copying cookies between browsers would mean handling authentication tokens, which this
project rules out. A handoff would leave you signed in to the wrong browser, so it isn't offered.

### Verified, and not verified

* Verified by unit tests (`test/unit/vexa090.test.js`): which hosts count as Google's (look-alikes
  such as `xgoogle.com` don't), the exact GIS endpoints that keep their cookies (HTTPS
  `accounts.google.com/gsi/*` and `/o/oauth2/*` only), and the brand headers. The existing e2e suite
  still checks that ordinary third-party cookies are stripped. Google's real hosts can't be faked in
  e2e tests, because HSTS preload forces HTTPS, so the header rewrite on live Google requests is
  covered only by these unit tests.
* **Not verified:** a live sign-in to a real Google account. That needs a real account and password,
  and the automated suite never enters real credentials. Try it once by hand before a release, and
  record the result in the release notes.

---

## 2. Protected video (Netflix, Disney+, Prime Video, Spotify…)

### What protected playback needs

Streaming services use **Encrypted Media Extensions (EME)** with a **Content Decryption Module (CDM)**:

| Piece | Status in Vexa (stock Electron 45) |
|---|---|
| EME API (`navigator.requestMediaKeySystemAccess`) | Built into Chromium and present, but it has no key system to offer |
| **Widevine CDM** (Google's DRM, used by Netflix, Disney+, Prime Video, Spotify, YouTube rentals) | **Not included.** Stock Electron is built without the Widevine component, and Google licenses Widevine only to approved distributors |
| **VMP** (Verified Media Path) signing | Required by Netflix, Disney+ and others on Windows and macOS. The browser binary has to be signed with a VMP certificate, or licenses are refused even with a CDM |
| PlayReady / **Media Foundation** hardware DRM on Windows | Microsoft Edge's Chromium fork has it. Upstream Chromium and Electron don't ship it, so it isn't available |
| Proprietary codecs (H.264, AAC) | Present: Electron's FFmpeg build includes them |
| Hardware video decode | On (Vexa doesn't disable GPU acceleration) |

Desktop Chromium browsers (including Chrome) get **Widevine L3** (software). With L3, Netflix
limits Chrome on Windows to 720p. Higher resolutions need Edge's PlayReady hardware path, which
Electron can't use.

### The legitimate route: castlabs ECS

[castlabs](https://castlabs.com) publishes **Electron for Content Security (ECS)**, Electron builds
with Widevine support (`+wvcus` builds on GitHub, `castlabs/electron-releases`). With ECS:

* the Widevine CDM is downloaded through Google's component updater on first start, so it is not
  bundled by us and not an unofficial copy. Vexa's `main.js` already waits for `components.whenReady()`;
* production use with Netflix-class services needs the **packaged app VMP-signed** through
  castlabs' **EVS** (Electron VMP signing) service: a castlabs account, the `castlabs-evs` Python
  tool, signing after packaging, and agreeing to castlabs' and Google's terms. castlabs documents a
  free tier for this. Check their current terms before you rely on it, because the licensing terms
  belong to castlabs and Google, not to this project.

Vexa already has the switch: `npm run use-widevine` changes the Electron dependency to the castlabs
build, and `npm run use-stock-electron` switches back. **Settings → Compatibility** shows which build
is running.

### What was done in 0.90, and what was not

* Done: the opt-in script, the CDM wait at startup, and a status readout in Settings → Compatibility
  and About.
* **Not done, on purpose:** switching the default build to castlabs, downloading any CDM ourselves,
  or VMP-signing. Each needs a castlabs/EVS account and accepting licenses, which is the project
  owner's decision. They are not something to automate.
* **Not tested:** Netflix and other DRM playback. Vexa makes **no claim of Netflix compatibility**.
  Expected result after `use-widevine`: Spotify's web player and most Widevine L3 sites should work.
  Netflix, Disney+ and Prime Video need VMP signing, and even then are limited to the resolution
  those services allow Widevine L3 browsers.

### Realistic alternatives

1. Ship a castlabs-ECS build with EVS signing (the only path to Netflix inside Vexa).
2. Keep stock Electron and open DRM-only services in the user's default browser. Vexa can't do this
   automatically without guessing which sites need DRM, so it's left to the user.
3. Use the services' own desktop apps.
