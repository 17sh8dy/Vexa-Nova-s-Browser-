# Google sign-in: manual test checklist

Automated tests never enter real credentials, so a real Google sign-in has to be tried by a
person. Do this before each release and write the result into the release notes. Background:
[COMPATIBILITY.md → Google sign-in](COMPATIBILITY.md#1-google-sign-in).

**Ground rules**

* Use your own account(s). Type the password yourself; don't paste it from somewhere a script can read.
* Start Vexa normally (Start menu / `npm start`). **Never** test from `npm run test:e2e` or with
  `--remote-debugging-port`: that is an automation signal and Google is right to refuse it.
* Use a fresh profile so earlier cookies or Shields overrides don't change the result:
  ```powershell
  $env:VEXA_PROFILE = "$env:TEMP\vexa-google-test"; npm start
  ```
  (Delete that folder afterwards.)
* Record for each attempt: Vexa version, Windows version, account type (personal / Workspace /
  with 2-Step Verification / with a passkey), the two compatibility settings, and the exact result
  (screenshot of any error page).

## A. Before signing in

- [ ] Settings → About shows the expected version (0.91.x) and Chromium 156.
- [ ] Settings → Compatibility: note whether *Present the Chrome brand to Google* is on (default: on).
- [ ] Settings → Shields: *Fingerprinting protection* is on (default) — the sign-in page should
      still be exempt. Shields panel on accounts.google.com should show no fingerprinting blocks.

## B. Direct sign-in (the case that failed in 0.90)

Run once with *Present the Chrome brand to Google* **on**, then repeat in a new profile with it **off**.

- [ ] Open `https://accounts.google.com/` in a normal (not private) window.
- [ ] Enter the email address → **Next**.
  - Result: password page / *"This browser or app may not be secure"* / other: ________
- [ ] Enter the password → **Next**. Complete 2-Step Verification if asked.
  - Result: signed in / refused / other: ________
- [ ] Open `https://myaccount.google.com/` — your name and photo appear.
- [ ] Open `https://www.youtube.com/` — you're signed in there too.
- [ ] Quit Vexa completely and start it again (same profile) — still signed in on both.

## C. Other Google flows

- [ ] Gmail: `https://mail.google.com/` loads your inbox.
- [ ] Sign out (avatar → Sign out), then sign in again from `https://www.google.com/` → **Sign in**.
- [ ] Add a second account (avatar → *Add another account*) — the account chooser shows both.
- [ ] Passkey (if the account has one): *Try another way* → *Use your passkey* → Windows Hello.
- [ ] Private window: sign in works; after closing the window, a new private window is signed out.
- [ ] Isolated Space (Settings → Spaces → *Isolated*): sign in to a **different** account there;
      the normal Space keeps the first account.

## D. "Sign in with Google" on other sites (popup and button)

Pick a site that offers "Sign in with Google" (for example a developer site you already use).

- [ ] The Google button shows your account name (needs *“Sign in with Google” buttons on other sites* on).
- [ ] Clicking it opens a small window whose title starts with **accounts.google.com —**.
- [ ] Choosing the account closes the window and signs you in on the site.
- [ ] With the button setting **off**, the button no longer shows your account (expected).

## E. Write down the outcome

| Date | Version | Account type | Chrome brand | Direct sign-in | Popup sign-in | Notes |
|---|---|---|---|---|---|---|
| | | | on | | | |
| | | | off | | | |

If every attempt is refused at the email step with *"This browser or app may not be secure"* in
both modes, Google is refusing Vexa itself. That is documented as a limitation in
[COMPATIBILITY.md](COMPATIBILITY.md#if-google-still-refuses-vexa); please don't add more browser
disguises to get around it.
