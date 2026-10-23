#!/usr/bin/env sh
# Mystique installer: fetch (or update) the repo, install dependencies, enable it for
# every agent found (pi, Claude Code), link the `mystique` CLI and run `mystique doctor`.
#
#   sh install.sh [pi] [claude]          from a checkout: installs that checkout in place
#   curl -fsSL <raw>/install.sh | sh     elsewhere: clones into $MYSTIQUE_HOME
#
# Env: MYSTIQUE_HOME (default ~/.local/share/mystique), MYSTIQUE_REPO (default the GitHub repo).
set -eu

REPO="${MYSTIQUE_REPO:-https://github.com/sudoish/mystique.git}"
HOME_DIR="${MYSTIQUE_HOME:-$HOME/.local/share/mystique}"

say() { printf 'mystique: %s\n' "$*"; }
die() { printf 'mystique: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required: $2"; }

need node "install Node.js 20+ (https://nodejs.org or 'brew install node')"
need npm "it ships with Node.js"

# Run from inside a checkout? Use it in place (dev setups, or an agent that cloned it).
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/bin/mystique.mjs" ] && [ -f "$here/core/lua/mystique.lua" ]; then
  DIR="$here"
  say "using checkout $DIR"
else
  need git "install git"
  DIR="$HOME_DIR"
  if [ -d "$DIR/.git" ]; then
    say "updating $DIR"
    git -C "$DIR" pull --ff-only --quiet
  else
    say "cloning $REPO into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --depth 1 --quiet "$REPO" "$DIR"
  fi
fi

exec node "$DIR/bin/mystique.mjs" install "$@"
