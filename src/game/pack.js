'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { API_BASE, INSTANCE_DIR, SERVER_HOST, SERVER_PORT } = require('../config');
const api = require('../api');

/**
 * Pack install/verify — the launcher's "locked client" pipeline. Before every launch:
 *
 *  1. Fetch the server's pack manifest (GET /api/v1/pack): Minecraft + Fabric loader
 *     versions and every file (mods / resourcepacks / config) with SHA-256 hashes.
 *  2. Install the Fabric loader version JSON (from meta.fabricmc.net) into
 *     INSTANCE_DIR/versions — minecraft-launcher-core resolves its libraries on launch.
 *  3. Download every manifest file that is missing or fails its hash; verify after download.
 *  4. Prune mods that are NOT in the manifest (it's a locked client — the mods folder is
 *     exactly the manifest, nothing else).
 *  5. Make sure the lock mod's config allows the realm host, and the resource pack is
 *     enabled in options.txt.
 *
 * Returns { versionName, manifest } — versionName is the custom version for the launcher.
 */

const API_ORIGIN = new URL(API_BASE).origin;
const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/**
 * Downloads one pack file over the authenticated session. The caller verifies the
 * manifest SHA-256 against the written file afterwards. (There was an AES layer here
 * once, keyed from the session token — the same token every request carried in its
 * headers, so it protected nothing transport security would not; it is gone, and the
 * answer to eavesdropping is HTTPS at the deployment edge.)
 */
async function download(url, dest, token, onChunk) {
  const res = await fetch(url, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    received += value.length;
    if (onChunk) onChunk(received, total);
  }
  const buf = Buffer.concat(chunks);
  // Write to a sibling temp file and rename: a crash mid-write must never leave a
  // half-file that later passes the "config exists, skip it" check forever.
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

/** Installs the Fabric loader version JSON; returns the custom version name. */
async function installFabric(mcVersion, loaderVersion, onEvent) {
  const versionName = `fabric-loader-${loaderVersion}-${mcVersion}`;
  const jsonPath = path.join(INSTANCE_DIR, 'versions', versionName, `${versionName}.json`);
  // A cached profile is only trusted if it still parses — a crash during the original
  // write would otherwise brick every launch until someone deletes the file by hand.
  let cachedOk = false;
  try { JSON.parse(fs.readFileSync(jsonPath, 'utf8')); cachedOk = true; } catch (_) {}
  if (!cachedOk) {
    onEvent({ type: 'pack', data: { step: 'fabric', detail: versionName } });
    const profile = await fetchJson(`${FABRIC_META}/${mcVersion}/${loaderVersion}/profile/json`);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2));
  }
  return versionName;
}

/**
 * Folder inside the instance for a manifest file type.
 *
 * <p>The manifest is server data, and a launcher that trusts it with a path writes
 * wherever a hostile or spoofed server says. A name is a bare filename — separators,
 * dot-segments or control characters are refused, and the resolved destination must
 * still be inside the instance afterwards (belt AND braces: the second check holds
 * even if a bypass of the first is ever found).
 */
function destFor(file) {
  const dirs = { mods: 'mods', resourcepacks: 'resourcepacks', config: 'config' };
  const dir = dirs[file.type];
  if (!dir) throw new Error(`unknown pack file type: ${file.type}`);
  const name = String(file.name || '');
  if (!name || /[/\\]|\.\.|[\x00-\x1f]/.test(name)) {
    throw new Error(`refusing pack file name from server: ${JSON.stringify(name)}`);
  }
  const dest = path.join(INSTANCE_DIR, dir, name);
  if (!path.resolve(dest).startsWith(path.resolve(INSTANCE_DIR) + path.sep)) {
    throw new Error(`pack file resolves outside the instance: ${name}`);
  }
  return dest;
}

/**
 * Downloads/verifies every manifest file; throws if a hash doesn't verify. Files that are
 * already present with the right hash are skipped entirely — a healthy instance downloads
 * nothing here. Progress events carry aggregated bytes for a real download bar.
 */
