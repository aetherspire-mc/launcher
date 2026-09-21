'use strict';
/**
 * Pure tests for the idempotency-key and origin-cache seams in `src/api.js`.
 * No test runner in package.json, so this is a plain node script - a pure JS module test
 * via `node` is acceptable here.
 * Run: node launcher/src/api.test.js
 * Exits non-zero on the first failed assertion.
 */
const assert = require('assert');
const api = require('./api.js');
const { req, cacheMaxAgeMs, originCache, cacheKeyFor } = api._test;

// --- cacheMaxAgeMs -----------------------------------------------------------------------

function fakeRes(cacheControl) {
  return { headers: { get: (name) => (name === 'cache-control' ? cacheControl : null) } };
}

assert.strictEqual(cacheMaxAgeMs(fakeRes('public, max-age=30, stale-while-revalidate=60')),
  30000, 'a public max-age is read in milliseconds');
assert.strictEqual(cacheMaxAgeMs(fakeRes('private, no-store')), 0,
  'no-store is never cached even if it somehow also carried a max-age');
assert.strictEqual(cacheMaxAgeMs(fakeRes('')), 0, 'no Cache-Control header at all is not cached');
assert.strictEqual(cacheMaxAgeMs(fakeRes(null)), 0, 'a missing header object does not throw');

// `no-cache` (a real RFC 9111 directive this client cannot honour
// short of revalidating, which it does not do) must not be treated as cacheable, and a
// distinct directive that merely ends the same way as `max-age` (`s-maxage`, shared-cache
// only) must not be confused with it.
assert.strictEqual(cacheMaxAgeMs(fakeRes('no-cache')), 0, 'no-cache is never cached');
assert.strictEqual(cacheMaxAgeMs(fakeRes('public, s-maxage=30')), 0,
  's-maxage is a shared-cache directive this client must not honour as its own max-age');
assert.strictEqual(cacheMaxAgeMs(fakeRes('public, s-maxage=30, max-age=10')), 10000,
  'the real max-age is still read correctly alongside an s-maxage this client ignores');

// The cache key must separate an anonymous and an authenticated
// response to the same path, since RealmRoute varies its body on Authorization.
assert.notStrictEqual(cacheKeyFor('/realm', false), cacheKeyFor('/realm', true),
  'an anonymous and an authenticated request to the same path must not share a cache slot');

// --- newIdempotencyKey ---------------------------------------------------------------------

// This only proves the RAW GENERATOR is not degenerate (does not hand
// back a constant or a colliding value). It is not, and must not be read as, a test of
// "one key per intent" - there is no caller in this module today that reuses a key across
// a retry (every write below takes `key` as an optional pass-through; nothing here mints
// one itself). A test asserting only "two calls DIFFER" would still pass if some future
// caller generated a new key per HTTP attempt instead of once per user action - exactly the
// failure mode this header exists to prevent - so it cannot stand in for that property. The
// property that matters (same key for a retry of the SAME intent, a fresh one once that
// intent is done) is proven elsewhere, where a real caller exists to hold a key across a
// retry.
const k1 = api.newIdempotencyKey();
const k2 = api.newIdempotencyKey();
assert.notStrictEqual(k1, k2, 'the raw generator does not hand back the same key twice');
assert.ok(k1 && k1.length > 0, 'a key is a non-empty string');

// --- req()'s origin cache -------------------------------------------------------------------

async function run() {
  originCache.clear();
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      headers: { get: (name) => (name === 'cache-control' ? 'public, max-age=30' : null) },
      json: async () => ({ hit: fetchCalls }),
    };
  };

  const first = await req('GET', '/realm', null, false);
  assert.strictEqual(first.hit, 1, 'the first GET reaches the network');
  const second = await req('GET', '/realm', null, false);
  assert.strictEqual(second.hit, 1,
    'a second GET within max-age is served from the origin cache, not re-fetched');
  assert.strictEqual(fetchCalls, 1, 'honouring Cache-Control means exactly one network call');

  // A cache hit used to return the stored object BY REFERENCE - a
  // caller mutating what it gets back would corrupt every later hit for the same key.
  second.hit = 'mutated';
  const third = await req('GET', '/realm', null, false);
  assert.strictEqual(third.hit, 1,
    'mutating a cache hit must not corrupt the cached copy for the next caller');

  // `/news`, `/patchnotes` and `/public/strata` all already answer `PUBLIC_SHORT` today
  // (`CacheControl.java`), so a response with no Cache-Control header at all is not a real
  // shape any of those three routes send. It IS still a real shape `req()` must handle
  // safely - the private, no-store default this test's own header stub does not literally
  // reproduce ("private, no-store" is a header, not an absent one) - so this is kept as a
  // defensive case (a route with a header this reader cannot parse, or none at all) rather
  // than dropped, but no longer named after routes that do not exhibit it.
  originCache.clear();
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    return { ok: true, headers: { get: () => null }, json: async () => ({ hit: fetchCalls }) };
  };
  await req('GET', '/me/some-future-route', null, false);
  await req('GET', '/me/some-future-route', null, false);
  assert.strictEqual(fetchCalls, 2, 'a response with no Cache-Control header is never cached');

  // A caller with its own freshness promise (the footer's 5 s
  // heartbeat) must be able to skip the origin cache for one call without disabling it for
  // everyone else who reads the same path.
  originCache.clear();
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      headers: { get: (name) => (name === 'cache-control' ? 'public, max-age=30' : null) },
      json: async () => ({ hit: fetchCalls }),
    };
  };
  const bypass1 = await api.realm(true);
  assert.strictEqual(bypass1.hit, 1);
  const bypass2 = await api.realm(true);
  assert.strictEqual(bypass2.hit, 2, 'bypassCache=true must reach the network every time');
  assert.strictEqual(fetchCalls, 2);
  const cached = await api.realm();
  assert.strictEqual(cached.hit, 2,
    'a bypassed call still WRITES the cache, so a normal caller of the same path benefits');

  // A write must carry the Idempotency-Key header when the caller supplies one, and must
  // not invent one itself - only the caller knows if this is a retry of the same intent.
  let sentHeaders = null;
  global.fetch = async (url, opts) => {
    sentHeaders = opts.headers;
    return { ok: true, headers: { get: () => null }, json: async () => ({}) };
  };
  await req('POST', '/me/friends/request', { name: 'x' }, true, 'key-123');
  assert.strictEqual(sentHeaders['Idempotency-Key'], 'key-123',
    'a supplied key is sent verbatim');

  sentHeaders = null;
  await req('POST', '/me/friends/request', { name: 'x' }, true);
  assert.ok(!sentHeaders['Idempotency-Key'],
    'req() never invents a key when the caller supplies none');

  console.log('api.test.js: all assertions passed');
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
