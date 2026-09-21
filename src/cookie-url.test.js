'use strict';
/**
 * LNCH1 (refs #46) — pure test for the token-cache clear helper's URL builder. No test
 * runner in launcher/package.json (only a `check` script that syntax-checks files), so this
 * is a plain node script asserting against the real module, per COMMON.md's "a pure JS
 * module test via node is acceptable". Run: node launcher/src/cookie-url.test.js
 * Exits non-zero on the first failed assertion.
 */
const assert = require('assert');
const { cookieRemovalUrl } = require('./cookie-url.js');

// Electron's session.cookies.get() domain-scoped cookies for login.live.com carry a
// leading dot; the removal URL must strip it to become a real hostname.
assert.strictEqual(
  cookieRemovalUrl({ domain: '.live.com', path: '/', secure: true }),
  'https://live.com/',
);

// A host-only cookie (no leading dot) keeps its domain as-is.
assert.strictEqual(
  cookieRemovalUrl({ domain: 'login.live.com', path: '/oauth20_authorize.srf', secure: true }),
  'https://login.live.com/oauth20_authorize.srf',
);

// Non-secure cookies must not get an https:// URL — session.cookies.remove() matches on
// scheme too, so this would silently fail to delete the cookie.
assert.strictEqual(
  cookieRemovalUrl({ domain: '.live.com', path: '/', secure: false }),
  'http://live.com/',
);

// Missing path defaults to '/' rather than producing a malformed URL.
assert.strictEqual(
  cookieRemovalUrl({ domain: '.live.com', secure: true }),
  'https://live.com/',
);

console.log('cookie-url.test.js: all assertions passed');
