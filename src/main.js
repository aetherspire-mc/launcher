'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const msauth = require('./auth/msauth');
const api = require('./api');
const game = require('./game/launch');
const { cookieRemovalUrl } = require('./cookie-url');

let win = null;
/** The Microsoft auth result (mcToken/uuid/name) needed to launch the game. */
let mcAuth = null;
/** When mcAuth was obtained — the Minecraft token lives ~24h, so launch re-checks age. */
let mcAuthAt = 0;
/** True from the launch click until the game closes or errors — blocks a second launch. */
let launching = false;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_) {
    return { maxMemory: '4G', minMemory: '2G', javaPath: '' };
  }
}
function writeSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); } catch (_) {}
}

// --- Remembered sign-in -------------------------------------------------------------
// The Microsoft refresh token is the one long-lived secret the launcher holds, so it is
// encrypted with the OS keychain (safeStorage: Keychain on macOS, DPAPI on Windows,
// libsecret on Linux) and written to the user-data directory. If the OS has no keychain
// available we simply do not remember the session — a plaintext token on disk is not an
// acceptable trade for skipping one sign-in.
function authPath() {
  return path.join(app.getPath('userData'), 'auth.bin');
}

function saveRemembered(auth) {
  if (!auth || !auth.msRefreshToken) return;
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const blob = JSON.stringify({
      msRefreshToken: auth.msRefreshToken,
      uuid: auth.uuid,
      name: auth.name,
      savedAt: Date.now(),
    });
    fs.writeFileSync(authPath(), safeStorage.encryptString(blob), { mode: 0o600 });
  } catch (_) {
    // never let a storage problem break sign-in
  }
}

function readRemembered() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = fs.readFileSync(authPath());
    return JSON.parse(safeStorage.decryptString(buf));
  } catch (_) {
    return null;
  }
}

function clearRemembered() {
  try { fs.unlinkSync(authPath()); } catch (_) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 640,
    frame: false,
    backgroundColor: '#070b17',
    // Windows and Linux read the window icon at runtime; macOS takes it from the bundle.
    icon: path.join(__dirname, '..', 'assets',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // This window renders exactly one document: the local index.html loaded below. Anything
  // that would take it somewhere else — a stray <a href="http://…">, an injected
  // location.href, window.open — is a bug at best and, since this renderer can call the
  // privileged IPC bridge, a way to point that bridge at attacker content at worst. Say so
  // rather than relying on nothing having tried yet.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/**
 * A launcher that talks cleartext to a remote host hands an on-path attacker the session
 * token, the update feed AND the mod jars — that is code execution, not eavesdropping.
 * Loopback is exempt because local dev is loopback; everything else must be https.
 */
function assertTransportSecurity() {
  for (const url of [config.API_BASE, config.UPDATE_URL]) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error('bad endpoint URL: ' + url); }
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
        || u.hostname === '::1';
    if (u.protocol !== 'https:' && !local) {
      throw new Error('refusing cleartext endpoint ' + url
          + ' — a remote realm must be reached over https');
    }
  }
}

app.whenReady().then(() => {
  try {
    assertTransportSecurity();
  } catch (e) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Aetherspire Launcher', e.message);
    app.quit();
    return;
  }
  createWindow();
  setupAutoUpdate();
});
app.on('window-all-closed', () => app.quit());

// --- Auto-update (packaged builds only; `npm start` dev runs skip it) ---
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.setFeedURL({ provider: 'generic', url: config.UPDATE_URL });
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', (info) => {
      if (win) win.webContents.send('update-ready', info.version);
    });
    ipcMain.on('install-update', () => autoUpdater.quitAndInstall());
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, 30 * 60 * 1000);
  } catch (e) {
    // Never let a broken update feed keep the launcher from starting.
  }
}

// --- Window controls ---
ipcMain.on('window-min', () => win && win.minimize());
ipcMain.on('window-close', () => win && win.close());

