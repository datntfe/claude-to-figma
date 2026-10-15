/* Claude Bridge — Figma plugin (main thread)
   Receives commands from the local bridge server (via ui.html) and runs them
   with the Figma Plugin API. Keep this plugin open while Claude works. */

figma.showUI(__html__, { width: 300, height: 236, themeColors: true, title: "Claude Bridge" });

const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;

/* ---------- serialisation ---------- */
function summary(node, depth) {
  const o = { id: node.id, name: node.name, type: node.type };
  if ("x" in node && node.type !== "PAGE") { o.x = round(node.x); o.y = round(node.y); o.width = round(node.width); o.height = round(node.height); }
  if (node.type === "TEXT") o.characters = node.characters.length > 300 ? node.characters.slice(0, 300) + "…" : node.characters;
  if ("layoutMode" in node && node.layoutMode !== "NONE") o.layoutMode = node.layoutMode;
  if ("visible" in node && node.visible === false) o.visible = false;
  if ("children" in node) {
    o.childCount = node.children.length;
    if (depth > 0) o.children = node.children.slice(0, 200).map(function (c) { return summary(c, depth - 1); });
  }
  return o;
}
function round(v) { return Math.round(v * 100) / 100; }
function isNode(v) { return v && typeof v === "object" && typeof v.id === "string" && typeof v.type === "string" && "name" in v && "parent" in v; }
function ser(v, depth) {
  if (v === undefined || v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v === undefined ? null : v;
  if (typeof v === "function") return "[function]";
  if (isNode(v)) return summary(v, 0);
  if (v instanceof Uint8Array) return "[Uint8Array " + v.length + " bytes]";
  if (depth <= 0) return "[…]";
  if (Array.isArray(v)) return v.slice(0, 500).map(function (x) { return ser(x, depth - 1); });
  const out = {};
  Object.keys(v).slice(0, 200).forEach(function (k) { out[k] = ser(v[k], depth - 1); });
  return out;
}
function safeString(x) { try { return typeof x === "string" ? x : JSON.stringify(ser(x, 4)); } catch (e) { return String(x); } }

/* ---------- helpers exposed to run_code as `h` ---------- */
function hex(h) {
  const s = h.replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map(function (c) { return c + c; }).join("") : s.slice(0, 6), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function solid(h, opacity) { return [{ type: "SOLID", color: hex(h), opacity: opacity === undefined ? 1 : opacity }]; }
function paints(v) {
  if (v === null || v === undefined || v === "none") return [];
  if (typeof v === "string") { const p = v.split("@"); return solid(p[0], p[1] !== undefined ? parseFloat(p[1]) : 1); }
  if (Array.isArray(v)) return v.reduce(function (acc, x) { return acc.concat(typeof x === "string" ? paints(x) : [x]); }, []);
  return [v];
}
async function font(family, style) { const f = { family: family, style: style || "Regular" }; await figma.loadFontAsync(f); return f; }
function svg(markup, width) {
  const n = figma.createNodeFromSvg(markup);
  if (width && Math.abs(n.width - width) > 0.01) n.rescale(width / n.width);
  return n;
}
const H = { hex: hex, solid: solid, paints: paints, font: font, svg: svg, summary: summary };

async function getNode(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error("Node not found: " + id);
  return n;
}

/* ---------- build: JSON spec → nodes ---------- */
const PAD = function (p) { return typeof p === "number" ? [p, p, p, p] : (p.length === 2 ? [p[0], p[1], p[0], p[1]] : p); };
async function buildNode(spec, parent, created) {
  const t = String(spec.type || "FRAME").toUpperCase();
  let n;
  if (t === "FRAME") { n = figma.createFrame(); n.fills = []; }
  else if (t === "TEXT") n = figma.createText();
  else if (t === "RECTANGLE") n = figma.createRectangle();
  else if (t === "ELLIPSE") n = figma.createEllipse();
  else if (t === "SVG") n = svg(spec.svg, spec.size ? spec.size[0] : undefined);
  else if (t === "SECTION") n = figma.createSection();
  else if (t === "LINE") n = figma.createLine();
  else throw new Error("Unsupported type: " + t);
  parent.appendChild(n);
  created.push(n);
  if (spec.name) n.name = spec.name;
  if (t === "TEXT") {
    const f = spec.font || { family: "Inter", style: "Regular" };
    await figma.loadFontAsync(f);
    n.fontName = f;
    n.characters = String(spec.text === undefined ? "" : spec.text);
    if (spec.fontSize) n.fontSize = spec.fontSize;
    if (spec.color) n.fills = paints(spec.color);
  }
  const L = spec.layout;
  if (L && (t === "FRAME")) {
    n.layoutMode = L.mode || "VERTICAL";
    if (L.gap !== undefined) n.itemSpacing = L.gap;
    if (L.padding !== undefined) { const p = PAD(L.padding); n.paddingTop = p[0]; n.paddingRight = p[1]; n.paddingBottom = p[2]; n.paddingLeft = p[3]; }
    if (L.justify) n.primaryAxisAlignItems = L.justify;
    if (L.align) n.counterAxisAlignItems = L.align;
  }
  if (spec.size && t !== "SVG") n.resize(spec.size[0], spec.size[1]);
  if (spec.fill !== undefined) n.fills = paints(spec.fill);
  if (spec.stroke !== undefined) n.strokes = paints(spec.stroke);
  if (spec.radius !== undefined) n.cornerRadius = spec.radius;
  const props = spec.props || {};
  Object.keys(props).forEach(function (k) {
    if (k === "layoutSizingHorizontal" || k === "layoutSizingVertical") return;
    n[k] = (k === "fills" || k === "strokes") ? paints(props[k]) : props[k];
  });
  if (L && t === "FRAME") {
    if (!L.w || L.w === "HUG") n.layoutSizingHorizontal = "HUG";
    if (!L.h || L.h === "HUG") n.layoutSizingVertical = "HUG";
  }
  for (const c of (spec.children || [])) await buildNode(c, n, created);
  const parentAuto = "layoutMode" in parent && parent.layoutMode !== "NONE";
  function sizing(axis, v) {
    const key = axis === "w" ? "layoutSizingHorizontal" : "layoutSizingVertical";
    if (v === "FILL" && parentAuto) n[key] = "FILL";
    else if (typeof v === "number") { if (axis === "w") n.resize(v, n.height); else n.resize(n.width, v); if ("layoutSizingHorizontal" in n && (parentAuto || (L && t === "FRAME"))) n[key] = "FIXED"; }
  }
  if (L) { sizing("w", L.w); sizing("h", L.h); }
  if (spec.fillWidth) sizing("w", "FILL");
  if (props.layoutSizingHorizontal) n.layoutSizingHorizontal = props.layoutSizingHorizontal;
  if (props.layoutSizingVertical) n.layoutSizingVertical = props.layoutSizingVertical;
  if (spec.x !== undefined) n.x = spec.x;
  if (spec.y !== undefined) n.y = spec.y;
  return n;
}

/* ---------- command handlers ---------- */
const handlers = {
  async ping() {
    return { file: figma.root.name, page: figma.currentPage.name, editorType: figma.editorType, selection: figma.currentPage.selection.length };
  },
  async run_code(p) {
    const logs = [];
    const log = function () { logs.push(Array.prototype.map.call(arguments, safeString).join(" ")); };
    let fn;
    try { fn = new AsyncFunction("figma", "log", "h", p.code); }
    catch (e) { throw new Error("Could not compile code: " + e.message); }
    const value = await fn(figma, log, H);
    return { value: ser(value, 4), logs: logs };
  },
  async screenshot(p) {
    let node = p.node_id ? await getNode(p.node_id) : figma.currentPage.selection[0];
    if (!node) throw new Error("Nothing to export: pass node_id or select a layer in Figma.");
    if (!("exportAsync" in node) || node.type === "PAGE") throw new Error("This node type can't be exported: " + node.type);
    const scale = p.scale || 1, max = p.max_size || 1600;
    const longest = Math.max(node.width, node.height) * scale;
    const constraint = longest > max
      ? (node.width >= node.height ? { type: "WIDTH", value: Math.round(max) } : { type: "HEIGHT", value: Math.round(max) })
      : { type: "SCALE", value: scale };
    const bytes = await node.exportAsync({ format: "PNG", constraint: constraint });
    const k = longest > max ? max / Math.max(node.width, node.height) : scale;
    return { base64: figma.base64Encode(bytes), id: node.id, name: node.name, width: Math.round(node.width * k), height: Math.round(node.height * k) };
  },
  async get_selection(p) {
    const d = p.depth === undefined ? 2 : p.depth;
    return { page: figma.currentPage.name, selection: figma.currentPage.selection.map(function (n) { return summary(n, d); }) };
  },
  async get_tree(p) {
    const n = p.node_id ? await getNode(p.node_id) : figma.currentPage;
    if (n.type === "PAGE" && n.loadAsync) await n.loadAsync();
    return summary(n, p.depth === undefined ? 2 : p.depth);
  },
  async list_pages() {
    return { current: { id: figma.currentPage.id, name: figma.currentPage.name }, pages: figma.root.children.map(function (pg) { return { id: pg.id, name: pg.name }; }) };
  },
  async set_page(p) {
    let page = null;
    if (p.page_id) page = await getNode(p.page_id);
    else if (p.name) page = figma.root.children.find(function (pg) { return pg.name === p.name; }) || null;
    if (!page && p.create && p.name) { page = figma.createPage(); page.name = p.name; }
    if (!page) throw new Error("Page not found.");
    await figma.setCurrentPageAsync(page);
    return { id: page.id, name: page.name };
  },
  async build(p) {
    const parent = p.parent_id ? await getNode(p.parent_id) : figma.currentPage;
    if (!("appendChild" in parent)) throw new Error("Parent can't have children: " + parent.type);
    const specs = Array.isArray(p.spec) ? p.spec : [p.spec];
    const created = [], roots = [];
    for (const s of specs) roots.push(await buildNode(s, parent, created));
    return { roots: roots.map(function (n) { return summary(n, 0); }), created: created.length };
  },
  async delete_nodes(p) {
    const done = [];
    for (const id of p.ids || []) { const n = await figma.getNodeByIdAsync(id); if (n && n.type !== "PAGE" && n.type !== "DOCUMENT") { n.remove(); done.push(id); } }
    return { deleted: done };
  },
  async focus(p) {
    const nodes = [];
    for (const id of p.ids || []) { const n = await figma.getNodeByIdAsync(id); if (n && n.type !== "PAGE" && n.type !== "DOCUMENT") nodes.push(n); }
    if (!nodes.length) throw new Error("No nodes found.");
    let page = nodes[0].parent;
    while (page && page.type !== "PAGE") page = page.parent;
    if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
    const onPage = nodes.filter(function (n) { let q = n.parent; while (q && q.type !== "PAGE") q = q.parent; return q === figma.currentPage; });
    figma.currentPage.selection = onPage;
    figma.viewport.scrollAndZoomIntoView(onPage);
    return { selected: onPage.map(function (n) { return n.id; }) };
  }
};

let busy = 0;
figma.ui.onmessage = async function (msg) {
  if (!msg) return;
  if (msg.type === "ui-ready") {
    figma.ui.postMessage({ type: "hello", info: { file: figma.root.name, page: figma.currentPage.name, editorType: figma.editorType } });
    return;
  }
  if (msg.type !== "command") return;
  busy++;
  try {
    const fn = handlers[msg.command];
    if (!fn) throw new Error("Unknown command: " + msg.command);
    const result = await fn(msg.params || {});
    figma.ui.postMessage({ type: "result", id: msg.id, ok: true, result: result });
  } catch (e) {
    figma.ui.postMessage({ type: "result", id: msg.id, ok: false, error: String(e && e.message ? e.message : e) });
  } finally {
    busy--;
  }
};
