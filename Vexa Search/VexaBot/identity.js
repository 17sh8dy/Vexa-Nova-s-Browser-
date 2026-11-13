'use strict';
// Who VexaBot says it is. Webmasters match on the token `VexaBot` in robots.txt.

const VERSION = '0.1';
const TOKEN = 'VexaBot';
// TODO before any large public crawl: publish the /bot page (server/views.js botPage)
// at this URL so webmasters can read what VexaBot is and how to block it.
const INFO_URL = 'https://vexa.shadylabs.workers.dev/bot';

const USER_AGENT = `Mozilla/5.0 (compatible; ${TOKEN}/${VERSION}; +${INFO_URL})`;

module.exports = { VERSION, TOKEN, INFO_URL, USER_AGENT };