// --- Config & settings ---
ipcMain.handle('get-config', () => ({
  server: `${config.SERVER_HOST}:${config.SERVER_PORT}`,
  mcVersion: config.MC_VERSION,
  instanceDir: config.INSTANCE_DIR,
  apiBase: config.API_BASE,
  version: app.getVersion(),
}));
ipcMain.handle('get-settings', () => readSettings());
ipcMain.handle('set-settings', (_e, s) => { writeSettings(s); return true; });
ipcMain.handle('open-instance', async () => {
  try { fs.mkdirSync(config.INSTANCE_DIR, { recursive: true }); } catch (_) {}
  return shell.openPath(config.INSTANCE_DIR);
});
ipcMain.handle('detect-java', () => {
  const p = game.findJava(21);
  return p ? { path: p, major: game.javaMajor(p) } : null;
});
// Avatar services go down (crafatar has been 500ing), and a missing face makes the whole
// launcher look broken — so try them in turn and cache whatever answers.
/**
 * Third-party head services, used only if Mojang itself cannot be reached. They are
 * genuinely unreliable: mc-heads served a valid account a Steve head with a 200 OK — so
 * "the request worked" is not evidence the head is real, and the loop below cannot tell
 * the difference. Mojang is the source of truth; these are the safety net.
 */
const SKIN_SOURCES = [
  (id) => `https://minotar.net/helm/${id}/64.png`,
  (id) => `https://mc-heads.net/avatar/${id}/64`,
  (id) => `https://crafatar.com/avatars/${id}?size=64&overlay`,
];
const skinCache = new Map();

/**
 * Crops the head out of a Minecraft skin and scales it up, hat layer composited on top.
 * The head is at (8,8) and the hat at (40,8) in every skin format, old 64x32 included.
 * Nearest-neighbour on purpose: an 8x8 face smoothed by a normal resize turns to mush.
 */
function headFromSkin(pngBuffer, size) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(pngBuffer);
  const { width, height } = img.getSize();
  if (width < 64 || height < 32) return null;
  const src = img.toBitmap();               // BGRA, row-major
  const at = (x, y) => (y * width + x) * 4;
  const out = Buffer.alloc(size * size * 4);
  const scale = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor(x / scale);
      const sy = Math.floor(y / scale);
      let i = at(8 + sx, 8 + sy);           // face
      const h = at(40 + sx, 8 + sy);        // hat, drawn over it where opaque
      if (src[h + 3] > 128) i = h;
      const o = (y * size + x) * 4;
      out[o] = src[i];
      out[o + 1] = src[i + 1];
      out[o + 2] = src[i + 2];
      out[o + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(out, { width: size, height: size }).toPNG();
}

/** The skin URL Mojang has on file for this account, or null. */
async function mojangSkinUrl(uuid) {
  const res = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
      { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const profile = await res.json();
  for (const prop of profile.properties || []) {
    const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
    const skin = decoded.textures && decoded.textures.SKIN;
    // Mojang still hands these out as http; ask for the same file over TLS.
    if (skin && skin.url) return String(skin.url).replace(/^http:/, 'https:');
  }
  return null;
}

ipcMain.handle('skin-head', async (_e, uuid) => {
  const clean = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null;
  if (skinCache.has(clean)) return skinCache.get(clean);

  // Mojang first: it is authoritative, and it is the only source that cannot quietly
  // hand back a placeholder for an account that does have a skin.
  try {
    const url = await mojangSkinUrl(clean);
    if (url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const head = headFromSkin(Buffer.from(await res.arrayBuffer()), 64);
        if (head && head.length > 64) {
          const uri = 'data:image/png;base64,' + head.toString('base64');
          skinCache.set(clean, uri);
          return uri;
        }
      }
    }
  } catch (_) {
    // fall through to the mirrors
  }

  for (const source of SKIN_SOURCES) {
    try {
      const res = await fetch(source(clean), { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64) continue; // an error page, not a skin
      const uri = 'data:image/png;base64,' + buf.toString('base64');
      skinCache.set(clean, uri);
      return uri;
    } catch (_) {
      // try the next source
    }
  }
  return null;
});

/**
 * The guild crest, decoded for the renderer. The API hands out the same deflated ARGB
 * payload the game client uses; zlib lives in the main process, so the decode happens here
 * and the renderer just paints 1024 pixels onto a canvas.
 */
let emblemCached = null;

ipcMain.handle('guild-emblem', async () => {
  try {
    const guild = await api.guild();
    if (!guild || !guild.emblem) return emblemCached; // keep the last good crest
    const packed = Buffer.from(guild.emblem, 'base64');
    const raw = require('zlib').inflateSync(packed);
    if (raw.length !== 32 * 32 * 4) return null;
    const pixels = new Array(32 * 32);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = [raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3], raw[i * 4]]; // r,g,b,a
    }
    emblemCached = { size: 32, pixels, version: guild.emblemVersion || 0 };
    return emblemCached;
  } catch (_) {
    // A hiccup on the guild endpoint must not blank a crest the launcher already has.
    return emblemCached;
  }
});

