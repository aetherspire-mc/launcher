# Aetherspire Launcher

Electron desktop launcher for [Aetherspire](https://aetherspire.net), a Minecraft server:
Microsoft sign-in, live account/guild/friends data from the Aetherspire API, and launching
the game.

The Aetherspire server itself is not part of this repository.

## Run (dev)

```bash
npm install
npm start
```

By default the launcher talks to a local server at `http://127.0.0.1:8080/api/v1` (game
server `127.0.0.1:25565`), so `npm start` works against your own dev server with no setup.
Override with the `AETHER_API`, `AETHER_SERVER`, `AETHER_SERVER_PORT` environment variables,
or point a packaged build at a real realm — see "Build" below.

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

## Microsoft sign-in — no setup needed

Click **Sign in with Microsoft**; a Microsoft login window opens. The launcher uses the
**public Minecraft launcher client ID** (`00000000402b5328`) with the desktop redirect
(`login.live.com/oauth20_desktop.srf`) via the OAuth **authorization-code** flow — so **no
Azure app registration is required**. The signing-in account must **own Minecraft: Java
Edition**.

The flow (auth code → MSA token → Xbox → XSTS → Minecraft token → profile) lives in
`src/auth/msauth.js`; the resulting token is validated server-side by the API
(`/auth/microsoft`).

*Optional:* to use your own Azure app instead, paste its Application (client) ID under
"Advanced" on the login screen (or set `AZURE_CLIENT_ID`).

Offline/dev alternative: run `/link` in-game for a 6-char code and use "Use an in-game link
code" on the login screen — this signs you in to **view** data; launching still needs Microsoft.

## What works / what's next

- ✅ Microsoft device-code sign-in → API session.
- ✅ Play / Friends / Guild / Settings screens wired to live API data (read + write).
- ✅ Launch via `minecraft-launcher-core`, auto-joining the server (vanilla `1.21.4`).
- ⏳ **Next:** install the full pack (Fabric loader + Aetherspire mods) before launch by
  fetching the server's pack manifest. The auth + join flow here is what it plugs into.

## Structure

```
src/
  main.js          Electron main: window, IPC, orchestrates auth/api/launch
  preload.js       contextBridge -> window.aether
  config.js        endpoints, server, Azure client id, paths
  auth/msauth.js   Microsoft device-code -> Minecraft token + profile
  api.js           Aetherspire REST API client (holds the session token)
  game/launch.js   minecraft-launcher-core wrapper
renderer/
  index.html       screens (login + app)
  styles.css       the navy/gold/blue theme
  app.js           screen routing + rendering from the API
```

## License

MIT — see [LICENSE](LICENSE).

This repository is a snapshot of the launcher's source, published for transparency. There
is no formal contribution process at this time.
