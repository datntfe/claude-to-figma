# Changelog

## 1.4.0

A review council compared the bridge with [figwright](https://github.com/awdr74100/figwright) (MIT) and picked what makes it better for designers: you see and control what Claude does, reads for code go deep, and the connection holds up.

- **See what Claude did.** The plugin window is now a timeline: one row per call with a plain summary ("Created 14 layers"), duration, a "↶ 1 undo" badge on changes, the request and result on click, and a **Show** button that selects and zooms to the layers it touched. After each change Figma shows a toast ("Claude: Changed 6 layers · Cmd+Z to undo") with Show. **Changes only** filter, **Copy log**, **Save version** ("Before Claude · 14:32"), and a resizable window that remembers its size.
- **One change at a time.** Changes to a file run one after another (reads don't wait), each its own Cmd+Z, even when several calls arrive together. **Allow changes** in the panel lets Claude look but not touch; `status` shows when it's off.
- **`get_spec`: read a design for code.** Every layer under the selection with CSS-ready values (px, hug/fill, flexbox, constraints, borders, dashes, shadows with a `boxShadow` string, blurs, gradients with their CSS angle), typography in px with styled runs for mixed text and links, components with variant and props, icons as one layer, repeated identical instances listed once, `{token}` references, and tables of the tokens (code syntax, value per mode), styles and components used. Big frames return a plan of sections. The `handoff` prompt uses it.
- **New work lands beside yours.** `build`, `place_image` and `import_from_library` put new top-level layers right of the selection or the frame on screen, overlapping nothing (`position: "auto"`; `"viewport"` and `"origin"` keep the old behaviour). Results include `placed_at`.
- **Lighter for Claude.** Compact JSON, results capped at about 20K tokens (`FIGMA_BRIDGE_MAX_TOKENS`) with a note on what was left out and how to get the rest; `get_tree` `max_nodes` (level by level); `offset`/`next_offset` on `find_nodes` and `get_variables`; MCP tool annotations (read-only tools can be always-allowed); a smaller tool catalog despite the new tool; figma.com links and `12-34` ids accepted for node ids (a link also picks its file); clearer not-found errors.
- **Safer connection.**
  - An answer is only accepted from the file the command was sent to, and command ids are random.
  - A change that times out is reported as "may still have been applied"; its late answer is reported with the next reply. A change still queued when Claude stops waiting is dropped.
  - A plugin that drops without closing gets 15 seconds to come back and its calls carry on; meanwhile changes without `file` don't land in the other open file.
  - Half-closed connections are noticed at once; silent ones are closed after about a minute; sleep/wake doesn't count as silence.
  - `Host` header check against DNS rebinding, a 10-second hello timeout, a 256 MB message cap, frames joined in linear time (big exports are faster), exports can't leave their folder, and bad input on stdin can't stop the server.
- Shadows built by Claude no longer show through translucent fills (`showShadowBehindNode` defaults to false, like CSS).
- `design` prompt: auto layout with hug/fill, section by section, and Vietnamese typography (fonts with Vietnamese glyphs, line height ≥ 1.3×, room for longer copy).
- `test/smoke.test.js`: the server starts and lists its tools on Node 18 (also part of `npm test`).

## 1.3.0

- **Shaders:** `update_nodes` and `build` apply shaders with `shader`: by name, as a fill, stroke or effect, with properties set by name (colours, numbers, booleans, points, gradients, `'{variable}'`). A shader is imported on first use, applying it again updates it, and `shader: null` removes them. `get_library` lists each shader's properties once it's imported, and `get_selection` shows applied shaders by name. Figma's Plugin API can't write new shaders, so they're made or added in Figma.
- `h.shader(node, spec)` for `run_code`.
- `status` also tells you when the plugin is newer than the bridge (quit and reopen Claude).
- README: a cover image (`assets/cover.png`, 1280×640 at 2x), also usable as the GitHub social preview.

## 1.2.0

Claude can now see what you're working on, work with variables, styles and libraries, and do the jobs Figma's own agent offers.

- **What you're working on:** `get_context` (selection and text being edited, the viewport with the frame in focus and the layers in view, and a log of recent activity by you, collaborators and Claude), a much richer `get_selection` (paints as hex, styles, bound variables, modes, auto layout, typography, component and variant info), and `screenshot` of exactly what's on your screen or around several selected layers.
- **Variables:** `get_variables`, `set_variables` (collections, modes, values per mode, aliases, scopes, code syntax; before → after report), `bind_variables` (fills, strokes, spacing, radius, typography… and frame modes).
- **Styles and libraries:** `get_library` (local styles, components, variable collections, shaders, library components used on the page), `set_styles`, `import_from_library`. Library variables can be bound by name and are imported automatically.
- **Tidy and polish:** `audit_design` (default names, values that match a variable, hard-coded colours, text without style, half pixels, off-grid spacing, WCAG contrast, small tap targets, hidden/empty layers, missing auto layout) with safe auto-fixes, and `update_nodes` for batch changes (text, styles, variables, auto layout inferred from positions, variants, properties, swaps, prototype links).
- **Search:** `find_nodes` by type, name, text or component.
- **Generate with the design system:** `build` now places component instances (local or library), binds `'{variable}'` values, applies styles, modes and prototype links.
- **Your computer:** `place_image` (files, links, SVG) and `export_nodes` (PNG/JPG/SVG/PDF into a folder).
- **Quick actions:** MCP prompts `context`, `tidy`, `check`, `design`, `text`, `tokens`, `prototype`, `handoff`, `library`.
- **Several Figma files at once:** the hub keeps one connection per file (no more two plugin windows taking turns), every tool takes `file`, reads follow the file you were last active in, and changes need `file` when several files are open.
- Every changing command is its own undo step (`figma.commitUndo()`); `save_version` saves a restore point before big batches.
- `status` reports the plugin version, the open files, and tells you when the plugin or another Claude window still runs older code. While another Claude window still runs a 1.1 hub, the new tools work with one file; calls that name a different file are refused until Claude is restarted, and the plugin window backs off instead of fighting for the connection.
- **Security:** the bridge refuses WebSocket connections from websites (browsers always send an `Origin` header). Before this, a web page open in your browser could send commands to the plugin.
- Manifest: `teamlibrary` permission and `enablePrivatePluginApi` (file key for Figma links).

## 1.1.0

- Several Claude processes can share one plugin connection. The first server copy is the hub and later copies relay through it. A relay takes over automatically if the hub exits.
- Detects an older (1.0.x) bridge holding the port and says how to fix it, instead of failing with `EADDRINUSE`.
- `status` now reports the server role (hub/relay), port and version.
- `run_code` help warns never to call `figma.closePlugin()`.

## 1.0.0

- First version: zero-dependency MCP server, Figma development plugin, and macOS installer.
- Tools: `status`, `run_code`, `screenshot`, `get_selection`, `get_tree`, `list_pages`, `set_page`, `build`, `delete_nodes`, `focus`.