// --- Auth ---
/** Opens a Microsoft login window and resolves with the OAuth authorization code. */
function captureAuthCode(clientId) {
  return new Promise((resolve, reject) => {
    const authWin = new BrowserWindow({
      width: 520, height: 640, parent: win, modal: true, autoHideMenuBar: true,
      title: 'Sign in with Microsoft',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } try { authWin.close(); } catch (_) {} };

    const handle = (url) => {
      if (!url.startsWith(config.REDIRECT_URI)) return;
      const u = new URL(url);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (code) finish(resolve, code);
      else finish(reject, new Error(err || 'sign-in cancelled'));
    };
    authWin.webContents.on('will-redirect', (_e, url) => handle(url));
    authWin.webContents.on('will-navigate', (_e, url) => handle(url));
    authWin.on('closed', () => { if (!settled) { settled = true; reject(new Error('window closed')); } });

    authWin.loadURL(msauth.buildAuthUrl(clientId, config.REDIRECT_URI, config.OAUTH_SCOPE));
  });
}

function clientId() {
  const settings = readSettings();
  return (settings.azureClientId || '').trim() || config.AZURE_CLIENT_ID;
}

ipcMain.handle('ms-signin', async () => {
  const id = clientId();
  const code = await captureAuthCode(id);
  mcAuth = await msauth.completeLogin(code, id, config.REDIRECT_URI, config.OAUTH_SCOPE);
  mcAuthAt = Date.now();
  emblemCached = null; // a different account may be signing in — no borrowed crests
  const s = await api.loginWithMicrosoft(mcAuth.mcToken);
  if (readSettings().rememberMe !== false) saveRemembered(mcAuth);
  return s; // { token, uuid, name, expiresAt }
});

/**
 * Whether a remembered account exists, and whose — the renderer shows "Continue as <name>"
 * while the silent sign-in runs instead of a blank login screen.
 */
ipcMain.handle('remembered-account', async () => {
  const r = readRemembered();
  return r ? { name: r.name, uuid: r.uuid } : null;
});

/**
 * Silent sign-in with the stored refresh token. Returns the API session on success, null
 * when nothing is remembered. A stale or revoked token clears the store and throws, so the
 * renderer falls back to the normal Microsoft button.
 */
ipcMain.handle('resume-signin', async () => {
  const remembered = readRemembered();
  if (!remembered || !remembered.msRefreshToken) return null;
  try {
    mcAuth = await msauth.loginWithRefreshToken(
      remembered.msRefreshToken, clientId(), config.REDIRECT_URI, config.OAUTH_SCOPE);
    mcAuthAt = Date.now();
    emblemCached = null;
    const s = await api.loginWithMicrosoft(mcAuth.mcToken);
    saveRemembered(mcAuth); // Microsoft rotates refresh tokens — keep the newest
    return s;
  } catch (e) {
    clearRemembered();
    mcAuth = null;
    throw e;
  }
});

