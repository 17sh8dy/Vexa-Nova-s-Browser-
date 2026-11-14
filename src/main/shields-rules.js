'use strict';
// Vexa Shields — the pure part: block lists, matching, tracking-parameter removal and
// HTTPS-upgrade eligibility. No Electron here, so all of it is unit-tested with plain Node.
//
// The ad / tracker / fingerprinter lists are Vexa's own, hand-curated lists of well-known
// third-party hosts (facts about which hosts serve ads, not copied from any filter list).
// They are deliberately smaller than EasyList-style lists: they block the big networks and
// avoid hosts that sites need to work (sign-in SDKs, fraud checks, video players).
// The malicious host list is a snapshot of abuse.ch URLhaus (CC0), refreshed at build time
// by scripts/update-shield-lists.js. Vexa never downloads anything at run time.

const fs = require('fs');
const path = require('path');

// Entry forms: "example.com" blocks the host and every subdomain;
// "example.com/path" blocks only URLs whose path starts with /path ("*" matches anything).
const ADS = `
doubleclick.net googlesyndication.com googleadservices.com adservice.google.com 2mdn.net
adnxs.com adsrvr.org rubiconproject.com pubmatic.com openx.net criteo.com criteo.net
taboola.com outbrain.com amazon-adsystem.com advertising.com adform.net smartadserver.com
casalemedia.com indexww.com media.net yieldmo.com sharethrough.com triplelift.com 3lift.com
teads.tv moatads.com adsafeprotected.com doubleverify.com serving-sys.com contextweb.com
gumgum.com spotxchange.com spotx.tv springserve.com lijit.com sovrn.com bidswitch.net
mathtag.com adroll.com revcontent.com mgid.com zedo.com propellerads.com popads.net
popcash.net adcash.com exoclick.com trafficjunky.net juicyads.com ads-twitter.com
ads.linkedin.com ads.yahoo.com gemini.yahoo.com yieldlab.net smaato.net inmobi.com
adtelligent.com onetag-sys.com seedtag.com kargo.com undertone.com districtm.io emxdgt.com
rhythmone.com unrulymedia.com tremorhub.com 33across.com 360yield.com improvedigital.com
adkernel.com adition.com zemanta.com nativo.com primis.tech connatix.com vidazoo.com
adthrive.com ezoic.net ezojs.com buysellads.com carbonads.net googletagservices.com
adsterra.com hilltopads.net clickadu.com admaven.com a-ads.com bidvertiser.com
infolinks.com yllix.com richpush.co pushground.com adspyglass.com ad-maven.com
trafficstars.com tsyndicate.com realsrv.com magsrv.com adskeeper.com lkqd.net
adcolony.com applovin.com vungle.com chartboost.com unityads.unity3d.com
adsystem.amazon.com aax.amazon-adsystem.com ad.atdmt.com atdmt.com
`;

const TRACKERS = `
google-analytics.com analytics.google.com googletagmanager.com stats.g.doubleclick.net
connect.facebook.net/*/fbevents.js connect.facebook.net/signals facebook.com/tr
hotjar.com hotjar.io mouseflow.com fullstory.com crazyegg.com luckyorange.com
luckyorange.net clarity.ms mixpanel.com mxpnl.com segment.io cdn.segment.com
api.segment.io amplitude.com heap.io heapanalytics.com kissmetrics.com chartbeat.com
chartbeat.net parsely.com parse.ly nr-data.net omtrdc.net 2o7.net demdex.net
everesttech.net krxd.net bluekai.com exelator.com rlcdn.com agkn.com adsymptotic.com
tapad.com liadm.com pippio.com crwdcntrl.net addthis.com sharethis.com quantcount.com
quantserve.com scorecardresearch.com comscore.com imrworldwide.com mookie1.com
mc.yandex.ru mc.yandex.com top-fwz1.mail.ru hm.baidu.com cnzz.com analytics.tiktok.com
tr.snapchat.com sc-static.net ct.pinterest.com px.ads.linkedin.com snap.licdn.com
analytics.twitter.com static.ads-twitter.com alb.reddit.com events.redditmedia.com
q.quora.com bat.bing.com statcounter.com histats.com appsflyer.com adjust.com
kochava.com siteimproveanalytics.com rum-static.pingdom.net tealiumiq.com
mparticle.com branch.io/v1/pageview bounceexchange.com bouncex.net
onesignal.com/api/v1/sync zdassets.com/ekr quantummetric.com contentsquare.net
smartlook.com inspectlet.com clicktale.net decibelinsight.net glassboxdigital.io
`;

// Commercial browser-fingerprinting services (not fraud-prevention ones, which banks need).
const FINGERPRINTERS = `
fpjs.io fpcdn.io openfpcdn.io fpnpmcdn.net fingerprintjs.com/api
`;

