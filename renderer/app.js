'use strict';
const A = window.aether;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const titdle = (s) => { s = String(s || '').toLowerCase(); return s ? s[0].toUpperCase() + s.slice(1) : ''; };

let me = null;
let cfg = null;
let footerTimer = null;

/**
 * Sets the login screen's error text and shows/hides the "Sign out and use another account"
 * action beneath it. That action is needed whenever the error follows a Microsoft sign-in
 * attempt (device/account picked, then something after it failed) — without it, a player
 * whose Microsoft account owns no Minecraft (or whose sign-in fails any other way after
 * picking an account) has no way to switch accounts and try again.
 */
function showLoginError(msg, withSignOut) {
  $('login-error').textContent = msg;
  $('btn-login-signout').classList.toggle('hidden', !withSignOut);
}

/**
 * Everything the account owns, as the server sees it. Filled by one /me/bootstrap call
 * right after sign-in, so a launcher started on a machine that has never seen this
 * account shows the same character, friends and guild as any other machine. Nothing here
 * is persisted locally — the server is the only source of truth.
 */
const state = { player: null, guild: null, friends: null, realm: null, fetchedAt: 0 };

/**
 * Re-pulls one slice in the background and repaints only if it actually changed. Repainting
 * unconditionally replaces the DOM — including the emblem canvas — on every visit.
 */
async function revalidate(slice, render) {
  const before = JSON.stringify(state[slice] ?? null);
  try { await refresh(slice); } catch (_) { return; }
  if (currentView === slice && JSON.stringify(state[slice] ?? null) !== before) render();
}

/** Re-pulls one slice (or all of it) from the server and repaints the current view. */
async function refresh(what = 'all') {
  if (what === 'all') {
    const b = await A.api('bootstrap');
    state.player = b.player; state.guild = b.guild;
    state.friends = b.friends; state.realm = b.realm;
    state.fetchedAt = b.fetchedAt || Date.now();
    me = b.player;
    return;
  }
  if (what === 'friends') state.friends = await A.api('friends');
  if (what === 'guild') state.guild = await A.api('guild');
  if (what === 'player') { state.player = await A.api('me'); me = state.player; }
}

if (!A) {
  document.body.innerHTML =
    '<div style="padding:40px;font-family:sans-serif;color:#93a4c4">This is the Aetherspire launcher UI. Run it with <b style="color:#e8eefc">npm start</b> (Electron).</div>';
} else {
  init();
}

async function init() {
  cfg = await A.getConfig();
  $('app-version').textContent = 'v' + (cfg.version || '0.1.0');
  $('btn-min').onclick = () => A.minimize();
  $('btn-close').onclick = () => A.close();
  $('btn-ms').onclick = signInMicrosoft;
  $('btn-code').onclick = signInCode;
  $('btn-signout').onclick = signOut;
  $('btn-login-signout').onclick = async () => { await signOut(); showLoginError('', false); };

  document.querySelectorAll('.nav-item').forEach((b) => (b.onclick = () => selectView(b.dataset.view)));

  // Auto-update: when a new launcher version is downloaded, offer a one-click restart.
  A.onUpdateReady((version) => {
    let btn = $('update-ready');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'update-ready';
      btn.className = 'btn-primary update-ready';
      btn.onclick = () => A.installUpdate();
      document.querySelector('.side-foot')?.prepend(btn);
    }
    btn.textContent = `Update v${version} ready — Restart`;
  });

  // Remembered account: sign back in with the stored Microsoft refresh token instead of
  // showing the login screen. Falls back to it if the token is gone or was rejected.
  await resumeSignIn();
}

// --- Auth ---
async function resumeSignIn() {
  let remembered = null;
  try { remembered = await A.rememberedAccount(); } catch (_) {}
  if (!remembered) return;
  $('signin-actions').classList.add('hidden');
  $('signing').classList.remove('hidden');
  $('signing-msg').textContent = 'Signing in as ' + remembered.name + '…';
  try {
    const session = await A.resumeSignIn();
    if (session) { await enterApp(); return; }
  } catch (e) {
    showLoginError('Session expired — sign in again.', true);
  } finally {
    $('signing').classList.add('hidden');
    $('signin-actions').classList.remove('hidden');
  }
}

async function signInMicrosoft() {
  showLoginError('', false);
  $('signin-actions').classList.add('hidden');
  $('signing').classList.remove('hidden');
  $('signing-msg').textContent = 'Waiting for Microsoft…';
  try {
    await A.msSignIn();
    $('signing-msg').textContent = 'Loading your character…';
    await enterApp();
  } catch (e) {
    // Everything caught here happens after an account was picked in the Microsoft window,
    // so the sign-out action is always offered: the login window's session otherwise stays
    // signed in to that same account and the next click would silently reuse it.
    showLoginError('Sign-in failed: ' + e.message, true);
  } finally {
    $('signing').classList.add('hidden');
    $('signin-actions').classList.remove('hidden');
  }
}
async function signInCode() {
  showLoginError('', false);
  const code = ($('code-input').value || '').trim().toUpperCase();
  if (!code) return;
  try { await A.loginCode(code); await enterApp(); }
  catch (e) { showLoginError('Link failed: ' + e.message, false); }
}
async function signOut() {
  if (footerTimer) clearInterval(footerTimer);
  await A.logout(); me = null;
  // Clear the previous account's snapshot: a failed bootstrap after re-login falls back
  // to whatever is in state, and that must never be someone else's guild and friends.
  state.player = null; state.guild = null; state.friends = null; state.realm = null;
  emblemCache = null;
  $('screen-app').classList.add('hidden');
  $('screen-login').classList.remove('hidden');
}

