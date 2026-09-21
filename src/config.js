'use strict';
const path = require('path');
const os = require('os');

/**
 * Launcher configuration. In production these would be baked in or fetched from the server;
 * for now they're constants with sensible dev defaults.
 */
/**
 * Which realm this build points at.
 *
 * A packaged launcher has no environment variables - the player just double-clicks it -
 * so the DEFAULTS below are what ships. They stay on loopback so `npm start` keeps
 * working against a local server with no setup.
 *
 * scripts/build-launcher.sh writes src/realm.json at package time with the real host, and
 * it is read in preference to the defaults. The file is gitignored and absent in a dev
 * checkout, which is exactly why the dev loop is unaffected. One file per environment is
 * also how a dev/test/prod client will be told apart later.
 *
 * Precedence: environment variable (a developer overriding one run) > realm.json (what
 * this build was packaged for) > loopback default.
 */
let realm = {};
try {
  realm = require('./realm.json');
} catch {
  // No realm.json: a dev checkout. Defaults apply.
}

module.exports = {
  // Aetherspire backend REST API (the game server's embedded API).
  API_BASE: process.env.AETHER_API || realm.apiBase || 'http://127.0.0.1:8080/api/v1',

  // The Minecraft server players connect to (shown on the Play screen, and joined on launch).
  SERVER_HOST: process.env.AETHER_SERVER || realm.serverHost || '127.0.0.1',
  SERVER_PORT: Number(process.env.AETHER_SERVER_PORT || realm.serverPort || 25565),

  // Minecraft version + loader the pack targets.
  MC_VERSION: '1.21.4',

  // Microsoft sign-in uses the legacy public Minecraft launcher client id + desktop redirect
  // (authorization-code flow via login.live.com), so NO Azure app registration is needed by
  // default. Override AZURE_CLIENT_ID only if you register your own app.
  AZURE_CLIENT_ID: process.env.AZURE_CLIENT_ID || '00000000402b5328',
  REDIRECT_URI: 'https://login.live.com/oauth20_desktop.srf',
  OAUTH_SCOPE: 'service::user.auth.xboxlive.com::MBI_SSL',

  // Where the game instance (mods, saves, assets) lives.
  INSTANCE_DIR: path.join(os.homedir(), 'aetherspire-instance'),

  // electron-updater generic feed (latest.yml + installer), served by the game server's API.
  UPDATE_URL: process.env.AETHER_UPDATE || realm.updateUrl || 'http://127.0.0.1:8080/api/v1/launcher',
};
