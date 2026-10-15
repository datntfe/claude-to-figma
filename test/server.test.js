// MCP protocol over stdio + WebSocket link to a fake plugin client.
// Run: node test/server.test.js  (Node 22+, uses the built-in WebSocket client)
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");
const PORT = Number(process.env.TEST_PORT || 3999);
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env: Object.assign({}, process.env, { FIGMA_BRIDGE_PORT: String(PORT) }) });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(400);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "figma-bridge");
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  console.log("tools:", names.join(", "));
  assert.ok(names.includes("run_code") && names.includes("screenshot"));

  // not connected
  const st0 = await rpc("tools/call", { name: "status", arguments: {} });
  assert.ok(/not connected/i.test(st0.result.content[0].text), st0.result.content[0].text);
  const rc0 = await rpc("tools/call", { name: "run_code", arguments: { code: "return 1" } });
  assert.equal(rc0.result.isError, true);
  console.log("not-connected errors OK:", rc0.result.content[0].text.slice(0, 70));

  // fake plugin over both localhost and 127.0.0.1
  const ws = new WebSocket("ws://localhost:" + PORT);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "hello", info: { file: "Test file", page: "Page 1", editorType: "figma" } }));
  const big = Buffer.alloc(3 * 1024 * 1024, 7).toString("base64"); // ~4 MB string
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    let reply;
    if (m.command === "ping") reply = { file: "Test file", page: "Page 1", editorType: "figma", selection: 0 };
    else if (m.command === "run_code") {
      if (m.params.code.includes("throw")) return ws.send(JSON.stringify({ type: "result", id: m.id, ok: false, error: "boom" }));
      reply = { value: { len: m.params.code.length }, logs: ["hi"] };
    }
    else if (m.command === "screenshot") reply = { base64: big, id: "1:2", name: "Frame", width: 390, height: 844 };
    else reply = { echo: m.command, params: m.params };
    ws.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: reply }));
  };
  await sleep(100);
  const st = await rpc("tools/call", { name: "status", arguments: {} });
  console.log("status:", st.result.content[0].text.replace(/\s+/g, " "));
  assert.ok(st.result.content[0].text.includes("Test file"));

  const longCode = "// " + "x".repeat(300000) + "\nreturn 1";   // > 64 KB → 64-bit frame length, server→client
  const rc = await rpc("tools/call", { name: "run_code", arguments: { code: longCode } });
  assert.equal(JSON.parse(rc.result.content[0].text).value.len, longCode.length);
  console.log("run_code large payload OK (" + longCode.length + " chars)");

  const err = await rpc("tools/call", { name: "run_code", arguments: { code: "throw 1" } });
  assert.equal(err.result.isError, true); assert.ok(err.result.content[0].text.includes("boom"));
  console.log("plugin error propagates OK");

  const shot = await rpc("tools/call", { name: "screenshot", arguments: {} });
  assert.equal(shot.result.content[0].type, "image"); assert.equal(shot.result.content[0].data.length, big.length);
  console.log("screenshot large frame OK (" + (big.length / 1e6).toFixed(1) + " MB base64)");

  // concurrency
  const many = await Promise.all([1, 2, 3, 4, 5].map((i) => rpc("tools/call", { name: "get_tree", arguments: { node_id: "n" + i } })));
  many.forEach((r, i) => assert.ok(r.result.content[0].text.includes("n" + (i + 1))));
  console.log("5 concurrent calls matched OK");

  // disconnect while pending
  ws.onmessage = () => { };
  const p = rpc("tools/call", { name: "list_pages", arguments: {} });
  await sleep(100); ws.close();
  const dis = await p;
  assert.equal(dis.result.isError, true);
  console.log("disconnect fails pending call OK:", dis.result.content[0].text);

  // reconnect via 127.0.0.1 works too
  const ws2 = new WebSocket("ws://127.0.0.1:" + PORT);
  await new Promise((r, j) => { ws2.onopen = r; ws2.onerror = j; });
  ws2.onmessage = (ev) => { const m = JSON.parse(ev.data); ws2.send(JSON.stringify({ type: "result", id: m.id, ok: true, result: { ok: 1 } })); };
  const again = await rpc("tools/call", { name: "list_pages", arguments: {} });
  assert.ok(!again.result.isError);
  console.log("reconnect OK");

  const unknown = await rpc("foo/bar", {});
  assert.equal(unknown.error.code, -32601);
  ws2.close();
  srv.stdin.end();
  await sleep(200);
  console.log("server stderr:\n" + stderr.trim());
  console.log("ALL SERVER TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); console.error(stderr); process.exit(1); });
