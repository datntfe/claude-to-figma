// 1.5: long calls become jobs, the same call never runs twice, cancel (job and MCP notifications/cancelled),
// progress from Figma, etags on reads, look: true pictures, Ask first, and all of it through a relay.
// Run: node test/jobs.test.js  (Node 22+, uses the built-in WebSocket client)
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const PORT = Number(process.env.TEST_PORT_JOBS || 3996);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-jobs-"));
const ENV = Object.assign({}, process.env, { FIGMA_BRIDGE_PORT: String(PORT), HOME: HOME, FIGMA_BRIDGE_SOFT_MS: "1000", FIGMA_BRIDGE_ASK_MS: "200000" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* an MCP client talking to one server process over stdio */
function mcp(name) {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env: ENV });
  const c = { proc, waiters: new Map(), notes: [], stderr: "", rid: 0 };
  let out = "";
  proc.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i); out = out.slice(i + 1);
      const msg = JSON.parse(line);
      if (msg.method) c.notes.push(msg);
      else if (c.waiters.has(msg.id)) { c.waiters.get(msg.id)(msg); c.waiters.delete(msg.id); }
    }
  });
  proc.stderr.on("data", (d) => { c.stderr += d; });
  c.raw = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
  c.rpc = (method, params, id) => { id = id || ++c.rid; return new Promise((res) => { c.waiters.set(id, res); c.raw({ jsonrpc: "2.0", id, method, params }); }); };
  c.tool = async (n, args, meta) => (await c.rpc("tools/call", Object.assign({ name: n, arguments: args || {} }, meta ? { _meta: meta } : {}))).result;
  c.close = () => { proc.stdin.end(); };
  return c;
}
const txt = (r) => r.content.find((x) => x.type === "text").text;
const json = (r) => JSON.parse(txt(r).replace(/^\[[^\n]*\]\n/, ""));

/* a fake Claude Bridge plugin: holds builds and updates until the test answers them */
const info = { file: "Jobs file", page: "Page 1", editorType: "figma", version: "1.5.0", session: "sJ" };
const held = [], cancels = [];
let selection = { count: 1, selection: [{ id: "1:2", name: "Card" }] };
function fakePlugin() {
  const ws = new WebSocket("ws://localhost:" + PORT);
  const p = { ws };
  p.ready = new Promise((r, j) => { ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", info })); setTimeout(r, 80); }; ws.onerror = j; });
  p.send = (o) => ws.send(JSON.stringify(o));
  p.answer = (m, result) => p.send({ type: "result", id: m.id, ok: true, result });
  p.fail = (m, error) => p.send({ type: "result", id: m.id, ok: false, error });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "cancel") { cancels.push(m); return; }
    if (m.command === "ping") return p.answer(m, { file: info.file, page: "Page 1", editorType: "figma", selection: 1, version: "1.5.0" });
    if (m.command === "get_selection") return p.answer(m, JSON.parse(JSON.stringify(selection)));
    if (m.command === "build" && m.params.look) return p.answer(m, { roots: [{ id: "1:9" }], created: 1, look: { base64: "iVBORw0KGgo=", width: 300, height: 200, id: "1:9", name: "Look at me" } });
    held.push(m);
  };
  return p;
}

