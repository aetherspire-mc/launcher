# Aetherspire Launcher

[![CI](https://github.com/aetherspire-mc/launcher/actions/workflows/ci.yml/badge.svg)](https://github.com/aetherspire-mc/launcher/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Electron desktop launcher for [Aetherspire](https://aetherspire.net), a Minecraft server:
Microsoft sign-in, live account/guild/friends data from the Aetherspire API, a locked
modpack install, and launching the game.

This is the launcher players actually use, developed in the open. Pull requests are
welcome: if a change fits the launcher and works, it gets merged and ships to players in
the next release. You are also free to fork it and build your own (see [Forking](#forking)).

The Aetherspire game server and its API are not part of this repository; they are a
separate project. This repository is the client that talks to them.

## Features

- **Microsoft sign-in with no setup.** Uses the public Minecraft launcher client ID with
  the desktop OAuth redirect, so signing in needs no Azure app registration. See
  "Microsoft sign-in" below.
- **Java, handled for you.** Downloads and unpacks a Java 21 JRE from Adoptium next to the
  game instance if one isn't already there, so players never have to install Java, or the
  wrong version of it, themselves (`src/game/java.js`).
- **Locked pack install.** Before every launch the launcher fetches the server's pack
  manifest, installs the matching Fabric loader, downloads and verifies every mod and
  resource pack by SHA-256, and prunes anything not in the manifest, so the client always
  matches what the server expects (`src/game/pack.js`).
- **Play / Friends / Guild / Settings screens** wired to live data from the Aetherspire
  API, both reading and writing.
- **Launch and auto-join** the server through `minecraft-launcher-core`.

## Requirements

- [Node.js](https://nodejs.org/) 20 or newer (any version current Electron 32 supports).
- npm (comes with Node).
- Electron itself is a dev dependency; `npm ci` installs it, no separate download needed.

## Quick start

```bash
npm ci
npm start
```

By default the launcher talks to a local server at `http://127.0.0.1:8080/api/v1` (game
server `127.0.0.1:25565`), so `npm start` works against your own dev server with no setup.
Override with the `AETHER_API`, `AETHER_SERVER`, `AETHER_SERVER_PORT` environment variables.

Run the syntax check and the test suite:

```bash
npm run check
npm test
```

## Build

```bash
npm ci
./build.sh            # host platform; or --mac / --win / --linux / --all
```

`build.sh` bakes the target realm's API/server host into the package (default
`aetherspire.net`); override with `AETHER_REALM_HOST` (and `AETHER_REALM_API` /
`AETHER_REALM_PLAY` / `AETHER_REALM_PORT` if the realm doesn't follow the `api.<host>` /
`play.<host>` convention). Cross-building the Windows MSI target and the macOS dmg/zip
targets needs a matching host OS (or Wine, for MSI); see the comments in `build.sh`.

Packages are built with `electron-builder` for Windows (NSIS and MSI, x64 and arm64), macOS
(dmg and zip), and Linux, as configured in `package.json`.

## Configuration

The launcher reads its configuration from environment variables in a dev checkout, or from
a `src/realm.json` file written by `build.sh` in a packaged build (see `src/config.js`):

| Variable | Default | What it controls |
| --- | --- | --- |
| `AETHER_API` | `http://127.0.0.1:8080/api/v1` | Aetherspire REST API base URL |
| `AETHER_SERVER` | `127.0.0.1` | Minecraft server host to show and join |
| `AETHER_SERVER_PORT` | `25565` | Minecraft server port |
| `AETHER_UPDATE` | `http://127.0.0.1:8080/api/v1/launcher` | electron-updater feed URL |
| `AZURE_CLIENT_ID` | the public Minecraft launcher client ID | Microsoft OAuth client ID |
| `AETHER_REALM_HOST` (build.sh only) | `aetherspire.net` | Host baked into a packaged build |
| `AETHER_REALM_API` (build.sh only) | `https://api.$AETHER_REALM_HOST/api/v1` | API URL baked into a packaged build |
| `AETHER_REALM_PLAY` (build.sh only) | `play.$AETHER_REALM_HOST` | Server host baked into a packaged build |
| `AETHER_REALM_PORT` (build.sh only) | `25565` | Server port baked into a packaged build |

## How it talks to the server

The launcher is a client for the Aetherspire game server's embedded REST API
(`API_BASE`, `/api/v1/...`) and joins the Minecraft server directly for gameplay. Both are
run by the Aetherspire project and are not part of this repository; there is no public
server-side code to build against, but the API shape (auth, pack manifest, realm status)
is visible in `src/api.js` and `src/game/pack.js` if you want to run something compatible.

## Microsoft sign-in

Click **Sign in with Microsoft**; a Microsoft login window opens. The launcher uses the
**public Minecraft launcher client ID** (`00000000402b5328`) with the desktop redirect
(`login.live.com/oauth20_desktop.srf`) via the OAuth **authorization-code** flow, so **no
Azure app registration is required**. The signing-in account must **own Minecraft: Java
Edition**.

The flow (auth code -> MSA token -> Xbox -> XSTS -> Minecraft token -> profile) lives in
`src/auth/msauth.js`; the resulting token is validated server-side by the API
(`/auth/microsoft`).

*Optional:* to use your own Azure app instead, paste its Application (client) ID under
"Advanced" on the login screen (or set `AZURE_CLIENT_ID`).

Offline/dev alternative: run `/link` in-game for a 6-char code and use "Use an in-game link
code" on the login screen; this signs you in to **view** data. Launching still needs
Microsoft.

## Project layout

```
src/
  main.js          Electron main: window, IPC, orchestrates auth/api/launch
  preload.js       contextBridge -> window.aether
  config.js        endpoints, server, Azure client id, paths
  auth/msauth.js   Microsoft device-code -> Minecraft token + profile
  api.js           Aetherspire REST API client (holds the session token)
  game/launch.js   minecraft-launcher-core wrapper
  game/java.js     fetches and unpacks a Java 21 JRE if needed
  game/pack.js     pack manifest install/verify (mods, loader, resource pack)
renderer/
  index.html       screens (login + app)
  styles.css       the navy/gold/blue theme
  app.js           screen routing + rendering from the API
```

## Contributing

We accept pull requests. If your change fits the launcher and works (CI is green and you
have tried it by hand), we merge it, and it goes out to players with the next launcher
release. Bug reports and feature ideas are just as welcome as code.

Good first steps: look for open issues, fix something that annoyed you while playing, or
improve the docs. See [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup and the PR flow.

## Forking

This project is MIT licensed (see [LICENSE](LICENSE)), which means you are free to fork
it, rebrand it, and ship your own launcher pointed at your own server. To do that:

1. Fork the repository.
2. Point it at your own server: set `AETHER_API`, `AETHER_SERVER`, `AETHER_SERVER_PORT` for
   development, and `AETHER_REALM_HOST` (or the more specific `AETHER_REALM_*` variables)
   when running `build.sh` for a packaged build.
3. Replace the Aetherspire name and icons: update `name`, `productName`, `appId`, and the
   `repository` field in `package.json`, and swap the files in `assets/`.
4. Keep the MIT license notice in `LICENSE` and in any copies of this source you
   redistribute.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

MIT. See [LICENSE](LICENSE).
