'use strict';
// Local test site for Vexa's end-to-end tests. Usage: node test/server/server.js [port]
const http = require('http');

const page = (title, body, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}<link rel="icon" href="/favicon.svg"></head><body style="font-family:system-ui;padding:24px">${body}</body></html>`;

const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#22c55e"/></svg>';
const cookieLog = [];

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  switch (url.pathname) {
    case '/':
      return send(200, 'text/html', page('Vexa Test Home', `<h1>Test home</h1>
        <p>Find target: needle needle needle</p>
        <a id="p2" href="/page2">Go to page 2</a> ·
        <a id="blank" href="/opener" target="_blank">Open in new tab</a> ·
        <button id="winopen" onclick="window.open('/opener')">window.open</button> ·
        <a id="dl" href="/download">Download a file</a>`));
    case '/page2':
      return send(200, 'text/html', page('Second Page', '<h1>Page two</h1><a id="home" href="/">Back home</a>'));
    case '/opener':
      return send(200, 'text/html', page('Opener Check', '<h1 id="r">checking</h1><script>document.getElementById("r").textContent = window.opener ? "has-opener" : "no-opener"</script>'));
    case '/download':
      return send(200, 'application/octet-stream', Buffer.alloc(256 * 1024, 7), { 'content-disposition': 'attachment; filename="vexa-test.bin"' });
    case '/slow':
      return setTimeout(() => send(200, 'text/html', page('Slow page', '<h1>Finally</h1>')), 2500);
    case '/notify':
      return send(200, 'text/html', page('Notify', '<h1 id="r">idle</h1><script>Notification.requestPermission().then(p => document.getElementById("r").textContent = p)</script>'));
    case '/leave':
      return send(200, 'text/html', page('Leave', '<h1>beforeunload page</h1><script>addEventListener("beforeunload", e => { e.preventDefault(); e.returnValue = "" })</script>'));
    case '/fs':
      return send(200, 'text/html', page('Fullscreen', '<button id="go" onclick="document.getElementById(\'box\').requestFullscreen()">Fullscreen</button><div id="box" style="background:#7c3aed;color:#fff;padding:40px">Fullscreen box</div>'));
    case '/favicon.svg':
      return send(200, 'image/svg+xml', FAVICON);
    // third-party cookie test: top page on one host embeds another host
    case '/3p':
      return send(200, 'text/html', page('Third party', `<img src="http://${url.searchParams.get('other')}/c/set"><script>setTimeout(()=>{const i=new Image();i.src="http://${url.searchParams.get('other')}/c/check";document.body.append(i)},400)</script>`));
    case '/c/set':
      return send(200, 'image/svg+xml', FAVICON, { 'set-cookie': 'tp=1; Path=/; SameSite=None' });
    case '/c/check':
      cookieLog.push(req.headers.cookie || '');
      return send(200, 'image/svg+xml', FAVICON);
    case '/c/first-set':
      return send(200, 'text/html', page('First party cookie', 'set'), { 'set-cookie': 'fp=1; Path=/' });
    case '/c/first-check':
      return send(200, 'text/html', page('First party check', `<h1 id="r">${req.headers.cookie || 'none'}</h1>`));
    case '/headers':
      return send(200, 'application/json', JSON.stringify(req.headers));
    case '/__cookielog':
      return send(200, 'application/json', JSON.stringify(cookieLog));
    default:
      return send(404, 'text/html', page('Not found', '<h1>404</h1>'));
  }
}

function start(port = 0) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

if (require.main === module) {
  start(Number(process.argv[2]) || 8787).then((s) => console.log('Test site on http://127.0.0.1:' + s.address().port));
}
module.exports = { start };
