# Vexa compatibility report: Google sign-in and protected video

Vexa 0.91 · Electron 45.2.3 · Chromium 156. Updated November 2026 (first written for 0.90).

This report covers what was investigated, what Vexa now does, and what has **not** been verified.
Nothing here bypasses a security check, a content-protection system, or a site's own rules.

---

## 1. Google sign-in

> **Status (0.91): not verified.** A tester using several real Google accounts on Vexa 0.90 got
> *"Couldn't sign you in — This browser or app may not be secure"* every time. 0.91 removes the
> things Vexa itself was doing that make a browser look tampered with (below), but nobody has yet
> signed in to a real Google account on 0.91. Until that has been done by hand
> ([checklist](GOOGLE-SIGNIN-TESTING.md)), treat Google sign-in in Vexa as **unsupported**.

### What Google says

Google's help page for this message ([support.google.com/accounts/answer/7675428](https://support.google.com/accounts/answer/7675428))
lists the causes as: the browser doesn't support JavaScript or has it turned off, an add-on or
setting makes it unsafe, the browser is **controlled through software automation** instead of a
person, or it is **embedded in a different application**. Google doesn't publish how it detects
these, and it changes its checks without notice. The sign-in page runs its own anti-abuse script
that inspects the browser environment before it accepts the email address.

### Why sign-in fails in Electron-based browsers

| Signal | What Vexa does | Effect |
|---|---|---|
| **User-agent string** | Removes `Electron/x` and `vexa/x` (`cleanUserAgent()` in `src/main/sessions.js`), applied to every session, popup and worker | What's left is accurate: Chromium 156 on Windows. Checked in 0.91: no Electron token reaches pages or requests. |
| **Client Hints** | Chromium 156's JavaScript reports `"Not:A-Brand";v="8"` and `"Chromium";v="156"`, but **Electron sends no `Sec-CH-UA` headers at all**. Optional compatibility mode adds `"Google Chrome"` on Google's hosts | See *0.91 findings* — in 0.90 the headers and the JavaScript told two different stories. |
| **Page environment** | Electron leaves out parts of Chrome that Chromium-based browsers normally have: `window.chrome` is an **empty object** (no `chrome.app`, `chrome.runtime`, `chrome.csi`, `chrome.loadTimes`), no Chrome components, no Safe Browsing | These can't be added honestly — faking them would be exactly the spoofing this project rules out. If Google's checks rely on them, Vexa can't pass them. |
| **Fingerprinting protection** | Vexa Shields replaces canvas, WebGL and audio functions in every page with versions that add noise | On Google's sign-in page this looked like a tampered browser — see *0.91 findings*. |
| **Embedded webviews / OAuth in a WebView** | Each tab is a top-level browsing context, like Chrome's | Google's OAuth `disallowed_useragent` rule is about apps that show *their own* login in a WebView; Vexa doesn't. |
| **Automation** | Vexa never attaches a debugger, never sets `navigator.webdriver` and never starts with remote debugging (only the test suite does) | Not a cause in normal use. **Don't test Google sign-in from the e2e harness** — remote debugging is an automation signal. |
| **Popups and `window.opener`** | Kept for `window.open` popups; sized popups open as real windows | 0.91: popup windows show the real host first in their title, so you can see it's `accounts.google.com` before typing. |
| **Third-party cookies** | Shields blocks cross-site cookies, except Google's sign-in button endpoints (setting below) | Needed for "Sign in with Google" buttons on other sites. |
| **Cookie persistence** | Persistent default session; `persist:` partitions for isolated Spaces | Sign-ins survive restarts. Private windows forget them on purpose. |
| **FedCM** | Not exposed by Electron 45 | Google Identity Services falls back to its iframe/popup flow. |

### 0.91 findings: what Vexa itself got wrong

Investigated by reading the code and by running the bundled Electron and Vexa against a local
server, a public HTTPS site and Google's public sign-in page (no credentials entered). Five
problems, all of the "browser looks tampered with" kind that the help page above describes:

