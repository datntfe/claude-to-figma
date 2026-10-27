# Changelog

## 1.6.3

The log after 1.6.2 had no new bridge errors: what remained was code sent to Figma using its API wrongly, and a few `run_code` calls that ran for minutes.

- **Hints for the mistakes seen most.** The error text now ends with a fix for: `strokes`/`fills` given the wrong shape, `layoutGrow` other than 0 or 1, `layoutPositioning = ABSOLUTE` outside an auto-layout frame, `combineAsVariants` arguments and page, component sets with errors (the old hint missed the "for node" wording) and names the code never declared.
- **More Figma calls are watched** (images, local styles, variables, team library), so a slow `run_code` more often says what it waits on.
- **A `run_code` that is busy for a long time says so.** The panel shows "its own code is busy (a long loop?)" after 30 s, and the log and the 5-minute timeout message tell Claude to split the work, look at one frame instead of the page, and use `h.progress(i, n)` in loops (the Cancel button works then).

## Installer fix (after 1.6.2)

- Claude started the bridge with the exact node it found at install time (for example `~/.local/bin/node`). When that node moved or was removed, the bridge silently stopped starting and the plugin stayed red ("Not connected"). Claude now starts `server/start.sh`, which finds Node.js each time (Homebrew, `/usr/local`, `~/.local/bin`, nvm, volta, mise, asdf, or a login shell). Run `./install-mac.sh` once to switch an existing setup over; it also finds Node.js when it isn't on the PATH.

## 1.6.2

The log after 1.6.1 showed the same `run_code` timeouts. Claude hadn't been restarted, so the bridge was still 1.6.0, and some `run_code` calls never finished because they waited on something in Figma.