async function enterApp() {
  // One round trip for character + guild + friends + realm. If it fails (older server,
  // network), fall back to the individual endpoints so sign-in still works.
  try {
    await refresh('all');
  } catch (_) {
    me = await A.api('me');
    state.player = me;
    await Promise.all([
      A.api('friends').then((f) => (state.friends = f)).catch(() => {}),
      A.api('guild').then((g) => (state.guild = g)).catch(() => {}),
    ]);
  }
  $('screen-login').classList.add('hidden');
  $('screen-app').classList.remove('hidden');
  renderSidebar();
  loadAvatar();
  startFooter();
  selectView('play');
  renderFriendBadge();
}

async function loadAvatar() {
  try {
    const head = await A.skinHead(me.uuid);
    if (head) {
      const av = document.querySelector('.avatar');
      av.style.backgroundImage = `url("${head}")`;
      av.setAttribute('data-skin', '');
    }
  } catch (_) {}
}

function renderSidebar() {
  $('player-name').textContent = me.name || '—';
  $('player-arch').textContent = me.hasCharacter ? titdle(me.archetype) : 'No character yet';
  $('side-lvl').textContent = me.hasCharacter ? me.level : '1';
  $('side-server').textContent = cfg.server;
  if (me.hasCharacter) {
    $('xp-text').textContent = me.xp.toLocaleString();
    // Progress inside the current level, straight from the server (falls back to the old
    // rough estimate against servers that do not send xpIntoLevel/xpForLevel yet).
    const pct = me.xpForLevel > 0
      ? (me.xpIntoLevel / me.xpForLevel) * 100
      : (me.level % 10) * 10 + 8;
    $('xp-fill').style.width = Math.max(6, Math.min(100, pct)) + '%';
  } else { $('xp-text').textContent = '—'; }
}

function renderFriendBadge() {
  const n = ((state.friends && state.friends.incomingRequests) || []).length;
  const b = $('nav-friends-badge');
  if (!b) return;
  if (n > 0) { b.textContent = n; b.style.display = ''; } else { b.style.display = 'none'; }
}

async function refreshFriendBadge() {
  try { await refresh('friends'); } catch (_) {}
  renderFriendBadge();
}

