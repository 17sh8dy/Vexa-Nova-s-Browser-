'use strict';
// Central defaults. Everything here can be overridden from the CLI.

const path = require('node:path');

module.exports = {
  dbPath: process.env.VEXA_SEARCH_DB || path.join(__dirname, 'data', 'vexa-search.db'),

  crawl: {
    maxPages: 500,         // stop after this many successful fetches in one run
    maxDepth: 3,           // link hops from a seed
    maxPerSite: 150,       // per registrable domain; keeps the crawl broad
    maxQueuedPerSite: 600, // frontier bound per site (seeds exempt)
    concurrency: 4,        // parallel fetches (always on different hosts)
    minHostDelayMs: 1500,  // politeness floor between hits to one host
    maxCrawlDelayMs: 30000,// ignore robots Crawl-delay above this (we just skip the host)
    timeoutMs: 15000,
    maxBytes: 2 * 1024 * 1024,
    maxRedirects: 5,
    allowPrivateHosts: false, // never crawl localhost / LAN unless explicitly allowed (tests)
    recrawlAfterMs: 7 * 24 * 3600 * 1000
  },

  server: {
    host: '127.0.0.1',
    port: 8790,
    pageSize: 10
  }
};
