// The server starts and lists its tools on the oldest Node it supports (18), with no network.
// Run: node test/smoke.test.js
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");
const srv = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")], { env: Object.assign({}, process.env, { FIGMA_BRIDGE_PORT: process.env.TEST_PORT_SMOKE || "3994" }) });
let out = "";
const got = new Map();
srv.stdout.on("data", (d) => {
  out += d;
  let i;
  while ((i = out.indexOf("\n")) >= 0) { const m = JSON.parse(out.slice(0, i)); out = out.slice(i + 1); got.set(m.id, m); }
});
const send = (o) => srv.stdin.write(JSON.stringify(o) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
send({ jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} });
setTimeout(() => {
  try {
    assert.equal(got.get(1).result.serverInfo.name, "figma-bridge");
    const tools = got.get(2).result.tools;
    assert.ok(tools.length >= 23 && tools.find((t) => t.name === "get_spec"), "tools listed");
    assert.ok(tools.every((t) => t.annotations && t.annotations.title), "every tool annotated");
    assert.equal(got.get(3).result.prompts.length, 9);
    console.log("SMOKE OK on Node " + process.version + ": " + tools.length + " tools");
    srv.stdin.end();
  } catch (e) { console.error("SMOKE FAILED", e.message); srv.kill(); process.exit(1); }
}, 1500);
