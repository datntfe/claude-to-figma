# Claude to Figma (Claude Bridge)

**English** · [Tiếng Việt](README.vi.md)

Let Claude work directly in the Figma file you have open: draw screens, edit layers, run any Figma Plugin API code, and take screenshots to check its own work.

```
Claude ──(MCP, stdio)──► server/index.js ──(WebSocket, localhost only)──► "Claude Bridge" plugin in Figma desktop
```

- **Knows what you're working on.** Claude reads your selection (and the text you're editing), the part of the canvas on your screen, and what you did in the last minutes, so "fix this" and "make one like here" just work.
- **Sees what you see.** `screenshot` exports a layer, the area around your selection, or exactly what's on your screen.
- **Variables, styles and libraries.** Create and edit variables, modes and aliases, bind them to layers, create styles, use and import library components, styles and variables.
- **Shaders.** List the shaders available to the file and apply them as a fill, stroke or effect, with their properties set by name (colours, numbers, points, gradients, variables).
- **Tidy and polish, check designs.** `audit_design` finds default names, hard-coded values that match a variable, off-grid spacing, half pixels, low text contrast and more, and fixes the safe ones. `update_nodes` changes many layers in one go: text, styles, variants, auto layout, prototype links.
- **Your computer too.** Put images from a folder or a link into the design, and export icons and screens straight into a code project.
- **Several files at once.** Keep the plugin open in a library file and a product file together; Claude works in both.
- **Quick actions.** Ready-made prompts (Tidy and polish, Check design, Generate a design, Rewrite or translate text, Edit variables, Make a prototype, Hand off to code, Edit a library).
- **Full Plugin API.** Anything a Figma plugin can do, Claude can do through `run_code`.
- **No dependencies, local only.** The server is one Node.js file (Node 18+) that listens on `127.0.0.1` / `::1`; the plugin is plain JavaScript. Several Claude windows (desktop, Cowork, Claude Code) share one connection.

---

## Contents