(async () => {
  const A = mcp("A");
  await sleep(400);
  const init = await A.rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
  assert.equal(init.result.protocolVersion, "2025-06-18", "an unknown protocol version gets the one this server speaks");
  assert.equal((await A.rpc("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "claude-code" } })).result.protocolVersion, "2025-03-26");
  const tools = (await A.rpc("tools/list", {})).result.tools;
  const t = (n) => tools.find((x) => x.name === n);
  assert.ok(t("job") && !t("job").inputSchema.properties.file && t("export_nodes").annotations.destructiveHint);
  assert.ok(t("get_selection").inputSchema.properties.since && t("build").inputSchema.properties.look && t("audit_design").inputSchema.properties.checks.items.enum.includes("overflow"));
  console.log("protocol version, job tool, since/look/overflow in the catalog OK");

  const plugin = fakePlugin();
  await plugin.ready;

  /* a long change becomes a job; the same call joins it; progress shows; job returns the result */
  let t0 = Date.now();
  let r = json(await A.tool("build", { spec: { type: "FRAME", name: "Slow" } }));
  assert.ok(r.job === "j1" && r.status === "running" && /Call job/.test(r.next) && Date.now() - t0 >= 900 && Date.now() - t0 < 3000, JSON.stringify(r));
  assert.equal(held.length, 1);
  const b1 = held[0];
  assert.ok(/^Claude Code ·[0-9a-z]{2}$/.test(b1.by), "commands say which Claude window sent them: " + b1.by);
  plugin.send({ type: "progress", rid: b1.id, state: "running", done: 2, total: 5, text: "Card" });
  await sleep(60);
  r = json(await A.tool("job", { id: "j1", wait: 0 }));
  assert.ok(r.status === "running" && r.progress === "2/5 Card", JSON.stringify(r));
  r = json(await A.tool("build", { spec: { type: "FRAME", name: "Slow" } }));
  assert.equal(r.job, "j1", "the same call joins the running job");
  assert.equal(held.length, 1, "and is not sent to Figma twice");
  setTimeout(() => plugin.answer(b1, { roots: [{ id: "1:2" }], created: 1 }), 150);
  r = await A.tool("job", { id: "j1" });
  assert.ok(/^\[Job j1 \(build\) finished after \d+s\.\]\n/.test(txt(r)) && json(r).created === 1, txt(r));
  const again = A.tool("build", { spec: { type: "FRAME", name: "Slow" } });
  await sleep(150);
  assert.equal(held.length, 2, "once its result was seen, the same call is a new change");
  plugin.answer(held[1], { created: 1 });
  assert.ok(!/Note/.test(txt(await again)));
  console.log("job: soft limit, progress, joining, result OK");

  /* Claude never saw the result (the client gave up): the retry gets it instead of changing again */
  r = json(await A.tool("update_nodes", { items: [{ id: "1:2", name: "X" }] }));
  assert.ok(r.job);
  plugin.answer(held[2], { done: ["Card: name"] });
  await sleep(60);
  r = await A.tool("update_nodes", { items: [{ id: "1:2", name: "X" }] });
  assert.ok(/^\[Note: this same call already ran \d+s ago \(job j\d\) and its answer hadn't been seen; here it is\. Nothing was done again\.\]/.test(txt(r)) && json(r).done[0] === "Card: name", txt(r));
  assert.equal(held.length, 3, "the retry wasn't sent to Figma");
  console.log("unseen result goes to the retry OK");

  /* job cancel: Figma drops a change that hasn't run; then the same call can be sent again */
  r = json(await A.tool("update_nodes", { items: [{ id: "1:3", name: "Y" }] }));
  const u2 = held[3];
  const pc = A.tool("job", { id: r.job, cancel: true });
  await sleep(120);
  assert.ok(cancels.find((c) => c.rid === u2.id && c.by === "claude"), "Figma is asked to cancel it");
  plugin.fail(u2, "Cancelled before it ran. Nothing was changed.");
  const cr = await pc;
  assert.ok(cr.isError && /Cancelled before it ran/.test(txt(cr)), txt(cr));
  const pa = A.tool("update_nodes", { items: [{ id: "1:3", name: "Y" }] });
  await sleep(120);
  assert.equal(held.length, 5, "a cancelled change can be sent again");
  plugin.answer(held[4], { done: ["Y"] });
  await pa;
  console.log("job cancel OK");

  /* the client cancels the request (the user stopped Claude): what hasn't run is dropped, no answer is sent */
  let answered = false;
  A.waiters.set(900, () => { answered = true; });
  A.raw({ jsonrpc: "2.0", id: 900, method: "tools/call", params: { name: "update_nodes", arguments: { items: [{ id: "1:4", name: "Z" }] } } });
  await sleep(150);
  const u4 = held[held.length - 1];
  assert.equal(u4.params.items[0].name, "Z");
  A.raw({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 900, reason: "stopped" } });
  await sleep(120);
  assert.ok(cancels.find((c) => c.rid === u4.id), "notifications/cancelled reaches Figma");
  plugin.fail(u4, "Cancelled before it ran. Nothing was changed.");
  await sleep(1200);
  assert.ok(!answered, "a cancelled request gets no answer");
  console.log("notifications/cancelled OK");

  /* progress notifications while a call runs */
  A.notes.length = 0;
  r = json(await A.tool("build", { spec: { type: "FRAME", name: "With progress" } }, { progressToken: "tok1" }));
  const prog = A.notes.filter((n) => n.method === "notifications/progress" && n.params.progressToken === "tok1");
  assert.ok(prog.length >= 2 && prog[1].params.progress >= prog[0].params.progress && /running/.test(prog[0].params.message), JSON.stringify(prog));
  plugin.answer(held[held.length - 1], { created: 1 });
  await A.tool("job", { id: r.job });
  console.log("progress notifications OK (" + prog.length + ")");

  /* reads: etag, and since → {unchanged: true} */
  const s1 = json(await A.tool("get_selection", {}));
  assert.ok(s1.etag && s1.count === 1);
  assert.deepEqual(json(await A.tool("get_selection", { since: s1.etag })), { unchanged: true, etag: s1.etag });
  selection = { count: 2, selection: [{ id: "1:2" }, { id: "1:3" }] };
  const s3 = json(await A.tool("get_selection", { since: s1.etag }));
  assert.ok(s3.count === 2 && s3.etag && s3.etag !== s1.etag);
  console.log("etag / since OK");

  /* look: true → a picture in the same answer */
  r = await A.tool("build", { spec: { type: "FRAME", name: "Look at me" }, look: true });
  assert.ok(r.content.length === 2 && r.content[1].type === "image" && r.content[1].data === "iVBORw0KGgo=");
  assert.deepEqual(json(r).look, { width: 300, height: 200, of: "Look at me" });
  assert.ok(!/iVBOR/.test(txt(r)));
  console.log("look OK");

  /* Ask first: status says so, and changes may wait for the user's OK longer */
  plugin.send({ type: "info", info: { ask: true, paused: false } });
  await sleep(60);
  const st = JSON.parse(txt(await A.tool("status")));
  assert.ok(st.ask_first && st.notes.some((n) => /Ask first/.test(n)), JSON.stringify(st));
  const pAsk = A.tool("update_nodes", { items: [{ id: "1:5", name: "Needs OK" }] });
  await sleep(100);
  const u5 = held[held.length - 1];
  assert.ok(u5.deadline - Date.now() > 150000, "a change in Ask first mode may wait up to FIGMA_BRIDGE_ASK_MS");
  plugin.send({ type: "progress", rid: u5.id, state: "asking" });
  r = json(await pAsk);
  assert.ok(r.job && /waiting for the user's OK/.test(r.status), JSON.stringify(r));
  plugin.answer(u5, { done: ["ok"] });
  assert.equal(json(await A.tool("job", { id: r.job })).done[0], "ok");
  plugin.send({ type: "info", info: { ask: false, paused: false } });
  console.log("Ask first OK");

  /* through a relay (a second Claude window): by, progress and cancel travel through the hub */
  const B = mcp("B");
  await sleep(600);
  await B.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-ai" } });
  assert.ok(/"role":\s*"relay"/.test(txt(await B.tool("status"))));
  r = json(await B.tool("run_code", { code: "slow()" }));
  const rc = held[held.length - 1];
  assert.ok(r.job && rc.command === "run_code" && /^Claude ·[0-9a-z]{2}$/.test(rc.by) && rc.by !== b1.by, rc.by);
  plugin.send({ type: "progress", rid: rc.id, state: "running", done: 7, total: 9 });
  await sleep(80);
  assert.equal(json(await B.tool("job", { id: r.job, wait: 0 })).progress, "7/9");
  const pcB = B.tool("job", { id: r.job, cancel: true });
  await sleep(150);
  assert.ok(cancels.find((c) => c.rid === rc.id), "cancel goes relay → hub → Figma");
  plugin.fail(rc, "Stopped part way through (cancelled): what it did before stopping stays in the file (one Cmd+Z undoes it).");
  assert.ok(/Stopped part way/.test(txt(await pcB)));
  console.log("relay: by, progress, cancel OK");

  B.close(); A.close(); plugin.ws.close();
  await sleep(200);
  console.log("ALL JOB TESTS PASSED");
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
