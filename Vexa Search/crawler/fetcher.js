'use strict';
// Polite HTTP fetching for VexaBot: identifies itself, follows redirects
// one hop at a time (so every hop is checked), caps size and time, and
// refuses to reach private network addresses unless allowed.

const dns = require('node:dns').promises;
const { USER_AGENT } = require('../VexaBot/identity');
const { normalizeUrl, isPrivateAddress, isPrivateHostname } = require('./url');
const { sniffCharset } = require('./html');

class FetchError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function assertPublic(url, allowPrivate) {
  if (allowPrivate) return;
  const { hostname } = new URL(url);
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostname(bare)) throw new FetchError(`private host ${hostname}`, 'private');
  let addrs;
  try { addrs = await dns.lookup(bare, { all: true }); } catch { throw new FetchError(`DNS failed for ${hostname}`, 'dns'); }
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new FetchError(`${hostname} resolves to a private address`, 'private');
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) { chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes))); break; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function decodeBody(buf, contentType) {
  let charset = (/charset\s*=\s*["']?([a-z0-9_.:-]+)/i.exec(contentType || '') || [])[1] || '';
  if (!charset) charset = sniffCharset(buf.subarray(0, 2048).toString('latin1'));
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

/**
 * Fetch a URL. `checkHop(url)` is called for every redirect target and may
 * throw to stop (robots / policy checks live in the crawler).
 * Resolves { url, status, contentType, body?, headers } where `url` is final.
 */
async function fetchPage(startUrl, opts = {}) {
  const {
    timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxRedirects = 5,
    allowPrivate = false, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
    checkHop = async () => {}, fetchImpl = fetch, anyType = false
  } = opts;

  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublic(url, allowPrivate);
    if (hop > 0) await checkHop(url);
    let res;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en;q=1, *;q=0.5' }
      });
    } catch (e) {
      throw new FetchError(e.name === 'TimeoutError' ? 'timeout' : `network: ${e.cause?.code || e.message}`, 'network');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = normalizeUrl(res.headers.get('location'), url);
      res.body?.cancel().catch(() => {});
      if (!next) throw new FetchError('bad redirect', 'redirect');
      url = next;
      continue;
    }
    const contentType = res.headers.get('content-type') || '';
    const result = { url, status: res.status, contentType, headers: res.headers };
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    const isText = /^text\/plain/i.test(contentType);
    if (res.status === 200 && (isHtml || isText || anyType)) {
      const buf = await readCapped(res, maxBytes);
      result.body = decodeBody(buf, contentType);
    } else {
      res.body?.cancel().catch(() => {});
    }
    return result;
  }
  throw new FetchError('too many redirects', 'redirect');
}

module.exports = { fetchPage, FetchError, decodeBody };
