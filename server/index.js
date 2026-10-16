#!/usr/bin/env node
/* =====================================================================
   Claude ↔ Figma bridge — MCP server (zero dependencies, Node 18+)

   Claude (MCP over stdio) ──► this server ──► WebSocket on localhost ──►
   "Claude Bridge" Figma plugin (runs inside Figma desktop, has full
   Plugin API access: create / edit / delete nodes, export PNG, ...)

   Several Claude windows/processes may each start a copy of this server.
   The first copy owns the port ("hub") and talks to the plugin; later
   copies connect to the hub as relays, so every Claude can use Figma.

   The plugin can be open in several Figma files at once (for example a
   library file and a product file). The hub keeps one connection per file.
   Each call goes to the file named in its `file` argument, or else to the
   file the user was last active in. Changes need `file` when several
   different files are open, so nothing lands in the wrong file.

   Only listens on 127.0.0.1 and ::1 (this computer). Port: 3055,
   override with env FIGMA_BRIDGE_PORT.
   ===================================================================== */
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const pathMod = require("path");

const PORT = parseInt(process.env.FIGMA_BRIDGE_PORT || "3055", 10);
const VERSION = "1.2.0";
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
const plugins = new Map();  // hub: id -> { id, conn, info, connectedAt, lastActive } (one per open Figma file)
let pluginSeq = 0;
let hubLink = null;         // relay: connection to the hub
let hubVersion = null;      // relay: version of the hub we relay through
const pending = new Map();  // id -> {resolve, reject, plugin?}
let seq = 0;

function failAll(reason) { for (const [id, p] of pending) { pending.delete(id); p.reject(new Error(reason)); } }
function failFor(plugin, reason) { for (const [id, p] of pending) if (p.plugin === plugin) { pending.delete(id); p.reject(new Error(reason)); } }

const PLUGIN_HINT = "The Figma plugin is not connected. In Figma desktop, open a design file and run Plugins → Development → Claude Bridge, then try again.";
const oldPluginHint = (command) => `The Claude Bridge plugin open in Figma is an older version and doesn't know "${command}". In Figma, close the Claude Bridge window and run it again (Plugins → Development → Claude Bridge) to load version ${VERSION}.`;

function lower(s) { return String(s === undefined || s === null ? "" : s).toLowerCase(); }
function ago(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 360) / 10 + "h"; }
function older(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0), pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) < (pb[i] || 0)) return true; if ((pa[i] || 0) > (pb[i] || 0)) return false; }
  return false;
}

/* ---------------- hub: which open Figma file a call goes to ---------------- */
function livePlugins() { return Array.from(plugins.values()).filter((p) => p.conn.alive && p.ready); }
function byRecent(list) { return list.slice().sort((a, b) => b.lastActive - a.lastActive); }
function fileLabel(p) { return p && p.info && p.info.file ? p.info.file : "(unknown file)"; }
function identity(p) { return p.info.fileKey ? "key:" + p.info.fileKey : "name:" + lower(p.info.file || p.id); }
function distinctFiles(list) { return new Set(list.map(identity)).size; }
function namesOf(list) { return Array.from(new Set(list.map((p) => '"' + fileLabel(p) + '"'))).join(", "); }
function fileKeyFromUrl(s) { const m = /figma\.com\/(?:design|file|board|proto|slides|site|buzz)\/([A-Za-z0-9]{10,})/.exec(String(s)); return m ? m[1] : null; }
const WRITE_COMMANDS = new Set(["run_code", "build", "delete_nodes", "set_variables", "bind_variables", "set_styles", "import_from_library", "update_nodes", "place_image"]);
/* Does `target` (a name, part of a name, a key or a figma.com link) mean this file? */
function fileMatches(target, info) {
  const t = String(target).trim(), tl = t.toLowerCase(), key = fileKeyFromUrl(t);
  if (info.fileKey && (info.fileKey === t || info.fileKey === key)) return true;
  return !!info.file && (lower(info.file) === tl || lower(info.file).includes(tl));
}
function pickPlugin(target, write) {
  const list = byRecent(livePlugins());
  if (!list.length) throw new Error(PLUGIN_HINT);
  if (target !== undefined && target !== null && String(target).trim() !== "") {
    const t = String(target).trim(), tl = t.toLowerCase(), key = fileKeyFromUrl(t);
    let m = list.filter((p) => p.id === t || (p.info.session && p.info.session === t) || (p.info.fileKey && (p.info.fileKey === t || p.info.fileKey === key)));
    if (!m.length) m = list.filter((p) => lower(p.info.file) === tl);
    if (!m.length) m = list.filter((p) => lower(p.info.file).includes(tl));
    if (!m.length) throw new Error(`No open Figma file matches "${t}". Claude Bridge is open in: ${namesOf(list)}.` + (key ? " (A Figma link only matches when the plugin can read the file key; use the file name instead.)" : ""));
    if (distinctFiles(m) > 1) throw new Error(`"${t}" matches several open files (${namesOf(m)}). Use the full file name, or one of these ids: ${m.map((p) => p.id + " = " + fileLabel(p)).join(", ")}.`);
    return m[0];
  }
  if (write && distinctFiles(list) > 1) {
    throw new Error(`Claude Bridge is open in several Figma files (${namesOf(list)}). Say which one to change with file: "<name>". The user was last active in "${fileLabel(list[0])}".`);
  }
  return list[0];
}
function filesSummary() {
  const now = Date.now();
  return byRecent(livePlugins()).map((p, i) => ({
    file: fileLabel(p), page: p.info.page, active: i === 0,
    last_activity: ago(now - p.lastActive) + " ago",
    plugin_version: p.info.version || "1.1 or older", id: p.id
  }));
}
function hubStatus() {
  const list = byRecent(livePlugins());
  return { connected: list.length > 0, info: list.length ? list[0].info : null, files: filesSummary(), version: VERSION };
}
function hubCallPlugin(command, params, timeout, target, write) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = pickPlugin(target, write); } catch (e) { return reject(e); }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out after " + Math.round(timeout / 1000) + "s waiting for Figma (" + command + ").")); }, timeout);
    pending.set(id, {
      plugin: p,
      resolve: (v) => { clearTimeout(timer); resolve({ result: v, file: fileLabel(p), files: distinctFiles(livePlugins()) }); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    p.conn.send({ id: id, command: command, params: params || {} });
  });
}
function acceptPlugin(socket, head) {
  const entry = { id: "f" + (++pluginSeq), conn: null, info: {}, ready: false, connectedAt: Date.now(), lastActive: Date.now() };
  entry.conn = makeConn(socket, {
    head: head,
    onMessage: (msg) => {
      if (msg.type === "hello") {
        entry.info = Object.assign({}, msg.info || {});
        entry.ready = true;
        entry.lastActive = Date.now();
        for (const p of plugins.values()) {   // the same plugin run reconnecting: drop its old socket
          if (p !== entry && entry.info.session && p.info.session === entry.info.session) { plugins.delete(p.id); failFor(p, "The Figma plugin reconnected."); p.conn.close(); }
        }
        log('plugin ready in "' + fileLabel(entry) + '" (' + entry.id + ")");
        return;
      }
      if (msg.type === "info") { Object.assign(entry.info, msg.info || {}); return; }
      if (msg.type === "activity") { entry.lastActive = Date.now(); return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || "Figma reported an error."));
      }
    },
    onClose: () => {
      if (plugins.get(entry.id) !== entry) return;
      plugins.delete(entry.id);
      log('plugin disconnected from "' + fileLabel(entry) + '"');
      failFor(entry, 'The Figma plugin in "' + fileLabel(entry) + '" disconnected.');
    }
  });
  plugins.set(entry.id, entry);
  log("plugin connected (" + entry.id + ")");
}
/* Web pages open WebSockets too, and a browser always sends an Origin header. Other copies of
   this server never send one, and the plugin window (an iframe with an opaque origin) sends
   "null". Anything else is a website trying to reach Figma through this computer: refuse it. */
