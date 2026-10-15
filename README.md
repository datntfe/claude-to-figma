# Claude to Figma (Claude Bridge)

**English** · [Tiếng Việt](README.vi.md)

Let Claude work directly in the Figma file you have open: draw screens, edit layers, run any Figma Plugin API code, and take screenshots to check its own work.

```
Claude ──(MCP, stdio)──► server/index.js ──(WebSocket, localhost only)──► "Claude Bridge" plugin in Figma desktop
```

- **No dependencies.** The server is one Node.js file (Node 18+). The plugin is plain JavaScript. There is nothing to `npm install`.
- **Full Plugin API.** Anything a Figma plugin can do, Claude can do through `run_code`: create, restyle, rename, auto layout, components, prototype links and more.
- **Claude can see its work.** `screenshot` exports any layer as PNG and returns it to Claude as an image.
- **Local only.** The server listens on `127.0.0.1` / `::1`. Nothing is sent anywhere except between Claude and Figma on your own computer.
- **Several Claude windows at once.** The first server copy owns the port and the others relay through it, so Claude desktop, Cowork and Claude Code can all share one Figma connection.

---

## Contents

1. [Requirements](#requirements)
2. [Quick start (macOS + Claude desktop)](#quick-start-macos--claude-desktop)
3. [Setup in detail](#setup-in-detail)
4. [Using it day to day](#using-it-day-to-day)
5. [Tool reference](#tool-reference)
6. [Writing good `run_code`](#writing-good-run_code)
7. [How it works](#how-it-works)
8. [Troubleshooting](#troubleshooting)
9. [Security](#security)
10. [Uninstall](#uninstall)
11. [Development](#development)

---

## Requirements

| What | Notes |
|---|---|
| **Figma desktop app** | Development plugins can only be imported and run in the desktop app (macOS or Windows), not in the browser. Works in Figma Design files. FigJam, Slides and Dev Mode are not supported. |
| **Node.js 18 or newer** | Check with `node -v` in a terminal. Get the LTS build from <https://nodejs.org>. |
| **An MCP client** | Claude desktop app (chat and Cowork), Claude Code, or any client that can start a stdio MCP server. |

---

## Quick start (macOS + Claude desktop)

```bash
git clone https://github.com/datntfe/claude-to-figma.git
cd claude-to-figma
bash install-mac.sh
```

The installer:

- copies the bridge to `~/claude-figma-bridge`.
- adds a `figma-bridge` entry to `~/Library/Application Support/Claude/claude_desktop_config.json`. It saves a timestamped backup first, keeps every other MCP server you already have, and stops without writing if the existing file is not valid JSON.

Then:

1. **Quit Claude completely** (Cmd+Q, not just closing the window) and open it again.
2. In **Figma desktop**, open a design file and choose **Plugins → Development → Import plugin from manifest…**. Pick `~/claude-figma-bridge/figma-plugin/manifest.json`.
3. Run **Plugins → Development → Claude Bridge**. A green dot means it's connected.
4. Ask Claude: *"Check the Figma bridge status."*

---

## Setup in detail

### 1. Get the code

Use either:

- `git clone https://github.com/datntfe/claude-to-figma.git`
- **Code → Download ZIP** on GitHub, then unzip it.

Put it somewhere permanent. Claude starts the server from this path every time it launches.

### 2. Register the MCP server

Pick the section for your client. Every client needs the same two things: the **absolute path to `node`** and the **absolute path to `server/index.js`**.

Find your `node` path with:

- macOS / Linux: `which node`, for example `/usr/local/bin/node` or `/opt/homebrew/bin/node`
- Windows: `where node`, for example `C:\Program Files\nodejs\node.exe`

#### A. Claude desktop on macOS (installer)

Run `bash install-mac.sh` as in the quick start. Re-run it any time you pull a new version. It overwrites `~/claude-figma-bridge` and updates the config entry.

#### B. Claude desktop, manual config (macOS or Windows)

Open the config file. In Claude desktop you can also get to it from **Settings → Developer → Edit Config**.

| OS | Config file |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add `figma-bridge` inside `mcpServers`, keeping any servers that are already there.

macOS:

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/you/claude-to-figma/server/index.js"]
    }
  }
}
```

Windows (escape backslashes as `\\`):

```json
{
  "mcpServers": {
    "figma-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\claude-to-figma\\server\\index.js"]
    }
  }
}
```

Save, then quit Claude completely and reopen it.

#### C. Claude Code

```bash
claude mcp add --scope user figma-bridge -- node /absolute/path/to/claude-to-figma/server/index.js
claude mcp list        # figma-bridge should be listed
```

`--scope user` makes it available in every project. Leave it out to add it to the current project only. Inside a session, `/mcp` shows whether the server is connected.

#### D. Any other MCP client

It is a standard stdio MCP server:

- command: `node`
- args: `["/absolute/path/to/server/index.js"]`
- optional env: `FIGMA_BRIDGE_PORT`

#### Using a different port (optional)

The default port is **3055**. To change it, you need to update three places:

1. **Server:** set `FIGMA_BRIDGE_PORT` in the client config, e.g. `"env": { "FIGMA_BRIDGE_PORT": "3056" }` next to `command`/`args`. For Claude Code, use `claude mcp add -e FIGMA_BRIDGE_PORT=3056 …`.
2. **Plugin manifest:** Figma only lets the plugin open the addresses listed in `figma-plugin/manifest.json`. Change both entries under `devAllowedDomains` to the new port.
3. **Plugin window:** type the new port in the **Port** field and press **Reconnect**. Close and rerun the plugin after editing the manifest.

### 3. Import the Figma plugin (once per computer)

1. Open the **Figma desktop app** and any design file.
2. Go to **Plugins → Development → Import plugin from manifest…**. In the Quick Actions bar (Cmd+/ or Ctrl+/) you can also type "Import plugin from manifest".
3. Select `figma-plugin/manifest.json`. If you used the installer, that's `~/claude-figma-bridge/figma-plugin/manifest.json`.

Import the **manifest from this repo**. Don't create a new plugin with Figma's "New plugin…" wizard, because that makes a TypeScript template that needs a build step and isn't this plugin.

### 4. Check that everything works

1. With Claude open, visit <http://localhost:3055> in a browser. You should see `Claude Figma bridge 1.1.0 is running. Plugin connected: no`.
2. In Figma, run **Plugins → Development → Claude Bridge**. The dot turns **green**: "Connected. Claude can now work in this file."
3. Reload the browser page. It should now say `Plugin connected: yes`.
4. Ask Claude *"Check the Figma bridge status."* It answers with your file and page name.

---

## Using it day to day

1. Open the Figma file you want Claude to work in. A separate working file or a duplicated page is a good idea.
2. Run **Plugins → Development → Claude Bridge**. To run it again later, use **Plugins → Development**, the recent plugins list, or Cmd+Option+P / Ctrl+Alt+P.
3. **Keep the plugin window open** while Claude works. Closing it disconnects Claude. You can move or collapse the window.
4. Ask Claude for what you want in plain words.

The plugin window shows:

| Element | Meaning |
|---|---|
| 🟢 green dot | Connected to the bridge |
| 🟠 amber dot | Connecting |
| 🔴 red dot | Not connected. It retries every 2 seconds on its own. |
| Log | Each command Claude sends (`run_code`, `screenshot`, …) and any errors |
| Port / Reconnect | Change the port, or force a reconnect |

### Example requests

- *"Check the Figma bridge status and list the pages."*
- *"On a new page called 'Explorations', draw a 390×844 mobile sign-in screen using Inter, then take a screenshot and fix anything that looks off."*
- *"Look at my selection and tell me which text layers aren't using our type scale (12/14/16/20/24/32)."*
- *"Rename every top-level frame on this page to 'Screen / <current name>'."*
- *"Duplicate the selected frame and make a dark-mode version next to it."*
- *"Convert the selected group into an auto layout frame with 16px padding and 12px gap."*
- *"Link the 'Continue' button on Login to the Home frame with a Smart Animate transition."*

Claude usually calls `status` first, uses `run_code` to draw, then `screenshot` to check the result. When it finishes, it uses `focus` to zoom your view to what changed.

### Tips

- **Save a version first.** Before a big change, use **File → Save to version history** so you can always go back.
- **Point Claude at layers.** Select layers in Figma and say "the selection", or paste a layer link. Claude can read `node-id` from a Figma URL.
- **One Figma window.** If the plugin runs in two Figma files, the one started last takes over the connection.

---

## Tool reference

Claude sees these tools. With some clients they're prefixed with the server name, e.g. `figma-bridge__run_code`.

| Tool | Parameters | What it does |
|---|---|---|
| `status` | — | Is the plugin connected? Returns `connected`, `role` (hub/relay), `port`, `version`, `file`, `page`, `editorType`, `selection` (count). |
| `run_code` | `code` (string, required), `timeout_ms` (default 60000) | Runs JavaScript in the plugin with the full Figma Plugin API. Returns `{ value, logs }`. |
| `screenshot` | `node_id`, `scale` (default 1), `max_size` (default 1600) | Exports a node (or the first selected layer) as PNG and returns it as an image. The longest side is capped at `max_size`. |
| `get_selection` | `depth` (default 2) | Describes the current selection: ids, names, types, positions, sizes, text, children. |
| `get_tree` | `node_id`, `depth` (default 2) | Layer tree of a node, or of the current page. |
| `list_pages` | — | All pages, plus the current one. |
| `set_page` | `page_id` or `name`, `create` | Switches page. With `create: true`, a missing page is created. |
| `build` | `spec` (object or array), `parent_id` | Creates layers from a JSON description, no code needed. |
| `delete_nodes` | `ids` | Deletes layers. Pages and the document are never deleted. |
| `focus` | `ids` | Switches to the right page, selects the layers and zooms the viewport to them. |

### `run_code` in detail

`code` is the **body of an async function** with these variables in scope:

| Name | What it is |
|---|---|
| `figma` | The Figma Plugin API |
| `log(...args)` | Collects debug lines. They come back in `logs`. |
| `h.solid('#RRGGBB', opacity?)` | Returns a solid paint array for `fills` / `strokes` |
| `h.hex('#RRGGBB')` | Returns `{ r, g, b }` in 0–1 |
| `await h.font(family, style?)` | Loads a font and returns the `FontName` |
| `h.svg(markup, width?)` | Creates a node from SVG, optionally scaled to `width` |
| `h.paints(v)` | `'#RRGGBB'`, `'#RRGGBB@0.5'`, a Paint, or an array of either → Paint[] |
| `h.summary(node, depth?)` | Returns a small JSON description of a node |

Return values are converted to JSON:

- Nodes become `{ id, name, type, x, y, width, height, … }`.
- `undefined` becomes `null`, and functions become `"[function]"`.
- Nesting is cut at depth 4, arrays at 500 items, objects at 200 keys.

Example:

```js
await figma.loadFontAsync({ family: "Inter", style: "Bold" });
const card = figma.createFrame();
card.name = "Card";
card.resize(358, 200);
card.cornerRadius = 20;
card.fills = h.solid("#15121F");
card.layoutMode = "VERTICAL";
card.paddingTop = card.paddingBottom = card.paddingLeft = card.paddingRight = 16;

const t = figma.createText();
t.fontName = { family: "Inter", style: "Bold" };
t.characters = "Daily Lucky Bonus";
t.fontSize = 20;
t.fills = h.solid("#F5F3FF");
card.appendChild(t);

figma.currentPage.appendChild(card);
figma.viewport.scrollAndZoomIntoView([card]);
log("created", card.id);
return card;
```

### `build` spec

A quick way to create layers without writing code. Each item:

```jsonc
{
  "type": "FRAME",              // FRAME | TEXT | RECTANGLE | ELLIPSE | SVG | SECTION | LINE
  "name": "Screen",
  "x": 0, "y": 0,
  "size": [390, 844],
  "fill": "#0A0912",            // '#RRGGBB', '#RRGGBB@0.5', a Paint or Paint[]
  "stroke": "#FFFFFF@0.1",
  "radius": 16,
  "layout": {                   // FRAME only: turns on auto layout
    "mode": "VERTICAL",         // or HORIZONTAL
    "gap": 12,
    "padding": [16, 16],        // number | [vertical, horizontal] | [top, right, bottom, left]
    "align": "MIN",             // counter axis: MIN | CENTER | MAX
    "justify": "MIN",           // main axis: MIN | CENTER | MAX | SPACE_BETWEEN
    "w": 390,                   // HUG | FILL | number
    "h": "HUG"
  },
  "text": "Hello",              // TEXT only
  "font": { "family": "Inter", "style": "Bold" },
  "fontSize": 20,
  "color": "#F5F3FF",
  "svg": "<svg …>…</svg>",      // SVG only
  "fillWidth": true,            // stretch to the parent's width (auto layout parent)
  "props": { "opacity": 0.9 },  // any other node property
  "children": [ /* more specs */ ]
}
```

`build` returns the root ids and how many layers it created. New frames are transparent unless you give them a `fill`.

---

## Writing good `run_code`

These notes are for people and agents writing code for the bridge. Most of them are Figma quirks we ran into in real files.

- **Pages load on demand.** The plugin uses `documentAccess: "dynamic-page"`, so:
  - Use `await figma.getNodeByIdAsync(id)` rather than `getNodeById`.
  - Call `await page.loadAsync()` before reading another page's children.
  - Switch pages with `await figma.setCurrentPageAsync(page)`.
- **Load fonts before touching text:** `await figma.loadFontAsync({ family, style })`. Style names differ per family ("SemiBold" vs "Semi Bold"). Use `await figma.listAvailableFontsAsync()` to check.
- **Never call `figma.closePlugin()`.** It closes the bridge, and the user has to run the plugin again.
- **Empty auto layout frames don't shrink.** A new frame is 100×100. If it has auto layout set to hug but **no children** (a spacer, for example), Figma keeps it at 100×100. Resize it first (`f.resize(0.01, 0.01)`) or give it a fixed size.
- **`globalThis` persists while the plugin is open.** Store a helper library once (`globalThis.lib = { … }`) and reuse it in later calls instead of resending big code.
- **Long jobs:** the default timeout is 60 s (`timeout_ms` raises it). Some clients also have their own limit. Cowork's link to your computer, for example, gives up after about 60 s. For long builds, start the work in the background and poll:

  ```js
  // call 1: start
  globalThis.jobs = globalThis.jobs || {};
  const job = (globalThis.jobs.build = { status: "running", started: Date.now() });
  (async () => {
    try { /* … long work … */ job.status = "done"; }
    catch (e) { job.status = "error"; job.error = String(e); }
  })();
  return "started";
  ```

  ```js
  // call 2, 3, …: check
  return globalThis.jobs.build;
  ```
- **Big payloads are fine.** Code over 300 KB and screenshots over 4 MB are tested. Still, sending a library once and reusing it is faster.
- **Pages with newer node types:** reading `.children` on a page that contains node types the Plugin API doesn't support yet can throw (e.g. `unsupported type in createVMObject: SPEC_BLOCK`). If that happens, build on a new page and leave that page alone.
- **Check visually.** After drawing, call `screenshot` with a `max_size` that fits the detail you need, look for overflow or clipping, then fix.

---

## How it works

```
Claude (any MCP client)
   │  JSON-RPC over stdio
   ▼
server/index.js  ── hub on 127.0.0.1:3055 ◄── /relay ── other server copies (more Claude windows)
   │  WebSocket, ws://localhost:3055
   ▼
figma-plugin/ui.html   (plugin UI iframe: the only part allowed to open a connection)
   │  postMessage
   ▼
figma-plugin/code.js   (plugin main thread: runs commands with the Figma Plugin API)
```

1. Your MCP client starts `server/index.js` and talks to it with JSON-RPC over stdio.
2. The server opens an HTTP + WebSocket server on `127.0.0.1:3055` (and `[::1]:3055` when available).
3. The plugin's UI (`ui.html`) connects to `ws://localhost:3055`. Plugin code can't open network connections itself, so the UI iframe does that and passes messages to the main thread (`code.js`), which has the Plugin API.
4. A tool call becomes `{ id, command, params }` → plugin → `{ type: "result", id, ok, result | error }` back.

**Several Claude processes.** Each Claude window, Cowork session or Claude Code instance may start its own copy of the server:

- The first copy to bind the port becomes the **hub** and talks to the plugin.
- Later copies see the port is taken, check that it's a compatible bridge (via `GET /`), and connect to `/relay` as **relays**. Their tool calls are forwarded through the hub.
- If the hub exits, a relay takes over the port within a few seconds, and the plugin reconnects by itself.
- If an **older** bridge (1.0.x) is holding the port, newer copies report it instead of fighting over the port.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Plugin dot stays **red**, "Not connected" | The server isn't running. Make sure Claude is open and was **fully restarted** (Cmd+Q) after setup. Open <http://localhost:3055> to check. If the page doesn't load, the MCP config is wrong. Check the paths, and on Windows the `\\` escaping. |
| <http://localhost:3055> works but the dot is red | Is the port in the plugin's **Port** field 3055 (or your custom port), and does `manifest.json` allow it? Press **Reconnect**. |
| Claude says "The Figma plugin is not connected" | Run **Plugins → Development → Claude Bridge** in the file you want, and keep its window open. |
| Figma error: *"This plugin template uses TypeScript…"* | You created a new plugin from Figma's template instead of importing this one. Remove it, then **Import plugin from manifest…** and pick this repo's `figma-plugin/manifest.json`. |
| "Import plugin from manifest" is missing | You're in the browser. Use the Figma **desktop app**. |
| Claude says *"could not open port 3055"* or *"port 3055 is used by another program"* | Something else is using the port. Pick another port (see [Using a different port](#using-a-different-port-optional)). |
| Claude says an *"older bridge"* is running | A 1.0.x copy is still running, often one started by hand in a Terminal window. Close that window or press Ctrl+C there, then try again. |
| `run_code` times out | Split the work or use the background-job pattern in [Writing good `run_code`](#writing-good-run_code). Also check that Figma isn't showing a modal dialog. |
| Text errors like *"unloaded font"* | Load the exact font family and style first. Use `figma.listAvailableFontsAsync()` to see what's installed. |
| Tools don't show up in Claude | Claude desktop: check **Settings → Developer** for errors from `figma-bridge`. Claude Code: run `claude mcp list` and `/mcp`. Test the server by hand: `node server/index.js` (Ctrl+C to stop). |

To run the server by hand for debugging:

```bash
node ~/claude-figma-bridge/server/index.js
# [figma-bridge] hub listening on ws://127.0.0.1:3055
```

Logs go to stderr with the `[figma-bridge]` prefix. stdout is reserved for MCP. Claude desktop keeps MCP logs at `~/Library/Logs/Claude/` (macOS) or `%APPDATA%\Claude\logs\` (Windows).

---

## Security

- The server binds only to `127.0.0.1` and `::1`. It is not reachable from your network.
- The plugin's manifest allows network access only to `localhost:3055` (`devAllowedDomains`). It can't reach the internet.
- `run_code` lets Claude run **any** Plugin API code in the open file: read, change or delete layers. Use the bridge on files you're comfortable letting Claude edit, keep version history, and close the plugin when you're done.
- Any program on your own computer that can reach `localhost:3055` could also send commands while the plugin is open. Close the plugin when you're not using it.

---

## Uninstall

1. Remove the `figma-bridge` entry from your client config:
   - Claude desktop: the `claude_desktop_config.json` file listed above.
   - Claude Code: `claude mcp remove figma-bridge`.
2. Delete the folder: `~/claude-figma-bridge` if you used the installer, and/or your clone.
3. In Figma: open **Plugins → Manage plugins…**, find **Claude Bridge** under the in-development plugins and remove it.
4. Restart Claude.

---

## Development

```
claude-to-figma/
├── server/index.js          MCP server + WebSocket hub/relay (zero dependencies)
├── figma-plugin/
│   ├── manifest.json        Plugin manifest (dynamic-page, localhost-only network access)
│   ├── code.js              Main thread: runs commands with the Plugin API
│   └── ui.html              Plugin window: WebSocket client + status and log
├── install-mac.sh           macOS installer for Claude desktop
├── test/
│   ├── plugin.test.js       code.js handlers against a strict mock Figma API
│   ├── server.test.js       MCP protocol, big payloads, concurrency, disconnects
│   ├── multi.test.js        hub + relays, failover, old-version detection
│   └── ui-e2e.py            Full chain through ui.html in real Chromium (Playwright)
└── package.json
```

Run the tests:

```bash
npm test              # Node 22+ (uses the built-in WebSocket client)
npm run test:ui       # optional, needs: pip install playwright && python -m playwright install chromium
```

The tests use ports 3997–3999, so they don't touch a bridge running on 3055.

**Wire protocol** (server ↔ plugin UI, JSON text frames):

```jsonc
// plugin → server, on connect
{ "type": "hello", "info": { "file": "…", "page": "…", "editorType": "figma" } }
// server → plugin
{ "id": 7, "command": "run_code", "params": { "code": "return 1" } }
// plugin → server
{ "type": "result", "id": 7, "ok": true, "result": { "value": 1, "logs": [] } }
{ "type": "result", "id": 7, "ok": false, "error": "message" }
```

Relays connect to `ws://127.0.0.1:<port>/relay` and send `{ type: "call", id, command, params, timeout }` or `{ type: "status", id }`. They receive `{ type: "reply", id, ok, result | error }`.

**Adding a command:**

1. Add a handler to `handlers` in `figma-plugin/code.js`.
2. Add a tool to `TOOLS` in `server/index.js` that calls `callPlugin("<command>", params)`.
3. Add a test in `test/plugin.test.js`.

**Releasing:** bump `VERSION` in `server/index.js` and `version` in `package.json` together. Relays use the hub's version string to detect old bridges.
