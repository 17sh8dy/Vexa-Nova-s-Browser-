# Vexa 0.91.0 — Google sign-in investigation, simpler Settings, a New Tab made for exploring

An improvement release on top of 0.90. Nothing was removed: every 0.90 feature and setting is
still there.

## Google sign-in

Testers on 0.90 got *"Couldn't sign you in — This browser or app may not be secure"* with every
account. The investigation ([COMPATIBILITY.md](COMPATIBILITY.md#1-google-sign-in)) found that Vexa
itself was making the browser look tampered with. 0.91 fixes those parts:

* **Standard Client Hints.** Electron sends no `Sec-CH-UA` headers at all, although its JavaScript
  reports brands — a mismatch no real browser has. Vexa now sends the three standard low-entropy
  hints with Chromium's own, honest values on secure requests.
* **No more hand-written brand list.** The *Present the Chrome brand to Google* mode now adds
  "Google Chrome" to Chromium's real list (keeping its `"Not:A-Brand";v="8"` entry), instead of
  replacing it with a list from an older Chrome. It no longer adds headers the browser didn't send.
* **Headers and JavaScript agree.** One host list, decided per frame, and the brand change is in
  place before the page's own scripts run.
* **Google's sign-in pages are left untouched by fingerprinting protection**, which made canvas,
  graphics and audio readings look altered there. Everywhere else, including Google Search and
  YouTube, the protection is unchanged. You can turn it back on for google.com in the Shields panel.
* **Sign-in popups show where they are:** the window title starts with the real host, e.g.
  "accounts.google.com — Sign in".

**Google still refuses the sign-in**, with the Chrome-brand switch on and off. Tested by hand on 0.91 (November 27, 2026): Google shows
*"Couldn't sign you in — This browser or app may not be secure."* The fixes above make Vexa
consistent and honest, but they are not enough for Google, which can refuse browsers it doesn't
recognise for reasons Electron can't honestly change (for example, `window.chrome` is empty).
**Google sign-in is a known limitation of Vexa** — see
[COMPATIBILITY.md](COMPATIBILITY.md#if-google-still-refuses-vexa) for what still works, and for the
long-term option (building Vexa on full Chromium, like Brave and Edge — not started).

* **A short notice when Google refuses:** on Google's "Couldn't sign you in" page, a one-line bar
  explains that the account and password are fine and that Google blocks browsers it doesn't
  recognise, with *Learn more* and *Got it*.

| Date | Account type | Chrome brand | Result |
|---|---|---|---|
| 2026-11-27 | tester's own accounts | on (default) | Refused: "This browser or app may not be secure" |
| 2026-11-27 | tester's own accounts | off | Refused: "This browser or app may not be secure" |

## Settings

Same settings, less reading. Descriptions were shortened to what each setting does for you, and the
page is grouped into everyday sections and an **Advanced** group (Extensions, Compatibility) in the
jump bar. The Google API key for location moved to an *Advanced* block under Site permissions.
Warnings that matter were kept: isolated vs. ordinary Spaces, trusting extensions, cross-site
cookies and sign-ins, and the Chrome-brand claim. On narrow windows, controls now drop under their
label instead of squeezing it.

## New Tab

* The search box is bigger and leads the page; the logo is smaller.
* Two chips under the search box: **@tabs** (find an open tab) and **Command Center** (showing your
  real shortcut key). No site shortcuts are suggested — where to go is up to you. These replace a
  hint that only appeared on hover.
* The **Spaces** and **Collections** boxes are no longer shown by default — both are always in the
  sidebar, and Collections is in the page footer. They're still available under Customize → Layout.
* **Your layout is kept.** Profiles whose widgets were still exactly the 0.90 defaults get the new
  defaults once. If you had changed any widget, the order or the arrangement, nothing changes.
  *Reset New Tab to the default look* now resets to the 0.91 defaults.
* Small windows: the search box, chips and tiles fit without sideways scrolling.

## Under the hood

* New: `src/main/ntp-defaults.js` (New Tab defaults migration), `test/unit/vexa091.test.js`,
  `docs/GOOGLE-SIGNIN-TESTING.md`.
* e2e: 50 checks (one new check for sized sign-in popups; existing checks extended for Client
  Hints matching JavaScript, New Tab defaults and explore chips, and Settings grouping).