// --- Footer status bar ---
function startFooter() {
  const paint = async () => {
    let r = {};
    // The origin cache serves /realm for 30 s, but this footer promises a 5 s
    // heartbeat - online count, TPS and the offline dot would go up to 30 s stale while
    // the clock kept implying otherwise. The poll bypasses the cache rather than the
    // interval being relaxed, because the freshness is the point of the footer.
    try { r = await A.api('realm', true); } catch (_) {}
    const online = r.online != null;
    $('footer-bar').innerHTML = `
      <span class="fi"><span class="dot ${online ? 'on' : 'off'}"></span><span class="l">Realm</span><span class="v">${online ? 'online' : 'offline'}</span></span>
      <span class="fi"><span class="l">Players</span><span class="v">${esc(r.online ?? 0)}/${esc(r.max ?? '—')}</span></span>
      <span class="fi"><span class="l">TPS</span><span class="v">${esc(r.tps ?? '—')}</span></span>
      <span class="fi"><span class="l">Pack</span><span class="v">Minecraft ${esc(cfg.mcVersion)}</span></span>
      <span class="clock">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  };
  paint();
  footerTimer = setInterval(paint, 5000);
}

let currentView = 'play';

function selectView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('content').innerHTML = '<div class="muted">Loading…</div>';
  ({ play: viewPlay, news: viewNews, patchnotes: viewPatchnotes,
     friends: viewFriends, guild: viewGuild, settings: viewSettings }[view] || viewPlay)();
}

function ringSvg(pct, label, sub, size = 96) {
  const r = 42, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(1, pct)));
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 96 96">
    <circle cx="48" cy="48" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="9"/>
    <circle cx="48" cy="48" r="${r}" fill="none" stroke="url(#g)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 48 48)"/>
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4c8bf5"/><stop offset="1" stop-color="#8fd0ff"/></linearGradient></defs>
    <text x="48" y="46" text-anchor="middle" fill="#fff" font-family="'Barlow Condensed',sans-serif" font-size="26" font-weight="700">${label}</text>
    <text x="48" y="62" text-anchor="middle" fill="#93a4c4" font-size="10" letter-spacing="1.5">${sub}</text>
  </svg>`;
}

// --- Play ---
// The three tiers, in the order the game presents them. Colours match the in-game tab so
// a raid looks like a raid in both places. No fixed headcount/seat text here any more
// (C6) — Raid's real range is 2-5 headcount-only and Ascension's seats scale with
// headcount (DungeonTier.compositionFor), so both are drawn per instance off the API
// instead of a shape that was pinned to the old fixed-5/fixed-9 numbers.
const TIERS = [
  { key: 'DUNGEON',   label: 'Dungeons',   color: '#7fb2ff' },
  { key: 'RAID',      label: 'Raids',      color: '#e8b45c' },
  { key: 'ASCENSION', label: 'Ascensions', color: '#c4a2f5' },
];
// Seat/headcount math lives in seatshape.js (loaded before this file, see index.html) so
// it is a plain node-testable module rather than logic only readable inside app.js.
const seatShape = SeatShape.seatDots;

// The instance list only ever carries a stratum ID (the API has no stratum-name service
// wired in). The name is joined here instead, off the public strata route, fetched once and
// cached for the life of the page rather than once per Play visit.
let strataNamesCache = null;
async function strataNames() {
  if (strataNamesCache) return strataNamesCache;
  let list = [];
  try { list = (await A.api('strata')).strata || []; } catch (_) { /* fall back to IDs */ }
  strataNamesCache = new Map(list.map((s) => [s.id, s.name]));
  return strataNamesCache;
}

/** What a player has to go and do about a place they have not found. */
function revealHint(reveal) {
  if (reveal === 'GATE') return 'Find its gate in the world';
  if (reveal === 'CLEAR') return 'Clear what feeds it';
  if (reveal === 'QUEST') return 'Attune with a quest';
  return '';
}

/** One tier's card: what you have found and cleared of it, and what is still out there. */
function tierCard(tier, rows, names) {
  const mine = rows.filter((r) => r.tier === tier.key);
  if (!mine.length) return '';
  const found = mine.filter((r) => r.known);
  const cleared = mine.filter((r) => r.clears > 0);
  const pct = mine.length ? cleared.length / mine.length : 0;
  // The tier's headcount range, straight off its own instances rather than a hardcoded
  // number — a bare Raid is 2-5 today, but content can override min/max-players per id.
  const range = SeatShape.headcountRange(mine);
  const lines = mine.map((r) => {
    const right = r.clears > 0 ? `${r.clears}× cleared`
      : !r.known ? revealHint(r.reveal) || 'Undiscovered'
      : r.levelMet ? 'Ready' : `Level ${r.minLevel}`;
    const cls = r.clears > 0 ? 'done' : !r.known ? 'unknown' : r.levelMet ? 'ready' : 'locked';
    const stratumName = (names && names.get(r.stratum)) || `Stratum ${r.stratum ?? 1}`;
    return `<div class="inst ${cls}">
        <span class="strat dim" title="${esc(stratumName)}">S${esc(r.stratum ?? 1)}</span>
        <span class="nm">${esc(r.name)}</span>
        ${seatShape(r)}
        <span class="rt">${esc(right)}</span>
      </div>`;
  }).join('');
  return `<div class="card tiercard" style="--tier:${tier.color}">
      <div class="card-head">
        <span class="tag" style="color:${tier.color}">${tier.label}</span>
        <span class="dim" style="font-size:12px">${range} players</span>
      </div>
      <div class="tierbar"><span style="width:${Math.round(pct * 100)}%"></span></div>
      <div class="dim" style="font-size:12px;margin:6px 0 8px">
        ${found.length} of ${mine.length} found · ${cleared.length} cleared
      </div>
      <div class="insts">${lines}</div>
    </div>`;
}

async function viewPlay() {
  let realm = {};
  try { realm = await A.api('realm'); } catch (_) {}
  // Beta gate. This is COURTESY, NOT SECURITY - the server refuses unwhitelisted players at
  // PreLogin regardless, and a launcher is client-side and editable. The point is that a
  // tester without a redeemed key learns it here, in a page that tells them what to do,
  // instead of watching Minecraft start, connect, and drop them with a kick screen.
  //
  // Only blocks when the realm says enforcement is ON. A launcher that blocked whenever the
  // player was unwhitelisted would lock everyone out of a realm running with the gate off.
  let gate = betaGate((state.player && state.player.beta) || null);
  if (gate.blocked) {
    // Only re-check when we are about to refuse. The cached slice can be minutes old, and
    // being told "no key" right after redeeming one is the moment a working system looks
    // broken. Costs one request, and only on the path that was going to block anyway.
    try { await refresh('player'); gate = betaGate((state.player && state.player.beta) || null); }
    catch (_) { /* keep the cached verdict; the server still decides at login */ }
  }
  // The spire is server truth now. It used to be invented here from the character level,
  // which meant the launcher and the game disagreed about what you had actually done.
  let instances = [];
  try { instances = (await A.api('instances')).instances || []; } catch (_) {}
  const names = await strataNames();
  const lvl = me.hasCharacter ? me.level : 1;
  const clearedCount = instances.filter((r) => r.clears > 0).length;
  const foundPct = instances.length
    ? instances.filter((r) => r.known).length / instances.length : 0;

  $('content').innerHTML = `
    <div class="col-main">
      <div class="card hero">
        <div class="card-head">
          <div><div class="title-xl">AETHER<span>SPIRE</span></div>
            <div class="muted" style="margin-top:6px">Server ${esc(cfg.server)} · Minecraft ${esc(cfg.mcVersion)}</div></div>
          <span class="badge success">Ready</span>
        </div>
        <div class="play-row">
          ${gate.blocked
            ? `<button class="play-btn" id="play" disabled title="${esc(gate.reason)}">
                 <span class="big">Beta key required</span><span class="sub">${esc(gate.reason)}</span></button>`
            : `<button class="play-btn" id="play"><span class="big">Play</span><span class="sub">Aetherspire · ${esc(cfg.mcVersion)}</span></button>`}
          ${ringSvg(foundPct, String(clearedCount), 'cleared')}
        </div>
        ${gate.blocked ? `<div class="field" style="margin-top:12px">
          <span class="fl status-bad">Closed beta</span>
          <span class="muted">${esc(gate.detail)}</span>
        </div>` : ''}
        <div class="actions">
          ${gate.blocked ? '<button class="btn-secondary" id="gotobeta">Beta access</button>' : ''}
          <button class="btn-secondary" id="openfolder">Open install folder</button>
          <button class="btn-secondary btn-ghost" id="relog">Re-sign in</button>
        </div>
        <div class="dl hidden" id="dl">
          <div class="dl-head"><span id="dl-label">Preparing…</span><span id="dl-pct"></span></div>
          <div class="dl-bar"><span id="dl-fill"></span></div>
          <button class="dl-toggle" id="dl-toggle">Details</button>
        </div>
        <div class="log hidden" id="launchlog"></div>
      </div>
      <div class="card" id="news-preview">
        <div class="card-head"><span class="tag">Latest news</span><span class="dim" style="font-size:12px">from the realm</span></div>
        <div class="muted" style="margin-top:8px">Loading…</div>
      </div>
    </div>
    <div class="col-side">
      <div class="card">
        <div class="card-head"><span class="tag">Realm</span><span class="badge ${realm.online != null ? 'success' : 'warn'}">${realm.online != null ? 'Online' : 'Offline'}</span></div>
        <div class="muted" style="margin-bottom:10px">${esc(cfg.server)}</div>
        <div class="tiles">
          <div class="tile"><div class="v">${esc(realm.online ?? 0)}<small> / ${esc(realm.max ?? '—')}</small></div><div class="l">Players</div></div>
          <div class="tile"><div class="v">${esc(realm.tps ?? '—')}</div><div class="l">TPS</div></div>
          <div class="tile"><div class="v">${me.hasCharacter ? esc(me.level) : '—'}</div><div class="l">Your level</div></div>
          <div class="tile"><div class="v">${me.hasCharacter ? esc(me.coins) : '—'}</div><div class="l">Coins</div></div>
        </div>
      </div>
      ${TIERS.map((t) => tierCard(t, instances, names)).join('')
        || '<div class="card"><div class="tag">The spire</div>'
           + '<div class="muted" style="margin-top:8px">Nothing mapped yet.</div></div>'}
      <div class="card" id="friends-preview"><div class="tag">Friends</div><div class="muted" style="margin-top:8px">Loading…</div></div>
    </div>`;

  const log = $('launchlog');
  const bar = { root: $('dl'), label: $('dl-label'), pct: $('dl-pct'), fill: $('dl-fill') };
  const setBar = (label, fraction) => {
    bar.root.classList.remove('hidden');
    bar.label.textContent = label;
    if (fraction == null) { // indeterminate
      bar.pct.textContent = '';
      bar.fill.style.width = '100%';
      bar.fill.classList.add('pulse');
    } else {
      const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
      bar.pct.textContent = pct + '%';
      bar.fill.style.width = pct + '%';
      bar.fill.classList.remove('pulse');
    }
  };
  const hideBar = () => bar.root.classList.add('hidden');
  const logLine = (line) => { log.textContent += line + '\n'; log.scrollTop = log.scrollHeight; };

  if ($('gotobeta')) $('gotobeta').onclick = () => selectView('settings');
  // Nothing below is wired when the gate is closed: the button is disabled, and attaching a
  // launch handler to it anyway is how a disabled control becomes clickable again after some
  // later edit removes the attribute.
  if (gate.blocked) return;

  $('play').onclick = async () => {
    $('play').disabled = true; $('play').querySelector('.big').textContent = 'Launching…';
    log.textContent = '';
    setBar('Preparing…', null);
    try { await A.launch(); } catch (e) { setBar('Error: ' + e.message, 0); resetPlay(); }
  };
  $('openfolder').onclick = () => A.openInstance();
  $('relog').onclick = signOut;
  $('dl-toggle').onclick = () => log.classList.toggle('hidden');

  A.onLaunchEvent((evt) => {
    if (evt.type === 'pack') {
      const d = evt.data || {};
      if (d.step === 'manifest') setBar('Checking pack…', null);
      else if (d.step === 'fabric') setBar('Installing Fabric…', null);
      else if (d.step === 'download') {
        const frac = d.totalBytes ? d.doneBytes / d.totalBytes : null;
        setBar(`Downloading pack (${d.i}/${d.n}) — ${d.detail}`, frac);
      }
      else if (d.step === 'ready') setBar('Pack up to date', 1);
      logLine(`pack: ${d.step}${d.detail ? ' ' + d.detail : ''}`);
    }
    else if (evt.type === 'java') {
      // A 50MB runtime download with no bar is a frozen window, and this is the one step
      // a player never asked for and does not know is happening.
      const d = evt.data || {};
      if (d.step === 'download') {
        const frac = d.total ? d.received / d.total : null;
        setBar('Installing Java 21 (one time)', frac);
      }
      else if (d.step === 'unpack') setBar('Unpacking Java 21…', null);
      else if (d.step === 'ready') setBar('Java 21 ready', 1);
      else if (d.step === 'failed') setBar('Could not install Java: ' + (d.detail || ''), 0);
      logLine(`java: ${d.step}${d.detail ? ' ' + d.detail : ''}`);
    }
    else if (evt.type === 'progress') {
      // minecraft-launcher-core verifies/downloads game files (assets, libraries, natives)
      const p = evt.data || {};
      setBar(`Game files — ${p.type}`, p.total ? p.task / p.total : null);
    }
    else if (evt.type === 'status' && evt.data === 'installing-java') setBar('Looking for Java 21…', null);
    else if (evt.type === 'status' && evt.data === 'launching') setBar('Starting Minecraft…', null);
    else if (evt.type === 'error') { setBar('Error: ' + evt.data, 0); log.classList.remove('hidden'); logLine('ERROR: ' + evt.data); resetPlay(); }
    else if (evt.type === 'data' || evt.type === 'debug') {
      logLine(String(evt.data).trimEnd());
      // First game output = the game is running; the bar's job is done.
      if (evt.type === 'data') hideBar();
    }
    else if (evt.type === 'close') { hideBar(); logLine('Game closed (' + evt.data + ')'); resetPlay(); }
  });
  loadFriendsPreview();
  loadNewsPreview();
}
function resetPlay() { const p = $('play'); if (p) { p.disabled = false; p.querySelector('.big').textContent = 'Play'; } }

async function loadNewsPreview() {
  try {
    const news = await A.api('news');
    const el = $('news-preview'); if (!el) return;
    const latest = (news || [])[0];
    if (!latest) { el.querySelector('.muted').textContent = 'No news yet.'; return; }
    el.innerHTML = `<div class="card-head"><span class="tag">Latest news</span>` +
      `<span class="dim" style="font-size:12px">${esc(latest.date || '')}</span></div>` +
      `<div class="headline">${esc(latest.title || '')}</div>` +
      `<p class="muted" style="margin-top:6px">${esc(latest.body || '')}</p>`;
  } catch (_) {}
}

// --- News & patch notes (server-fed: plugins/Aetherspire/news.json + patchnotes.json) ---
const NEWS_TAGS = { announcement: '#7fb2ff', event: '#e8b45c', maintenance: '#f87171' };

async function viewNews() {
  let news = [];
  try { news = await A.api('news'); } catch (_) {}
  $('content').innerHTML = `
    <div class="col-main">
      <div class="card"><div class="card-head"><span class="tag">News</span>
        <span class="dim" style="font-size:12px">${news.length} article${news.length === 1 ? '' : 's'}</span></div>
        ${news.length ? '' : '<div class="muted" style="margin-top:8px">Nothing posted yet.</div>'}</div>
      ${news.map((a, i) => `
        <div class="card news-item" data-i="${i}">
          <div class="card-head">
            <span class="tag" style="color:${NEWS_TAGS[a.tag] || 'var(--muted)'}">${esc(a.tag || 'news')}</span>
            <span class="dim" style="font-size:12px">${esc(a.date || '')}</span>
          </div>
          <div class="headline" style="cursor:pointer">${esc(a.title || '')}</div>
          <p class="muted news-body ${i === 0 ? '' : 'hidden'}" style="margin-top:6px">${esc(a.body || '')}</p>
        </div>`).join('')}
    </div>`;
  document.querySelectorAll('.news-item .headline').forEach((h) =>
    (h.onclick = () => h.parentElement.querySelector('.news-body').classList.toggle('hidden')));
}

async function viewPatchnotes() {
  let notes = [];
  try { notes = await A.api('patchnotes'); } catch (_) {}
  $('content').innerHTML = `
    <div class="col-main">
      <div class="card"><div class="card-head"><span class="tag">Patch notes</span>
        <span class="dim" style="font-size:12px">${notes.length} release${notes.length === 1 ? '' : 's'}</span></div>
        ${notes.length ? '' : '<div class="muted" style="margin-top:8px">No releases yet.</div>'}</div>
      ${notes.map((r) => `
        <div class="card">
          <div class="card-head">
            <span class="tag" style="color:var(--gold,#e8b45c)">v${esc(r.version || '?')}</span>
            <span class="dim" style="font-size:12px">${esc(r.date || '')}</span>
          </div>
          <div class="headline">${esc(r.title || '')}</div>
          <ul class="muted" style="margin:8px 0 0 18px;display:flex;flex-direction:column;gap:4px">
            ${(r.changes || []).map((c) => `<li>${esc(c)}</li>`).join('')}
          </ul>
        </div>`).join('')}
    </div>`;
}

async function loadFriendsPreview() {
  try {
    if (!state.friends) await refresh('friends');
    const f = state.friends || { friends: [] };
    const el = $('friends-preview'); if (!el) return;
    const rows = (f.friends || []).slice(0, 4);
    el.innerHTML = `<div class="card-head"><span class="tag">Friends</span><span class="dim" style="font-size:12px">${(f.friends || []).filter((x) => x.online).length} online</span></div>` +
      (rows.length ? rows.map((x) => `<div class="list-row"><span class="dot ${x.online ? 'on' : 'off'}"></span><span class="grow">${esc(x.name)}</span><span class="muted">${x.online ? 'online' : 'offline'}</span></div>`).join('')
        : '<div class="muted">No friends yet — add some in the Friends tab.</div>');
  } catch (_) {}
}

// --- Friends ---
async function viewFriends() {
  // Paint what the bootstrap already fetched, then revalidate in the background.
  if (!state.friends) { try { await refresh('friends'); } catch (_) {} }
  else { revalidate('friends', viewFriends); }
  const d = state.friends || { friends: [], incomingRequests: [] };
  d.friends = d.friends || []; d.incomingRequests = d.incomingRequests || [];
  $('content').innerHTML = `<div class="col-main" style="max-width:720px">
    <div class="card"><span class="tag">Add friend</span>
      <div class="row" style="margin-top:10px"><input id="fname" placeholder="Minecraft name"/><button class="btn-primary" id="fadd" style="height:38px;padding:0 18px">Send</button></div></div>
    ${d.incomingRequests.length ? `<div class="card"><span class="tag" style="color:#fbbf24">Requests (${d.incomingRequests.length})</span>${d.incomingRequests.map((n) => `
      <div class="list-row"><span class="grow">${esc(n)}</span><button class="mini" data-accept="${esc(n)}">Accept</button><button class="mini" data-decline="${esc(n)}">Decline</button></div>`).join('')}</div>` : ''}
    <div class="card"><div class="card-head"><span class="tag">Friends</span><span class="dim" style="font-size:12px">${d.friends.filter((x) => x.online).length} online</span></div>
      ${d.friends.length ? d.friends.map((f) => `<div class="list-row"><span class="dot ${f.online ? 'on' : 'off'}"></span><span class="grow">${esc(f.name)}</span><span class="muted">${f.online ? 'online' : 'offline'}</span><button class="mini danger" data-remove="${esc(f.name)}">Remove</button></div>`).join('') : '<div class="muted">No friends yet.</div>'}
    </div></div>`;
  $('fadd').onclick = () => act(() => A.api('friendRequest', $('fname').value.trim()), 'friends');
  bind('accept', (n) => A.api('friendAccept', n), 'friends');
  bind('decline', (n) => A.api('friendDecline', n), 'friends');
  bind('remove', (n) => A.api('friendRemove', n), 'friends');
  refreshFriendBadge();
}

// --- Guild ---
async function viewGuild() {
  if (!state.guild) { try { await refresh('guild'); } catch (_) {} }
  else { revalidate('guild', viewGuild); }
  const g = state.guild || { inGuild: false };
  if (!g.inGuild) { $('content').innerHTML = '<div class="col-main"><div class="card"><span class="tag">Guild</span><div class="muted" style="margin-top:8px">You are not in a guild. Create one in-game with /guild create &lt;name&gt;.</div></div></div>'; return; }
  const canManage = g.yourRank === 'OWNER' || g.yourRank === 'OFFICER';
  $('content').innerHTML = `<div class="col-main" style="max-width:760px">
    <div class="card purple" style="display:flex;align-items:center;gap:18px">
      <canvas id="guild-emblem" width="32" height="32" class="emblem" title="Drawn in game: guild tab -> click the crest"></canvas>
      <div class="grow"><div style="font-family:'Barlow Condensed';font-size:32px;font-weight:700">${esc(g.name)}</div>
        <div class="muted">${g.members.length} members · you are ${esc((g.yourRank || '').toLowerCase())}</div></div>
      <div style="text-align:right"><div class="l" style="font-size:11px;color:#66799c;text-transform:uppercase">Level</div>
        <div style="font-family:'Barlow Condensed';font-size:30px;color:#f3d08a">${esc(g.level)}</div></div>
    </div>
    <div class="card"><span class="tag">Roster</span>
      ${canManage ? `<div class="row" style="margin:10px 0 4px"><input id="ginv" placeholder="Invite by name"/><button class="btn-primary" id="ginvbtn" style="height:38px;padding:0 18px">Invite</button></div>` : ''}
      ${g.members.map((m) => `<div class="list-row"><span class="dot ${m.online ? 'on' : 'off'}"></span><span class="grow">${esc(m.name)}</span><span class="muted">${esc(m.rank)}</span>
        ${canManage && m.rank !== 'OWNER' ? `<button class="mini" data-promote="${esc(m.uuid)}">Promote</button><button class="mini" data-demote="${esc(m.uuid)}">Demote</button><button class="mini danger" data-kick="${esc(m.uuid)}">Kick</button>` : ''}</div>`).join('')}
    </div></div>`;
  paintEmblem();
  const inv = $('ginvbtn'); if (inv) inv.onclick = () => act(() => A.api('guildInvite', $('ginv').value.trim()), 'guild');
  bind('promote', (u) => A.api('guildPromote', u), 'guild');
  bind('demote', (u) => A.api('guildDemote', u), 'guild');
  bind('kick', (u) => A.api('guildKick', u), 'guild');
}

/**
 * Paints the guild crest — the same 32x32 image members draw in game — onto the guild
 * screen. One canvas pixel per emblem pixel, scaled up by CSS with pixelated rendering, so
 * it stays crisp instead of turning into a blur.
 */
/**
 * The last crest we successfully decoded. The guild view re-renders whenever fresh guild
 * data lands, which replaces the canvas element; without this the crest would blink out
 * every time and stay blank whenever the follow-up fetch failed.
 */
let emblemCache = null;

async function paintEmblem() {
  // Paint what we already have first — synchronously, so a repaint never shows a gap.
  if (emblemCache) drawEmblem(emblemCache);
  let emblem = null;
  try { emblem = await A.guildEmblem(); } catch (_) {}
  if (emblem && Array.isArray(emblem.pixels)) {
    emblemCache = emblem;
    drawEmblem(emblem);
  } else if (!emblemCache) {
    drawEmblem(null); // nothing known yet: the plate look, not a black hole
  }
}

function drawEmblem(emblem) {
  const canvas = $('guild-emblem');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 32, 32);
  if (!emblem) {
    ctx.fillStyle = '#182240';
    ctx.fillRect(0, 0, 32, 32);
    return;
  }
  const image = ctx.createImageData(32, 32);
  for (let i = 0; i < emblem.pixels.length; i++) {
    const [r, g, b, a] = emblem.pixels[i];
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = a;
  }
  ctx.putImageData(image, 0, 0);
}

