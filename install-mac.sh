#!/bin/bash
# Claude ↔ Figma bridge — installer for macOS
# 1) copies the bridge to ~/claude-figma-bridge
# 2) adds "figma-bridge" to Claude desktop's MCP config (keeps a backup, never removes other servers)
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/claude-figma-bridge"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then   # not on PATH: look where Node.js usually lives
  for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME/.volta/bin/node" $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null) "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node"; do
    if [ -x "$n" ] && [ ! -d "$n" ]; then NODE="$n"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "Node.js not found. Install the LTS version from https://nodejs.org and run this again."
  exit 1
fi
echo "Node: $NODE ($("$NODE" -v))"

if [ "$SRC" != "$DEST" ]; then
  mkdir -p "$DEST"
  cp -R "$SRC/server" "$SRC/figma-plugin" "$DEST/"
  if [ -d "$SRC/assets" ]; then cp -R "$SRC/assets" "$DEST/"; fi
  cp "$SRC/install-mac.sh" "$DEST/" 2>/dev/null || true
  for f in README.md README.vi.md HUONG-DAN.md CHANGELOG.md package.json; do [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/"; done
fi
chmod +x "$DEST/server/start.sh" 2>/dev/null || true
echo "Bridge copied to: $DEST"

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CFG")"
if [ -f "$CFG" ]; then cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"; echo "Backed up the existing config."; fi

"$NODE" -e '
const fs = require("fs");
const [cfg, node, server] = process.argv.slice(1);
let j = {};
if (fs.existsSync(cfg)) {
  const raw = fs.readFileSync(cfg, "utf8").trim();
  if (raw) {
    try { j = JSON.parse(raw); }
    catch (e) { console.error("The existing config is not valid JSON. Stopping so nothing is overwritten: " + cfg); process.exit(1); }
  }
}
j.mcpServers = j.mcpServers || {};
// start.sh finds Node.js each time Claude starts: an upgraded or moved node can not break the bridge
j.mcpServers["figma-bridge"] = { command: "/bin/bash", args: [server] };
fs.writeFileSync(cfg, JSON.stringify(j, null, 2) + "\n");
console.log("Added \"figma-bridge\" to " + cfg);
console.log("MCP servers now configured: " + Object.keys(j.mcpServers).join(", "));
' "$CFG" "$NODE" "$DEST/server/start.sh"

echo ""
echo "Done. Two steps left:"
echo "  1. Quit Claude completely (Cmd+Q) and open it again."
echo "  2. In Figma desktop: Plugins > Development > Import plugin from manifest..."
echo "     and pick: $DEST/figma-plugin/manifest.json"
