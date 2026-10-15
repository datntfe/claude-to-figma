#!/usr/bin/env node
/* =====================================================================
   Claude ↔ Figma bridge — MCP server (zero dependencies, Node 18+)

   Claude (MCP over stdio) ──► this server ──► WebSocket on localhost ──►
   "Claude Bridge" Figma plugin (runs inside Figma desktop, has full
   Plugin API access: create / edit / delete nodes, export PNG, ...)

   Several Claude windows/processes may each start a copy of this server.
   The first copy owns the port ("hub") and talks to the plugin; later
   copies connect to the hub as relays, so every Claude can use Figma.

   Only listens on 127.0.0.1 and ::1 (this computer). Port: 3055,
   override with env FIGMA_BRIDGE_PORT.
   ===================================================================== */
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = parseInt(process.env.FIGMA_BRIDGE_PORT || "3055", 10);
const VERSION = "1.1.0";
const log = (...a) => process.stderr.write("[figma-bridge] " + a.join(" ") + "\n");

/* ---------------- WebSocket framing (RFC 6455, minimal) ---------------- */
function makeConn(socket, opts) {
  let buf = opts.head && opts.head.length ? Buffer.from(opts.head) : Buffer.alloc(0);
  let frags = [];
  let alive = true;
  const conn = {
    send(obj) { sendFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8")); },
    close() { try { sendFrame(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ } socket.destroy(); },
    get alive() { return alive; }
  };
  function sendFrame(op, payload) {
    if (!alive) return;
    const len = payload.length;
    const maskBit = opts.mask ? 0x80 : 0;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, maskBit | len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | op; header[1] = maskBit | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | op; header[1] = maskBit | 127; header.writeUInt32BE(Math.floor(len / 4294967296), 2); header.writeUInt32BE(len >>> 0, 6); }
    if (opts.mask) {
      const key = crypto.randomBytes(4);
      const body = Buffer.from(payload);
      for (let i = 0; i < body.length; i++) body[i] ^= key[i & 3];
      socket.write(Buffer.concat([header, key, body]));
    } else socket.write(Buffer.concat([header, payload]));
  }
  function parse() {
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(2) * 4294967296 + buf.readUInt32BE(6); off = 10; }
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) { for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)]; }
      buf = buf.subarray(off + len);
      if (op === 0x8) { try { sendFrame(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ } socket.end(); return; }
      if (op === 0x9) { sendFrame(0xA, payload); continue; }
      if (op === 0xA) continue;
      frags.push(payload);
      if (fin) {
        const text = Buffer.concat(frags).toString("utf8");
        frags = [];
        let msg;
        try { msg = JSON.parse(text); } catch (e) { continue; }
        try { opts.onMessage(msg); } catch (e) { log("message handler error:", e.message); }
      }
    }
  }
  socket.on("data", (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; try { parse(); } catch (e) { log("frame error", e.message); socket.destroy(); } });
  socket.on("close", () => { if (!alive) return; alive = false; clearInterval(keepAlive); opts.onClose && opts.onClose(); });
  socket.on("error", () => { /* close follows */ });
  const keepAlive = setInterval(() => { try { sendFrame(0x9, Buffer.alloc(0)); } catch (e) { /* ignore */ } }, 20000);
  if (buf.length) setImmediate(parse);
  return conn;
}

/* ---------------- state ---------------- */
let role = "starting";      // "hub" | "relay" | "starting" | "blocked"
let blockedReason = "";
let plugin = null;          // hub: plugin connection
let pluginInfo = null;      // hub: info from the plugin's hello
let hubLink = null;         // relay: connection to the hub
const pending = new Map();  // id -> {resolve, reject}
let seq = 0;

function failAll(reason) { for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(reason)); } }

const PLUGIN_HINT = "The Figma plugin is not connected. In Figma desktop, open a design file and run Plugins → Development → Claude Bridge, then try again.";