// --- Settings ---
/**
 * Writes `text` to the clipboard and flashes `btn`'s label to confirm it, the same shape as
 * the existing beta-code copy button. Used for the read-only facts (server address, instance
 * folder) a player is asked for when they report a problem - the whole point of a copy
 * button next to a value nobody types by hand.
 */
async function copyValue(btn, text) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch (_) {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = original; }, 1500);
}

async function viewSettings() {
  const s = await A.getSettings();
  // Pull the player slice fresh rather than trusting the cached one: the whole point of
  // the beta card is that the player redeems a key in Discord and comes straight back
  // here to check. A cached "not linked" would be the one answer that makes them think
  // it failed.
  try { await refresh('player'); } catch (_) {}
  const beta = (state.player && state.player.beta) || { available: false };
  const rams = ['2G', '4G', '6G', '8G', '12G'];
  const ramNum = parseInt(s.maxMemory || '4G', 10);
  // Two columns by intent: the left is what a player CHANGES (memory, Java, account); the
  // right is what the install already IS (read-only facts, then beta access below them - an
  // account-linking task, but one that belongs next to the other per-install state rather
  // than the settings a player actually turns knobs on). Both columns must fit in one
  // screen's height with no scroll, so every card here uses `.card.tight`
  // and shorter copy instead of the launcher's normal card padding and paragraph length -
  // see styles.css `.card.tight` for the measured budget this is built against.
  $('content').innerHTML = `<div class="col-main"><div class="set-grid">
    <div class="set-col">
      <div class="card tight">
        <span class="tag">Memory</span>
        <div class="seg" style="margin-top:8px" id="ramseg">${rams.map((r) => `<button data-ram="${r}" class="${s.maxMemory === r ? 'on' : ''}">${r}</button>`).join('')}</div>
        <div class="mem-wrap">${ringSvg(ramNum / 16, String(ramNum), 'GB', 64)}
          <span class="hint">Higher isn't always better — <b>6–8&nbsp;GB</b> suits this pack; past 12&nbsp;GB you gain nothing.</span></div>
      </div>
      <div class="card tight">
        <span class="tag">Java runtime</span>
        <div class="field"><span class="fl">Detected (Minecraft 1.21.4 needs Java 21+)</span><span class="mono" id="java-status">checking…</span></div>
        <div class="field"><span class="fl">Custom path — optional</span>
          <div class="row"><input id="javapath" class="mono" placeholder="…\\bin\\javaw.exe" value="${esc(s.javaPath || '')}"/><button class="btn-secondary" id="javasave">Save</button></div>
          <span class="hint">Leave blank to use the detected Java above.</span></div>
      </div>
      <div class="card tight">
        <span class="tag">Account</span>
        <div class="field"><span class="fl">Stay signed in</span>
          <div class="seg" id="rememberseg">
            <button data-remember="1" class="${s.rememberMe === false ? '' : 'on'}">On</button>
            <button data-remember="0" class="${s.rememberMe === false ? 'on' : ''}">Off</button>
          </div>
          <span class="hint">Keeps your Microsoft session in the system keychain for automatic sign-in. Off (or Sign out) forgets it.</span></div>
      </div>
    </div>
    <div class="set-col set-col-side">
      <div class="card tight">
        <span class="tag">About this install</span>
        <div class="field"><span class="fl">Instance folder</span>
          <div class="row"><input class="mono" value="${esc(cfg.instanceDir)}" title="${esc(cfg.instanceDir)}" readonly/>
            <button class="btn-secondary" id="copy-instance">Copy</button>
            <button class="btn-secondary" id="openfolder2">Open</button></div></div>
        <div class="field"><span class="fl">Server</span>
          <div class="row"><span class="mono grow" title="${esc(cfg.server)}">${esc(cfg.server)}</span>
            <button class="btn-secondary" id="copy-server">Copy</button></div></div>
        <div class="field"><span class="fl">Minecraft</span><span class="mono" title="${esc(cfg.mcVersion)}">${esc(cfg.mcVersion)}</span></div>
        <div class="field"><span class="fl">API</span><span class="mono" title="${esc(cfg.apiBase)}">${esc(cfg.apiBase)}</span></div>
      </div>
      ${betaCard(beta)}
    </div>
  </div></div>`;

  $('content').querySelectorAll('#ramseg button').forEach((b) => (b.onclick = async () => {
    const cur = await A.getSettings(); cur.maxMemory = b.dataset.ram; await A.setSettings(cur);
    selectView('settings');
  }));
  $('content').querySelectorAll('#rememberseg button').forEach((b) => (b.onclick = async () => {
    const cur = await A.getSettings();
    cur.rememberMe = b.dataset.remember === '1';
    await A.setSettings(cur);
    // Turning it off must also drop what is already stored.
    if (!cur.rememberMe) await A.forgetAccount();
    selectView('settings');
  }));
  $('openfolder2').onclick = () => A.openInstance();
  $('copy-instance').onclick = () => copyValue($('copy-instance'), cfg.instanceDir);
  $('copy-server').onclick = () => copyValue($('copy-server'), cfg.server);
  $('javasave').onclick = async () => {
    const cur = await A.getSettings(); cur.javaPath = ($('javapath').value || '').trim();
    await A.setSettings(cur); selectView('settings');
  };
  const linkBtn = $('beta-link');
  if (linkBtn) linkBtn.onclick = async () => {
    linkBtn.disabled = true;
    linkBtn.textContent = 'Requesting…';
    try {
      const r = await A.api('discordCode');
      showDiscordCode(r);
    } catch (e) {
      const box = $('beta-code-box');
      if (box) box.innerHTML = `<span class="status-bad">${esc(String(e.message || e)
        .replace(/^Error invoking remote method '[^']*': (Error: )?/, ''))}</span>`;
      linkBtn.disabled = false;
      linkBtn.textContent = 'Try again';
    }
  };

  A.detectJava().then((j) => {
    const el = $('java-status'); if (!el) return;
    // A detected path is arbitrarily long (200+ characters is not unusual under Program
    // Files with a vendor name in it). The CSS on `.field span.mono` is the actual
    // containment guarantee at any width; the middle-ellipsis here is what keeps the
    // filename (javaw.exe) visible instead of just the drive letter, which an end-ellipsis
    // alone would have thrown away. `title` always carries the untruncated path.
    const full = j ? `Java ${j.major} — ${j.path}` : 'No Java 21+ found — install Temurin JDK 21 (adoptium.net)';
    el.textContent = j ? `Java ${j.major} — ${TextFit.middleEllipsis(j.path, 56)}` : full;
    el.title = full;
    el.className = 'mono ' + (j ? 'status-ok' : 'status-bad');
  });
}