1. [Requirements](#requirements)
2. [Quick start (macOS + Claude desktop)](#quick-start-macos--claude-desktop)
3. [Setup in detail](#setup-in-detail)
4. [Using it day to day](#using-it-day-to-day)
5. [Quick actions](#quick-actions)
6. [Libraries and several files](#libraries-and-several-files)
7. [Tool reference](#tool-reference)
8. [Writing good `run_code`](#writing-good-run_code)
9. [How it works](#how-it-works)
10. [Troubleshooting](#troubleshooting)
11. [Security](#security)
12. [Uninstall](#uninstall)
13. [Development](#development)

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

1. With Claude open, visit <http://localhost:3055> in a browser. You should see `Claude Figma bridge 1.3.0 is running. Plugin connected: no`.
2. In Figma, run **Plugins → Development → Claude Bridge**. The dot turns **green**: "Connected: Claude can work in “your file”."
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

- *"What am I working on? Make the card I selected consistent with the others on screen."*
- *"Tidy and polish this frame."* · *"Check this screen for contrast and design-system problems."*
- *"Translate all the text in the selected screens to English, keep it short."*
- *"Add a Dark mode to the Theme collection and fill it from the gray scale."*
- *"Design a reward popup with our Button and Card components and our color variables, next to the Home screen."*
- *"Put the photos from ~/Pictures/pets into the four cards."* · *"Export the icons on this page as SVG into ~/code/app/assets/icons."*
- *"Link every 'Continue' button to the next screen with Smart Animate."*

Claude usually calls `get_context` to see what you mean, works with the tools below, then takes a `screenshot` to check the result and uses `focus` to zoom your view to what changed.

### Tips

- **Every Claude change is one Cmd+Z.** Each tool call is its own undo step in Figma. Before a big change, Claude can also save a named version (`save_version`) so you can go back in version history.
- **Point Claude at layers.** Select layers, put the area you mean on screen, or paste a layer link. Claude reads your selection, your screen and your recent edits (from the moment the plugin was opened).
- **Several files.** The plugin can be open in several Figma files at once; see [Libraries and several files](#libraries-and-several-files).

---

## Quick actions

The bridge offers ready-made prompts, like the suggestions in Figma's own agent. In Claude desktop chat they're in the **+** menu under *figma-bridge*; in Claude Code they're slash commands such as `/mcp__figma-bridge__tidy`. You can also just ask in your own words: Claude reads the same playbooks from the tool descriptions.

| Prompt | What Claude does |
|---|---|
| **context** — What am I working on? | Looks at your selection, your screen and recent edits, and asks what you want to do. |
| **tidy** — Tidy and polish | Audits the selection, applies the safe fixes (bind matching variables, whole pixels), names layers, snaps spacing, adds auto layout where it helps, shows before/after. |
| **check** — Check design | Contrast (WCAG AA), design-system usage and polish report. Changes nothing. |
| **design** — Generate a design | Learns your components, styles and variables, then builds the design with them. |
| **text** — Rewrite or translate | Collects every text layer, rewrites or translates them in one batch, checks for overflow. |
| **tokens** — Edit variables | Plans and applies variable changes with a restore point, then binds layers. |
| **prototype** — Make a prototype | Links buttons to screens with transitions, back actions and overlays. |
| **handoff** — Hand off to code | Exports assets into your project and writes the code with your tokens. |
| **library** — Edit a library | Walks through changing a library file safely and reminds you to publish. |

---

## Libraries and several files

- **Library items are read-only where they're used.** In a product file, Claude can list, use, bind and import library variables, styles and components, but not change them. That's how Figma works for every plugin.
- **To change a library, open the library file** and run Claude Bridge there too. Claude Bridge can be open in several files at the same time: the library and the product files. Claude then edits the library file directly (variables, modes, styles, components) and you **publish** it from the Assets panel. Publishing and accepting updates stay manual in Figma.
- **Which file?** Reads go to the file you were last active in (selected, edited, scrolled or switched to). When several files are open, changes need the file's name (`file: "Savepet DS"`), so nothing lands in the wrong file. `status` lists the open files.
- **Library variables need the library enabled.** Claude sees variables from libraries enabled for the file (Assets panel → Libraries). Library components and styles that aren't used in the file yet can be imported by key.

---

## Tool reference

Claude sees these tools. With some clients they're prefixed with the server name, e.g. `figma-bridge__run_code`. Every tool also takes `file`, to pick a file when the plugin is open in several (see [Libraries and several files](#libraries-and-several-files)).

**Seeing what you work on**

| Tool | Parameters | What it does |
|---|---|---|
| `status` | — | Is the plugin connected? `role` (hub/relay), `port`, `version`, `file`, `page`, `selection` (count), `plugin_version`, the open `files` when there are several, and `notes` when something needs updating. |
| `get_context` | `activity` (default 15), `since_seconds`, `depth` (default 2), `max_layers` | What you're looking at and doing: file, page, selection (and text being edited), the viewport (zoom, bounds, the frame in focus at the centre of the screen, the layers in view) and recent activity (select, edit, create, delete, page, viewport, styles; by you, a collaborator or Claude). |
| `get_selection` | `depth` (default 1), `brief` | Full details of each selected layer: path, position, size, fills/strokes as hex, radius, effects, auto layout and sizing, text and typography, styles, bound variables, variable modes, component info (main component, variant, key, library or local, property values), plus the colours in the selection. |
| `screenshot` | `node_id`, `viewport`, `scale`, `max_size` (default 1600) | An image of a layer; or with `viewport: true` exactly what's on your screen. No arguments: the selected layer, the area around several selected layers, or your screen. |
| `get_tree` | `node_id`, `depth` (default 2) | Layer tree of a node, or of the current page. |
| `find_nodes` | `scope` (page/selection/file) or `node_id`, `type`, `name`, `text`, `component`, `limit` | Search layers by type, name (or `/regex/`), text content or component; flat list with ids, paths, text, fonts and text styles. |
| `list_pages` | — | All pages, plus the current one. |

**Changing things**

| Tool | Parameters | What it does |
|---|---|---|
| `update_nodes` | `items: [{ id \| ids, …changes }]`, `save_version` | Batch edits without code: name, text, font, size, colours, strokes, radius, effects, styles, auto layout (incl. `mode: "AUTO"` inferred from positions), sizing, variables (`'{name}'`), modes, variant, component properties, swap, prototype `link`, `shader`, any other property, remove. |
| `audit_design` | `node_id` or `scope`, `checks`, `fix`, `grid` (default 4) | Design check: default names, values that match a variable, hard-coded colours, text without style, half pixels, off-grid spacing, WCAG contrast, small tap targets, hidden/empty layers, frames without auto layout. `fix: ["bind","round","autolayout"]` applies the safe fixes. |
| `build` | `spec` (object or array), `parent_id` | Creates layers from a JSON description, including instances of local or library components, `'{variable}'` values, styles, modes, shaders and prototype links. |
| `run_code` | `code` (string, required), `timeout_ms` (default 60000) | Runs JavaScript in the plugin with the full Figma Plugin API. Returns `{ value, logs }`. |
| `set_page` | `page_id` or `name`, `create` | Switches page. With `create: true`, a missing page is created. |
| `delete_nodes` | `ids` | Deletes layers. Pages and the document are never deleted. |
| `focus` | `ids` | Switches to the right page, selects the layers and zooms the viewport to them. |

**Variables, styles and libraries**

| Tool | Parameters | What it does |
|---|---|---|
| `get_variables` | `collection`, `query`, `type`, `library`, `values`, `ids`, `limit` | Local collections, modes and every value per mode (hex colours, `{aliases}`), scopes, code syntax; with `library: true` also the variables of enabled libraries (with keys). |
| `set_variables` | `ops`, `save_version` | Batch: create/rename/delete collections and modes, create or update variables (values per mode, aliases, scopes, code syntax, description, hidden), rename, delete. Stops at the first error and reports before → after values. |
| `bind_variables` | `bindings`, `modes`, `save_version` | Bind variables (local or library, by name) to fills, strokes, sizes, spacing, padding, radius, opacity, visibility, text and typography; set or reset a frame's mode per collection. |
| `get_library` | `kind`, `query`, `used_remote`, `limit` | Local styles with values, local components and sets (keys, variants, properties), variable collections (local and library), shaders (with their properties once imported), and the library components used on the page. |
| `set_styles` | `ops`, `save_version` | Create, update, rename or delete paint, text, effect and grid styles; bind style colours and typography to variables. |
| `import_from_library` | `kind`, `key`, `place`, `variant`, `parent_id`, `x`, `y` | Import a published variable, style, component or component set by key; components are placed as instances. |

**Files on your computer**

| Tool | Parameters | What it does |
|---|---|---|
| `place_image` | `source` (path, https link or data: URL), `node_id`, `add`, `parent_id`, `x`, `y`, `width`, `height`, `scale_mode` | PNG/JPEG/GIF become image fills (on a layer or a new rectangle); SVG files become vector layers. |
| `export_nodes` | `ids` (default selection), `format` (PNG/JPG/SVG/PDF), `scale`, `dir`, `overwrite` | Writes the exports into a folder (default `~/Figma Exports/<file>`) and returns the paths. |

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
| `h.color('#RRGGBBAA')`, `h.toHex(color)` | Hex ↔ `{ r, g, b, a }` |
| `await h.describe(node)` | Full details, as in `get_selection` |
| `await h.variable(name, collection?)` | A `Variable` by name (local, or imported from an enabled library) |
| `await h.bind(node, field, name)` | Binds a variable, e.g. `h.bind(card, 'fill', 'color/surface')` |
| `await h.update(node, changes)` | Applies the same changes as one `update_nodes` item |
| `await h.link(node, target, opts?)` | Prototype link (`'back'`, a node or id; `{ transition, duration }`) |
| `await h.component(nameOrKey, variant?)` | A component to instantiate (local name or `key:…`) |
| `await h.shader(node, spec)` | Applies a shader, as `shader` in `update_nodes` (`null` removes them) |

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

Using the design system:

```jsonc
{
  "type": "FRAME", "name": "Reward", "size": [390, 844],
  "fill": "{color/bg/surface}",                    // '{name}' binds a variable (local or library)
  "layout": { "mode": "VERTICAL", "gap": "{space/4}", "padding": 16, "w": 390, "h": 844 },
  "modes": { "Theme": "Dark" },                    // variable mode for this frame
  "children": [
    { "component": "Button", "variant": "Size=L, State=Default", "properties": { "Label": "Claim" }, "link": "Done" },
    { "component": "key:5f1c…", "name": "Card" },  // a library component by key
    { "type": "TEXT", "text": "Daily bonus", "textStyle": "Heading/M", "color": "{color/text/primary}" }
  ]
}
```

`build` returns the root ids and how many layers it created. New frames are transparent unless you give them a `fill`. `link` can name another layer created in the same call.

### Shaders

`get_library` with `kind: "shaders"` lists the shaders available to the file: the ones in it, from enabled libraries and your own. `update_nodes` and `build` apply one with `shader`:

```jsonc
{ "id": "12:34", "shader": { "name": "Film grain", "properties": { "Amount": 0.4, "Tint": "#7C3AED80" } } }
{ "id": "12:35", "shader": { "name": "Mesh gradient", "properties": { "Colors": ["#0A0912", "#7C3AED"], "Center": [0.5, 0.3], "Glow": "{color/brand}" } } }
{ "id": "12:35", "shader": null }   // remove every shader from the layer
```

- A shader is imported into the file the first time it's used. Its properties are then listed by `get_library`, and the first `update_nodes` result names them.
- Properties go by name. Values: `'#RRGGBB'` or `'#RRGGBBAA'` for colours, numbers, `true`/`false`, `[x, y]` for points, a list of colours (or `{position, color}` stops) for gradients, and `'{variable}'` to bind a variable.
- Effect shaders go on `effects`; fill shaders go on `fills` (on top of the paints already there) or, with `target: "stroke"`, on `strokes`. `replace: true` keeps only the shader, `remove: true` removes that one shader, and applying a shader the layer already has updates its properties.
- Figma's Plugin API can apply shaders but not write new ones: make or add the shader in Figma first.

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
- If an **older** bridge (1.0.x) is holding the port, newer copies report it instead of fighting over the port. A 1.1 hub still works with 1.2 relays and plugins for one file; calls that name another file are refused until Claude is restarted, and `status` says so.

**Several Figma files.** The hub keeps one connection per file that has the plugin open. A call goes to the file named in `file`, otherwise to the file with the most recent user activity. The plugin reports activity (selection, edits, page changes, scrolling and zooming, bringing the tab to the front) but never Claude's own changes. When different files are open, changing tools refuse to guess and ask for `file`.

**What the plugin keeps track of.** While it is open, the plugin keeps the last 300 events in memory: selections, page changes, edits/creates/deletes on the current page (`PageNode` `nodechange`), style changes and viewport moves, each tagged as yours, a collaborator's or Claude's. Nothing is stored in the file or sent anywhere unless Claude asks with `get_context`.

**Screenshots of your screen.** To render exactly what's in view, the plugin puts a temporary rectangle (filled with the canvas colour) under everything on the page at the viewport bounds, exports it with `contentsOnly: false` (which draws every overlapping layer), and removes it right away.

**Undo.** The plugin calls `figma.commitUndo()` after each changing command, so every Claude action is a separate Cmd+Z step.

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
| `status` notes: *"another Claude window started an older bridge"* | You updated the files but an old copy still owns the port. Quit Claude completely (Cmd+Q) and open it again. |
| Claude says the plugin *"is an older version and doesn't know …"* | Figma is still running the old plugin code. Close the Claude Bridge window in Figma and run it again. |
| *"Reading team libraries needs the teamlibrary permission"* | Same: re-run the plugin so Figma loads the updated `manifest.json`. |
| *"macOS did not let Claude access …"* (images or exports) | Allow Claude in System Settings → Privacy & Security → Files and Folders, or use a folder directly in your home folder. |
| A rectangle named *"Claude capture (temporary)"* stays on the page | A screen capture was interrupted. Delete it; the plugin also removes leftovers when it starts. |
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
- Web pages can't use it either: browsers always send an `Origin` header with WebSockets, and the server only accepts the plugin window (origin `null` or `figma.com`) and other copies of itself (no origin).
- The plugin's manifest allows network access only to `localhost:3055` (`devAllowedDomains`). It can't reach the internet.
- `run_code` lets Claude run **any** Plugin API code in the open file: read, change or delete layers. Use the bridge on files you're comfortable letting Claude edit, keep version history, and close the plugin when you're done.
- `place_image` reads the image file or link Claude is given, and `export_nodes` writes files into the folder Claude is given. Both run with your user's permissions on your computer, only when Claude calls them.
- The activity log lives in the plugin's memory and disappears when you close the plugin.
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
│   ├── manifest.json        Plugin manifest (dynamic-page, teamlibrary, localhost-only network access)
│   ├── code.js              Main thread: runs commands with the Plugin API, keeps the activity log
│   └── ui.html              Plugin window: WebSocket client + status and log
├── install-mac.sh           macOS installer for Claude desktop
├── test/
│   ├── plugin.test.js       code.js handlers against a strict mock Figma API (variables, libraries, viewport, activity…)
│   ├── server.test.js       MCP tools and prompts, several files, big payloads, local images and exports
│   ├── multi.test.js        hub + relays, failover, two files through relays, old-version detection
│   └── ui-e2e.py            Full chain through ui.html in real Chromium (Playwright), two plugin windows
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
{ "type": "hello", "info": { "file": "…", "fileKey": "…", "page": "…", "editorType": "figma", "version": "1.3.0", "session": "…" } }
// plugin → server, while open
{ "type": "info", "info": { "page": "…" } }          // page changed
{ "type": "activity", "what": "select" }               // the user did something here (at most once a second)
// server → plugin
{ "id": 7, "command": "run_code", "params": { "code": "return 1" } }
// plugin → server
{ "type": "result", "id": 7, "ok": true, "result": { "value": 1, "logs": [] } }
{ "type": "result", "id": 7, "ok": false, "error": "message" }
```

Relays connect to `ws://127.0.0.1:<port>/relay` and send `{ type: "call", id, command, params, timeout, target?, write? }` or `{ type: "status", id }`. They receive `{ type: "reply", id, ok, result | error, file?, files? }`.

**Adding a command:**

1. Add a handler to `handlers` in `figma-plugin/code.js` (and to `MUTATING` if it changes the file, so it becomes one undo step).
2. Add a tool to `TOOLS` in `server/index.js` that calls `callPlugin("<command>", params, timeout, a.file, write)`.
3. Add a test in `test/plugin.test.js`.

**Releasing:** bump `VERSION` in `server/index.js` and `version` in `package.json` together. Relays use the hub's version string to detect old bridges.
