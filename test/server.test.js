// MCP protocol over stdio + WebSocket links to fake plugin clients (one per open Figma file).
// Run: node test/server.test.js  (Node 22+, uses the built-in WebSocket client)
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const PORT = Number(process.env.TEST_PORT || 3999);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-home-"));
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env: Object.assign({}, process.env, { FIGMA_BRIDGE_PORT: String(PORT), HOME: HOME, FIGMA_BRIDGE_HELLO_MS: "400" }) });
let out = "", stderr = "";
const waiters = new Map();
srv.stdout.on("data", (d) => {
  out += d;
  let i;
  while ((i = out.indexOf("\n")) >= 0) {
    const line = out.slice(0, i); out = out.slice(i + 1);
    const msg = JSON.parse(line);
    if (waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
srv.stderr.on("data", (d) => { stderr += d; });
let rid = 0;
function rpc(method, params) {
  const id = ++rid;
  return new Promise((res) => { waiters.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
}
const tool = async (name, args) => (await rpc("tools/call", { name, arguments: args || {} })).result;
const txt = (r) => r.content[0].text;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* a fake Claude Bridge plugin open in one Figma file */
function fakePlugin(info, handler, host) {
  const ws = new WebSocket("ws://" + (host || "localhost") + ":" + PORT);
  const p = { ws, calls: [], info };
  p.ready = new Promise((r, j) => { ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", info })); setTimeout(r, 50); }; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    p.calls.push(m);
    const res = handler(m, p);
    if (res === undefined) return;
    if (res instanceof Error) ws.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: res.message }));
    else ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: res }));
  };
  p.send = (o) => ws.send(JSON.stringify(o));
  p.close = () => ws.close();
  return p;
}
const ping = (info) => ({ file: info.file, page: "Page 1", editorType: "figma", selection: 0, version: info.version });
/* a plugin on a raw socket, so the test can drop it without a close frame */
function rawPlugin(info, onCommand) {
  const crypto = require("crypto");
  return new Promise((resolve) => {
    const req = require("http").request({ host: "127.0.0.1", port: PORT, path: "/", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), Origin: "null" } });
    req.on("upgrade", (res, sock) => {
      let buf = Buffer.alloc(0);
      const frame = (op, pl) => {
        const mask = crypto.randomBytes(4), body = Buffer.from(pl);
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
        let hdr;
        if (body.length < 126) hdr = Buffer.from([0x80 | op, 0x80 | body.length]);
        else { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(body.length, 2); }
        sock.write(Buffer.concat([hdr, mask, body]));
      };
      const send = (o) => frame(1, Buffer.from(JSON.stringify(o)));
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + len) break;
          const op = buf[0] & 0x0f, pl = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 1) onCommand(JSON.parse(pl.toString()), send);
        }
      });
      sock.on("error", () => { });
      send({ type: "hello", info });
      setTimeout(() => resolve({ send, drop: () => sock.destroy(), close: () => { frame(8, Buffer.alloc(0)); setTimeout(() => sock.destroy(), 50); } }), 60);
    });
    req.end();
  });
}