/**
 * Whether the launcher should refuse to start the game.
 *
 * Deliberately conservative: it blocks ONLY when the realm reports the gate enforced AND
 * says this player is not admitted. Anything else - no beta section at all (an older
 * server), the service unavailable, enforcement off, or a state this build does not
 * recognise - lets the player through and leaves the decision to the server, which is the
 * only place it is actually made. A launcher that guessed would lock people out of a realm
 * that would have admitted them, and that failure is invisible from the server side.
 */
function betaGate(beta) {
  const open = { blocked: false, reason: '', detail: '' };
  if (!beta || !beta.available || !beta.enforced) return open;
  if (beta.admission === 'ALLOWED') return open;
  if (beta.admission === 'NO_KEY') {
    return { blocked: true,
      reason: 'No beta key redeemed',
      detail: 'Your Discord account is linked, but no key has been redeemed yet. '
            + 'Run /redeem <key> in Discord, then reopen this page.' };
  }
  if (beta.admission === 'NOT_LINKED') {
    return { blocked: true,
      reason: 'Discord not linked',
      detail: 'Aetherspire is in closed beta. Open Beta access, link your Discord account, '
            + 'then redeem your key in Discord.' };
  }
  // An admission value this build predates. The server will refuse if it means to.
  return open;
}

/**
 * The closed-beta card. Four states, because "not whitelisted" on its own tells a player
 * nothing they can act on - the same reason the kick message has three variants.
 */