0. **No Client Hints headers.** Every Chromium browser sends `Sec-CH-UA`, `Sec-CH-UA-Mobile` and
   `Sec-CH-UA-Platform` on every secure request. Stock Electron 45 sends none of them (checked with
   and without Vexa's user-agent cleanup, against `localhost` and a live HTTPS site) while
   `navigator.userAgentData` in the same page reports brands. With compatibility mode off, 0.90 sent
   Google no hints at all; with it on, it sent hints *only* to Google, and different ones from the
   JavaScript. **Fixed:** Vexa now sends the three standard low-entropy hints itself, on secure
   requests only (`https:`, `wss:` and localhost — the same rule as Chromium), with Chromium's
   own honest values: `chromiumBrands()` reproduces Chromium's GREASE algorithm (checked against
   the captured 156 values and the published values for Chrome 120, 124 and 131), and the e2e suite
   compares the header a server receives with `navigator.userAgentData`, so an Electron upgrade that
   changes the algorithm fails the tests instead of drifting silently. Headers Chromium sends
   itself are never overwritten. High-entropy hints (full version, platform version…) are still
   only available to JavaScript.
1. **A brand list no real browser sends.** Chromium 156 generates its own "GREASE" brand
   (`"Not:A-Brand";v="8"`, listed first). 0.90's compatibility mode threw that away and sent a
   hand-written `"Chromium"; "Google Chrome"; "Not.A/Brand";v="99"` — the GREASE value of a much
   older Chrome. Real Chrome 156 never sends that combination, so the header itself was a
   giveaway. **Fixed:** Vexa now keeps Chromium's own list and only inserts `"Google Chrome"` after
   `"Chromium"` with the same version (`withChromeBrand()` / `withChromeBrandHeader()` in
   `src/main/url.js`).
2. **Headers Chromium didn't send.** 0.90 added `Sec-CH-UA-Full-Version-List` to every Google
   request. Browsers only send that high-entropy hint when a site asks for it. **Fixed:** the Chrome
   brand is only ever added to brand headers that are already on the request (`applyChromeBrand()`
   in `sessions.js`); Vexa never adds the full version list.
3. **JavaScript and headers disagreed.** The headers changed on `google.*`, `youtube.com`,
   `gstatic.com` and `googleusercontent.com`, but `navigator.userAgentData` only changed on
   `google.*` and `youtube.com`, and was installed late with `executeJavaScript`. **Fixed:** the main
   process decides per frame with the same host list as the headers, and the brand change is
   installed before any page script runs (`contextBridge.executeInMainWorld`).
4. **Fingerprinting noise on the sign-in page.** With Shields' fingerprinting protection on (the
   default), `accounts.google.com` got canvas/WebGL/audio functions that are visibly not the
   browser's own and return different readings every session. Anti-abuse scripts check exactly
   this. **Fixed:** fingerprinting protection is skipped on Google's account hosts only
   (`accounts.google.*`, `accounts.youtube.com`; `isGoogleAccountsHost()`), unless you turn it on for
   google.com yourself in the Shields panel. Google Search, YouTube and every other site are still
   protected. Settings → Shields says so next to the switch.

**What 0.91 does not change — and why sign-in may still fail:**

* The brand change is still done in JavaScript. A careful script can tell (`Function.prototype.toString`
  on the getter isn't native, `NavigatorUAData.toJSON()` and Web Workers still report Chromium's
  original list). Hiding that would mean disguising patches as native code — anti-detection work
  this project won't do.
* `window.chrome` is empty and Chrome's components are missing. That's what Electron is.
* Google can refuse any browser it doesn't recognise, and offers no way for a new browser to
  register. If Google's checks require Chrome-only features, **no legitimate change to Vexa fixes
  it.** That is a Google decision, documented here rather than worked around.

### What Vexa does now

1. **Honest base identity, always.** Chromium's UA without `Electron/x` or `vexa/x`, plus the
   standard low-entropy Client Hints with Chromium's own brands on secure requests (new in 0.91).
   No other site is ever told Vexa is anything else.
2. **Chrome-brand compatibility mode, on by default, switchable** (Settings → Compatibility →
   *Present the Chrome brand to Google*). Only on Google's own hosts, `Sec-CH-UA` (and the full
   version list, if a request ever carries one) and `navigator.userAgentData` get
   `"Google Chrome"` added to Chromium's own list. It is the one place Vexa claims the Chrome name,
   which is a misstatement made to one company; Google could treat it as a policy violation or
   change its checks at any time. Turn it off and Vexa reports only Chromium's brands everywhere.
   **Both settings need testing by hand** — with an otherwise unmodified browser, the honest list
   may well do better than the claim (see the checklist).
