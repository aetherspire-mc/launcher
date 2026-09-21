'use strict';
const { API_BASE } = require('./config');

/** Thin client for the Aetherspire REST API. Holds the session token after sign-in. */

let sessionToken = null;

function getToken() { return sessionToken; }

/**
 * A fresh `Idempotency-Key`. The API service requires this header on any write that
 * moves items or coins (`/me/slots/switch`, `/me/mail`, `/me/mail/claim` - API.md's
 * Idempotency-Key table); it is optional on every write this file makes today (friends,
 * guild), so none of those calls need to pass one yet.
 *
 * The rule that makes the header worth anything: generate ONE key when the user acts and
 * reuse it on every retry of THAT SAME action; never generate a new one per HTTP attempt. A
 * key made fresh per attempt looks like protection and is not - it gives a retried write a
 * brand new command id, so a slot switch or a mail send that already landed runs again. A
 * caller that adds a slot-switch or mail call to this module later should hold its key the
 * same way `guildInvite`'s caller would need to for a required-header route: made once by
 * whatever triggers the action, passed in here, not generated inside `req`.
 */
function newIdempotencyKey() {
  return crypto.randomUUID();
}

/**
 * The origin cache the API service now runs for its public reads (`CacheControl.java`
 * `forPath`: `PUBLIC_SHORT` for `GET /realm` with no `Authorization` header, `/news`,
 * `/patchnotes` and every `/public/*` including `/public/memorials`). This launcher calls
 * `/realm`, `/news`, `/patchnotes` and `/public/strata`, and all four already answer
 * `PUBLIC_SHORT` (`public, max-age=30, stale-while-revalidate=60`). Before this, every
 * footer poll and every `enterApp` re-fetched `/realm` regardless of the `Cache-Control`
 * the API service actually sends, which defeated half the point of that server-side cache.
 * Honouring it here means:
 *   - what's cached: only a GET whose response carries a `Cache-Control: max-age=N` with
 *     N > 0. A private, no-store response (any authenticated read, i.e. everything but
 *     `realm()`/`news()`/`patchnotes()`/`strata()`) is never cached, so this is safe by
 *     construction even for a route this file has not yet confirmed carries a header.
 *   - for how long: exactly the `max-age` the server sent (30 s for `/realm` today), not a
 *     value guessed here - a change to the server's TTL takes effect on the next request
 *     with no launcher change.
 *   - what forces a refresh: the TTL expiring is the only thing that does. There is no
 *     manual invalidation, because there is nothing here that ever changes what `/realm`
 *     answers - the API service's own origin cache and Cloudflare purge are what keep that
 *     bounded (API.md: 91 s worst case after a mutation). A stale realm-status past that
 *     window is a server-side bug, not a launcher one.
 */
const originCache = new Map(); // cacheKeyFor(...) -> { body, expiresAt }

/**
 * The cache keys on `path` alone would be wrong, because `RealmRoute` varies its
 * body on `Authorization` (`RealmRoute.java` - the anonymous body drops `players`,
 * an authenticated one keeps it, and the route sets `Vary: Authorization` because of it).
 * Safe today only because `realm()` always calls with `auth=false` (`api.js`'s own
 * `realm(bypassCache)`), so this launcher never actually sends Authorization on that path -
 * but nothing enforced that, and a future caller passing `auth=true` on any cached path
 * would read (or poison) the wrong body for whoever asks next. Keying on path PLUS whether
 * an Authorization header was actually sent - not merely whether the caller asked for auth,
 * `sessionToken` may be null - separates the two representations the way the route's own
 * `Vary` header says a cache must.
 */
function cacheKeyFor(path, hasAuthHeader) {
  return path + (hasAuthHeader ? '|auth' : '|anon');
}

/**
 * This splits on directive boundaries rather than a bare substring regex, for two reasons -
 * `no-cache` (a real RFC 9111 directive
 * meaning "do not reuse without revalidating", which this client cannot do and so must
 * treat as "do not reuse at all") was ignored entirely, and a raw `/max-age=(\d+)/` risks
 * matching a same-suffixed but distinct directive (`s-maxage`, a shared-cache-only
 * directive this client must not honour) if one is ever added to a response here. Splitting
 * on `,` and matching each trimmed directive exactly rules both out by construction rather
 * than by hoping no header ever adds one.
 */
function cacheMaxAgeMs(res) {
  const header = res.headers.get('cache-control') || '';
  const directives = header.split(',').map((d) => d.trim().toLowerCase());
  if (directives.includes('no-store') || directives.includes('no-cache')) return 0;
  for (const d of directives) {
    const m = /^max-age=(\d+)$/.exec(d);
    if (m) return Number(m[1]) * 1000;
  }
  return 0;
}

