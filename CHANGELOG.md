# Changelog

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