function betaCard(beta) {
  if (!beta.available) return '';
  const admission = beta.admission || 'NOT_LINKED';
  const linkedAs = beta.discordId
    ? `<div class="field"><span class="fl">Discord</span><span class="mono status-ok">linked (${esc(beta.discordId)})</span></div>`
    : '';

  let body;
  if (admission === 'ALLOWED') {
    body = `<div class="field"><span class="fl">Status</span><span class="mono status-ok">access granted</span></div>
      ${linkedAs}
      <span class="hint">You can join the realm.${beta.enforced ? '' : ' The beta gate is currently off, so this is not what is letting you in.'}</span>
      <div class="row" style="margin-top:8px"><button class="btn-secondary btn-full" id="beta-link">Link a different Discord account</button></div>`;
  } else if (admission === 'NO_KEY') {
    body = `<div class="field"><span class="fl">Status</span><span class="mono status-bad">no key redeemed</span></div>
      ${linkedAs}
      <span class="hint">Discord is linked. Run <b>/redeem &lt;key&gt;</b> in Discord, then reopen this page - it re-checks every time.</span>
      <div class="row" style="margin-top:8px"><button class="btn-secondary btn-full" id="beta-link">Link a different Discord account</button></div>`;
  } else {
    body = `<div class="field"><span class="fl">Status</span><span class="mono status-bad">not linked</span></div>
      <span class="hint">Aetherspire is in closed beta — press the button, then run
      <b>/link &lt;code&gt;</b> and <b>/redeem &lt;key&gt;</b> in Discord.</span>
      <div class="row" style="margin-top:8px"><button class="btn-secondary btn-full" id="beta-link">Link Discord</button></div>`;
  }

  return `<div class="card tight">
    <span class="tag">Beta access</span>
    ${body}
    <div id="beta-code-box" style="margin-top:8px"></div>
  </div>`;
}