function originAllowed(req, isRelay) {
  const o = req.headers.origin;
  if (isRelay) return o === undefined;
  if (o === undefined || o === "null") return true;
  return /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(String(o));
}
function onUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") { socket.destroy(); return; }
  const isRelay = String(req.url || "").indexOf("/relay") === 0;
  if (!originAllowed(req, isRelay)) {
    log("refused a WebSocket from " + (req.headers.origin || "unknown origin") + (isRelay ? " on /relay" : ""));
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.setNoDelay(true);
  if (isRelay) {
    /* another Claude process relaying its tool calls through us */
    const relay = makeConn(socket, {
      head: head,
      onMessage: async (m) => {
        if (m.type === "status") return relay.send({ type: "reply", id: m.id, ok: true, result: hubStatus() });
        if (m.type !== "call") return;
        try {
          // relays from 1.1 don't say whether a call changes the file: judge by the command
          const write = m.write !== undefined ? !!m.write : (WRITE_COMMANDS.has(m.command) || (m.command === "set_page" && !!(m.params && m.params.create)));
          const r = await hubCallPlugin(m.command, m.params, m.timeout || 60000, m.target, write);
          relay.send({ type: "reply", id: m.id, ok: true, result: r.result, file: r.file, files: r.files });
        } catch (e) { relay.send({ type: "reply", id: m.id, ok: false, error: e.message }); }
      },
      onClose: () => log("relay disconnected")
    });
    log("relay connected");
    return;
  }
  /* a Claude Bridge plugin (one per open Figma file) */
  acceptPlugin(socket, head);
}
function makeHttpServer() {
  const srv = http.createServer((req, res) => {
    const n = livePlugins().length;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Claude Figma bridge " + VERSION + " is running. Plugin connected: " + (n ? "yes" + (n > 1 ? " (" + n + " files)" : "") : "no") + "\n");
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
      hubVersion = VERSION;
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
          if (m.ok) p.resolve(m); else p.reject(new Error(m.error || "Figma reported an error."));
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
/* Resolves with the hub's whole reply message ({result, file, files}). */
function relayCall(type, command, params, timeout, target, write) {
  return new Promise((resolve, reject) => {
    if (!hubLink) return reject(new Error("Not connected to the bridge hub yet."));
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out after " + Math.round(timeout / 1000) + "s waiting for Figma (" + (command || type) + ").")); }, timeout + 2000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    hubLink.send({ type: type, id: id, command: command, params: params || {}, timeout: timeout, target: target, write: write || undefined });
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
    const m = body && /Claude Figma bridge (\d+)\.(\d+)(?:\.(\d+))?/.exec(body);
    if (!m) { role = "blocked"; blockedReason = "port " + PORT + " is used by another program"; scheduleEnsure(3000); return; }
    if (+m[1] === 1 && +m[2] < 1) { role = "blocked"; blockedReason = "an older bridge (" + m[1] + "." + m[2] + ") is running on port " + PORT + ", probably started by hand in Terminal. Close that Terminal window (or press Ctrl+C there)"; scheduleEnsure(3000); return; }
    if (await connectRelay()) { hubVersion = m[1] + "." + m[2] + (m[3] !== undefined ? "." + m[3] : ""); blockedReason = ""; return; }
    scheduleEnsure(1500);
  })().finally(() => { ensuring = null; });
  return ensuring;
}
ensureRole();

/* Returns { result, file, files }: the plugin's answer, which file answered,
   and how many different files have the plugin open (undefined from an old hub). */
async function callPlugin(command, params, timeoutMs, target, write) {
  const timeout = timeoutMs || 60000;
  await ensureRole();
  try {
    if (role === "hub") return await hubCallPlugin(command, params, timeout, target, write);
    if (role === "relay") {
      if (target && hubVersion && older(hubVersion, "1.2.0")) {
        // a 1.1 hub ignores `file` and talks to one file only: make sure it's the one asked for
        const who = (await relayCall("call", "ping", {}, 8000)).result || {};
        if (!fileMatches(target, who)) throw new Error(`The bridge running now is an older version (${hubVersion}) that can only reach one Figma file, "${who.file}", not "${target}". Quit Claude completely (Cmd+Q) and open it again to finish updating; then several files work at once.`);
      }
      const m = await relayCall("call", command, params, timeout, target, write);
      return { result: m.result, file: m.file, files: m.files };
    }
  } catch (e) {
    if (/^Unknown command/i.test(e.message)) throw new Error(oldPluginHint(command));
    throw e;
  }
  throw new Error("The bridge is not ready: " + (blockedReason || "starting up, try again in a moment") + ".");
}
async function pluginStatus() {
  await ensureRole();
  if (role === "hub") return hubStatus();
  if (role === "relay") return (await relayCall("status", null, null, 5000)).result;
  return { connected: false, error: blockedReason || "starting" };
}

/* ---------------- local files: images in, exports out ---------------- */
function expandHome(p) { return String(p).replace(/^~(?=$|\/|\\)/, os.homedir()); }
/* "~/x", "/abs/x", or "x" (relative paths are taken from the home folder: the server's own
   working directory is often "/" under Claude desktop). */
function userPath(p) { const e = expandHome(String(p).trim()); return pathMod.isAbsolute(e) ? pathMod.resolve(e) : pathMod.resolve(os.homedir(), e); }
function safeName(s) { return String(s || "").replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120); }
function fsHint(e, p) {
  if (e && (e.code === "EPERM" || e.code === "EACCES")) return new Error("macOS did not let Claude access " + p + ". Allow it in System Settings → Privacy & Security → Files and Folders (Claude), or use a folder in your home folder such as ~/Figma Exports.");
  if (e && e.code === "ENOENT") return new Error("No such file or folder: " + p);
  if (e && e.code === "EROFS") return new Error(p + " is on a read-only disk. Use a folder in your home folder, e.g. ~/Figma Exports.");
  return e;
}
async function loadSource(src) {
  const s = String(src || "").trim();
  if (!s) throw new Error("Pass source: a file path on this computer or an https:// link.");
  let buf, name;
  if (/^data:/i.test(s)) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(s);
    if (!m) throw new Error("Bad data: URL");
    buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    name = "image";
  } else if (/^https?:\/\//i.test(s)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await fetch(s, { signal: ctl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("Download failed: HTTP " + res.status);
      buf = Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
    name = decodeURIComponent(s.split(/[?#]/)[0].split("/").pop() || "image");
  } else {
    const p = userPath(s);
    try { buf = await fs.promises.readFile(p); } catch (e) { throw fsHint(e, p); }
    name = pathMod.basename(p);
  }
  if (buf.length > 25 * 1024 * 1024) throw new Error("The image is larger than 25 MB.");
  return { buf, name };
}
function imageKind(buf, name) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 4).toString("ascii") === "GIF8") return "gif";
  const head = buf.slice(0, 1024).toString("utf8").trim().toLowerCase();
  if (head.startsWith("<svg") || ((head.startsWith("<?xml") || head.startsWith("<!--")) && head.includes("<svg")) || /\.svg$/i.test(name)) return "svg";
  return null;
}

/* ---------------- MCP tools ---------------- */
const RUN_CODE_HELP = [
  "Runs JavaScript inside the Figma plugin (Figma Plugin API) on the user's open file and returns the result.",
  "The code is the BODY of an async function with these variables in scope:",
  "  figma — the Figma Plugin API object (documentAccess is dynamic-page: use await figma.getNodeByIdAsync(id), await figma.setCurrentPageAsync(page), await page.loadAsync(), and the *Async variants such as figma.variables.getLocalVariablesAsync(), node.getMainComponentAsync(), node.setFillStyleIdAsync()).",
  "  log(...args) — collect debug output (returned as logs).",
  "  h — helpers: h.solid('#RRGGBB', opacity?) → paints, h.hex('#RRGGBB') → {r,g,b}, h.color('#RRGGBBAA') → {r,g,b,a}, h.toHex(color) → '#RRGGBB', await h.font(family, style) → loads and returns a FontName, h.svg(svgString, width?) → node, h.summary(node, depth?), await h.describe(node) → full details (fills, styles, bound variables, component), await h.variable('color/brand/primary', collection?) → a Variable (local, or imported from an enabled library), await h.bind(node, 'fill', 'color/brand/primary') → binds a variable to a field.",
  "Use `return value` to send data back; nodes are returned as {id,name,type,...} summaries.",
  "Load fonts before setting text: await figma.loadFontAsync({family:'Inter', style:'Regular'}).",
  "globalThis persists while the plugin stays open, so you can store a helper library once (globalThis.lib = {...}) and reuse it in later calls.",
  "Each call is one undo step for the user (Cmd+Z). Before big or risky edits, save a restore point: await figma.saveVersionHistoryAsync('Before …').",
  "Never call figma.closePlugin(): it disconnects the bridge.",
  "After drawing, call the screenshot tool to check the result visually."
].join("\n");

const FILE_PROP = {
  type: "string",
  description: "Which open Figma file to use, when Claude Bridge is open in several files: its name (or part of it) or a figma.com link. Reads default to the file the user was last active in; changes require it when several different files are open."
};
const VAR_REF = "a variable name like 'color/brand/primary', '{name}', a 'VariableID:…' id, {key: '…'} for a library variable, or null to unbind";

const TOOLS = [
  {
    name: "status",
    description: "Check whether the Figma plugin is connected, which file and page are open, and (when several files have Claude Bridge open) which ones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (a) => {
      const st = await pluginStatus();
      if (!st || !st.connected) return text(st && st.error ? "The bridge is not ready: " + st.error + "." : PLUGIN_HINT);
      let info = Object.assign({}, st.info || {});
      try { const r = await callPlugin("ping", {}, 8000, a.file, false); info = Object.assign(info, r.result); } catch (e) { /* keep hello info */ }
      const hubV = role === "hub" ? VERSION : (st.version || hubVersion || "1.1.0");
      const res = { connected: true, role: role, port: PORT, version: VERSION, file: info.file, page: info.page, editorType: info.editorType, selection: info.selection };
      if (hubV !== VERSION) res.hub_version = hubV;
      res.plugin_version = info.version || "1.1.0 or older";
      if (st.files && st.files.length > 1) res.files = st.files;
      const notes = [];
      if (!info.version || older(info.version, VERSION)) notes.push("The Claude Bridge plugin in Figma is older than this bridge (" + VERSION + "): close it in Figma and run it again (Plugins → Development → Claude Bridge).");
      if (older(hubV, VERSION)) notes.push("Another Claude window started an older bridge (" + hubV + ") that still owns port " + PORT + ". Quit Claude completely (Cmd+Q) and open it again to finish updating; until then working with several files at once is off.");
      if (notes.length) res.notes = notes;
      return text(JSON.stringify(res, null, 2));
    }
  },
  {
    name: "get_context",
    description: [
      "What the user is looking at and working on in Figma right now. Call this first when the user says \"this\", \"here\", \"what I selected\" or \"what I'm working on\".",
      "Returns: file and page; the selection (and the text range if they are editing text); the viewport, i.e. the area of the canvas on their screen: zoom, bounds, the frame in focus (centre of the screen) and the layers in view; and recent activity in this file (what was selected, edited, created or deleted, by the user, a collaborator or Claude, and when).",
      "Use get_selection for full details of the selected layers and screenshot (no arguments) to see the screen."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        activity: { type: "number", description: "How many recent activity events to include (default 15, 0 for none)." },
        since_seconds: { type: "number", description: "Only include activity from the last N seconds." },
        depth: { type: "number", description: "How deep to list the layers in view (default 2: top-level layers and their children)." },
        max_layers: { type: "number", description: "Cap on listed layers in view (default 60)." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("get_context", { activity: a.activity, since_seconds: a.since_seconds, depth: a.depth, max_layers: a.max_layers }, 30000, a.file, false))
  },
  {
    name: "get_selection",
    description: "Full details of what the user has selected in Figma: for each layer its id, path, position and size, fills and strokes (hex), radius, effects, auto layout and sizing, text and typography, applied styles, bound variables, variable modes, and component info (main component, variant, key, library or local, component property values). Also the text range when they are editing text, and the colours used in the selection. depth sets how many child levels to summarise (default 1).",
    inputSchema: {
      type: "object",
      properties: {
        depth: { type: "number", description: "Child depth, default 1." },
        brief: { type: "boolean", description: "Only ids, names, types and sizes." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("get_selection", { depth: a.depth, brief: a.brief }, 60000, a.file, false))
  },
  {
    name: "screenshot",
    description: "See the canvas as an image. With node_id: export that layer. With viewport=true: capture exactly what the user sees on screen (all layers in view, with the canvas colour). With no arguments: the selected layer; several selected layers → the area around them; nothing selected → what the user sees on screen.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Layer to export." },
        viewport: { type: "boolean", description: "Capture the user's visible canvas area." },
        scale: { type: "number", description: "Export scale (default 1 for layers, the current zoom for the screen)." },
        max_size: { type: "number", description: "Longest side in px after scaling, default 1600." }
      },
      additionalProperties: false
    },
    run: async (a) => {
      const r = await callPlugin("screenshot", { node_id: a.node_id, viewport: a.viewport, scale: a.scale, max_size: a.max_size }, 120000, a.file, false);
      const s = r.result;
      const what = s.id ? 'Exported "' + s.name + '" (' + s.id + ")" : "Captured " + s.name;
      return { content: [
        { type: "image", data: s.base64, mimeType: "image/png" },
        { type: "text", text: fileNote(r) + what + " at " + s.width + "×" + s.height + " px." + (s.region ? " Canvas area x " + s.region.x + ", y " + s.region.y + ", " + s.region.width + "×" + s.region.height + "." : "") }
      ] };
    }
  },
  {
    name: "get_tree",
    description: "Describe the layer tree of a node, or of the current page if no id is given.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string" }, depth: { type: "number", description: "Child depth, default 2." } },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("get_tree", { node_id: a.node_id, depth: a.depth }, 60000, a.file, false))
  },
  {
    name: "list_pages",
    description: "List the pages of the open Figma file and which one is current.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (a) => reply(await callPlugin("list_pages", {}, 60000, a.file, false))
  },
  {
    name: "set_page",
    description: "Switch to a page by id or name. With create=true, a missing page is created.",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" }, name: { type: "string" }, create: { type: "boolean" } },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("set_page", { page_id: a.page_id, name: a.name, create: a.create }, 60000, a.file, !!a.create))
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
    run: async (a) => reply(await callPlugin("run_code", { code: a.code }, a.timeout_ms || 60000, a.file, true))
  },
  {
    name: "build",
    description: [
      "Create layers from a JSON spec (an object or an array) without writing code, using the file's design system. Each spec item:",
      "{ type: 'FRAME'|'TEXT'|'RECTANGLE'|'ELLIPSE'|'SVG'|'SECTION'|'INSTANCE', name?, x?, y?, size?: [w,h],",
      "  fill?: '#RRGGBB' | '#RRGGBB@0.5' | Paint[] | '{color/variable}', stroke?: same, strokeWeight?, radius?: number | [tl,tr,br,bl] | '{variable}',",
      "  layout?: { mode: 'HORIZONTAL'|'VERTICAL', gap?, padding?: number|[t,r,b,l]|'{variable}', align?: 'MIN'|'CENTER'|'MAX', justify?: 'MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN', wrap?, w?: 'HUG'|'FILL'|number, h?: 'HUG'|'FILL'|number },",
      "  text?: string, font?: {family, style}, fontSize?, lineHeight?, letterSpacing?, textAlign?, color?: '#RRGGBB' | '{variable}', svg?: string (for SVG),",
      "  component?: local component (set) name or id, or 'key:<library key>' (makes an INSTANCE), variant?: 'Size=L, State=Hover', properties?: {Label: 'Play'},",
      "  textStyle?, fillStyle?, strokeStyle?, effectStyle?: style name (or 'key:<library key>'), effects?: [{type:'DROP_SHADOW', color, x, y, blur, spread}],",
      "  variables?: {field: '{variable}'}, modes?: {Collection: 'Dark'}, link?: '<name of another layer in this build>' | {to, transition?, duration? (ms)},",
      "  opacity?, visible?, fillWidth?: true, props?: { any other Figma node property }, children?: [ ...specs ] }",
      "'{name}' values bind variables (local, or from enabled libraries). Returns the created node ids."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        spec: { description: "Node spec object or array of specs.", anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] },
        parent_id: { type: "string", description: "Parent node id. Defaults to the current page." }
      },
      required: ["spec"], additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("build", { spec: a.spec, parent_id: a.parent_id }, 120000, a.file, true))
  },
  {
    name: "delete_nodes",
    description: "Delete nodes by id.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"], additionalProperties: false },
    run: async (a) => reply(await callPlugin("delete_nodes", { ids: a.ids }, 60000, a.file, true))
  },
  {
    name: "focus",
    description: "Select nodes and zoom the Figma viewport to them, so the user sees what changed.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"], additionalProperties: false },
    run: async (a) => reply(await callPlugin("focus", { ids: a.ids }, 60000, a.file, false))
  },
  {
    name: "find_nodes",
    description: "Search layers: by type ('TEXT', 'FRAME', 'INSTANCE', …), name (part of it, or '/regex/i'), text content, or component (instances of a component, by name or key). scope: 'page' (default), 'selection' or 'file', or node_id for one layer and everything inside it. Returns a flat list with ids, paths and sizes; for text layers the text, font, size and text style. Use it to collect all texts to translate or rewrite, or all layers to fix, then change them with update_nodes.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["page", "selection", "file"] },
        node_id: { type: "string", description: "Search inside this layer." },
        type: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        name: { type: "string" },
        text: { type: "string" },
        component: { type: "string" },
        visible_only: { type: "boolean" },
        limit: { type: "number", description: "Default 200." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("find_nodes", { scope: a.scope, node_id: a.node_id, type: a.type, name: a.name, text: a.text, component: a.component, visible_only: a.visible_only, limit: a.limit }, 120000, a.file, false))
  },
  {
    name: "update_nodes",
    description: [
      "Change many existing layers in one batch (one undo step), without writing code. items: [{ id | ids: [...] | 'selection', …changes }]. Changes:",
      "name, text (fonts are loaded for you), font: {family, style}, fontSize, lineHeight, letterSpacing, textAlign, textCase, textStyle, x, y, width, height, rotation, visible, locked, opacity,",
      "fill / color / stroke: '#RRGGBB' | '#RRGGBB@0.5' | 'none' | Paint[], strokeWeight, radius, effects, fillStyle, strokeStyle, effectStyle (style names or 'key:<library key>'),",
      "layout: {mode: 'HORIZONTAL'|'VERTICAL'|'NONE'|'AUTO', gap, padding, align, justify, wrap} (mode 'AUTO' turns the layer into auto layout from how its children are placed now), sizing: {w, h: 'HUG'|'FILL'|'FIXED'},",
      "variables: {field: '{variable}'} and any value written as '{variable}' is bound to that variable, modes: {Collection: 'Dark' | null},",
      "variant: 'Size=L' and properties: {Label: 'Play'} for instances, swap: component name or 'key:…',",
      "link: {to: layer id | 'back' | 'close' | 'https://…', trigger?: 'ON_CLICK'|'ON_HOVER'|'ON_PRESS'|'ON_DRAG', transition?: 'SMART_ANIMATE'|'DISSOLVE'|'MOVE_IN'|'PUSH'|'SLIDE_IN'|'none', duration?: ms, overlay?: true} (prototype), or link: null to remove,",
      "props: {any other Figma property}, remove: true.",
      "Errors are reported per layer; the others still change. save_version: a title to save a restore point first."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object" } },
        save_version: { type: "string" }
      },
      required: ["items"], additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("update_nodes", { items: a.items, save_version: a.save_version }, 180000, a.file, true))
  },
  {
    name: "audit_design",
    description: [
      "Check a design for polish and design-system problems, like Figma's \"Check designs\" and \"Tidy and polish\". Checks: names (default layer names like 'Frame 12'), bind (hard-coded values that match a variable), colors (hard-coded colours outside the variables and styles), text (text without a text style), pixels (positions/sizes off whole pixels), spacing (auto layout gaps/padding off the grid), contrast (text contrast below WCAG AA), targets (tappable layers under 44×44), hidden, empty, autolayout (frames that could use auto layout).",
      "Scope: node_id, or scope 'selection' | 'page' (default: the selection, else the page). fix: ['bind', 'round', 'autolayout'] applies those safe fixes (one undo step); renames and colour choices are yours to make with update_nodes."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        scope: { type: "string", enum: ["selection", "page", "file"] },
        checks: { type: "array", items: { type: "string", enum: ["names", "bind", "colors", "text", "pixels", "spacing", "contrast", "targets", "hidden", "empty", "autolayout"] } },
        fix: { type: "array", items: { type: "string", enum: ["bind", "round", "autolayout"] } },
        grid: { type: "number", description: "Spacing grid in px (default 4)." },
        limit: { type: "number", description: "Max issues listed (default 150)." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("audit_design", { node_id: a.node_id, scope: a.scope, checks: a.checks, fix: a.fix, grid: a.grid, limit: a.limit }, 180000, a.file, !!(a.fix && a.fix.length)))
  },
  {
    name: "place_image",
    description: "Put an image into Figma from a file on this computer (e.g. '~/Pictures/dog.jpg'), an https:// link or a data: URL. PNG, JPEG and GIF become an image fill: on node_id (replacing its fills, or add=true to add on top) or on a new rectangle (inside parent_id at x/y, or in the middle of the user's screen; width/height default to the image size, keeping its ratio). SVG files become vector layers. scale_mode: FILL (default), FIT, CROP or TILE.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "File path, https:// link or data: URL." },
        node_id: { type: "string" }, add: { type: "boolean" },
        parent_id: { type: "string" }, x: { type: "number" }, y: { type: "number" },
        width: { type: "number" }, height: { type: "number" },
        name: { type: "string" },
        scale_mode: { type: "string", enum: ["FILL", "FIT", "CROP", "TILE"] }
      },
      required: ["source"], additionalProperties: false
    },
    run: async (a) => {
      const src = await loadSource(a.source);
      const kind = imageKind(src.buf, src.name);
      if (!kind) throw new Error("Figma takes PNG, JPEG, GIF or SVG images. Convert this file first (WebP, HEIC and AVIF are not supported).");
      const params = { name: a.name || src.name.replace(/\.[a-z0-9]+$/i, ""), node_id: a.node_id, add: a.add, parent_id: a.parent_id, x: a.x, y: a.y, width: a.width, height: a.height, scale_mode: a.scale_mode };
      if (kind === "svg") params.svg = src.buf.toString("utf8"); else params.base64 = src.buf.toString("base64");
      return reply(await callPlugin("place_image", params, 120000, a.file, true));
    }
  },
  {
    name: "export_nodes",
    description: "Export layers to files on this computer, e.g. icons as SVG or screens as PNG straight into a code project. ids (default: the selection), format PNG | JPG | SVG | PDF, scale (PNG/JPG, default 1; 2 or 3 for retina), dir (default ~/Figma Exports/<file name>). Files are named after the layers; existing files get a -1, -2 suffix unless overwrite=true. Returns the saved paths.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        format: { type: "string", enum: ["PNG", "JPG", "SVG", "PDF"] },
        scale: { type: "number" },
        dir: { type: "string" },
        overwrite: { type: "boolean" },
        svg_ids: { type: "boolean", description: "Keep layer names as id attributes in SVG." }
      },
      additionalProperties: false
    },
    run: async (a) => {
      const fmt = String(a.format || "PNG").toUpperCase() === "JPEG" ? "JPG" : String(a.format || "PNG").toUpperCase();
      const r = await callPlugin("export_nodes", { ids: a.ids, format: fmt, scale: a.scale, svg_ids: a.svg_ids }, 180000, a.file, false);
      const dir = userPath(a.dir || pathMod.join("~", "Figma Exports", safeName(r.file || "") || "Figma"));
      try { await fs.promises.mkdir(dir, { recursive: true }); } catch (e) { throw fsHint(e, dir); }
      const ext = { PNG: "png", JPG: "jpg", SVG: "svg", PDF: "pdf" }[r.result.format];
      const used = new Set(), written = [];
      for (const f of r.result.files) {
        let base = safeName(f.name) || f.id.replace(/:/g, "-");
        if (r.result.scale && r.result.scale !== 1) base += "@" + r.result.scale + "x";
        let fn = base + "." + ext, i = 1;
        while (used.has(fn.toLowerCase()) || (!a.overwrite && fs.existsSync(pathMod.join(dir, fn)))) fn = base + "-" + (i++) + "." + ext;
        used.add(fn.toLowerCase());
        const full = pathMod.join(dir, fn);
        try { await fs.promises.writeFile(full, Buffer.from(f.base64, "base64")); } catch (e) { throw fsHint(e, full); }
        written.push({ layer: f.name, id: f.id, path: full, bytes: f.bytes });
      }
      return text(fileNote(r) + JSON.stringify({ folder: dir, files: written }, null, 2));
    }
  },
  {
    name: "get_variables",
    description: [
      "List the variables of the open file: each local collection with its modes, and every variable's type and value per mode (colours as hex, aliases as {other/name}), scopes, code syntax and description.",
      "Filter with collection, query (part of the name) and type.",
      "library=true also lists the variable collections of the libraries enabled in this file (name, type and key of each variable). Library variables are read-only here: bind them by name or import them by key; to change them, open the library file and run Claude Bridge there."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name (or part of it)." },
        query: { type: "string", description: "Only variables whose name contains this." },
        type: { type: "string", enum: ["COLOR", "FLOAT", "STRING", "BOOLEAN"] },
        library: { type: "boolean", description: "Also list variables from enabled libraries." },
        values: { type: "boolean", description: "Include values (default true)." },
        ids: { type: "boolean", description: "Include variable and collection ids." },
        limit: { type: "number", description: "Max variables listed (default 500)." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("get_variables", { collection: a.collection, query: a.query, type: a.type, library: a.library, values: a.values, ids: a.ids, limit: a.limit }, 60000, a.file, false))
  },
  {
    name: "set_variables",
    description: [
      "Create, change, rename or delete local variables, collections and modes in one batch (one undo step). Ops run in order and stop at the first error:",
      "{op:'create_collection', collection, modes?:['Light','Dark']}",
      "{op:'rename_collection', collection, to} · {op:'delete_collection', collection}",
      "{op:'add_mode', collection, mode} · {op:'rename_mode', collection, mode, to} · {op:'delete_mode', collection, mode}",
      "{op:'set', collection, name, type?:'COLOR'|'FLOAT'|'STRING'|'BOOLEAN', values?:{'<mode name>'|'*': value}, value?: same value for every mode, description?, scopes?:['ALL_FILLS',…], code_syntax?:{WEB?, ANDROID?, iOS?}, hidden?: bool} — creates the variable when missing (type is inferred from the value), otherwise updates it",
      "{op:'rename', collection?, name, to} · {op:'delete', collection?, name}",
      "Values: '#RRGGBB' or '#RRGGBBAA' colours, numbers, strings, booleans, or an alias to another variable: '{color/blue/500}' or {alias:'color/blue/500', collection:'Primitives'} (library variables work too).",
      "Variables that come from a library can't be changed here: open the library file and run Claude Bridge there, then the user publishes the library.",
      "save_version: a title to save a restore point in version history before the batch."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        ops: { type: "array", items: { type: "object" } },
        save_version: { type: "string", description: "Save a named version before applying." }
      },
      required: ["ops"], additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("set_variables", { ops: a.ops, save_version: a.save_version }, 120000, a.file, true))
  },
  {
    name: "bind_variables",
    description: [
      "Bind variables to layers (or unbind with variable:null), and set which variable mode frames use.",
      "bindings: [{nodes?: [ids] (default: the current selection), field, variable: " + VAR_REF + ", collection?, index?: paint index}].",
      "Fields: fill, stroke (solid paint colour), width, height, minWidth, maxWidth, minHeight, maxHeight, gap, rowGap, padding, paddingX, paddingY, paddingTop/Right/Bottom/Left, radius (all corners) or topLeftRadius…, strokeWeight, opacity, visible, characters, and for text fontFamily, fontStyle, fontWeight, fontSize, lineHeight, letterSpacing, paragraphSpacing, paragraphIndent.",
      "Names are looked up in local collections first, then in enabled libraries (imported automatically).",
      "modes: [{nodes?: [ids], collection, mode: 'Dark' | null (back to auto)}]."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        bindings: { type: "array", items: { type: "object" } },
        modes: { type: "array", items: { type: "object" } },
        save_version: { type: "string", description: "Save a named version before applying." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("bind_variables", { bindings: a.bindings, modes: a.modes, save_version: a.save_version }, 120000, a.file, true))
  },
  {
    name: "get_library",
    description: [
      "The design-system assets available in the open file: local paint/text/effect/grid styles with their values, local components and component sets (key, variants, properties), variable collections (local and from enabled libraries),",
      "the shaders available to the file, and with used_remote=true the library components used on the current page (name, key, number of uses).",
      "Local items can be edited here (set_styles, set_variables, run_code). Library items are read-only here; their keys work with import_from_library."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["all", "styles", "components", "variables", "shaders", "used"], description: "What to list (default all)." },
        query: { type: "string", description: "Only names containing this." },
        used_remote: { type: "boolean", description: "Also list library components used on the current page." },
        limit: { type: "number", description: "Max items per list (default 300)." }
      },
      additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("get_library", { kind: a.kind, query: a.query, used_remote: a.used_remote, limit: a.limit }, 120000, a.file, false))
  },
  {
    name: "set_styles",
    description: [
      "Create or change local styles in one batch (one undo step). Ops run in order and stop at the first error:",
      "{op:'set', type:'PAINT', name, color?:'#RRGGBB', paints?:[…], variable?: colour variable to bind, description?}",
      "{op:'set', type:'TEXT', name, font?:{family, style}, fontSize?, lineHeight?: number|'auto'|'150%', letterSpacing?: number|'2%', paragraphSpacing?, textCase?, textDecoration?, variables?:{fontSize:'type/size/m', …}, description?}",
      "{op:'set', type:'EFFECT', name, effects:[{type:'DROP_SHADOW', color:'#00000033', x:0, y:4, blur:12, spread:0}, {type:'LAYER_BLUR', blur:8}], description?}",
      "{op:'rename', type?, name, to} · {op:'delete', type?, name}",
      "'set' creates the style when no local style has that name. save_version: a title to save a restore point first."
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        ops: { type: "array", items: { type: "object" } },
        save_version: { type: "string", description: "Save a named version before applying." }
      },
      required: ["ops"], additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("set_styles", { ops: a.ops, save_version: a.save_version }, 120000, a.file, true))
  },
  {
    name: "import_from_library",
    description: "Bring a published library item into this file by key: kind 'variable', 'style', 'component' or 'component_set'. A component is placed as an instance (inside parent_id at x/y, or in the middle of the user's screen) unless place=false; for a component set, variant picks the variant by name. Keys come from get_library and get_variables (library=true).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["variable", "style", "component", "component_set"] },
        key: { type: "string" },
        place: { type: "boolean", description: "Create an instance of a component (default true)." },
        variant: { type: "string", description: "Variant name (or part of it) for a component set, e.g. 'Size=L'." },
        parent_id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" }
      },
      required: ["kind", "key"], additionalProperties: false
    },
    run: async (a) => reply(await callPlugin("import_from_library", { kind: a.kind, key: a.key, place: a.place, variant: a.variant, parent_id: a.parent_id, x: a.x, y: a.y }, 120000, a.file, true))
  }
];
function text(s) { return { content: [{ type: "text", text: s }] }; }
function fileNote(r) { return r && r.files > 1 && r.file ? "[Figma file: " + r.file + "] " : ""; }
function reply(r) { return text((r && r.files > 1 && r.file ? "[Figma file: " + r.file + "]\n" : "") + JSON.stringify(r.result, null, 2)); }
function listTools() {
  return TOOLS.map((t) => {
    const schema = JSON.parse(JSON.stringify(t.inputSchema));
    schema.properties = Object.assign({}, schema.properties, { file: FILE_PROP });
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  try { return await tool.run(args || {}); }
  catch (e) { return { content: [{ type: "text", text: "Error: " + (e && e.message ? e.message : String(e)) }], isError: true }; }
}

/* ---------------- MCP prompts: one-click jobs, like the suggestions in Figma's agent ---------------- */
const TARGET_ARG = { name: "target", description: "What to work on (default: what you have selected in Figma, else the frame in the middle of your screen).", required: false };
const PROMPTS = [
  {
    name: "context", title: "What am I working on?",
    description: "Claude looks at your selection, your screen and what you just did in Figma. / Xem bạn đang chọn và thao tác gì.",
    arguments: [],
    text: () => [
      "Look at what I'm working on in Figma: call get_context, then screenshot with no arguments.",
      "Tell me in a few lines what you see (file, page, the frame in focus, what I selected and what I changed recently), then ask what I'd like to do with it."
    ]
  },
  {
    name: "tidy", title: "Tidy and polish",
    description: "Clean up names, spacing, pixels, auto layout and variables without changing the look. / Dọn dẹp, chuẩn hoá thiết kế.",
    arguments: [TARGET_ARG],
    text: (a) => [
      "Tidy and polish " + (a.target || "what I have selected in Figma (if nothing is selected, the frame in focus on my screen)") + ", like Figma's \"Tidy and polish\". Keep the look the same unless something is clearly broken.",
      "1. get_context, then screenshot it (the before state).",
      "2. audit_design on it, then apply the safe fixes with audit_design fix [\"bind\", \"round\"].",
      "3. In one update_nodes batch: give layers with default names (Frame 12, Rectangle 4, Group 3…) short names that say what they are; snap spacing to the 4px grid; turn stacked layers into auto layout with layout {mode: \"AUTO\"} where it clearly helps; bind remaining hard-coded colours and type to variables or styles only when the match is obvious.",
      "4. Screenshot again, compare with the before state, and list briefly what changed and what still needs my decision (colours with no matching variable, low contrast…). Each batch is one Cmd+Z in Figma."
    ]
  },
  {
    name: "check", title: "Check design",
    description: "Accessibility, design-system and polish report, without changing anything. / Soát lỗi thiết kế, không sửa.",
    arguments: [TARGET_ARG],
    text: (a) => [
      "Check " + (a.target || "what I have selected in Figma (or the whole page if nothing is selected)") + " without changing anything.",
      "Run audit_design with all checks and look at get_selection and a screenshot for context.",
      "Report the problems grouped as accessibility, design system and polish, with layer names, and say which ones you can fix automatically. Ask before fixing anything."
    ]
  },
  {
    name: "design", title: "Generate a design",
    description: "Design a screen or component with your components, variables and styles. / Thiết kế mới bằng design system của bạn.",
    arguments: [{ name: "brief", description: "What to design.", required: true }],
    text: (a) => [
      "Design this in Figma with my design system: " + (a.brief || "(ask me what to design)"),
      "1. get_context to see where I'm working; get_library (used_remote: true) and get_variables to learn the components, styles and tokens. If the brief refers to existing screens, screenshot them and match their style.",
      "2. Build it with build (run_code for anything build can't express): use existing components as instances (component, variant, properties), bind colours, spacing and radii to variables with '{name}', use text styles, and fall back to raw values only when nothing fits. Put it next to my current work, not on top of it.",
      "3. Screenshot the result, check alignment, spacing, text overflow and contrast (audit_design), fix what's off, then focus on it so I see it."
    ]
  },
  {
    name: "text", title: "Rewrite or translate text",
    description: "Translate or rewrite every text layer in the selection at once. / Dịch hoặc viết lại toàn bộ text.",
    arguments: [{ name: "instruction", description: "e.g. 'translate to English', 'shorter and friendlier'.", required: true }, TARGET_ARG],
    text: (a) => [
      "Change the text in " + (a.target || "my selection") + ": " + (a.instruction || "(ask me what to change)") + ".",
      "1. find_nodes with type TEXT (scope 'selection', or node_id) to collect every text layer.",
      "2. Write the new copy for each one: keep meaning, numbers, names and placeholders, and keep it about as long as the original so the layout holds.",
      "3. Apply everything in one update_nodes batch ({id, text}).",
      "4. Screenshot and fix overflow or awkward wrapping (shorter wording or textAutoResize)."
    ]
  },
  {
    name: "tokens", title: "Edit variables",
    description: "Create or update design tokens (collections, modes, values, aliases) safely. / Tạo, sửa variables.",
    arguments: [{ name: "instruction", description: "What to change.", required: true }],
    text: (a) => [
      "Work on the variables (design tokens) of this Figma file: " + (a.instruction || "(ask me what to change)") + ".",
      "1. get_variables (library: true if libraries may be involved) to see the collections, modes and values.",
      "2. If the change touches many variables or deletes anything, show me the plan first.",
      "3. Apply it with set_variables in one batch, with save_version set to a short title so there is a restore point. Use aliases ({primitive/name}) for semantic tokens.",
      "4. If layers should use the new variables, bind them with bind_variables or audit_design fix [\"bind\"].",
      "If the variables come from a library, they can only change in the library file: ask me to open it and run Claude Bridge there, pass file: '<library>' for the changes, and remind me to publish the library afterwards."
    ]
  },
  {
    name: "prototype", title: "Make a prototype",
    description: "Wire up clicks and transitions between screens. / Nối prototype giữa các màn hình.",
    arguments: [{ name: "instruction", description: "Optional: the flow you want.", required: false }],
    text: (a) => [
      "Make a clickable prototype: " + (a.instruction || "connect the screens I selected in a sensible flow") + ".",
      "1. get_context and get_selection to see the screens and their buttons (screenshot if needed).",
      "2. Add the links with update_nodes: {id: <button>, link: {to: <screen id>, transition: 'SMART_ANIMATE', duration: 300}}; 'back' for back buttons; overlay: true for sheets and dialogs.",
      "3. List the interactions you added and tell me to press Present to try it."
    ]
  },
  {
    name: "handoff", title: "Hand off to code",
    description: "Export assets into your project and write the code for the selection. / Xuất asset và viết code.",
    arguments: [{ name: "stack", description: "e.g. 'Flutter', 'React + Tailwind'.", required: true }, { name: "folder", description: "Where to save assets.", required: false }, TARGET_ARG],
    text: (a) => [
      "Prepare " + (a.target || "my selection") + " for development in " + (a.stack || "(ask me which stack)") + ".",
      "1. get_selection (depth 2) and a screenshot for structure and exact values; get_variables for the tokens it uses.",
      "2. Export icons as SVG and bitmaps as PNG @2x/@3x with export_nodes" + (a.folder ? " into " + a.folder : "") + ".",
      "3. Write the code using the variables as named tokens, and list anything ambiguous (states, breakpoints, interactions) for me to confirm."
    ]
  },
  {
    name: "library", title: "Edit a library",
    description: "Change variables, styles or components of a team library safely. / Sửa library.",
    arguments: [{ name: "instruction", description: "What to change.", required: true }, { name: "library", description: "Library file name.", required: false }],
    text: (a) => [
      "Change the library" + (a.library ? " \"" + a.library + "\"" : "") + ": " + (a.instruction || "(ask me what to change)") + ".",
      "1. status: check that Claude Bridge is open in the library file. If it isn't, ask me to open that file in Figma and run Plugins → Development → Claude Bridge there.",
      "2. With several files open, pass file: '<library file name>' for every change.",
      "3. Save a version first (save_version), then change variables with set_variables, styles with set_styles, and components with update_nodes or run_code, in the library file.",
      "4. Remind me to publish the library (Assets panel → Publish) and to accept the update in the files that use it."
    ]
  }
];
function getPrompt(name, args) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new Error("Unknown prompt: " + name);
  return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.text(args || {}).join("\n") + "\nAnswer in my language." } }] };
}