3. **Untouched sign-in pages.** No fingerprinting noise on Google's account hosts (above).
4. **"Sign in with Google" buttons on other sites** (Settings → Compatibility, on by default). Like
   Brave's *"Allow Google login buttons on third-party sites"*, Shields lets your Google cookies reach
   `https://accounts.google.com/gsi/*` and `/o/oauth2/*` when embedded on another site. Nothing else
   Google loads on third-party pages gets this exception (`isGoogleSignInButton()` in `sessions.js`).
5. **Popup titles show the host** (`popupTitle()` in `url.js`): "accounts.google.com — Sign in".
6. **No interception.** Vexa never reads, stores or forwards Google passwords or tokens beyond its
   normal password manager, which only offers to save what you type yourself. It doesn't proxy or
   script Google's login pages, apart from the brand list in point 2. It doesn't copy cookies from
   other browsers.

### If Google still refuses Vexa

* Try both settings of *Present the Chrome brand to Google* (restart not needed; reload the page).
* Use a **passkey** if the account has one — it still goes through the same page, so it may also be
  refused.
* On sites that offer it, use another sign-in method (Microsoft, Apple, email + password).
* Use Google's own apps (Gmail, Drive) or another browser for Google itself.

### Why there is no "sign in through the system browser" handoff

The RFC 8252 pattern (open the system browser, then return to the app through a redirect) lets a
*native app* sign in to **its own backend**. Vexa has no Google-backed account of its own. The
Google session a *website* needs has to live in Vexa's own cookie jar. A sign-in finished in Edge or
Chrome leaves its cookies in Edge or Chrome, and no supported way exists to move them into another
browser. Copying cookies between browsers would mean handling authentication tokens, which this
project rules out. A handoff would leave you signed in to the wrong browser, so it isn't offered.

### Verified, and not verified

* **Unit tests** (`test/unit/vexa090.test.js`, `test/unit/vexa091.test.js`): Google host lists
  (look-alikes such as `xgoogle.com` or `accounts.google.com.evil.net` don't count), the GIS cookie
  endpoints, brand lists derived from Chromium's real 156 values, header rewriting (nothing added,
  unparseable values untouched), the preload's brand change matching the main process's, the
  sign-in fingerprinting exemption and its per-site override, and popup titles.
* **e2e** (`npm run test:e2e`): sized popups open as windows and keep `window.opener`; third-party
  cookies are still stripped elsewhere; fingerprinting is still applied on ordinary sites. Google's
  real hosts can't be served locally (HSTS preload), so the Google-only behaviour is covered by the
  unit tests and the live probe below.
* **Live probe, no credentials** — Vexa 0.91 with a fresh profile loading
  `https://accounts.google.com/` (it redirects to the email step), November 2026:

  | | Chrome brand **on** (default) | Chrome brand **off** |
  |---|---|---|
  | `User-Agent` sent | `… Chrome/156.0.8078.80 Safari/537.36`, no Electron/vexa token | same |
  | `Sec-CH-UA` sent | `"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"` | `"Not:A-Brand";v="8", "Chromium";v="156"` |
  | `Sec-CH-UA-Mobile` / `-Platform` | `?0` / `"Windows"` | same |
  | `navigator.userAgentData.brands` | same three as the header | same two as the header |
  | `brands` getter is native code | **no** (the JavaScript patch is visible) | yes |
  | canvas / WebGL functions are native | yes (fingerprinting exemption) | yes |
  | `navigator.webdriver` | `false` | `false` |
  | `window.chrome` | `{}` (empty — Electron) | `{}` |

  For comparison, 0.90 (from its code): no hints at all with the brand off; with it on, a
  `"Not.A/Brand";v="99"` header that disagreed with the JavaScript's `"Not:A-Brand";v="8"`, plus
  wrapped canvas / WebGL / audio functions on the sign-in page in both modes. The probe ran through
  the e2e-style remote-debugging connection, so it says nothing about whether Google *accepts* the
  sign-in — only what Vexa now presents.
* **Not verified: a real sign-in.** That needs a real account and password, which automated tests
  never enter. Follow [GOOGLE-SIGNIN-TESTING.md](GOOGLE-SIGNIN-TESTING.md) and record the result.

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