/* ---------------- hub: owns the port, talks to the plugin ---------------- */
function hubCallPlugin(command, params, timeout) {
  return new Promise((resolve, reject) => {
    if (!plugin) return reject(new Error(PLUGIN_HINT));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out after " + Math.round(timeout / 1000) + "s waiting for Figma (" + command + ").")); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    plugin.send({ id: id, command: command, params: params || {} });
  });
}
function onUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.setNoDelay(true);
  if (String(req.url || "").indexOf("/relay") === 0) {
    /* another Claude process relaying its tool calls through us */
    const relay = makeConn(socket, {
      head: head,
      onMessage: async (m) => {
        if (m.type === "status") return relay.send({ type: "reply", id: m.id, ok: true, result: { connected: !!plugin, info: pluginInfo } });
        if (m.type !== "call") return;
        try { relay.send({ type: "reply", id: m.id, ok: true, result: await hubCallPlugin(m.command, m.params, m.timeout || 60000) }); }
        catch (e) { relay.send({ type: "reply", id: m.id, ok: false, error: e.message }); }
      },
      onClose: () => log("relay disconnected")
    });
    log("relay connected");
    return;
  }
  /* the Figma plugin */
  const conn = makeConn(socket, {
    head: head,
    onMessage: (msg) => {
      if (msg.type === "hello") { pluginInfo = msg.info || {}; return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || "Figma reported an error."));
      }
    },
    onClose: () => { if (plugin === conn) { plugin = null; pluginInfo = null; log("plugin disconnected"); failAll("The Figma plugin disconnected."); } }
  });
  if (plugin) { const old = plugin; plugin = null; old.close(); }
  plugin = conn;
  log("plugin connected");
}
function makeHttpServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Claude Figma bridge " + VERSION + " is running. Plugin connected: " + (plugin ? "yes" : "no") + "\n");
  });
  srv.on("upgrade", onUpgrade);
  return srv;
}
const hubServers = [];
function tryBecomeHub() {
  return new Promise((resolve) => {
    const srv = makeHttpServer();
    srv.once("error", (e) => resolve(e.code || "ERROR"));
    srv.listen(PORT, "127.0.0.1", () => {
      hubServers.push(srv);
      role = "hub";
      log("hub listening on ws://127.0.0.1:" + PORT);
      const v6 = makeHttpServer();
      v6.on("error", () => { /* IPv6 unavailable or taken: 127.0.0.1 is enough */ });
      v6.listen(PORT, "::1", () => { hubServers.push(v6); log("also listening on ws://[::1]:" + PORT); });
      resolve("OK");
    });
  });
}

/* ---------------- relay: forwards calls to the hub ---------------- */
function probeHub() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 2000 }, (res) => {
      let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
function connectRelay() {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/relay", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });
    req.on("upgrade", (res, socket, head) => {
      socket.setNoDelay(true);
      const link = makeConn(socket, {
        head: head, mask: true,
        onMessage: (m) => {
          if (m.type !== "reply" || !pending.has(m.id)) return;
          const p = pending.get(m.id); pending.delete(m.id);
          if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || "Figma reported an error."));
        },
        onClose: () => { if (hubLink === link) { hubLink = null; role = "starting"; log("lost the hub"); failAll("Lost the connection to the bridge hub. Try again in a few seconds."); scheduleEnsure(500); } }
      });
      hubLink = link; role = "relay";
      log("relaying through the hub on port " + PORT);
      resolve(true);
    });
    req.on("response", () => resolve(false));
    req.on("error", () => resolve(false));
    req.end();
  });
}
function relayCall(type, command, params, timeout) {
  return new Promise((resolve, reject) => {
    if (!hubLink) return reject(new Error("Not connected to the bridge hub yet."));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out after " + Math.round(timeout / 1000) + "s waiting for Figma (" + (command || type) + ").")); }, timeout + 2000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    hubLink.send({ type: type, id: id, command: command, params: params || {}, timeout: timeout });
  });
}

/* ---------------- become hub or relay, and keep it that way ---------------- */
let ensuring = null, ensureTimer = null;
function scheduleEnsure(ms) { clearTimeout(ensureTimer); ensureTimer = setTimeout(ensureRole, ms); }
function ensureRole() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    if (role === "hub" || (role === "relay" && hubLink)) return;
    const r = await tryBecomeHub();
    if (r === "OK") { blockedReason = ""; return; }
    if (r !== "EADDRINUSE") { role = "blocked"; blockedReason = "could not open port " + PORT + " (" + r + ")"; scheduleEnsure(3000); return; }
    const body = await probeHub();
    const m = body && /Claude Figma bridge (\d+)\.(\d+)/.exec(body);
    if (!m) { role = "blocked"; blockedReason = "port " + PORT + " is used by another program"; scheduleEnsure(3000); return; }
    if (+m[1] === 1 && +m[2] < 1) { role = "blocked"; blockedReason = "an older bridge (" + m[0].split(" ").pop() + ") is running on port " + PORT + ", probably started by hand in Terminal. Close that Terminal window (or press Ctrl+C there)"; scheduleEnsure(3000); return; }
    if (await connectRelay()) { blockedReason = ""; return; }
    scheduleEnsure(1500);
  })().finally(() => { ensuring = null; });
  return ensuring;
}
ensureRole();