- **The plugin window says when the bridge is older than the plugin** ("Quit Claude completely (Cmd+Q) and open it again"). Bridge fixes only apply after that restart, and nothing showed it before.
- **A slow change says what it waits on.** After 15 s the panel row, and the `job` status Claude sees, show which Figma call it waits on ("waiting on figma.loadFontAsync(Be Vietnam Pro SemiBold) for 40s") or that the code itself is busy. After 50 s this goes to the log too.
- **A font load that never finishes becomes a clear error** after 45 s (a font installed on the computer needs Figma's font helper), and a library import after 90 s, instead of an unexplained timeout.
- **`h.findAll(root, test)`** skips the broken layers inside instances that make Figma's `findAll`/`findOne` crash ("in get_name: The node … does not exist"); the hint says so.
- Hints for `documentAccess: dynamic-page` errors (use the Async calls) and for pages that aren't loaded yet.

## 1.6.1

Fixes for what the bridge's own log showed over three days of real work (1,683 lines: 942 `run_code`, 99 errors, 38 dropped plugin connections).

- **`run_code` gets time to finish.** Most errors (about 45) were `run_code` calls given 60–120 s that were still working: they ended as "may still have been applied" while Figma carried on. A call past 45 s is a job anyway, so `run_code` now runs up to 5 minutes by default and never less than 2 (`timeout_ms` raises it; `FIGMA_BRIDGE_MIN_TIMEOUT_MS`). `build` and `update_nodes` get 5 minutes too.
- **Code may declare its own `h`, `log` or `figma`.** "invalid redefinition of parameter name" (10 times) is gone: such code runs one level in. Syntax errors say the code is the body of an async function.
- **Figma's own network hiccups are retried.** "Unable to establish connection to Figma after 10 seconds" (11 times, in bursts) comes from Figma loading fonts and library items; `loadFontAsync`, `listAvailableFontsAsync`, the library imports and `importVariableByKeyAsync` are now tried up to 3 times.
- **Hints with common errors:** unloaded fonts (and the new `await h.loadFonts(node)`, which loads every font of a text layer or of all text in a frame), frozen `fills`/`effects` arrays, gradient colours without `a`, old ids inside instances, component sets with errors, missing layers.
- `screenshot` of a page captures everything on it (it failed with "This node type can't be exported: PAGE").
- **Cancel** on code that never calls `h.progress` lets the next change go ahead after 3 seconds instead of waiting for Claude's timeout.
- More in the log: why the plugin's connection dropped (close code, how long it lasted, whether the window was hidden), the plugin version and window of each connection, calls waiting when it dropped, and changes that finished after Claude stopped waiting.

## 1.6.0

- **Claude can read the file's comments.** New tool `get_comments`: open threads, newest first, with the comment number, author, time, text, the layer each one is pinned to (id, name, page, path) or its point on the canvas, replies and reactions. `node_id` keeps the comments on one layer and what's inside it, `resolved: true` adds resolved threads, and `since` works as on other reads.
- The Plugin API can't see comments, so they come from Figma's REST API with a personal access token. Paste it once in the Claude Bridge window (**Comments** → token → Save): the plugin checks it, keeps it in its local storage on this computer, and sends it only to api.figma.com. Without a token, Claude is told how to make one (Figma → Settings → Security → Personal access tokens, scope "File comments: Read").
- Manifest: network access to `https://api.figma.com` (re-run the plugin to load it).

## 1.5.1

Fewer errors when Claude windows come and go, and a log to find the rest.

- **A call waits for the plugin to come back** (up to 8 s, `FIGMA_BRIDGE_PLUGIN_WAIT_MS`) when it was connected a moment ago: another Claude window closed and the plugin is finding the new hub, Figma reloaded the plugin, the Mac woke up. Before, calls in those few seconds failed with "The Figma plugin is not connected". Figma not open at all still says so at once.
- **A read lost to a dropped line is tried again once** (hub closed, plugin dropped). Changes are not repeated, as before.
- **A call waits out a hub takeover** instead of failing with "The bridge is not ready".
- **The bridge keeps its own log**, `logs/bridge.log` next to the server (`FIGMA_BRIDGE_LOG` for another file, `off` to turn it off): one line per tool call with its time and size or its error, connections, and crashes, shared by every Claude window. Arguments and results are never written. `status` with `errors: true` lists the recent errors.
- **Problems in the plugin reach the log**: errors in its event handlers and in the panel, which used to vanish in Figma's console.
- When a file's plugin was closed, the error says so ("Claude Bridge in "X" closed 12s ago: ask the user to run it again").



Two things only: a better view and better control in the Claude Bridge window, and a sturdier link for Claude to work through.

**In the Claude Bridge window**

- **Allow changes · Ask first · Look only.** *Ask first* puts each change on a card before it runs: what it will do ("Create 9 layers: “Order list – empty” …"), **Allow**, **Deny**, **Show** (the layers it will change), **Details** (the request, or the code for `run_code`), **Allow for 10 min**, and the time left. The toast on the canvas has **Allow** too. *Look only* replaces the old Allow changes switch. Each file remembers its choice (it used to reset to on at every run). `status` tells Claude which one is set.
- **Progress and Cancel.** A change that waits says what for ("Waiting for the change before it", "Waiting for your OK"). A running one shows how far it is ("12 of 40 · Renaming layers") with a progress bar and the time so far. **Cancel** drops a change that hasn't started, or stops a running one at its next step (between `build` / `update_nodes` items, or at `h.progress` in `run_code`); what it did stays as one undo step, and the result says "stopped".
- **Follow.** The canvas scrolls to what Claude changes. Your selection stays, and it never zooms in.
- **Which Claude.** When several Claude windows work in a file, each row says which one sent it ("Claude Code ·4f").

**For Claude**

- **Long calls don't break or run twice.** A call still running after 45 seconds (`FIGMA_BRIDGE_SOFT_MS`) answers with a job id and its progress, and the new `job` tool waits for the result or cancels it. Before, clients gave up after about a minute (Cowork sooner) and a retried `build` drew everything twice. The same call sent again while it runs, or before its result was seen, now joins it instead. When the client cancels a request (you stop Claude), changes that haven't run are dropped and no answer is sent. With a `progressToken`, MCP progress notifications go out while it waits.
- **`look: true`** on `build`, `update_nodes` and `run_code` returns a picture of the frames that changed in the same answer.
- **`since`: reads that cost nothing when nothing changed.** `get_selection`, `get_spec`, `get_tree`, `find_nodes`, `get_variables` and `get_library` answer with an `etag`; with `since: <etag>` they return just `{ "unchanged": true }`.
- **`audit_design` checks `overflow`:** text running out of its box (measured from what Figma rendered), layers sticking out of their auto layout frame, and text cut off by a clipping frame. Nothing is changed to measure it.
- **`h.progress(done, total, text)`** for `run_code`: the user sees it and can cancel.
- In *Ask first* a change may wait up to 5 minutes for the OK (`FIGMA_BRIDGE_ASK_MS`).

**Fixes**

- A `run_code` that never finishes no longer holds up every change after it: the queue moves on once Claude has stopped waiting.
- Reads no longer make your own edits look like Claude's in the activity log; only changes (and `focus` / `set_page`) count, and only while they run, not while they wait for your OK.
- `export_nodes` is marked as able to overwrite files (`destructiveHint`), since `overwrite: true` replaces them.
- The server answers `initialize` with a protocol version it knows instead of echoing any version.
- README: the version shown at <http://localhost:3055>, and the "start work in the background" pattern for long `run_code` (it escaped the queue and its undo step) is replaced by jobs and `h.progress`.
- 1.4 hubs and plugins keep working: progress messages carry `rid`, so older hubs ignore them.

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