// Query parameters that only exist to track the click. Removed from top-level navigations.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_eid', 'mc_cid',
  'igshid', 'igsh', 'yclid', 'ysclid', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsctatracking',
  'twclid', 'ttclid', 'li_fat_id', 'epik', 'scclid', 'rdt_cid', 'oly_anon_id', 'oly_enc_id',
  'vero_id', 'vero_conv', 'mkt_tok', '_openstat', 'wickedid', 's_cid', 'srsltid', 'si_trk',
  'ef_id', 'irclickid', 'ncid', 'sms_click', 'sms_source', 'sms_uph', 'ml_subscriber',
  'ml_subscriber_hash', 'rb_clickid', 'soc_src', 'soc_trk', 'cvid', 'oicd', 'gad_source',
  '_kx', 'trk_contact', 'trk_msg', 'trk_module', 'trk_sid', 'mtm_cid', 'pk_cid', 'unicorn_click_id'
]);
// Any parameter with these prefixes is tracking (utm_source, utm_medium, …).
const TRACKING_PREFIXES = ['utm_', 'pk_campaign', 'pk_kwd', 'mtm_campaign', 'mtm_kwd', 'hsa_'];

function parseList(text) {
  const hosts = new Set();
  const paths = new Map(); // host -> [RegExp]
  for (const raw of text.split(/\s+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry || entry.startsWith('#')) continue;
    const slash = entry.indexOf('/');
    if (slash < 0) {
      hosts.add(entry);
      continue;
    }
    const host = entry.slice(0, slash);
    const glob = entry.slice(slash).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^?#]*');
    if (!paths.has(host)) paths.set(host, []);
    paths.get(host).push(new RegExp('^' + glob));
  }
  return { hosts, paths };
}

const LISTS = {
  ads: parseList(ADS),
  trackers: parseList(TRACKERS),
  fingerprinting: parseList(FINGERPRINTERS)
};

let malicious = null;
function maliciousHosts() {
  if (malicious) return malicious;
  malicious = new Set();
  try {
    const text = fs.readFileSync(path.join(__dirname, 'data', 'shields', 'malicious-hosts.txt'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const h = line.trim().toLowerCase();
      if (h && !h.startsWith('#')) malicious.add(h);
    }
  } catch {
    /* list missing: malicious-site protection has nothing to match */
  }
  return malicious;
}

/** Every suffix of a hostname that could be a list entry: a.b.example.com → [a.b.example.com, b.example.com, example.com]. */
function suffixes(host) {
  const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  const out = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

function listHas(list, host, pathname) {
  for (const s of suffixes(host)) {
    if (list.hosts.has(s)) return true;
    const rx = list.paths.get(s);
    if (rx && rx.some((r) => r.test(pathname || '/'))) return true;
  }
  return false;
}

/**
 * Which Shields category (if any) a URL's host belongs to.
 * @returns {'ads'|'trackers'|'fingerprinting'|null}
 */
function classify(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^(https?|wss?):$/.test(u.protocol)) return null;
  const path = u.pathname.toLowerCase();
  if (listHas(LISTS.fingerprinting, u.hostname, path)) return 'fingerprinting';
  if (listHas(LISTS.ads, u.hostname, path)) return 'ads';
  if (listHas(LISTS.trackers, u.hostname, path)) return 'trackers';
  return null;
}

function isMaliciousHost(host) {
  const set = maliciousHosts();
  if (!set.size) return false;
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (set.has(h)) return true;
  return suffixes(h).some((s) => set.has(s));
}

function isTrackingParam(name) {
  const k = name.toLowerCase();
  return TRACKING_PARAMS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Remove click-tracking parameters from a URL.
 * @returns {{ url: string, removed: number }} url is unchanged when nothing was removed
 */
function stripTrackingParams(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { url, removed: 0 };
  }
  if (!/^https?:$/.test(u.protocol) || !u.search) return { url, removed: 0 };
  const keep = [];
  let removed = 0;
  // Work on the raw query so parameters we keep are byte-for-byte unchanged.
  for (const part of u.search.slice(1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    let name = eq < 0 ? part : part.slice(0, eq);
    try {
      name = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      /* keep raw */
    }
    if (isTrackingParam(name)) removed++;
    else keep.push(part);
  }
  if (!removed) return { url, removed: 0 };
  u.search = keep.length ? '?' + keep.join('&') : '';
  return { url: u.href, removed };
}

const NON_PUBLIC_TLDS = new Set(['localhost', 'local', 'lan', 'internal', 'intranet', 'home', 'corp', 'test', 'example', 'invalid', 'onion', 'arpa', 'localdomain']);

/** Should Vexa try https:// first for this http:// URL? Only public hostnames on the default port. */
function httpsUpgradeCandidate(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return null; // single-label intranet names
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null; // IP literals
  const tld = host.split('.').pop();
  if (NON_PUBLIC_TLDS.has(tld) || host.endsWith('.home.arpa')) return null;
  u.protocol = 'https:';
  return u.href;
}

// The protections, in display order. `cookies` is third-party cookie blocking.
const PROTECTIONS = ['ads', 'trackers', 'cookies', 'fingerprinting', 'https', 'malicious', 'params', 'popups'];

module.exports = { classify, isMaliciousHost, maliciousHosts, stripTrackingParams, isTrackingParam, httpsUpgradeCandidate, suffixes, PROTECTIONS, LISTS };