async function callPlugin(command, params, timeoutMs) {
  const timeout = timeoutMs || 60000;
  await ensureRole();
  if (role === "hub") return hubCallPlugin(command, params, timeout);
  if (role === "relay") return relayCall("call", command, params, timeout);
  throw new Error("The bridge is not ready: " + (blockedReason || "starting up, try again in a moment") + ".");
}
async function pluginStatus() {
  await ensureRole();
  if (role === "hub") return { connected: !!plugin, info: pluginInfo };
  if (role === "relay") return relayCall("status", null, null, 5000);
  return { connected: false, error: blockedReason || "starting" };
}

/* ---------------- MCP tools ---------------- */
const RUN_CODE_HELP = [
  "Runs JavaScript inside the Figma plugin (Figma Plugin API) on the user's open file and returns the result.",
  "The code is the BODY of an async function with these variables in scope:",
  "  figma — the Figma Plugin API object (documentAccess is dynamic-page: use await figma.getNodeByIdAsync(id), await figma.setCurrentPageAsync(page), await page.loadAsync()).",
  "  log(...args) — collect debug output (returned as logs).",
  "  h — helpers: h.solid('#RRGGBB', opacity?) → paints, h.hex('#RRGGBB') → {r,g,b}, await h.font(family, style) → loads and returns a FontName, h.svg(svgString, width?) → node, h.summary(node, depth?).",
  "Use `return value` to send data back; nodes are returned as {id,name,type,...} summaries.",
  "Load fonts before setting text: await figma.loadFontAsync({family:'Inter', style:'Regular'}).",
  "globalThis persists while the plugin stays open, so you can store a helper library once (globalThis.lib = {...}) and reuse it in later calls.",
  "Never call figma.closePlugin(): it disconnects the bridge.",
  "After drawing, call the screenshot tool to check the result visually."
].join("\n");

