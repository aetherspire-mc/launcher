#!/usr/bin/env bash
# Builds the Aetherspire Launcher installers with electron-builder.
#
# Usage: build.sh [--mac | --win | --linux | --all]   (default: the host platform)
#
# Cross-building from macOS: --win builds the NSIS installer only. The MSI target needs
# 32-bit wine, which macOS cannot run ("Wine cannot run Windows 32-bit applications") —
# build the MSI on a Windows host instead. mac dmg/zip can only be built on macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

target="${1:-}"
if [ -z "$target" ]; then
  case "$(uname -s)" in
    Darwin) target="--mac" ;;
    Linux)  target="--linux" ;;
    *)      target="--win" ;;
  esac
fi

# Which realm the packaged launcher points at. A packaged app has no environment, so this
# is written into the bundle as src/realm.json - the defaults in src/config.js stay on
# loopback so a dev checkout and `npm start` are untouched.
#
# Override per environment:
#   AETHER_REALM_HOST=my-server.example.com ./build.sh --win
REALM_HOST="${AETHER_REALM_HOST:-aetherspire.net}"
REALM_API="${AETHER_REALM_API:-https://api.$REALM_HOST/api/v1}"
REALM_PLAY="${AETHER_REALM_PLAY:-play.$REALM_HOST}"
REALM_PORT="${AETHER_REALM_PORT:-25565}"

write_realm() {
  cat > "$ROOT/src/realm.json" <<JSON
{
  "apiBase": "$REALM_API",
  "serverHost": "$REALM_PLAY",
  "serverPort": $REALM_PORT,
  "updateUrl": "$REALM_API/launcher"
}
JSON
  info "==> Packaging for realm $REALM_PLAY (api $REALM_API)"
}

# Leaving it behind would silently point the NEXT `npm start` at that realm.
clear_realm() { rm -f "$ROOT/src/realm.json"; }
trap clear_realm EXIT

# On macOS the MSI target is unbuildable (needs 32-bit wine), so --win means NSIS only.
build_one() {
  local t="$1" args=("$1")
  # MSI needs WiX, and WiX under wine wants a desktop session: on a non-Windows host it
  # dies with "XDG_RUNTIME_DIR is invalid or not set" after NSIS has already built fine.
  # NSIS is what players install anyway; MSI is for managed deployment and needs a Windows
  # host.
  if [ "$t" = "--win" ] && [ "$(uname -s)" != "Windows_NT" ] && [ -z "${MSYSTEM:-}" ]; then
    warn "    (non-Windows host: building NSIS only - the MSI target needs a Windows host)"
    # Naming the target on the CLI drops the arch list from package.json, so pass the
    # architectures explicitly - x64 is what almost every Windows player runs.
    args=(--win nsis --x64 --arm64)
  fi
  write_realm
  info "==> Building launcher installers (electron-builder ${args[*]})"
  ( cd "$ROOT" && npx electron-builder "${args[@]}" )
}

if [ "$target" = "--all" ]; then
  case "$(uname -s)" in
    Darwin) build_one --mac; build_one --win ;;
    *)      build_one --win; build_one --linux ;;
  esac
else
  build_one "$target"
fi

ok "==> Installers built in $ROOT/dist"
