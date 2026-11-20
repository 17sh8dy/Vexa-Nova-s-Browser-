# Vexa Download Website — 0.5.5

A standalone, responsive product/download website for Vexa, Nova's Chromium-powered desktop browser.

## Preview locally

No build tools or package installation are required.

1. Extract this folder.
2. Open a terminal in this folder.
3. Run:

   ```bash
   python -m http.server 5500
   ```

4. Visit <http://localhost:5500>.

You can also open `index.html` directly, although using a local server is closer to normal hosting behaviour.

## Deploy later to Cloudflare Pages

This is a static site. When you're ready to publish it:

- Create a Cloudflare Pages project connected to the website repository, or upload the folder using the Pages direct-upload workflow.
- Build command: leave blank.
- Build output directory: `/` (the project root).
- No Node.js install or framework build is needed.

The `_headers` file provides baseline response security headers for Cloudflare Pages.

## Downloads

The download links point at the GitHub Release `v0.5.5` on github.com/17sh8dy/Vexa-Nova-s-Browser-
(`Vexa-Setup-0.5.5.exe`, 174 MB, and `Vexa-Portable-0.5.5.exe`, 162 MB; 0.5.5 bundles the Vexa Search index). The installers are well over 100 MB, which is over
Cloudflare Workers' 25 MiB static-asset limit, so they are not hosted on the site itself. For a new
version, publish a new release and update the URLs, sizes and version numbers in `index.html`.

## Project files

- `index.html` — page structure and product content.
- `styles.css` — responsive dark UI, feature illustrations, and scroll-reveal animations.
- `script.js` — mobile navigation, reveal-on-scroll behaviour, and back-to-top scrolling.
- `assets/vexa-mark.svg` — local Vexa site mark/favicon.
- `_headers` — Cloudflare Pages security headers.
- `robots.txt` — basic crawler policy.

## Content source

Product details are based on the Vexa 0.5.0 repository README and `package.json`. The website intentionally calls out known limitations: unpacked-only extension support, unverified Google sign-in, and the optional/unverified Widevine DRM path.
