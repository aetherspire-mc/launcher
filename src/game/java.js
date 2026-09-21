'use strict';

/**
 * Getting a Java 21 runtime onto the player's machine, without asking them to.
 *
 * <p>Minecraft 1.21.4 needs Java 21 and the Fabric/Mixin stack we ship cannot run on
 * anything newer: ASM refuses class files it does not know, and the player sees
 * "Unsupported class file major version 69" out of a Mixin stack trace with nothing
 * pointing at Java. So "install Java" is not advice a player can act on reliably - the
 * Adoptium front page offers the newest release, which is precisely the one that breaks.
 * A player did exactly that today, which is why this exists.
 *
 * <p>So the launcher fetches its own. A JRE (not a JDK) from Adoptium's API, unpacked
 * beside the instance, used only by us: nothing is installed system-wide, nothing on the
 * machine changes, and uninstalling the launcher takes it with it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

/** Pinned to 21 deliberately. "Latest" is the bug this whole file exists to prevent. */
const MAJOR = 21;

/** Adoptium's redirect endpoint: always the current 21 GA build for this platform. */
function downloadUrl() {
  const platform = process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'mac' : 'linux';
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  return `https://api.adoptium.net/v3/binary/latest/${MAJOR}/ga/${platform}/${arch}`
    + '/jre/hotspot/normal/eclipse';
}

/** The java binary inside an unpacked runtime, wherever the archive put it. */
function javaBinaryUnder(dir) {
  const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === exe && path.basename(here) === 'bin') return full;
    }
  }
  return null;
}

/** What major version a binary actually is. Trust the runtime, not the folder name. */
function majorOf(binary) {
  // javaw.exe emits nothing; ask its sibling java.exe instead.
  const probe = process.platform === 'win32'
    ? path.join(path.dirname(binary), 'java.exe') : binary;
  try {
    const out = spawnSync(probe, ['-version'], { encoding: 'utf8', timeout: 10000 });
    const text = `${out.stdout || ''}${out.stderr || ''}`;
    const m = text.match(/version "(\d+)/) || text.match(/(?:openjdk|java) (\d+)/i);
    return m ? Number(m[1]) : 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Unpacks an archive using what the operating system already has.
 *
 * <p>bsdtar ships with Windows 10 1803 and later and reads zip perfectly well, so one
 * command covers all three platforms. PowerShell's Expand-Archive is the fallback for
 * older Windows, and it is the fallback rather than the default because it is far slower
 * on a 50MB archive.
 */
function unpack(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  try {
    execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'ignore', timeout: 300000 });
    return;
  } catch (err) {
    if (process.platform !== 'win32') throw err;
  }
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`],
  { stdio: 'ignore', timeout: 600000 });
}

/**
 * Returns a path to a Java 21 binary, downloading one if this machine has none.
 *
 * @param {string} runtimeDir where the launcher may keep its own runtime
 * @param {(evt:{type:string,data:any})=>void} onEvent progress, so a 50MB download is not
 *        a frozen window
 * @returns {Promise<string|null>} the binary, or null if it could not be provided
 */
async function ensureJava(runtimeDir, onEvent) {
  const report = (data) => { if (onEvent) onEvent({ type: 'java', data }); };

  // Already fetched on an earlier run? Verify rather than assume: a half-extracted
  // runtime from an interrupted download would otherwise be trusted forever.
  const existing = javaBinaryUnder(runtimeDir);
  if (existing && majorOf(existing) === MAJOR) return existing;

  report({ step: 'download', detail: `Java ${MAJOR}` });
  const tmp = path.join(os.tmpdir(), `aetherspire-jre-${Date.now()}`
    + (process.platform === 'win32' ? '.zip' : '.tar.gz'));
  try {
    const res = await fetch(downloadUrl(), { redirect: 'follow' });
    if (!res.ok) throw new Error(`GET runtime -> ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const chunks = [];
    let received = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
      report({ step: 'download', received, total });
    }
    fs.writeFileSync(tmp, Buffer.concat(chunks));

    report({ step: 'unpack' });
    // Into a fresh directory: unpacking over a previous failed attempt is how two
    // runtimes end up interleaved and the wrong java is found first.
    fs.rmSync(runtimeDir, { recursive: true, force: true });
    unpack(tmp, runtimeDir);

    const binary = javaBinaryUnder(runtimeDir);
    if (!binary) throw new Error('the runtime unpacked without a java binary in it');
    const major = majorOf(binary);
    if (major !== MAJOR) throw new Error(`the downloaded runtime reports Java ${major}`);
    report({ step: 'ready', detail: binary });
    return binary;
  } catch (err) {
    report({ step: 'failed', detail: String(err && err.message ? err.message : err) });
    return null;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

module.exports = { ensureJava, MAJOR };