/* ---------------- MCP stdio transport (JSON-RPC 2.0, one message per line) ---------------- */
const INSTRUCTIONS = [
  "Tools to work directly in the user's open Figma file through the Claude Bridge plugin. Call status first.",
  "To find out what the user means by \"this\" or \"here\", call get_context (selection, the area on their screen, recent activity), get_selection for full details, and screenshot with no arguments to see it.",
  "Tidy and polish: audit_design (with fix for the safe fixes) and update_nodes for batch changes. Text: find_nodes, then update_nodes.",
  "Variables: get_variables, set_variables, bind_variables. Styles and components: get_library, set_styles, import_from_library. New designs: build with components, '{variable}' values and styles.",
  "Files on this computer: place_image brings images in, export_nodes writes assets out.",
  "Library items (variables, styles, components from another file) are read-only in the files that use them: to change them, ask the user to open the library file and run Claude Bridge there, make the change in that file, then the user publishes the library update.",
  "Prefer run_code for anything the other tools don't cover, then screenshot to check the result.",
  "When Claude Bridge is open in several files, pass file: \"<name>\" (required for changes)."
].join(" ");
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
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: "figma-bridge", version: VERSION },
          instructions: INSTRUCTIONS
        } });
      case "ping": return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list": return send({ jsonrpc: "2.0", id, result: { tools: listTools() } });
      case "tools/call": return send({ jsonrpc: "2.0", id, result: await callTool(params.name, params.arguments) });
      case "resources/list": return send({ jsonrpc: "2.0", id, result: { resources: [] } });
      case "prompts/list": return send({ jsonrpc: "2.0", id, result: { prompts: PROMPTS.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })) } });
      case "prompts/get":
        if (!PROMPTS.find((x) => x.name === params.name)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown prompt: " + params.name } });
        return send({ jsonrpc: "2.0", id, result: getPrompt(params.name, params.arguments) });
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
