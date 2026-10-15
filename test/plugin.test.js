// Plugin main-thread handlers (figma-plugin/code.js) against a mock Figma API.
// Run: node test/plugin.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");
let ids = 0; const all = new Map(); const fonts = new Set(); const errors = [];
function node(type, extra) {
  const n = Object.assign({ id: (++ids) + ":1", type, name: type, x: 0, y: 0, width: 100, height: 100, parent: null, visible: true }, extra || {});
  if (["FRAME", "PAGE", "SECTION", "DOCUMENT"].includes(type)) n.children = [];
  if (type === "FRAME") { n.layoutMode = "NONE"; n.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; }
  if (type === "TEXT") { n.fontName = { family: "Inter", style: "Regular" }; n._chars = ""; Object.defineProperty(n, "characters", { get() { return this._chars; }, set(v) { const f = this.fontName; if (!fonts.has(f.family + f.style)) errors.push("chars before font"); this._chars = v; }, enumerable: true }); }
  n.appendChild = function (c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.push(c); };
  n.resize = function (w, h) { if (!(w > 0 && h > 0)) errors.push("bad resize"); this.width = w; this.height = h; };
  n.rescale = function (k) { this.width *= k; this.height *= k; };
  n.remove = function () { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; all.delete(this.id); };
  n.exportAsync = async function (opts) { n._lastExport = opts; return new Uint8Array([137, 80, 78, 71, 1, 2, 3]); };
  let lsh, lsv;
  Object.defineProperty(n, "layoutSizingHorizontal", { get() { return lsh; }, set(v) { check(n, v, "H"); lsh = v; }, enumerable: false });
  Object.defineProperty(n, "layoutSizingVertical", { get() { return lsv; }, set(v) { check(n, v, "V"); lsv = v; }, enumerable: false });
  all.set(n.id, n);
  return n;
}
function check(n, v, axis) {
  const auto = (x) => x && x.layoutMode && x.layoutMode !== "NONE";
  if (v === "HUG" && !(n.type === "TEXT" || auto(n))) errors.push("HUG on non-auto " + n.name);
  if (v === "FILL" && !auto(n.parent)) errors.push("FILL without auto parent " + n.name);
}
const doc = node("DOCUMENT", { name: "Take-home.fig" });
const page1 = node("PAGE", { name: "Page 1" }); doc.appendChild(page1);
let current = page1;
let uiHandler = null; const toUI = [];
const figma = {
  editorType: "figma",
  get root() { return doc; },
  get currentPage() { return current; },
  showUI() { }, ui: { postMessage(m) { toUI.push(m); }, set onmessage(f) { uiHandler = f; } },
  async loadFontAsync(f) { fonts.add(f.family + f.style); },
  async getNodeByIdAsync(id) { return all.get(id) || null; },
  async setCurrentPageAsync(p) { current = p; },
  createPage() { const p = node("PAGE"); doc.appendChild(p); return p; },
  createFrame() { const n = node("FRAME"); current.appendChild(n); return n; },
  createText() { const n = node("TEXT"); current.appendChild(n); return n; },
  createRectangle() { const n = node("RECTANGLE"); current.appendChild(n); return n; },
  createEllipse() { const n = node("ELLIPSE"); current.appendChild(n); return n; },
  createSection() { const n = node("SECTION"); current.appendChild(n); return n; },
  createLine() { const n = node("LINE"); current.appendChild(n); return n; },
  createNodeFromSvg(s) { const n = node("FRAME", { width: 24, height: 24 }); current.appendChild(n); return n; },
  base64Encode(b) { return Buffer.from(b).toString("base64"); },
  viewport: { scrollAndZoomIntoView(ns) { figma._zoomed = ns.map((n) => n.id); } }
};
page1.selection = [];
const code = fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
vm.runInNewContext(code, { figma, __html__: "<html>", console, Promise, Object, Array, Math, String, JSON, Uint8Array, parseInt, parseFloat });
let mid = 0;
async function cmd(command, params) {
  const id = ++mid; toUI.length = 0;
  await uiHandler({ type: "command", id, command, params });
  const r = toUI.find((m) => m.id === id);
  return r;
}
(async () => {
  await uiHandler({ type: "ui-ready" });
  assert.equal(toUI[0].type, "hello"); assert.equal(toUI[0].info.file, "Take-home.fig");
  console.log("hello OK");

  let r = await cmd("ping");
  assert.ok(r.ok && r.result.page === "Page 1"); console.log("ping OK");

  r = await cmd("run_code", { code: "const f = figma.createFrame(); f.name = 'Card'; f.resize(358, 200); f.fills = h.solid('#15121F'); log('made', f.name); return f;" });
  assert.ok(r.ok, r.error); assert.equal(r.result.value.name, "Card"); assert.deepEqual(r.result.logs, ["made Card"]);
  const cardId = r.result.value.id; console.log("run_code OK →", JSON.stringify(r.result.value));

  r = await cmd("run_code", { code: "globalThis.lib = { n: 41 }; return 1" });
  r = await cmd("run_code", { code: "return globalThis.lib.n + 1" });
  assert.equal(r.result.value, 42); console.log("globalThis persists between calls OK");

  r = await cmd("run_code", { code: "return {a:[1,2,{b:figma.currentPage}], c: undefined}" });
  assert.ok(r.ok); console.log("serialisation OK →", JSON.stringify(r.result.value));

  r = await cmd("run_code", { code: "this is not js" });
  assert.ok(!r.ok && /compile/.test(r.error)); console.log("compile error OK →", r.error);
  r = await cmd("run_code", { code: "throw new Error('nope')" });
  assert.ok(!r.ok && r.error === "nope"); console.log("runtime error OK");

  r = await cmd("build", { spec: { type: "FRAME", name: "Screen", size: [390, 844], fill: "#0A0912", layout: { mode: "VERTICAL", gap: 12, padding: [16, 16], w: 390, h: 844 }, children: [
    { type: "TEXT", text: "Daily Lucky Bonus", font: { family: "Be Vietnam Pro", style: "Bold" }, fontSize: 20, color: "#F5F3FF", fillWidth: true },
    { type: "FRAME", name: "Card", fill: "#15121F@0.9", radius: 20, layout: { mode: "HORIZONTAL", gap: 8, padding: 16, w: "FILL" }, children: [{ type: "ELLIPSE", size: [24, 24], fill: "#F5B83D" }, { type: "SVG", svg: "<svg width='24' height='24'></svg>", size: [20, 20] }] }
  ] } });
  assert.ok(r.ok, r.error); assert.equal(r.result.created, 5);
  const screen = all.get(r.result.roots[0].id);
  assert.equal(screen.layoutMode, "VERTICAL"); assert.equal(screen.paddingLeft, 16); assert.equal(screen.layoutSizingHorizontal, "FIXED");
  assert.equal(screen.children[1].layoutSizingHorizontal, "FILL"); assert.equal(screen.children[0].characters, "Daily Lucky Bonus");
  assert.equal(screen.children[1].fills[0].opacity, 0.9);
  console.log("build OK → created", r.result.created, "nodes");

  r = await cmd("get_tree", { depth: 3 });
  assert.ok(r.ok); console.log("get_tree OK → page children:", r.result.childCount);

  page1.selection = [screen];
  r = await cmd("get_selection", {});
  assert.equal(r.result.selection[0].name, "Screen"); console.log("get_selection OK");

  r = await cmd("screenshot", {});
  assert.ok(r.ok && r.result.base64.length > 0 && r.result.width === 390); console.log("screenshot (selection) OK →", JSON.stringify(screen._lastExport.constraint));
  r = await cmd("screenshot", { node_id: screen.id, scale: 2 });
  assert.equal(screen._lastExport.constraint.type, "HEIGHT"); console.log("screenshot max_size clamp OK →", JSON.stringify(screen._lastExport.constraint), r.result.width + "x" + r.result.height);
  page1.selection = [];
  r = await cmd("screenshot", {});
  assert.ok(!r.ok); console.log("screenshot with nothing selected → clear error:", r.error);

  r = await cmd("set_page", { name: "02 Mobile", create: true });
  assert.ok(r.ok && figma.currentPage.name === "02 Mobile"); console.log("set_page create OK");
  r = await cmd("list_pages", {});
  assert.equal(r.result.pages.length, 2); console.log("list_pages OK");

  r = await cmd("focus", { ids: [screen.id] });
  assert.ok(r.ok && figma.currentPage === page1 && figma._zoomed[0] === screen.id); console.log("focus switches page + zooms OK");

  r = await cmd("delete_nodes", { ids: [cardId, "999:1"] });
  assert.deepEqual(r.result.deleted, [cardId]); console.log("delete_nodes OK");

  r = await cmd("nope", {});
  assert.ok(!r.ok);
  assert.deepEqual(errors, []);
  console.log("ALL PLUGIN TESTS PASSED (API rule violations: " + errors.length + ")");
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