const TOOLS = [
  {
    name: "status",
    description: "Check whether the Figma plugin is connected and which file/page is open.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const st = await pluginStatus();
      if (!st.connected) return text(st.error ? "The bridge is not ready: " + st.error + "." : PLUGIN_HINT);
      let info = Object.assign({}, st.info || {});
      try { info = Object.assign(info, await callPlugin("ping", {}, 8000)); } catch (e) { /* keep hello info */ }
      return text(JSON.stringify({ connected: true, role: role, port: PORT, version: VERSION, file: info.file, page: info.page, editorType: info.editorType, selection: info.selection }, null, 2));
    }
  },
  {
    name: "run_code",
    description: RUN_CODE_HELP,
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Body of an async JS function. Use `return` to send back a value." },
        timeout_ms: { type: "number", description: "Max time to wait, default 60000." }
      },
      required: ["code"], additionalProperties: false
    },
    run: async (a) => text(JSON.stringify(await callPlugin("run_code", { code: a.code }, a.timeout_ms || 60000), null, 2))
  },
  {
    name: "screenshot",
    description: "Export a PNG of a node (by id), or of the current selection if no id is given, and return it as an image so you can see the result.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node to export. Defaults to the first selected node." },
        scale: { type: "number", description: "Export scale, default 1." },
        max_size: { type: "number", description: "Longest side in px after scaling, default 1600." }
      },
      additionalProperties: false
    },
    run: async (a) => {
      const r = await callPlugin("screenshot", { node_id: a.node_id, scale: a.scale, max_size: a.max_size }, 90000);
      return { content: [
        { type: "image", data: r.base64, mimeType: "image/png" },
        { type: "text", text: "Exported \"" + r.name + "\" (" + r.id + ") at " + r.width + "×" + r.height + " px." }
      ] };
    }
  },
  {
    name: "get_selection",
    description: "Describe what the user has selected in Figma (ids, names, types, sizes, text, children).",
    inputSchema: { type: "object", properties: { depth: { type: "number", description: "Child depth, default 2." } }, additionalProperties: false },
    run: async (a) => text(JSON.stringify(await callPlugin("get_selection", { depth: a.depth }), null, 2))
  },
  {
    name: "get_tree",
    description: "Describe the layer tree of a node, or of the current page if no id is given.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" }, depth: { type: "number", description: "Child depth, default 2." } },
      additionalProperties: false
    },
    run: async (a) => text(JSON.stringify(await callPlugin("get_tree", { node_id: a.node_id, depth: a.depth }), null, 2))
  },
  {
    name: "list_pages",
    description: "List the pages of the open Figma file and which one is current.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => text(JSON.stringify(await callPlugin("list_pages", {}), null, 2))
  },
  {
    name: "set_page",
    description: "Switch to a page by id or name. With create=true, a missing page is created.",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" }, name: { type: "string" }, create: { type: "boolean" } },
      additionalProperties: false
    },
    run: async (a) => text(JSON.stringify(await callPlugin("set_page", a), null, 2))
  },
  {
    name: "build",
    description: [
      "Create nodes from a JSON spec (an object or an array) without writing code. Each spec item:",
      "{ type: 'FRAME'|'TEXT'|'RECTANGLE'|'ELLIPSE'|'SVG'|'SECTION', name?, x?, y?, size?: [w,h],",
      "  fill?: '#RRGGBB' | '#RRGGBB@0.5' | Paint[], stroke?: same, radius?: number,",
      "  layout?: { mode: 'HORIZONTAL'|'VERTICAL', gap?, padding?: number|[t,r,b,l], align?: 'MIN'|'CENTER'|'MAX', justify?: 'MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN', w?: 'HUG'|'FILL'|number, h?: 'HUG'|'FILL'|number },",
      "  text?: string, font?: {family, style}, fontSize?, color?: '#RRGGBB', svg?: string (for SVG),",
      "  props?: { any other Figma node property }, children?: [ ...specs ] }",
      "Returns the created node ids."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        spec: { description: "Node spec object or array of specs.", anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] },
        parent_id: { type: "string", description: "Parent node id. Defaults to the current page." }
      },
      required: ["spec"], additionalProperties: false
    },
    run: async (a) => text(JSON.stringify(await callPlugin("build", { spec: a.spec, parent_id: a.parent_id }, 120000), null, 2))
  },
  {
    name: "delete_nodes",
    description: "Delete nodes by id.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"], additionalProperties: false },
    run: async (a) => text(JSON.stringify(await callPlugin("delete_nodes", { ids: a.ids }), null, 2))
  },
  {
    name: "focus",
    description: "Select nodes and zoom the Figma viewport to them, so the user sees what changed.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"], additionalProperties: false },
    run: async (a) => text(JSON.stringify(await callPlugin("focus", { ids: a.ids }), null, 2))
  }
];
function text(s) { return { content: [{ type: "text", text: s }] }; }

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  try { return await tool.run(args || {}); }
  catch (e) { return { content: [{ type: "text", text: "Error: " + (e && e.message ? e.message : String(e)) }], isError: true }; }
}

/* ---------------- MCP stdio transport (JSON-RPC 2.0, one message per line) ---------------- */
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
async function handle(msg) {
  if (Array.isArray(msg)) { for (const m of msg) await handle(m); return; }
  const id = msg.id, method = msg.method, params = msg.params || {};
  if (id === undefined || id === null) return; // notification
  try {
    switch (method) {
      case "initialize":
        return send({ jsonrpc: "2.0", id, result: {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "figma-bridge", version: VERSION },
          instructions: "Tools to work directly in the user's open Figma file through the Claude Bridge plugin. Call status first. Prefer run_code for drawing, then screenshot to check the result visually."
        } });
      case "ping": return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list": return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
      case "tools/call": return send({ jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments) });
      case "resources/list": return send({ jsonrpc: "2.0", id, result: { resources: [] } });
      case "prompts/list": return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
      default: return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e && e.message ? e.message : String(e) } });
  }
}
let inBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inBuf += chunk;
  let i;
  while ((i = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => { hubServers.forEach((s) => s.close()); process.exit(0); });
