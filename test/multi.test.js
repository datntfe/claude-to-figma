// Several server copies share one plugin (hub + relays), hub failover, old-version detection.
// Run: node test/multi.test.js  (Node 22+)
const { spawn } = require("child_process");
const http = require("http");
const assert = require("assert");
const path = require("path");
const PORT = Number(process.env.TEST_PORT_MULTI || 3998);
const SERVER = path.join(__dirname, "..", "server", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(name) {
  const p = spawn(process.execPath, [SERVER], { env: Object.assign({}, process.env, { FIGMA_BRIDGE_PORT: String(PORT) }) });
  let out = ""; const waiters = new Map(); let rid = 0;
  p.stdout.on("data", (d) => { out += d; let i; while ((i = out.indexOf("\n")) >= 0) { const m = JSON.parse(out.slice(0, i)); out = out.slice(i + 1); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } });
  p.stderr.on("data", (d) => process.stdout.write("   [" + name + "] " + d));
  const rpc = (method, params) => { const id = ++rid; return new Promise((res) => { waiters.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }); };
  const tool = async (n, a) => (await rpc("tools/call", { name: n, arguments: a || {} })).result;
  return { p, rpc, tool, kill: () => p.stdin.end() };
}
function fakePlugin(tag, file) {
  let ws, stop = false;
  const name = file || "Demo file";
  const connect = () => {
    if (stop) return;
    ws = new WebSocket("ws://localhost:" + PORT);
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", info: { file: name, page: "Page 1", editorType: "figma", version: "1.2.0", session: tag } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: m.command === "ping" ? { file: name, page: "Page 1", editorType: "figma", selection: 0, version: "1.2.0" } : { by: tag, cmd: m.command, code: m.params.code } })); };
    let retried = false;
    const again = () => { if (!retried) { retried = true; setTimeout(connect, 300); } };
    ws.onclose = again;
    ws.onerror = again;
  };
  connect();
  return { stop: () => { stop = true; try { ws.close(); } catch (e) { } } };
}

(async () => {
  const A = startServer("A"); await sleep(400);
  const B = startServer("B"); await sleep(400);
  const C = startServer("C"); await sleep(400);
  for (const s of [A, B, C]) await s.rpc("initialize", { protocolVersion: "2025-06-18" });
  const plug = fakePlugin("plugin"); await sleep(500);

  let r = await B.tool("status");
  console.log("B status:", r.content[0].text.replace(/\s+/g, " "));
  assert.ok(/"role": "relay"/.test(r.content[0].text) && /Demo file/.test(r.content[0].text));
  r = await C.tool("run_code", { code: "return 'from C'" });
  assert.ok(r.content[0].text.includes("from C")); console.log("C → hub A → plugin OK");
  r = await A.tool("run_code", { code: "return 'from A'" });
  assert.ok(r.content[0].text.includes("from A")); console.log("A (hub) direct OK");
  const big = "// " + "y".repeat(200000);
  r = await B.tool("run_code", { code: big });
  assert.ok(r.content[0].text.length > 200000); console.log("large payload through relay OK");

  // hub A goes away → B or C takes over, plugin reconnects
  A.kill(); await sleep(3500);
  r = await B.tool("status"); const sb = r.content[0].text;
  r = await C.tool("status"); const sc = r.content[0].text;
  console.log("B:", sb); console.log("C:", sc);
  console.log("after A exit: B", (sb.match(/"role": "(\w+)"/) || [])[1], "| C", (sc.match(/"role": "(\w+)"/) || [])[1]);
  assert.ok(/connected": true/.test(sb) && /connected": true/.test(sc));
  r = await C.tool("run_code", { code: "return 'after failover'" });
  assert.ok(r.content[0].text.includes("after failover")); console.log("failover OK");

  // a second Figma file: both stay connected (no fighting over the hub), relays pass the file through
  const lib = fakePlugin("library", "Library file"); await sleep(800);
  r = await B.tool("status");
  assert.equal(JSON.parse(r.content[0].text).files.length, 2, r.content[0].text);
  r = await B.tool("run_code", { code: "return 'which file?'" });
  assert.ok(r.isError && /several Figma files/.test(r.content[0].text), r.content[0].text);
  r = await B.tool("run_code", { code: "return 'to the library'", file: "library" });
  assert.ok(/"by": "library"/.test(r.content[0].text) && /\[Figma file: Library file\]/.test(r.content[0].text), r.content[0].text);
  r = await C.tool("get_tree", { file: "Demo" });
  assert.ok(/"by": "plugin"/.test(r.content[0].text));
  await sleep(2500);
  r = await B.tool("status");
  assert.equal(JSON.parse(r.content[0].text).files.length, 2, "still two files a few seconds later");
  console.log("two files through relays OK");
  lib.stop(); plug.stop(); B.kill(); C.kill(); await sleep(500);

  // an old 1.0.0 bridge holds the port
  const old = http.createServer((q, s) => { s.end("Claude Figma bridge 1.0.0 is running. Plugin connected: yes\n"); });
  old.on("upgrade", (q, sock) => sock.destroy());
  await new Promise((r2) => old.listen(PORT, "127.0.0.1", r2));
  const D = startServer("D"); await sleep(600); await D.rpc("initialize", {});
  r = await D.tool("status");
  console.log("old bridge on port →", r.content[0].text);
  assert.ok(/older bridge/.test(r.content[0].text));
  old.close(); await sleep(3500);
  const plug2 = fakePlugin("plugin2"); await sleep(800);
  r = await D.tool("run_code", { code: "return 'D became hub'" });
  assert.ok(r.content[0].text.includes("D became hub")); console.log("D takes over once the old bridge closes OK");
  plug2.stop(); D.kill(); await sleep(300);
  console.log("ALL MULTI-INSTANCE TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
