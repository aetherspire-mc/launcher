'use strict';
const { Client } = require('minecraft-launcher-core');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MC_VERSION, INSTANCE_DIR, SERVER_HOST, SERVER_PORT } = require('../config');
const { installPack, writeSessionConfig } = require('./pack');
const { ensureJava } = require('./java');
const api = require('../api');

/** Runs `<exe> -version` and returns the major Java version, or 0 if it fails. */
function javaMajor(exe) {
  try {
    // javaw.exe is the no-console binary and does not reliably emit -version output;
    // probe with the console java.exe next to it, launch with whatever was passed in.
    const probe = exe.toLowerCase().endsWith('javaw.exe')
        ? exe.slice(0, -'javaw.exe'.length) + 'java.exe'
        : exe;
    const r = spawnSync(probe, ['-version'], { timeout: 5000 });
    const s = (r.stderr || '').toString() + (r.stdout || '').toString();
    const m = s.match(/version "(\d+)/) || s.match(/(?:openjdk|java) (\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) {
    return 0;
  }
}

let javaScanNote = '';

/**
 * Finds an installed Java runtime. Minecraft 1.21.4 targets Java 21, and the Fabric/Mixin
 * stack we ship chokes on newer JVMs (ASM can't read Java 25 class files -> "Unsupported
 * class file major version 69" and a failed resource reload). So: prefer EXACTLY major 21;
 * only if none exists fall back to the lowest runtime >= minMajor.
 */
function findJava(minMajor = 21, preferMajor = 21) {
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const exe = win ? 'javaw.exe' : 'java';
  const direct = [];
  if (process.env.JAVA_HOME) direct.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  if (mac) {
    // The system JDK registry: ask it for a 21 first, then for whatever is default.
    for (const args of [['-v', '21'], []]) {
      try {
        const r = spawnSync('/usr/libexec/java_home', args, { timeout: 5000 });
        const home = (r.stdout || '').toString().trim();
        if (home) direct.push(path.join(home, 'bin', exe));
      } catch (_) {}
    }
    direct.push(
      '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java',
      '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java'
    );
  }
  direct.push(exe); // PATH fallback

  // Directories that commonly contain one-level-deep JDK folders. On macOS the runtime
  // lives under <jdk>/Contents/Home, so both layouts are probed for every candidate.
  // Where a Java 21 actually lives on a player's machine. The official Minecraft launcher
  // ships its own runtimes and is by far the likeliest source, so it is searched first.
  // Third-party launchers keep theirs in the same shape - <name>/runtime/<jdk>/bin - so
  // any AppData folder that has a runtime/ directory is treated as a parent too. That is
  // one cheap readdir, not a scan of AppData.
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const launcherRuntimes = [];
  if (win) {
    try {
      for (const d of fs.readdirSync(appData)) {
        const r = path.join(appData, d, 'runtime');
        try { if (fs.statSync(r).isDirectory()) launcherRuntimes.push(r); } catch (_) {}
      }
    } catch (_) {}
  }

  const parents = win
    ? [
        ...launcherRuntimes,
        'C:\Program Files\Eclipse Adoptium',
        'C:\Program Files\Java',
        'C:\Program Files (x86)\Java',
        'C:\Program Files\Microsoft',
        'C:\Program Files\Zulu',
        'C:\Program Files\Amazon Corretto',
        'C:\Program Files\BellSoft\LibericaJDK-21',
        path.join(os.homedir(), '.jdks'),
        path.join(os.homedir(), 'aetherspire-tools'),
      ]
    : mac
    ? [
        '/Library/Java/JavaVirtualMachines',
        path.join(os.homedir(), 'Library', 'Java', 'JavaVirtualMachines'),
        path.join(os.homedir(), 'aetherspire-tools'),
        '/opt/homebrew/Cellar/openjdk@21',
        '/usr/local/Cellar/openjdk@21',
      ]
    : ['/usr/lib/jvm', '/opt/java', path.join(os.homedir(), 'aetherspire-tools')];

  const suffixes = mac ? [['bin', exe], ['Contents', 'Home', 'bin', exe]] : [['bin', exe]];

  // Walk a few levels: the official runtime nests as
  // runtime/java-runtime-delta/windows-x64/java-runtime-delta/bin/javaw.exe, while a
  // bundled one is a single level. Three is enough for both and cheap enough to be safe.
  const globbed = [];
  const walk = (dir, depth) => {
    if (depth < 0) return;
    for (const s of suffixes) globbed.push(path.join(dir, ...s));
    if (depth === 0) return;
    try {
      for (const d of fs.readdirSync(dir)) {
        try {
          const child = path.join(dir, d);
          if (fs.statSync(child).isDirectory()) walk(child, depth - 1);
        } catch (_) {}
      }
    } catch (_) {}
  };
  for (const p of parents) walk(p, 3);

  // EXACTLY 21. A newer JVM is not a degraded option, it is a guaranteed failure: ASM
  // cannot read its class files, so Mixin dies with "Unsupported class file major
  // version" and the player gets a stack trace instead of a game. Falling back to one
  // trades a clear "install Java 21" for an unreadable crash, so we refuse and say so.
  javaScanNote = '';
  let tooNew = null;
  for (const cand of [...direct, ...globbed]) {
    try {
      if (cand === exe || fs.existsSync(cand)) {
        const major = javaMajor(cand);
        if (major === preferMajor) return cand;
        if (major > preferMajor && !tooNew) tooNew = `${cand} (Java ${major})`;
      }
    } catch (_) {}
  }
  javaScanNote = tooNew
    ? `The only runtimes found are newer than 21 - e.g. ${tooNew} - and the game cannot run on them.`
    : 'No Java runtime was found at all.';
  return null;
}

/**
 * Launches Minecraft with the signed-in Microsoft account, auto-joining the Aetherspire
 * server. Before launching it runs the pack install/verify pipeline (see game/pack.js):
 * Fabric loader + the Aetherspire mod set + resource pack, all fetched from the server's
 * pack manifest and hash-verified. If the pack can't be installed (server unreachable,
 * hash mismatch) the launch fails rather than starting an unlocked vanilla client.
 */

let client = null;

/**
 * @param {{mcToken:string, uuid:string, name:string}} auth
 * @param {{maxMemory?:string, minMemory?:string, javaPath?:string}} opts
 * @param {(evt:{type:string, data:any})=>void} onEvent
 */
async function launch(auth, opts, onEvent) {
  onEvent({ type: 'status', data: 'installing-pack' });
  const { versionName } = await installPack(onEvent);
  // The client mod reads this to show Friends and Guild on the title screen, where there is
  // no server connection to ask over yet.
  writeSessionConfig({ token: api.getToken(), name: auth.name, uuid: auth.uuid });

  client = new Client();

  const authorization = {
    access_token: auth.mcToken,
    client_token: auth.uuid,
    uuid: auth.uuid,
    name: auth.name,
    user_properties: '{}',
    meta: { type: 'msa', demo: false },
  };

  const options = {
    authorization,
    root: INSTANCE_DIR,
    version: { number: MC_VERSION, type: 'release', custom: versionName },
    memory: { max: opts.maxMemory || '4G', min: opts.minMemory || '2G' },
    // Auto-join the realm on launch (Minecraft 1.20+ quick-play).
    quickPlay: { type: 'multiplayer', identifier: `${SERVER_HOST}:${SERVER_PORT}` },
  };
  // Minecraft 1.21.4 requires Java 21+. Use the configured path, else auto-detect one.
  let javaPath = opts.javaPath && javaMajor(opts.javaPath) === 21 ? opts.javaPath : null;
  if (opts.javaPath && !javaPath) {
    onEvent({ type: 'debug', data: 'Configured Java is not 21 (breaks Fabric); looking for a 21.' });
  }
  javaPath = javaPath || findJava(21);

  // Nothing suitable on this machine: fetch one rather than sending the player away.
  //
  // "Install Java 21" is not advice a player can follow reliably - Adoptium's front page
  // offers the newest release, which is exactly the version that cannot run our Mixin
  // stack. A player did that today and arrived back here no better off. The launcher now
  // downloads a Java 21 JRE of its own, beside the instance: nothing system-wide, nothing
  // else on the machine touched, and uninstalling the launcher removes it too.
  if (!javaPath) {
    onEvent({ type: 'status', data: 'installing-java' });
    javaPath = await ensureJava(path.join(INSTANCE_DIR, 'runtime'), onEvent);
  }

  // Refuse rather than start something that cannot work. Launching on a newer JVM does
  // not degrade gracefully - ASM cannot read its class files and the player gets
  // "Unsupported class file major version 69" out of a Mixin stack trace, with nothing
  // pointing at Java. A named requirement is a fixable problem; that crash is not.
  if (!javaPath) {
    throw new Error(
      'Aetherspire needs Java 21, and it could not be found or downloaded. '
      + javaScanNote
      + ' Install Java 21 specifically - NOT the newest version, which the game cannot run '
      + 'on: adoptium.net/temurin/releases/?version=21. Then press Play again.'
    );
  }
  if (javaPath) {
    options.javaPath = javaPath;
    onEvent({ type: 'debug', data: 'Using Java: ' + javaPath });
  } else {
    // Launching anyway would fall back to a bare `java` and die with a cryptic error —
    // fail here with the fix in hand instead.
    throw new Error('No Java 21 found. Install Temurin 21 (adoptium.net) or set the path in Settings.');
  }

  client.on('debug', (line) => onEvent({ type: 'debug', data: String(line) }));
  client.on('data', (line) => onEvent({ type: 'data', data: String(line) }));
  client.on('progress', (p) => onEvent({ type: 'progress', data: p }));
  client.on('close', (code) => onEvent({ type: 'close', data: code }));

  onEvent({ type: 'status', data: 'launching' });
  return client.launch(options);
}

module.exports = { launch, findJava, javaMajor };