// One timer at a time. The view is rebuilt on every visit, so a stale interval would be
// writing into a detached node - it clears itself when its element is gone.
let betaTimer = null;

function showDiscordCode(r) {
  const box = $('beta-code-box');
  if (!box) return;
  const code = String(r.code || '');
  let left = Number(r.expiresInSeconds || 600);

  // The field holds the CODE ALONE, with "/link" as a label beside it rather than inside
  // it. It used to hold "/link CODE", and both the copy button and a manual select then
  // handed the player the whole string - which they pasted into the command's option, where
  // the slash, the space and the letters in "link" are outside the code alphabet. The bot
  // told them to check their typing. They had typed nothing; they pasted exactly what was
  // shown. Anything a copy button produces has to be the value, never the instruction.
  box.innerHTML = `<div class="field"><span class="fl">In Discord, run <b>/link</b> and paste this</span></div>
    <div class="row">
      <input class="mono" id="beta-code" readonly value="${esc(code)}" style="font-size:16px;letter-spacing:2px"/>
      <button class="btn-secondary" id="beta-copy">Copy</button>
    </div>
    <span class="muted">Expires in <b id="beta-left">--:--</b>. One use. Generating a new code
    replaces this one.</span>`;

  $('beta-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      $('beta-copy').textContent = 'Copied';
    } catch (_) {
      // Clipboard can be refused; selecting the field is always available - and the field
      // now contains only the code, so a manual copy is correct too.
      $('beta-code').select();
      $('beta-copy').textContent = 'Select & copy';
    }
  };

  if (betaTimer) clearInterval(betaTimer);
  const tick = () => {
    const el = $('beta-left');
    if (!el) { clearInterval(betaTimer); betaTimer = null; return; }
    if (left <= 0) {
      clearInterval(betaTimer); betaTimer = null;
      el.parentElement.innerHTML = '<span class="status-bad">This code expired. Press Link Discord for a new one.</span>';
      const b = $('beta-link');
      if (b) { b.disabled = false; b.textContent = 'Link Discord'; }
      return;
    }
    el.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    left -= 1;
  };
  tick();
  betaTimer = setInterval(tick, 1000);
}

// --- helpers ---
function bind(attr, fn, view) {
  document.querySelectorAll(`[data-${attr}]`).forEach((b) =>
    (b.onclick = () => act(() => fn(b.getAttribute('data-' + attr)), view)));
}
async function act(fn, view) {
  // Electron prefixes IPC errors with "Error invoking remote method 'api': " — noise.
  try { await fn(); } catch (e) {
    alert(String(e.message || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
  }
  // A write just changed server state — pull that slice again before repainting, so the
  // view never shows the pre-write snapshot.
  try { await refresh(view); } catch (_) {}
  selectView(view);
}