async function syncFiles(manifest, token, onEvent) {
  const files = manifest.files || [];
  // Decide up front what actually needs fetching so the bar has a true total.
  const toFetch = files.filter((file) => {
    const dest = destFor(file);
    // Config files are templates: install once, then the launcher/player may edit them
    // (e.g. we merge the realm host into aetherspire-lock.json), so never hash-resync.
    if (file.type === 'config' && fs.existsSync(dest)) return false;
    return !(fs.existsSync(dest) && sha256(dest) === file.sha256);
  });
  const totalBytes = toFetch.reduce((sum, f) => sum + (f.size || 0), 0);
  let doneBytes = 0;
  let i = 0;
  let lastEmit = 0;
  for (const file of toFetch) {
    i++;
    const emit = (fileReceived) => {
      const now = Date.now();
      if (now - lastEmit < 100 && fileReceived) return; // throttle chunk spam over IPC
      lastEmit = now;
      onEvent({ type: 'pack', data: {
        step: 'download', detail: file.name, i, n: toFetch.length,
        doneBytes: doneBytes + (fileReceived || 0), totalBytes,
      } });
    };
    emit(0);
    const dest = destFor(file);
    // One retry after a short pause: a transient blip should not fail the whole launch.
    try {
      await download(API_ORIGIN + file.url, dest, token,
          (received) => emit(Math.min(received, file.size || received)));
    } catch (_) {
      onEvent({ type: 'pack', data: { step: 'retry', detail: file.name } });
      await new Promise((r) => setTimeout(r, 1500));
      await download(API_ORIGIN + file.url, dest, token,
          (received) => emit(Math.min(received, file.size || received)));
    }
    doneBytes += file.size || 0;
    const got = sha256(dest);
    if (got !== file.sha256) {
      fs.rmSync(dest, { force: true });
      throw new Error(`hash mismatch for ${file.name}: expected ${file.sha256}, got ${got}`);
    }
  }
  // Locked client: the mods folder is exactly the manifest.
  const wanted = new Set(files.filter((f) => f.type === 'mods').map((f) => f.name));
  const modsDir = path.join(INSTANCE_DIR, 'mods');
  if (fs.existsSync(modsDir)) {
    for (const name of fs.readdirSync(modsDir)) {
      if (!wanted.has(name)) {
        onEvent({ type: 'pack', data: { step: 'prune', detail: name } });
        // recursive: a stray subfolder in mods/ must not throw and fail every launch
        fs.rmSync(path.join(modsDir, name), { force: true, recursive: true });
      }
    }
  }
}

/** Makes sure the lock mod's allow-list contains the realm host we launch against. */
function ensureLockConfig(manifest) {
  const file = path.join(INSTANCE_DIR, 'config', 'aetherspire-lock.json');
  let cfg = {};
  // strip a UTF-8 BOM if present — strict JSON.parse rejects it
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) {}
  const hosts = new Set(Array.isArray(cfg.allowedHosts) ? cfg.allowedHosts : []);
  hosts.add(SERVER_HOST);
  cfg.allowedHosts = [...hosts];
  // The realm the mod's "Connect to AetherSpire" button joins directly.
  cfg.serverHost = SERVER_HOST;
  cfg.serverPort = SERVER_PORT;
  // The mod force-enables these at game start (options.txt names), OS-independent.
  cfg.resourcePacks = (manifest.files || [])
    .filter((f) => f.type === 'resourcepacks')
    .map((f) => `file/${f.name}`);
  if (!cfg.message) cfg.message = 'This client only connects to the Aetherspire realm.';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

/**
 * Hands the client mod the API session it needs to show Friends and Guild on the title
 * screen — before the player has joined anything, there is no plugin channel to ask over,
 * so the mod talks to the same REST API the launcher does.
 *
 * The file holds the session token, so it is written 0600 and replaced on every launch;
 * the token is short-lived and scoped to the account that is already signed in here.
 */
function writeSessionConfig(session) {
  const file = path.join(INSTANCE_DIR, 'config', 'aetherspire-session.json');
  if (!session || !session.token) {
    try { fs.unlinkSync(file); } catch (_) {}
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    apiBase: API_BASE,
    token: session.token,
    name: session.name,
    uuid: session.uuid,
    expiresAt: session.expiresAt || 0,
  }, null, 2), { mode: 0o600 });
}

/** Enables the pack's resource packs in options.txt (created or edited in place). */
function ensureResourcePacks(manifest) {
  const entries = (manifest.files || [])
    .filter((f) => f.type === 'resourcepacks')
    .filter((f) => !/[/\\]|\.\.|[\x00-\x1f]/.test(String(f.name || '')))
    .map((f) => `file/${f.name}`);
  if (entries.length === 0) return;
  const optionsPath = path.join(INSTANCE_DIR, 'options.txt');
  let text = '';
  try { text = fs.readFileSync(optionsPath, 'utf8'); } catch (_) {}
  const m = text.match(/^resourcePacks:(.*)$/m);
  let packs = ['vanilla'];
  if (m) {
    try { packs = JSON.parse(m[1]); } catch (_) {}
  }
  for (const e of entries) if (!packs.includes(e)) packs.push(e);
  const line = `resourcePacks:${JSON.stringify(packs)}`;
  if (m) text = text.replace(/^resourcePacks:.*$/m, line);
  else text += (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
  fs.mkdirSync(INSTANCE_DIR, { recursive: true });
  fs.writeFileSync(optionsPath, text);
}

/**
 * @param {(evt:{type:string, data:any})=>void} onEvent
 * @returns {Promise<{versionName:string, manifest:any}>}
 */
async function installPack(onEvent) {
  const token = api.getToken();
  if (!token) throw new Error('not signed in — pack downloads require a session');
  onEvent({ type: 'pack', data: { step: 'manifest' } });
  const manifest = await fetchJson(`${API_BASE}/pack`, token);
  const versionName = await installFabric(manifest.mcVersion, manifest.fabricLoader, onEvent);
  await syncFiles(manifest, token, onEvent);
  ensureLockConfig(manifest);
  ensureResourcePacks(manifest);
  onEvent({ type: 'pack', data: { step: 'ready', detail: versionName } });
  return { versionName, manifest };
}

module.exports = { installPack, writeSessionConfig };