async function req(method, path, body, auth = true, idempotencyKey, bypassCache = false) {
  const hasAuthHeader = auth && !!sessionToken;
  const cacheKey = cacheKeyFor(path, hasAuthHeader);
  if (method === 'GET' && !bypassCache) {
    const cached = originCache.get(cacheKey);
    // Returning the cached body BY REFERENCE would be a bug - a caller that
    // mutates the object it gets back (a common pattern: patch one field, re-render) would
    // corrupt every later cache hit for the same key. `structuredClone` (Node 17+, already
    // relied on for `crypto.randomUUID` elsewhere in this file) hands each caller its own copy.
    if (cached && cached.expiresAt > Date.now()) return structuredClone(cached.body);
  }
  const headers = { 'Content-Type': 'application/json' };
  if (hasAuthHeader) headers['Authorization'] = 'Bearer ' + sessionToken;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    // A blackholed host must not hang the footer poll (or enterApp) forever.
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  if (method === 'GET') {
    const ttl = cacheMaxAgeMs(res);
    if (ttl > 0) originCache.set(cacheKey, { body: data, expiresAt: Date.now() + ttl });
    else originCache.delete(cacheKey);
  }
  return data;
}

module.exports = {
  getToken,

  // --- Auth ---
  async loginWithMicrosoft(mcToken) {
    const s = await req('POST', '/auth/microsoft', { token: mcToken }, false);
    sessionToken = s.token;
    return s;
  },
  async loginWithCode(code) {
    const s = await req('POST', '/auth/link', { code }, false);
    sessionToken = s.token;
    return s;
  },
  async logout() {
    if (sessionToken) { try { await req('POST', '/auth/logout'); } catch (_) {} }
    sessionToken = null;
  },

  // --- Reads ---
  // `bypassCache` (default false) skips reading `originCache` for this
  // one call, but still writes it on a fresh response, so a caller with its own freshness
  // promise to keep (the footer's 5 s heartbeat, in `renderer/app.js`'s `startFooter`) can ask
  // for one without turning off the cache for every other caller of `realm()` (`enterApp`,
  // which has no such promise and benefits from the origin cache same as before).
  realm: (bypassCache) => req('GET', '/realm', null, false, undefined, bypassCache),
  news: () => req('GET', '/news', null, false),
  patchnotes: () => req('GET', '/patchnotes', null, false),
  // Stratum id -> display name, for the Play page's stratum tag (C6-fix1). Public: no
  // session needed to know a stratum's name.
  strata: () => req('GET', '/public/strata', null, false),
  // One round trip that returns character + guild + friends + realm. Used on first load
  // so a launcher on a machine that has never seen this account still shows everything.
  bootstrap: () => req('GET', '/me/bootstrap'),
  me: () => req('GET', '/me'),
  guild: () => req('GET', '/me/guild'),
  friends: () => req('GET', '/me/friends'),
  instances: () => req('GET', '/me/instances'),

  // --- Writes ---
  // A one-time Discord link code. Requested here rather than in game on purpose: with
  // the closed beta whitelist on, a new player cannot join the server, so an in-game
  // command could never be their first step. The Microsoft sign-in behind this session
  // is stronger proof of the account anyway.
  discordCode: () => req('POST', '/me/discord-code'),
  // `key` is optional on every write below (none moves items or coins - API.md's
  // Idempotency-Key table), threaded through so a caller that wants one stable across its
  // own retries can supply it, same shape a future slot-switch/mail call here would need to
  // use since those DO require one. Nothing calls these with a key today.
  friendRequest: (name, key) => req('POST', '/me/friends/request', { name }, true, key),
  friendAccept: (name, key) => req('POST', '/me/friends/accept', { name }, true, key),
  friendDecline: (name, key) => req('POST', '/me/friends/decline', { name }, true, key),
  friendRemove: (name, key) => req('POST', '/me/friends/remove', { name }, true, key),
  guildInvite: (name, key) => req('POST', '/me/guild/invite', { name }, true, key),
  guildPromote: (uuid, key) => req('POST', '/me/guild/promote', { uuid }, true, key),
  guildDemote: (uuid, key) => req('POST', '/me/guild/demote', { uuid }, true, key),
  guildKick: (uuid, key) => req('POST', '/me/guild/kick', { uuid }, true, key),
  newIdempotencyKey,

  // Test-only seams (api.test.js). Not part of the launcher's own call surface.
  _test: { req, cacheMaxAgeMs, originCache, cacheKeyFor },
};
