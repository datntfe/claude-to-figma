# Changelog

## 1.1.0

- Several Claude processes can share one plugin connection. The first server copy is the hub and later copies relay through it. A relay takes over automatically if the hub exits.
- Detects an older (1.0.x) bridge holding the port and says how to fix it, instead of failing with `EADDRINUSE`.
- `status` now reports the server role (hub/relay), port and version.
- `run_code` help warns never to call `figma.closePlugin()`.

## 1.0.0

- First version: zero-dependency MCP server, Figma development plugin, and macOS installer.
- Tools: `status`, `run_code`, `screenshot`, `get_selection`, `get_tree`, `list_pages`, `set_page`, `build`, `delete_nodes`, `focus`.
