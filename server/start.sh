#!/bin/bash
# Starts the bridge with whatever Node.js this Mac has right now. Claude's config points here instead of at
# one node binary, so moving, upgrading or switching Node (Homebrew, nvm, volta, mise…) doesn't break it.
DIR="$(cd "$(dirname "$0")" && pwd)"
NVM=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -t v -k 2 -n -r)
for n in "$FIGMA_BRIDGE_NODE" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME/.volta/bin/node" \
         $NVM "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" "$HOME/.fnm/aliases/default/bin/node" /usr/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ] && [ ! -d "$n" ]; then exec "$n" "$DIR/index.js" "$@"; fi
done
# last try: the node a login shell finds (its output is captured, so nothing reaches Claude's channel)
n="$( { /bin/zsh -lc 'command -v node' || /bin/bash -lc 'command -v node'; } 2>/dev/null </dev/null | tail -n 1)"
if [ -n "$n" ] && [ -x "$n" ]; then exec "$n" "$DIR/index.js" "$@"; fi
echo "[figma-bridge] Node.js was not found. Install the LTS version from https://nodejs.org, then quit Claude (Cmd+Q) and open it again." >&2
exit 1