(async () => {
  await sleep(400);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "figma-bridge"); assert.equal(init.result.serverInfo.version, "1.4.0");
  assert.ok(init.result.capabilities.prompts && /get_context/.test(init.result.instructions));
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  /* tools and prompts */
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  console.log("tools (" + names.length + "):", names.join(", "));
  ["status", "get_context", "get_selection", "screenshot", "run_code", "build", "find_nodes", "update_nodes", "audit_design", "get_variables", "set_variables", "bind_variables", "get_library", "set_styles", "import_from_library", "place_image", "export_nodes"].forEach((n) => assert.ok(names.includes(n), n));
  assert.ok(list.result.tools.every((t) => t.inputSchema.properties.file && t.inputSchema.properties.file.type === "string"), "every tool takes file");
  const prompts = await rpc("prompts/list", {});
  const pnames = prompts.result.prompts.map((p) => p.name);
  assert.deepEqual(pnames, ["context", "tidy", "check", "design", "text", "tokens", "prototype", "handoff", "library"]);
  const tidy = await rpc("prompts/get", { name: "tidy", arguments: { target: "the Home frame" } });
  assert.ok(/Tidy and polish the Home frame/.test(tidy.result.messages[0].content.text) && /audit_design/.test(tidy.result.messages[0].content.text));
  const design = await rpc("prompts/get", { name: "design", arguments: { brief: "a reward popup" } });
  assert.ok(/a reward popup/.test(design.result.messages[0].content.text));
  const badPrompt = await rpc("prompts/get", { name: "nope" });
  assert.equal(badPrompt.error.code, -32602); console.log("prompts OK:", pnames.join(", "));

  /* websites can't reach the bridge: browsers always send an Origin header */
  const handshake = (url, origin) => new Promise((res) => {
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
    if (origin) headers.Origin = origin;
    const req = require("http").request({ host: "127.0.0.1", port: PORT, path: url, headers });
    req.on("upgrade", (r, sock) => { sock.destroy(); res(101); });
    req.on("response", (r) => res(r.statusCode));
    req.on("error", () => res("error"));
    req.end();
  });
  assert.equal(await handshake("/relay", "https://evil.example"), 403);
  assert.equal(await handshake("/relay", "null"), 403, "a sandboxed web page can't relay either");
  assert.equal(await handshake("/", "https://evil.example"), 403);
  assert.equal(await handshake("/", "http://localhost:8000"), 403);
  assert.equal(await handshake("/", "null"), 101, "the plugin window has an opaque origin");
  assert.equal(await handshake("/", "https://www.figma.com"), 101);
  assert.equal(await handshake("/relay"), 101, "other copies of the server send no Origin");
  console.log("origin checks OK");

  /* not connected */
  let r = await tool("status");
  assert.ok(/not connected/i.test(txt(r)), txt(r));
  r = await tool("run_code", { code: "return 1" });
  assert.equal(r.isError, true);
  console.log("not-connected errors OK:", txt(r).slice(0, 70));

  /* one file */
  const big = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64"); // ~4 MB string
  const infoA = { file: "Product", fileKey: "AbCdEf123456", page: "Page 1", editorType: "figma", version: "1.4.0", session: "sA" };
  let heldId = null, slowId = null, aPaused = false;
  const handlerA = (m) => {
    if (m.command === "ping") return Object.assign(ping(infoA), aPaused ? { paused: true } : {});
    if (m.command === "get_tree" && m.params.node_id === "hold") { heldId = m.id; return undefined; }
    if (m.command === "run_code" && m.params.code === "slow") { slowId = m.id; return undefined; }
    if (m.command === "find_nodes" && m.params.name === "huge") return { count: 20000, nodes: Array.from({ length: 20000 }, (_, i) => ({ id: "1:" + i, name: "Layer with a fairly long name " + i, type: "RECTANGLE", path: "Screen › Section › Card" })) };
    if (m.command === "export_nodes" && m.params.format === "PDF") return { format: "PDF", files: [{ id: "../../../evil", name: "..", base64: Buffer.from("%PDF").toString("base64"), bytes: 4 }] };
    if (m.command === "run_code") return m.params.code.includes("throw") ? new Error("boom") : { value: { len: m.params.code.length, by: "A" }, logs: ["hi"] };
    if (m.command === "screenshot") return { base64: big, id: "1:2", name: "Frame", width: 390, height: 844 };
    if (m.command === "place_image") return { node: { id: "9:9", name: m.params.name }, got: { base64: m.params.base64 ? m.params.base64.length : 0, svg: m.params.svg ? m.params.svg.length : 0 } };
    if (m.command === "export_nodes") return { format: m.params.format, scale: m.params.format === "PNG" ? (m.params.scale || 1) : undefined, files: [{ id: "1:1", name: "Icon/Home", base64: Buffer.from("<svg>1</svg>").toString("base64"), bytes: 12 }, { id: "1:2", name: "Icon/Home", base64: Buffer.from("<svg>2</svg>").toString("base64"), bytes: 12 }] };
    return { echo: m.command, by: "A", params: m.params };
  };
  let A = fakePlugin(infoA, handlerA);
  await A.ready;
  r = await tool("status");
  const st = JSON.parse(txt(r));
  console.log("status:", txt(r).replace(/\s+/g, " "));
  assert.equal(st.file, "Product"); assert.equal(st.plugin_version, "1.4.0"); assert.ok(!st.notes && !st.files);

  const longCode = "// " + "x".repeat(300000) + "\nreturn 1";   // > 64 KB → 64-bit frame length, server→client
  r = await tool("run_code", { code: longCode });
  assert.equal(JSON.parse(txt(r)).value.len, longCode.length);
  console.log("run_code large payload OK (" + longCode.length + " chars)");
  r = await tool("run_code", { code: "throw 1" });
  assert.equal(r.isError, true); assert.ok(txt(r).includes("boom"));
  r = await tool("screenshot", {});
  assert.equal(r.content[0].type, "image"); assert.equal(r.content[0].data.length, big.length);
  console.log("plugin errors + 4 MB screenshot OK");
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) => tool("get_tree", { node_id: "n" + i })));
  many.forEach((x, i) => assert.ok(txt(x).includes("n" + (i + 1))));
  console.log("5 concurrent calls matched OK");

  /* images from this computer, data: URLs and links */
  const pngPath = path.join(HOME, "Pictures", "dog photo.png");
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
  r = await tool("place_image", { source: "~/Pictures/dog photo.png", width: 200 });
  let pr = JSON.parse(txt(r));
  assert.equal(pr.node.name, "dog photo"); assert.equal(pr.got.base64, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64").length);
  const pcall = A.calls.filter((m) => m.command === "place_image").pop();
  assert.equal(pcall.params.width, 200);
  fs.writeFileSync(path.join(HOME, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><rect width='4' height='4'/></svg>");
  r = await tool("place_image", { source: path.join(HOME, "logo.svg") });
  assert.ok(JSON.parse(txt(r)).got.svg > 0);
  r = await tool("place_image", { source: "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]).toString("base64") });
  assert.ok(!r.isError);
  fs.writeFileSync(path.join(HOME, "notes.txt"), "hello");
  r = await tool("place_image", { source: path.join(HOME, "notes.txt") });
  assert.ok(r.isError && /PNG, JPEG, GIF or SVG/.test(txt(r)));
  r = await tool("place_image", { source: "~/missing.png" });
  assert.ok(r.isError && /No such file/.test(txt(r)));
  console.log("place_image OK (file path, ~, svg, data: URL, unsupported, missing)");

  /* exports land in a folder on this computer */
  r = await tool("export_nodes", { format: "SVG" });
  let ex = JSON.parse(txt(r));
  assert.equal(ex.folder, path.join(HOME, "Figma Exports", "Product"));
  assert.deepEqual(ex.files.map((f) => path.basename(f.path)), ["Icon-Home.svg", "Icon-Home-1.svg"]);
  assert.equal(fs.readFileSync(ex.files[1].path, "utf8"), "<svg>2</svg>");
  const outDir = path.join(HOME, "project", "assets");
  r = await tool("export_nodes", { format: "PNG", scale: 2, dir: outDir });
  ex = JSON.parse(txt(r));
  assert.deepEqual(ex.files.map((f) => path.basename(f.path)), ["Icon-Home@2x.png", "Icon-Home@2x-1.png"]);
  r = await tool("export_nodes", { format: "PNG", scale: 2, dir: outDir, overwrite: true });
  ex = JSON.parse(txt(r));
  assert.deepEqual(ex.files.map((f) => path.basename(f.path)), ["Icon-Home@2x.png", "Icon-Home@2x-1.png"], "overwrite keeps the names");
  r = await tool("export_nodes", { format: "SVG", dir: "relative/icons" });
  assert.equal(JSON.parse(txt(r)).folder, path.join(HOME, "relative", "icons"), "relative folders start at the home folder");
  console.log("export_nodes OK →", ex.folder);

  /* 1.4: hardening */
  {
    // a file name or id from Figma can't steer an export out of its folder
    r = await tool("export_nodes", { format: "PDF", dir: outDir });
    const pdf = JSON.parse(txt(r)).files[0];
    assert.equal(path.dirname(pdf.path), outDir, pdf.path);
    // only the connection a command went to may answer it; ids can't be guessed
    const infoZ = { file: "Zeta", page: "P", editorType: "figma", version: "1.4.0", session: "sZ" };
    const Z = fakePlugin(infoZ, (m) => (m.command === "ping" ? ping(infoZ) : undefined));
    await Z.ready;
    const held = tool("get_tree", { node_id: "hold", file: "Product" });
    await sleep(120);
    assert.ok(typeof heldId === "string" && heldId.length >= 16, "command ids are random: " + heldId);
    Z.send({ type: "result", id: heldId, ok: true, result: { forged: true } });
    await sleep(80);
    A.send({ type: "result", id: heldId, ok: true, result: { real: true } });
    r = await held;
    assert.ok(/"real":true/.test(txt(r)) && !/forged/.test(txt(r)), txt(r));
    Z.close();
    await sleep(120);
    // a socket that never says who it is gets closed
    const mute = new WebSocket("ws://localhost:" + PORT);
    const closed = await new Promise((res) => { mute.onclose = () => res(true); setTimeout(() => res(false), 2500); });
    assert.ok(closed, "silent socket closed");
    // DNS rebinding: a page under another domain name is refused
    const withHost = (url, host) => new Promise((res) => {
      const req = require("http").request({ host: "127.0.0.1", port: PORT, path: url, headers: Object.assign({ Host: host }, url === "/" ? { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } : {}) });
      req.on("upgrade", (x, sock) => { sock.destroy(); res(101); });
      req.on("response", (x) => res(x.statusCode));
      req.on("error", () => res("error"));
      req.end();
    });
    assert.equal(await withHost("/", "evil.example:" + PORT), 403);
    assert.equal(await withHost("/status", "attacker.test"), 403);
    assert.equal(await withHost("/status", "localhost:" + PORT), 200);
    // garbage on stdin doesn't stop the server
    srv.stdin.write("null\n5\n\"x\"\n");
    assert.ok((await rpc("ping", {})).result, "still alive");
    console.log("hardening OK (answers only from the right socket, random ids, hello timeout, Host check, stdin, export folder)");

    // writes carry a deadline (a change Figma hasn't started when Claude gives up is dropped); reads don't
    await tool("run_code", { code: "return 1" });
    assert.equal(typeof A.calls.filter((m) => m.command === "run_code").pop().deadline, "number");
    assert.equal(A.calls.filter((m) => m.command === "get_tree").pop().deadline, undefined);
    // a change that times out "may still have been applied", and its late answer is reported
    r = await tool("run_code", { code: "slow", timeout_ms: 300 });
    assert.ok(r.isError && /may still have been applied/.test(txt(r)), txt(r));
    A.send({ type: "result", id: slowId, ok: true, result: { value: 1 } });
    await sleep(100);
    r = await tool("get_tree", { node_id: "n1" });
    assert.ok(/^\[Note: The run_code that timed out .* finished later in Figma: it was applied\.\]/.test(txt(r)), txt(r));
    r = await tool("get_tree", { node_id: "n1" });
    assert.ok(!/\[Note:/.test(txt(r)), "reported once");
    console.log("late changes reported OK");

    // figma.com links and dash ids
    r = await tool("get_tree", { node_id: "https://www.figma.com/design/AbCdEf123456/Product?node-id=12-34&t=abc" });
    assert.equal(A.calls.filter((m) => m.command === "get_tree").pop().params.node_id, "12:34");
    await tool("update_nodes", { items: [{ id: "56-78", name: "x" }, { ids: ["1-2", "I3-4;5-6"], visible: false }] });
    const un = A.calls.filter((m) => m.command === "update_nodes").pop().params.items;
    assert.deepEqual([un[0].id, un[1].ids], ["56:78", ["1:2", "I3:4;5:6"]]);
    // results stay inside the context budget, with a note first
    r = await tool("find_nodes", { name: "huge" });
    const big2 = JSON.parse(txt(r));
    assert.ok(Object.keys(big2)[0] === "note" && /nodes shows \d+ of 20000/.test(big2.note) && /offset/.test(big2.note), big2.note);
    assert.ok(txt(r).length * 0.4 <= 20000 && big2.nodes.length > 100, "fits: " + txt(r).length);
    // paused changes show in status
    aPaused = true;
    const stp = JSON.parse(txt(await tool("status")));
    assert.ok(stp.paused && stp.notes.some((n) => /Allow changes/.test(n)));
    aPaused = false;
    // annotations
    const t = (n) => list.result.tools.find((x) => x.name === n);
    assert.ok(t("get_spec").annotations.readOnlyHint && t("delete_nodes").annotations.destructiveHint && !t("build").annotations.readOnlyHint);
    const catalog = JSON.stringify(list.result.tools).length;
    assert.ok(catalog < 27000, "catalog " + catalog + " chars: no bigger than 1.3's 22 tools (27.1K) despite get_spec and annotations");
    console.log("ids, budget, paused, annotations OK (catalog " + catalog + " chars)");

    // a dropped socket gets a moment to come back; meanwhile changes without file don't go elsewhere
    const infoR = { file: "Raw file", page: "P", editorType: "figma", version: "1.4.0", session: "sR" };
    let rawHeld = null;
    const onCmd = (m, send) => { if (m.command === "ping") send({ type: "result", id: m.id, ok: true, result: ping(infoR) }); else rawHeld = m; };
    const R1 = await rawPlugin(infoR, onCmd);
    const pend = tool("run_code", { code: "return 1", file: "Raw file" });
    await sleep(120);
    assert.ok(rawHeld && rawHeld.command === "run_code");
    R1.drop();
    await sleep(150);
    r = await tool("run_code", { code: "return 2" });
    assert.ok(r.isError && /reconnecting/.test(txt(r)), txt(r));
    const R2 = await rawPlugin(infoR, onCmd);
    R2.send({ type: "result", id: rawHeld.id, ok: true, result: { value: "after reconnect" } });
    r = await pend;
    assert.ok(!r.isError && /after reconnect/.test(txt(r)), txt(r));
    R2.close();
    await sleep(150);
    r = await tool("run_code", { code: "return 3" });
    assert.ok(!r.isError, "a plugin that closed normally doesn't block changes: " + txt(r));
    console.log("dropped socket: calls survive the reconnect, write guard holds OK");
  }

  /* a second file: the library */
  const infoB = { file: "Savepet Library", page: "Tokens", editorType: "figma", version: "1.4.0", session: "sB" };
  let holdB = false;
  const B = fakePlugin(infoB, (m) => {
    if (m.command === "ping") return ping(infoB);
    if (m.command === "get_library") return new Error("Unknown command: get_library");
    if (m.command === "list_pages" && holdB) return undefined;   // never answers
    return { echo: m.command, by: "B" };
  });
  await B.ready;
  r = await tool("status");
  const st2 = JSON.parse(txt(r));
  assert.equal(st2.files.length, 2); assert.equal(st2.files[0].file, "Savepet Library"); assert.equal(st2.files[0].active, true);
  r = await tool("get_context", {});
  assert.ok(txt(r).startsWith("[Figma file: Savepet Library]") && /"by": ?"B"/.test(txt(r)), "reads go to the file opened last");
  A.send({ type: "activity", what: "select" });
  await sleep(100);
  r = await tool("get_context", {});
  assert.ok(/"by": ?"A"/.test(txt(r)), "…then to the file the user was last active in");
  r = await tool("run_code", { code: "return 1" });
  assert.ok(r.isError && /several Figma files/.test(txt(r)) && /last active in "Product"/.test(txt(r)), txt(r));
  console.log("changes need file when two files are open OK:", txt(r).slice(7, 120) + "…");
  r = await tool("run_code", { code: "return 2", file: "library" });
  assert.ok(!r.isError && /"by": ?"B"/.test(txt(r)), txt(r));
  r = await tool("set_variables", { ops: [{ op: "set", name: "x", value: 1 }], file: "https://www.figma.com/design/AbCdEf123456/Product?node-id=1-2" });
  assert.ok(/"by": ?"A"/.test(txt(r)), "a Figma link picks the file by its key");
  r = await tool("run_code", { code: "return 3", file: "nope" });
  assert.ok(r.isError && /No open Figma file matches "nope"/.test(txt(r)) && /Savepet Library/.test(txt(r)));
  r = await tool("set_page", { name: "Tokens" });
  assert.ok(!r.isError, "switching pages is not a change");
  r = await tool("set_page", { name: "New", create: true });
  assert.ok(r.isError, "creating a page is a change");
  r = await tool("get_library", { file: "Savepet" });
  assert.ok(r.isError && /older version/.test(txt(r)) && /run it again/.test(txt(r)), txt(r));
  console.log("file targeting OK (name, part of name, figma link, unknown, old plugin hint)");

  /* the same plugin run reconnecting replaces its old socket */
  const A2 = fakePlugin(infoA, handlerA);
  await A2.ready;
  await sleep(100);
  assert.equal(A.ws.readyState, 3, "old socket of the same session closed");
  r = await tool("status");
  assert.equal(JSON.parse(txt(r)).files.length, 2);
  A = A2;
  console.log("same-session reconnect OK");

  /* a file disconnecting fails only its own pending calls */
  holdB = true;
  const pending = tool("list_pages", { file: "Savepet Library" });
  await sleep(100);
  B.close();
  r = await pending;
  assert.ok(r.isError && /Savepet Library" disconnected/.test(txt(r)), txt(r));
  r = await tool("run_code", { code: "return 4" });
  assert.ok(!r.isError && /"by": ?"A"/.test(txt(r)), "one file left: no file needed");
  console.log("disconnect fails only that file's calls OK");

  /* reconnect via 127.0.0.1 works too */
  A.close();
  await sleep(100);
  const C = fakePlugin({ file: "Third", page: "P", editorType: "figma" }, (m) => ({ ok: 1, cmd: m.command }), "127.0.0.1");
  await C.ready;
  r = await tool("list_pages", {});
  assert.ok(!r.isError);
  r = await tool("status");
  assert.ok(/older than this bridge/.test(txt(r)), "a plugin without a version is reported as old");
  C.close();
  await sleep(100);
  const D = fakePlugin({ file: "Fourth", page: "P", editorType: "figma", version: "9.0.0", session: "sD" }, (m) => ({ ok: 1, cmd: m.command }));
  await D.ready;
  r = await tool("status");
  assert.ok(/newer than this bridge/.test(txt(r)) && /Cmd\+Q/.test(txt(r)), "a newer plugin asks for a Claude restart");
  D.close();
  console.log("reconnect over 127.0.0.1 + old/new plugin notes OK");

  const unknown = await rpc("foo/bar", {});
  assert.equal(unknown.error.code, -32601);
  srv.stdin.end();
  await sleep(200);
  console.log("server stderr:\n" + stderr.trim());
  console.log("ALL SERVER TESTS PASSED");
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); console.error(stderr); process.exit(1); });