ipcMain.handle('login-code', async (_e, code) => {
  // Link-code login lets the launcher VIEW data in dev/offline; launching still needs
  // Microsoft sign-in (Minecraft requires a real account token to start).
  return api.loginWithCode(code);
});

/** Forgets the stored Microsoft session without ending the current one. */
ipcMain.handle('forget-account', async () => { clearRemembered(); return true; });

/**
 * Clears the Microsoft login cookies from the persistent (default) Electron session that
 * the sign-in window (captureAuthCode) uses. Without this, login.live.com stays signed in
 * inside that window's session forever: a player whose Microsoft account owns no Minecraft
 * would click "Sign in with Microsoft" again and silently land back on the same account
 * with no account picker, unable to switch. Best-effort — a missing cookie API failure must
 * never block sign-out.
 */
async function clearMicrosoftLoginCookies() {
  try {
    const ses = session.defaultSession;
    const cookies = await ses.cookies.get({ domain: 'live.com' });
    await Promise.all(cookies.map((c) => ses.cookies.remove(cookieRemovalUrl(c), c.name).catch(() => {})));
  } catch (_) {
    // best effort
  }
}

/**
 * One sign-out path for both the account view's "Sign out" button and the "Sign out and use
 * another account" action shown on a post-Microsoft-sign-in error: forgets the remembered
 * refresh token, clears the Microsoft login cookies (see clearMicrosoftLoginCookies), and
 * ends the Aetherspire API session. The renderer returns to the sign-in screen either way.
 */
ipcMain.handle('logout', async () => {
  mcAuth = null;
  mcAuthAt = 0;
  emblemCached = null; // the next account must not inherit this guild's crest
  clearRemembered();
  await clearMicrosoftLoginCookies();
  await api.logout();
  return true;
});

// --- Generic API passthrough for renderer (whitelisted fns) ---
const API_FNS = new Set([
  'bootstrap', 'realm', 'me', 'guild', 'friends', 'instances', 'news', 'patchnotes',
  'discordCode',
  'friendRequest', 'friendAccept', 'friendDecline', 'friendRemove',
  'guildInvite', 'guildPromote', 'guildDemote', 'guildKick',
]);
ipcMain.handle('api', async (_e, fn, ...args) => {
  if (!API_FNS.has(fn)) throw new Error('unknown api fn: ' + fn);
  return api[fn](...args);
});

// --- Launch ---
ipcMain.handle('launch', async () => {
  if (!mcAuth) throw new Error('Sign in with Microsoft before launching.');
  if (launching) throw new Error('Already launching.');
  launching = true;
  // The Minecraft token lives about a day. A launcher left open overnight would hand the
  // game a dead token (multiplayer auth then fails in-game) — refresh silently first.
  if (Date.now() - mcAuthAt > 23 * 60 * 60 * 1000) {
    const remembered = readRemembered();
    if (remembered && remembered.msRefreshToken) {
      try {
        mcAuth = await msauth.loginWithRefreshToken(
          remembered.msRefreshToken, clientId(), config.REDIRECT_URI, config.OAUTH_SCOPE);
        mcAuthAt = Date.now();
        await api.loginWithMicrosoft(mcAuth.mcToken);
        saveRemembered(mcAuth);
      } catch (_) {
        // Launch with what we have; worst case the game asks for a fresh sign-in.
      }
    }
  }
  const settings = readSettings();
  const emit = (evt) => {
    if (evt.type === 'close' || evt.type === 'error') launching = false;
    if (win) win.webContents.send('launch-event', evt);
  };
  // Pack install/verify happens inside launch(); surface failures instead of losing them.
  game.launch(mcAuth, settings, emit).catch((e) => emit({ type: 'error', data: String(e.message || e) }));
  return true;
});
