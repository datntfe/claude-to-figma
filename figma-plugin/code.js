/* Claude Bridge — Figma plugin (main thread)
   Receives commands from the local bridge server (via ui.html) and runs them
   with the Figma Plugin API. Keep this plugin open while Claude works.

   It also keeps a short log of what happens in this file while it is open
   (selection, page, viewport, edits; by the user, a collaborator or Claude),
   so Claude can tell what "this" and "here" mean. The log stays inside the
   plugin and is only sent when Claude asks for it (get_context). */

const VERSION = "1.2.0";
const SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const STARTED = Date.now();

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
    const kids = safe(function () { return node.children; }, null);   // another page that isn't loaded yet throws
    if (!kids) o.childCount = "not loaded";
    else {
      o.childCount = kids.length;
      if (depth > 0) o.children = kids.slice(0, 200).map(function (c) { return summary(c, depth - 1); });
    }
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

/* ---------- small utilities ---------- */
function safe(f, fallback) { try { return f(); } catch (e) { return fallback; } }
function lower(s) { return String(s === undefined || s === null ? "" : s).toLowerCase(); }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
function hex2(v) { const s = Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16); return s.length < 2 ? "0" + s : s; }
function toHex(c, opacity) {
  if (!c || typeof c !== "object") return String(c);
  const a = (c.a === undefined ? 1 : c.a) * (opacity === undefined ? 1 : opacity);
  return ("#" + hex2(c.r) + hex2(c.g) + hex2(c.b) + (a < 0.998 ? hex2(a) : "")).toUpperCase();
}
function parseColor(v) {
  if (v && typeof v === "object" && "r" in v) return { r: +v.r, g: +v.g, b: +v.b, a: v.a === undefined ? 1 : +v.a };
  let s = String(v).trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(s) || [3, 4, 6, 8].indexOf(s.length) < 0) throw new Error('Not a colour: "' + v + '" (use #RRGGBB or #RRGGBBAA)');
  if (s.length <= 4) s = s.split("").map(function (c) { return c + c; }).join("");
  const n = function (i) { return parseInt(s.slice(i, i + 2), 16) / 255; };
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) : 1 };
}
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return Math.round(s / 360) / 10 + "h";
}
function inter(a, b) {
  if (!a || !b) return null;
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}
function areaOf(r) { return r ? r.width * r.height : 0; }
function boxOf(n) { return safe(function () { return n.absoluteBoundingBox || n.absoluteRenderBounds || null; }, null); }
function unionBox(a, b) {
  if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x: x, y: y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
function pageOf(n) { let q = n; while (q && q.type !== "PAGE") q = q.parent; return q; }
function ancestors(n) {
  const names = [];
  let q = n.parent;
  while (q && q.type !== "PAGE" && q.type !== "DOCUMENT" && names.length < 12) { names.unshift(q.name); q = q.parent; }
  return names.join(" › ");
}
function label(n) {
  if (!n) return "?";
  if (n.removed) return "(deleted " + n.type + ", " + n.id + ")";
  return safe(function () { return n.name + " (" + n.type + ", " + n.id + ")"; }, "(" + n.id + ")");
}
function fileKey() { return safe(function () { return figma.fileKey || undefined; }, undefined); }
function helloInfo() {
  return { file: figma.root.name, fileKey: fileKey(), page: figma.currentPage.name, editorType: figma.editorType, version: VERSION, session: SESSION };
}

/* ---------- helpers exposed to run_code as `h` ---------- */
function hex(h) { const c = parseColor(h); return { r: c.r, g: c.g, b: c.b }; }
function solid(h, opacity) { const c = parseColor(h); return [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: opacity === undefined ? c.a : opacity }]; }
/* '#RRGGBB', '#RRGGBBAA', '#RGB(A)', '#RRGGBB@0.5', a Paint, or an array of those → Paint[] */
function paints(v) {
  if (v === null || v === undefined || v === "none") return [];
  return paintsFrom(Array.isArray(v) ? v : [v]);
}
async function ensureLoaded(n) { if (n && n.type === "PAGE" && typeof n.loadAsync === "function") await n.loadAsync(); return n; }
/* Properties that can't be assigned directly with documentAccess: dynamic-page go through their async setters. */
async function setRawProp(n, k, v) {
  if (k === "fillStyleId") return n.setFillStyleIdAsync(v);
  if (k === "strokeStyleId") return n.setStrokeStyleIdAsync(v);
  if (k === "effectStyleId") return n.setEffectStyleIdAsync(v);
  if (k === "gridStyleId") return n.setGridStyleIdAsync(v);
  if (k === "textStyleId") { await loadFontsOf(n); return n.setTextStyleIdAsync(v); }
  if (k === "reactions") return n.setReactionsAsync(v);
  if (k === "fills" || k === "strokes") { n[k] = paints(v); return; }
  if (k === "effects") { n[k] = (v || []).map(effectFrom); return; }
  n[k] = v;
}
async function font(family, style) { const f = { family: family, style: style || "Regular" }; await figma.loadFontAsync(f); return f; }
function svg(markup, width) {
  const n = figma.createNodeFromSvg(markup);
  if (width && Math.abs(n.width - width) > 0.01) n.rescale(width / n.width);
  return n;
}
const H = {
  hex: hex, solid: solid, paints: paints, font: font, svg: svg, summary: summary,
  color: parseColor, toHex: toHex,
  describe: function (node, depth) { return describe(node, makeCtx(), depth === undefined ? 1 : depth); },
  variable: function (ref, collection) { return resolveVariable(ref, collection); },
  bind: async function (node, field, ref, opts) { return bindOne(node, field, ref === null ? null : await resolveVariable(ref, opts && opts.collection), opts || {}); },
  update: function (node, props) { return applyProps(node, props || {}, makeCtx()); },
  link: function (node, to, opts) { return setLink(node, Object.assign({ to: typeof to === "string" ? to : to.id }, opts || {})); },
  component: function (ref, variant) { return resolveComponent(ref, variant); }
};

async function getNode(id) {
  const n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error("Node not found: " + id);
  return n;
}

/* ---------- lookups shared within one command (cached) ---------- */
function makeCtx() {
  const vars = new Map(), cols = new Map(), styles = new Map(), mains = new Map();
  const ctx = {
    main: async function (inst) {
      if (!mains.has(inst.id)) { let m = null; try { m = await inst.getMainComponentAsync(); } catch (e) { m = null; } mains.set(inst.id, m); }
      return mains.get(inst.id);
    },
    variable: async function (id) {
      if (!vars.has(id)) { let v = null; try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { v = null; } vars.set(id, v); }
      return vars.get(id);
    },
    collection: async function (id) {
      if (!cols.has(id)) { let c = null; try { c = await figma.variables.getVariableCollectionByIdAsync(id); } catch (e) { c = null; } cols.set(id, c); }
      return cols.get(id);
    },
    varLabel: async function (id) {
      const v = await ctx.variable(id);
      if (!v) return "(missing variable " + id + ")";
      const c = await ctx.collection(v.variableCollectionId);
      return v.name + " [" + (c ? c.name : "?") + (v.remote ? ", library" : "") + "]";
    },
    style: async function (id) {
      if (!id || typeof id !== "string") return null;
      if (!styles.has(id)) { let s = null; try { s = await figma.getStyleByIdAsync(id); } catch (e) { s = null; } styles.set(id, s); }
      return styles.get(id);
    },
    styleLabel: async function (id) { const s = await ctx.style(id); return s ? s.name + (s.remote ? " [library]" : "") : null; }
  };
  return ctx;
}

/* ---------- describing layers ---------- */
async function paintText(p, ctx) {
  let s;
  if (p.type === "SOLID") s = toHex(p.color, p.opacity);
  else if (p.type.indexOf("GRADIENT_") === 0) s = lower(p.type.slice(9)) + " gradient " + (p.gradientStops || []).map(function (st) { return toHex(st.color); }).join(" → ");
  else s = lower(p.type);
  if (p.type !== "SOLID" && p.opacity !== undefined && p.opacity < 1) s += " " + Math.round(p.opacity * 100) + "%";
  if (p.visible === false) s += " (hidden)";
  if (p.blendMode && p.blendMode !== "NORMAL" && p.blendMode !== "PASS_THROUGH") s += " · " + lower(p.blendMode);
  const bv = p.boundVariables && p.boundVariables.color;
  if (bv && bv.id && ctx) s += " ← " + await ctx.varLabel(bv.id);
  return s;
}
function effectText(e) {
  let s = lower(e.type).replace(/_/g, "-");
  if (e.color) s += " " + toHex(e.color);
  if (e.offset) s += " " + round(e.offset.x) + "," + round(e.offset.y);
  if (e.radius !== undefined) s += " blur " + round(e.radius);
  if (e.spread) s += " spread " + round(e.spread);
  if (e.visible === false) s += " (hidden)";
  return s;
}
function lhText(lh) { if (!lh || lh === figma.mixed) return "mixed"; if (lh.unit === "AUTO") return "auto"; return round(lh.value) + (lh.unit === "PERCENT" ? "%" : ""); }
function lsText(ls) { if (!ls || ls === figma.mixed) return "mixed"; return round(ls.value) + (ls.unit === "PERCENT" ? "%" : "px"); }
function defsText(defs) {
  const out = {};
  Object.keys(defs || {}).forEach(function (k) {
    const d = defs[k];
    let s = d.type;
    if (d.type === "VARIANT") s += ": " + (d.variantOptions || []).join(" | ");
    if (d.defaultValue !== undefined && d.type !== "INSTANCE_SWAP") s += " (default " + JSON.stringify(d.defaultValue) + ")";
    out[k] = s;
  });
  return out;
}
function textInfo(node) {
  const t = { characters: clip(node.characters, 1000) };
  if (node.fontName === figma.mixed) {
    const fonts = safe(function () { return node.getRangeAllFontNames(0, node.characters.length); }, []);
    const uniq = [];
    fonts.forEach(function (f) { const s = f.family + " " + f.style; if (uniq.indexOf(s) < 0) uniq.push(s); });
    t.font = uniq.slice(0, 6).join(", ") || "mixed";
  } else t.font = node.fontName.family + " " + node.fontName.style;
  t.size = node.fontSize === figma.mixed ? "mixed" : round(node.fontSize);
  t.lineHeight = lhText(node.lineHeight);
  if (node.letterSpacing !== figma.mixed && node.letterSpacing && node.letterSpacing.value) t.letterSpacing = lsText(node.letterSpacing);
  t.align = node.textAlignHorizontal;
  if (node.textAutoResize && node.textAutoResize !== "NONE") t.autoResize = node.textAutoResize;
  if (node.textCase && node.textCase !== figma.mixed && node.textCase !== "ORIGINAL") t.case = node.textCase;
  if (node.textDecoration && node.textDecoration !== figma.mixed && node.textDecoration !== "NONE") t.decoration = node.textDecoration;
  return t;
}
async function componentInfo(node, ctx) {
  if (node.type === "INSTANCE") {
    const c = {};
    const main = ctx ? await ctx.main(node) : await safeMain(node);
    if (main) {
      const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
      c.main = set ? set.name : main.name;
      if (set) c.variant = main.name;
      c.key = main.key;
      if (set) c.setKey = set.key;
      c.source = main.remote ? "library" : "local";
      c.mainId = main.id;
    }
    const props = safe(function () { return node.componentProperties; }, null);
    if (props && Object.keys(props).length) {
      c.properties = {};
      Object.keys(props).forEach(function (k) { c.properties[k] = props[k].value; });
    }
    return c;
  }
  if (node.type === "COMPONENT") {
    const c = { key: node.key, source: node.remote ? "library" : "local" };
    if (node.description) c.description = clip(node.description, 200);
    if (node.parent && node.parent.type === "COMPONENT_SET") c.variantOf = node.parent.name;
    else {
      const d = safe(function () { return node.componentPropertyDefinitions; }, null);
      if (d && Object.keys(d).length) c.properties = defsText(d);
    }
    return c;
  }
  if (node.type === "COMPONENT_SET") {
    const c = { key: node.key, variants: node.children.length };
    if (node.description) c.description = clip(node.description, 200);
    const d = safe(function () { return node.componentPropertyDefinitions; }, null);
    if (d) c.properties = defsText(d);
    return c;
  }
  return null;
}
async function describe(node, ctx, depth) {
  const o = { id: node.id, name: node.name, type: node.type };
  const path = ancestors(node);
  if (path) o.path = path;
  if ("x" in node && node.type !== "PAGE") { o.x = round(node.x); o.y = round(node.y); o.width = round(node.width); o.height = round(node.height); }
  const bb = boxOf(node);
  if (bb && (round(bb.x) !== o.x || round(bb.y) !== o.y)) o.absolute = { x: round(bb.x), y: round(bb.y) };
  if (node.rotation) o.rotation = round(node.rotation);
  if (node.visible === false) o.visible = false;
  if (node.locked) o.locked = true;
  if ("opacity" in node && node.opacity < 1) o.opacity = round(node.opacity);
  if ("blendMode" in node && node.blendMode && node.blendMode !== "PASS_THROUGH" && node.blendMode !== "NORMAL") o.blendMode = node.blendMode;
  if ("fills" in node) {
    if (node.fills === figma.mixed) o.fills = "mixed (differs per text range)";
    else if (node.fills && node.fills.length) o.fills = await Promise.all(node.fills.map(function (p) { return paintText(p, ctx); }));
  }
  if ("strokes" in node && node.strokes && node.strokes.length) {
    o.strokes = await Promise.all(node.strokes.map(function (p) { return paintText(p, ctx); }));
    o.strokeWeight = node.strokeWeight === figma.mixed ? "mixed" : round(node.strokeWeight);
    if (node.strokeAlign && node.strokeAlign !== "INSIDE") o.strokeAlign = node.strokeAlign;
  }
  if ("cornerRadius" in node) {
    if (node.cornerRadius === figma.mixed) o.radius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius].map(round);
    else if (node.cornerRadius) o.radius = round(node.cornerRadius);
  }
  if ("effects" in node && node.effects && node.effects.length) o.effects = node.effects.map(effectText);
  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    const al = { direction: node.layoutMode };
    if (node.layoutMode !== "GRID") {
      al.gap = node.primaryAxisAlignItems === "SPACE_BETWEEN" ? "auto" : round(node.itemSpacing);
      al.padding = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(round);
      al.align = node.primaryAxisAlignItems + " / " + node.counterAxisAlignItems;
      if (node.layoutWrap === "WRAP") { al.wrap = true; al.rowGap = round(node.counterAxisSpacing); }
    }
    o.autoLayout = al;
  }
  const parentAuto = !!(node.parent && "layoutMode" in node.parent && node.parent.layoutMode && node.parent.layoutMode !== "NONE");
  if ((parentAuto || o.autoLayout) && "layoutSizingHorizontal" in node) {
    const sz = safe(function () { return node.layoutSizingHorizontal + " × " + node.layoutSizingVertical; }, null);
    if (sz) o.sizing = sz;
  }
  if (parentAuto && "layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") o.absolutePositioned = true;
  if (node.type === "TEXT") o.text = textInfo(node);
  const st = {};
  const styleKeys = [["fillStyleId", "fill"], ["strokeStyleId", "stroke"], ["effectStyleId", "effect"], ["textStyleId", "text"], ["gridStyleId", "grid"]];
  for (let i = 0; i < styleKeys.length; i++) {
    const k = styleKeys[i][0];
    if (!(k in node)) continue;
    const v = safe(function () { return node[k]; }, null);
    if (v === figma.mixed) st[styleKeys[i][1]] = "mixed";
    else if (v) { const l = await ctx.styleLabel(v); if (l) st[styleKeys[i][1]] = l; }
  }
  if (Object.keys(st).length) o.styles = st;
  const bound = safe(function () { return node.boundVariables; }, null);
  if (bound) {
    const bv = {};
    const keys = Object.keys(bound);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], v = bound[k];
      if (Array.isArray(v)) {
        for (let j = 0; j < v.length; j++) if (v[j] && v[j].id) bv[(v.length > 1 || k === "fills" || k === "strokes" || k === "effects") ? k + "[" + j + "]" : k] = await ctx.varLabel(v[j].id);
      } else if (v && v.id) bv[k] = await ctx.varLabel(v.id);
      else if (v && typeof v === "object") {
        const ks = Object.keys(v);
        for (let j = 0; j < ks.length; j++) if (v[ks[j]] && v[ks[j]].id) bv[k + "." + ks[j]] = await ctx.varLabel(v[ks[j]].id);
      }
    }
    if (Object.keys(bv).length) o.variables = bv;
  }
  const em = safe(function () { return node.explicitVariableModes; }, null);
  if (em && Object.keys(em).length) {
    o.modes = {};
    const cids = Object.keys(em);
    for (let i = 0; i < cids.length; i++) {
      const c = await ctx.collection(cids[i]);
      const m = c ? c.modes.filter(function (x) { return x.modeId === em[cids[i]]; })[0] : null;
      o.modes[c ? c.name : cids[i]] = m ? m.name : em[cids[i]];
    }
  }
  const comp = await componentInfo(node, ctx);
  if (comp) o.component = comp;
  if ("children" in node) {
    o.childCount = node.children.length;
    if (depth > 0 && node.children.length) o.children = node.children.slice(0, 100).map(function (c) { return summary(c, depth - 1); });
  }
  return o;
}
function brief(n) {
  const o = { id: n.id, name: n.name, type: n.type };
  if ("width" in n) o.size = round(n.width) + "×" + round(n.height);
  const p = ancestors(n);
  if (p) o.path = p;
  if (n.type === "TEXT") o.text = clip(n.characters, 80);
  return o;
}
function textRange() {
  const r = safe(function () { return figma.currentPage.selectedTextRange; }, null);
  if (!r) return null;
  const o = { node: r.node.name, nodeId: r.node.id, start: r.start, end: r.end };
  if (r.end > r.start) o.selected = clip(r.node.characters.slice(r.start, r.end), 500);
  else o.caretOnly = true;
  return o;
}

/* ---------- what is on screen ---------- */
function focusChain(b) {
  const va = b.width * b.height, cx = b.x + b.width / 2, cy = b.y + b.height / 2, chain = [];
  let cands = figma.currentPage.children;
  for (let lvl = 0; lvl < 8 && cands && cands.length; lvl++) {
    let best = null, bestA = 0, centre = null, centreA = 0;
    for (let i = 0; i < cands.length && i < 3000; i++) {
      const c = cands[i];
      if (c.visible === false) continue;
      const bb = boxOf(c);
      const a = areaOf(inter(bb, b));
      if (!a) continue;
      if (a > bestA) { bestA = a; best = c; }
      if (bb.x <= cx && cx <= bb.x + bb.width && bb.y <= cy && cy <= bb.y + bb.height && a > centreA) { centreA = a; centre = c; }
    }
    let pick = null, pa = 0;
    if (centre && centreA >= 0.2 * va) { pick = centre; pa = centreA; }
    else if (best && bestA >= 0.4 * va) { pick = best; pa = bestA; }
    if (!pick) break;
    chain.push({ node: pick, cover: pa / va });
    if (!("children" in pick) || pick.type === "INSTANCE" || pick.type === "BOOLEAN_OPERATION") break;
    cands = pick.children;
  }
  return chain;
}
function viewportInfo(depth, maxLayers) {
  const b = figma.viewport.bounds, z = figma.viewport.zoom, page = figma.currentPage;
  const out = {
    zoom: round(z),
    bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
    screen: Math.round(b.width * z) + "×" + Math.round(b.height * z) + " px"
  };
  const chain = focusChain(b);
  if (chain.length) {
    const f = chain[chain.length - 1];
    out.focus = { id: f.node.id, name: f.node.name, type: f.node.type, path: chain.map(function (c) { return c.node.name; }).join(" › "), fillsView: Math.round(f.cover * 100) + "%" };
  }
  let count = 0;
  function visibleKids(parent) {
    const res = [];
    if (!("children" in parent)) return res;
    const kids = parent.children;
    for (let i = 0; i < kids.length && i < 5000; i++) {
      const c = kids[i];
      if (c.visible === false) continue;
      const bb = boxOf(c);
      const vis = inter(bb, b);
      if (vis) res.push({ node: c, box: bb, vis: areaOf(vis) });
    }
    res.sort(function (p, q) { return (p.box.y - q.box.y) || (p.box.x - q.box.x); });
    return res;
  }
  function item(e, d) {
    count++;
    const n = e.node;
    const o = { id: n.id, name: n.name, type: n.type, size: Math.round(e.box.width) + "×" + Math.round(e.box.height) };
    const whole = areaOf(e.box);
    if (whole && e.vis / whole < 0.97) o.inView = Math.round(100 * e.vis / whole) + "%";
    if (n.type === "TEXT") o.text = clip(n.characters, 60);
    if (d > 1 && "children" in n && n.type !== "INSTANCE") {
      const kids = visibleKids(n);
      if (kids.length) {
        o.children = [];
        for (let i = 0; i < kids.length; i++) {
          if (count >= maxLayers) { o.more = kids.length - i; break; }
          o.children.push(item(kids[i], d - 1));
        }
      }
    }
    return o;
  }
  const top = visibleKids(page);
  out.layers = [];
  for (let i = 0; i < top.length; i++) {
    if (count >= maxLayers) { out.moreLayers = top.length - i; break; }
    out.layers.push(item(top[i], depth));
  }
  out.topLevelInView = top.length + " of " + page.children.length;
  if (!top.length) out.note = "The visible part of the canvas is empty.";
  return out;
}

/* Puts a new layer at x/y, or in the middle of the user's screen when it goes on the page. */
function position(n, p, parent) {
  if (p.x !== undefined || p.y !== undefined) { if (p.x !== undefined) n.x = +p.x; if (p.y !== undefined) n.y = +p.y; }
  else if (parent.type === "PAGE") { const c = figma.viewport.center; n.x = Math.round(c.x - n.width / 2); n.y = Math.round(c.y - n.height / 2); }
}

/* ---------- screenshots ---------- */
const tempIds = new Set();
function cleanupTemp() {
  const kids = figma.currentPage.children;
  for (let i = Math.min(kids.length, 5) - 1; i >= 0; i--) {
    const k = kids[i];
    if (safe(function () { return k.getPluginData("claude-temp"); }, "") === "1") { tempIds.add(k.id); k.remove(); }
  }
}
async function exportNode(node, scale, max) {
  if (!("exportAsync" in node) || node.type === "PAGE" || node.type === "DOCUMENT") throw new Error("This node type can't be exported: " + node.type);
  const s = scale || 1;
  const longest = Math.max(node.width, node.height) * s;
  const constraint = longest > max
    ? (node.width >= node.height ? { type: "WIDTH", value: Math.round(max) } : { type: "HEIGHT", value: Math.round(max) })
    : { type: "SCALE", value: s };
  const bytes = await node.exportAsync({ format: "PNG", constraint: constraint });
  const k = longest > max ? max / Math.max(node.width, node.height) : s;
  return { base64: figma.base64Encode(bytes), id: node.id, name: node.name, width: Math.round(node.width * k), height: Math.round(node.height * k) };
}
/* Renders everything inside `rect` on the current page, like a screenshot of
   the canvas: a temporary rectangle filled with the canvas colour is put at the
   very bottom of the page and exported with contentsOnly:false (so every
   overlapping layer is drawn), then removed again. */
async function captureRegion(rect, scale, max, what) {
  const page = figma.currentPage;
  cleanupTemp();
  if (tempIds.size > 100) tempIds.clear();
  const w = Math.max(1, rect.width), ht = Math.max(1, rect.height);
  const r = figma.createRectangle();
  tempIds.add(r.id);
  try {
    r.name = "Claude capture (temporary)";
    r.setPluginData("claude-temp", "1");
    page.insertChild(0, r);
    r.x = rect.x; r.y = rect.y;
    r.resize(w, ht);
    const bg = page.backgrounds && page.backgrounds[0];
    r.fills = bg && bg.type === "SOLID" ? [{ type: "SOLID", color: { r: bg.color.r, g: bg.color.g, b: bg.color.b }, opacity: bg.opacity === undefined ? 1 : bg.opacity }] : [];
    r.strokes = [];
    const longest = Math.max(w, ht) * scale;
    const constraint = longest > max ? (w >= ht ? { type: "WIDTH", value: Math.round(max) } : { type: "HEIGHT", value: Math.round(max) }) : { type: "SCALE", value: scale };
    const bytes = await r.exportAsync({ format: "PNG", constraint: constraint, contentsOnly: false });
    const k = longest > max ? max / Math.max(w, ht) : scale;
    return { base64: figma.base64Encode(bytes), id: null, name: what, width: Math.round(w * k), height: Math.round(ht * k), region: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(w), height: Math.round(ht) } };
  } finally {
    try { r.remove(); } catch (e) { /* already gone */ }
  }
}

/* ---------- variables ---------- */
const TYPES = { COLOR: "COLOR", COLOUR: "COLOR", FLOAT: "FLOAT", NUMBER: "FLOAT", STRING: "STRING", TEXT: "STRING", BOOLEAN: "BOOLEAN", BOOL: "BOOLEAN" };
function normType(t) {
  const k = String(t).toUpperCase();
  if (!TYPES[k]) throw new Error('Unknown variable type "' + t + '" (use COLOR, FLOAT, STRING or BOOLEAN)');
  return TYPES[k];
}
async function varIndex() {
  return { cols: await figma.variables.getLocalVariableCollectionsAsync(), vars: await figma.variables.getLocalVariablesAsync() };
}
function colNames(idx) { return idx.cols.map(function (c) { return c.name; }).join(", "); }
function findCol(idx, ref, required) {
  if (ref === undefined || ref === null || ref === "") {
    if (!required) return null;
    if (idx.cols.length === 1) return idx.cols[0];
    throw new Error(idx.cols.length ? "Say which collection (" + colNames(idx) + ")" : "This file has no local variable collections yet: create one first with {op:'create_collection', collection:'…'}");
  }
  const r = String(ref);
  let c = idx.cols.filter(function (x) { return x.id === r || x.name === r; })[0];
  if (!c) c = idx.cols.filter(function (x) { return lower(x.name) === lower(r); })[0];
  if (!c && required) throw new Error('No local collection "' + r + '"' + (idx.cols.length ? " (have: " + colNames(idx) + ")" : ""));
  return c || null;
}
function findMode(col, ref) {
  if (ref === undefined || ref === null || lower(ref) === "default") return col.modes.filter(function (m) { return m.modeId === col.defaultModeId; })[0] || col.modes[0];
  const r = String(ref);
  return col.modes.filter(function (m) { return m.modeId === r || m.name === r; })[0] || col.modes.filter(function (m) { return lower(m.name) === lower(r); })[0] || null;
}
function modeOrThrow(col, ref) {
  const m = findMode(col, ref);
  if (!m) throw new Error('No mode "' + ref + '" in "' + col.name + '" (modes: ' + col.modes.map(function (x) { return x.name; }).join(", ") + ")");
  return m;
}
function varInCol(idx, col, name) {
  return idx.vars.filter(function (v) { return v.variableCollectionId === col.id && v.name === name; })[0] ||
    idx.vars.filter(function (v) { return v.variableCollectionId === col.id && lower(v.name) === lower(name); })[0] || null;
}
function libError(e) {
  const m = String(e && e.message ? e.message : e);
  if (/permission/i.test(m)) return new Error("Reading team libraries needs the plugin's \"teamlibrary\" permission. In Figma, close Claude Bridge and run it again so it loads the updated manifest.");
  return e instanceof Error ? e : new Error(m);
}
async function libraryCollectionsList() {
  try { return await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync(); } catch (e) { throw libError(e); }
}
let libCache = null;
async function libraryVariables() {
  if (libCache && Date.now() - libCache.t < 60000) return libCache.list;
  const cols = await libraryCollectionsList();
  const lists = await Promise.all(cols.map(function (c) { return figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key).catch(function () { return []; }); }));
  const list = [];
  cols.forEach(function (c, i) { lists[i].forEach(function (v) { list.push({ name: v.name, key: v.key, type: v.resolvedType, collection: c.name, collectionKey: c.key, library: c.libraryName }); }); });
  libCache = { t: Date.now(), list: list };
  return list;
}
async function importVar(key) {
  try { return await figma.variables.importVariableByKeyAsync(key); }
  catch (e) { throw new Error("Could not import library variable " + key + ": " + (e && e.message ? e.message : e)); }
}
/* A variable reference can be: a name ("color/brand/primary"), "{name}",
   "{name} [Collection]", a VariableID, {key}, "key:…", or {alias|name, collection}.
   Local variables win; otherwise the enabled libraries are searched and the
   match is imported so it can be used in this file. */
async function resolveVariable(ref, colRef, idx) {
  if (ref && typeof ref === "object") {
    if (typeof ref.id === "string" && /^VariableID:/.test(ref.id)) {
      if (typeof ref.setValueForMode === "function") return ref;   // already a Variable (local ones have a key too)
      ref = ref.id;                                                   // a VariableAlias or {id}
    } else if (ref.key) return importVar(ref.key);
    else { colRef = ref.collection || colRef; ref = ref.alias || ref.name || ref.id; }
  }
  if (ref === undefined || ref === null || ref === "") throw new Error("Missing variable name");
  let s = String(ref).trim();
  const m = /^\{(.+)\}\s*(?:\[([^\]]+)\])?$/.exec(s);
  if (m) { s = m[1].trim(); if (m[2] && !colRef) colRef = m[2].replace(/,\s*library\s*$/i, "").trim(); }
  if (/^VariableID:/.test(s)) {
    const v = await figma.variables.getVariableByIdAsync(s);
    if (!v) throw new Error("No variable with id " + s);
    return v;
  }
  if (/^key:/i.test(s)) return importVar(s.slice(4).trim());
  idx = idx || await varIndex();
  const colName = function (v) { const c = idx.cols.filter(function (x) { return x.id === v.variableCollectionId; })[0]; return c ? c.name : "?"; };
  let cands = idx.vars.filter(function (v) { return v.name === s; });
  if (!cands.length) cands = idx.vars.filter(function (v) { return lower(v.name) === lower(s); });
  if (colRef) cands = cands.filter(function (v) { return v.variableCollectionId === colRef || lower(colName(v)) === lower(colRef); });
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) throw new Error('Variable "' + s + '" exists in several collections (' + cands.map(colName).join(", ") + "); say which one with collection.");
  let lib = null, libErr = null;
  try { lib = await libraryVariables(); } catch (e) { libErr = e; }
  if (lib) {
    let lc = lib.filter(function (v) { return v.name === s; });
    if (!lc.length) lc = lib.filter(function (v) { return lower(v.name) === lower(s); });
    if (colRef) lc = lc.filter(function (v) { return lower(v.collection) === lower(colRef) || lower(v.library) === lower(colRef) || lower(v.library + "/" + v.collection) === lower(colRef); });
    if (lc.length === 1) return importVar(lc[0].key);
    if (lc.length > 1) throw new Error('Library variable "' + s + '" exists in several collections (' + lc.map(function (v) { return v.library + " / " + v.collection; }).join(", ") + "); say which one with collection.");
  }
  throw new Error('No variable "' + s + '"' + (colRef ? ' in "' + colRef + '"' : "") + " in this file" +
    (lib ? " or its enabled libraries" : (libErr ? " (libraries not checked: " + libErr.message + ")" : "")) + ". get_variables lists what exists.");
}
async function resolveCollection(ref, idx) {
  if (ref === undefined || ref === null || ref === "") throw new Error("Say which variable collection");
  idx = idx || await varIndex();
  const c = findCol(idx, ref, false);
  if (c) return c;
  if (/^VariableCollectionId:/.test(String(ref))) {
    const rc = await figma.variables.getVariableCollectionByIdAsync(String(ref));
    if (rc) return rc;
  }
  let libs;
  try { libs = await libraryCollectionsList(); }
  catch (e) { throw new Error('No local collection "' + ref + '" (' + e.message + ")"); }
  const r = lower(ref);
  const lc = libs.filter(function (x) { return lower(x.name) === r || lower(x.libraryName + "/" + x.name) === r; });
  if (lc.length > 1) throw new Error('Several library collections are called "' + ref + '" (' + lc.map(function (x) { return x.libraryName; }).join(", ") + '); use "Library/Collection".');
  if (lc.length === 1) {
    const vs = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(lc[0].key);
    if (!vs.length) throw new Error('Library collection "' + ref + '" has no variables');
    const v = await importVar(vs[0].key);
    return figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
  }
  throw new Error('No variable collection "' + ref + '" in this file or its enabled libraries');
}
function isAliasInput(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return !!(raw.alias || raw.key || raw.type === "VARIABLE_ALIAS" || (typeof raw.id === "string" && /^VariableID:/.test(raw.id)));
  return typeof raw === "string" && /^\{.+\}(\s*\[[^\]]+\])?$/.test(raw.trim());
}
async function parseValue(raw, type, idx) {
  if (raw === undefined || raw === null) throw new Error("Missing value");
  if (isAliasInput(raw)) return figma.variables.createVariableAlias(await resolveVariable(raw, null, idx));
  if (type === "COLOR") return parseColor(raw);
  if (type === "FLOAT") {
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!isFinite(n)) throw new Error('Not a number: "' + raw + '"');
    return n;
  }
  if (type === "BOOLEAN") {
    if (typeof raw === "boolean") return raw;
    if (/^(true|false)$/i.test(String(raw))) return lower(raw) === "true";
    throw new Error('Not a boolean: "' + raw + '"');
  }
  if (type === "STRING") return String(raw);
  return raw;
}
async function inferType(raw, idx) {
  if (isAliasInput(raw)) return (await resolveVariable(raw, null, idx)).resolvedType;
  if (typeof raw === "boolean") return "BOOLEAN";
  if (typeof raw === "number") return "FLOAT";
  if (raw && typeof raw === "object" && "r" in raw) return "COLOR";
  if (typeof raw === "string" && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw.trim())) return "COLOR";
  if (typeof raw === "string") return "STRING";
  return null;
}
async function fmtValue(val, type, ctx, ownColId) {
  if (val === undefined) return null;
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
    const v = await ctx.variable(val.id);
    if (!v) return "{missing " + val.id + "}";
    const c = await ctx.collection(v.variableCollectionId);
    const other = (c && c.id !== ownColId) || v.remote;
    return "{" + v.name + "}" + (other ? " [" + (c ? c.name : "?") + (v.remote ? ", library" : "") + "]" : "");
  }
  if (type === "COLOR" && val && typeof val === "object" && "r" in val) return toHex(val);
  if (typeof val === "number") return Math.round(val * 10000) / 10000;
  if (val && typeof val === "object") return ser(val, 3);
  return val;
}
async function varOut(v, c, ctx, p) {
  const o = { name: v.name, type: v.resolvedType };
  if (p.ids) o.id = v.id;
  if (p.values !== false) {
    if (c.modes.length === 1) o.value = await fmtValue(v.valuesByMode[c.modes[0].modeId], v.resolvedType, ctx, c.id);
    else {
      o.values = {};
      for (let i = 0; i < c.modes.length; i++) o.values[c.modes[i].name] = await fmtValue(v.valuesByMode[c.modes[i].modeId], v.resolvedType, ctx, c.id);
    }
  }
  if (v.scopes && !(v.scopes.length === 1 && v.scopes[0] === "ALL_SCOPES")) o.scopes = v.scopes;
  if (v.codeSyntax && Object.keys(v.codeSyntax).length) o.codeSyntax = v.codeSyntax;
  if (v.description) o.description = clip(v.description, 200);
  if (v.hiddenFromPublishing) o.hidden = true;
  return o;
}
async function findVarForOp(op, idx) {
  let v = null;
  if (op.id) v = await figma.variables.getVariableByIdAsync(String(op.id));
  else {
    if (!op.name) throw new Error(op.op + " needs name");
    const col = op.collection ? findCol(idx, op.collection, true) : null;
    if (col) v = varInCol(idx, col, op.name);
    else {
      let c = idx.vars.filter(function (x) { return x.name === op.name; });
      if (!c.length) c = idx.vars.filter(function (x) { return lower(x.name) === lower(op.name); });
      if (c.length > 1) throw new Error('"' + op.name + '" exists in several collections; add collection.');
      v = c[0] || null;
    }
  }
  if (!v) throw new Error('No local variable "' + (op.name || op.id) + '"' + (op.collection ? ' in "' + op.collection + '"' : ""));
  if (v.remote) throw new Error('"' + v.name + '" comes from a library and is read-only in this file. Open the library file, run Claude Bridge there and change it there (then publish the library).');
  return v;
}
async function varOp(op, idx, ctx) {
  const kind = lower(op.op || "set");
  if (kind === "create_collection") {
    const name = op.collection || op.name;
    if (!name) throw new Error("create_collection needs collection (the new collection's name)");
    let col = findCol(idx, name, false);
    const changes = [];
    if (!col) {
      col = figma.variables.createVariableCollection(String(name));
      idx.cols.push(col);
      changes.push("created");
      if (op.modes && op.modes.length) col.renameMode(col.modes[0].modeId, String(op.modes[0]));
    }
    (op.modes || []).forEach(function (m) { if (!findMode(col, m)) { col.addMode(String(m)); changes.push("added mode " + m); } });
    if (op.hidden !== undefined) { col.hiddenFromPublishing = !!op.hidden; changes.push(op.hidden ? "hidden from publishing" : "published"); }
    return { op: kind, collection: col.name, modes: col.modes.map(function (m) { return m.name; }), changes: changes.length ? changes : ["already exists"] };
  }
  if (kind === "rename_collection") {
    const col = findCol(idx, op.collection || op.name, true);
    if (!op.to) throw new Error("rename_collection needs to");
    const old = col.name;
    col.name = String(op.to);
    return { op: kind, collection: col.name, changes: [old + " → " + col.name] };
  }
  if (kind === "delete_collection") {
    const col = findCol(idx, op.collection || op.name, true);
    const id = col.id, name = col.name, n = col.variableIds.length;
    col.remove();
    idx.cols = idx.cols.filter(function (c) { return c.id !== id; });
    idx.vars = idx.vars.filter(function (v) { return v.variableCollectionId !== id; });
    return { op: kind, collection: name, changes: ["deleted, with " + n + " variables"] };
  }
  if (kind === "add_mode") {
    const col = findCol(idx, op.collection, true);
    const name = op.mode || op.to || op.name;
    if (!name) throw new Error("add_mode needs mode (the new mode's name)");
    if (findMode(col, name)) return { op: kind, collection: col.name, changes: ['mode "' + name + '" already exists'] };
    col.addMode(String(name));
    return { op: kind, collection: col.name, modes: col.modes.map(function (m) { return m.name; }), changes: ["added mode " + name] };
  }
  if (kind === "rename_mode") {
    const col = findCol(idx, op.collection, true);
    const m = modeOrThrow(col, op.mode);
    if (!op.to) throw new Error("rename_mode needs to");
    const old = m.name;
    col.renameMode(m.modeId, String(op.to));
    return { op: kind, collection: col.name, changes: ["mode " + old + " → " + op.to] };
  }
  if (kind === "delete_mode") {
    const col = findCol(idx, op.collection, true);
    const m = modeOrThrow(col, op.mode);
    if (col.modes.length < 2) throw new Error("A collection needs at least one mode");
    col.removeMode(m.modeId);
    return { op: kind, collection: col.name, modes: col.modes.map(function (x) { return x.name; }), changes: ["deleted mode " + m.name] };
  }
  if (kind === "rename") {
    const v = await findVarForOp(op, idx);
    if (!op.to) throw new Error("rename needs to");
    const old = v.name;
    v.name = String(op.to);
    return { op: kind, variable: v.name, changes: [old + " → " + v.name] };
  }
  if (kind === "delete") {
    const v = await findVarForOp(op, idx);
    const name = v.name;
    v.remove();
    idx.vars = idx.vars.filter(function (x) { return x !== v; });
    return { op: kind, variable: name, changes: ["deleted"] };
  }
  if (kind === "set") {
    if (!op.name) throw new Error("set needs name");
    const col = findCol(idx, op.collection, true);
    let v = varInCol(idx, col, op.name);
    const created = !v;
    const vals = [];
    const put = function (mode, raw) {
      const i = vals.findIndex(function (x) { return x.mode.modeId === mode.modeId; });
      if (i >= 0) vals[i].raw = raw; else vals.push({ mode: mode, raw: raw });
    };
    if (op.value !== undefined) col.modes.forEach(function (m) { put(m, op.value); });
    if (op.values) Object.keys(op.values).forEach(function (k) {
      if (k === "*" || lower(k) === "all") col.modes.forEach(function (m) { put(m, op.values[k]); });
      else put(modeOrThrow(col, k), op.values[k]);
    });
    if (!v) {
      const type = op.type ? normType(op.type) : (vals.length ? await inferType(vals[0].raw, idx) : null);
      if (!type) throw new Error('New variable "' + op.name + '" needs a type or a value');
      v = figma.variables.createVariable(String(op.name), col, type);
      idx.vars.push(v);
      if (vals.length && vals.length < col.modes.length) {
        const src = vals.filter(function (x) { return x.mode.modeId === col.defaultModeId; })[0] || vals[0];
        col.modes.forEach(function (m) {
          if (!vals.some(function (x) { return x.mode.modeId === m.modeId; })) vals.push({ mode: m, raw: src.raw, copied: true });
        });
      }
    } else if (op.type && normType(op.type) !== v.resolvedType) throw new Error('"' + v.name + '" is ' + v.resolvedType + ", not " + normType(op.type));
    const changes = [];
    for (let i = 0; i < vals.length; i++) {
      const it = vals[i];
      const before = created ? null : await fmtValue(v.valuesByMode[it.mode.modeId], v.resolvedType, ctx, col.id);
      v.setValueForMode(it.mode.modeId, await parseValue(it.raw, v.resolvedType, idx));
      const after = await fmtValue(v.valuesByMode[it.mode.modeId], v.resolvedType, ctx, col.id);
      if (created) changes.push(it.mode.name + " = " + after + (it.copied ? " (copied)" : ""));
      else if (JSON.stringify(before) !== JSON.stringify(after)) changes.push(it.mode.name + ": " + before + " → " + after);
    }
    if (op.description !== undefined && v.description !== String(op.description)) { v.description = String(op.description); changes.push("description"); }
    if (op.scopes) {
      v.scopes = (Array.isArray(op.scopes) ? op.scopes : [op.scopes]).map(function (s) { return String(s).toUpperCase(); });
      changes.push("scopes " + v.scopes.join(", "));
    }
    const cs = op.code_syntax || op.codeSyntax;
    if (cs) Object.keys(cs).forEach(function (pl) {
      const plat = { web: "WEB", android: "ANDROID", ios: "iOS" }[lower(pl)];
      if (!plat) throw new Error('Unknown code syntax platform "' + pl + '" (WEB, ANDROID or iOS)');
      if (cs[pl] === null || cs[pl] === "") v.removeVariableCodeSyntax(plat); else v.setVariableCodeSyntax(plat, String(cs[pl]));
      changes.push("code syntax " + plat);
    });
    if (op.hidden !== undefined) { v.hiddenFromPublishing = !!op.hidden; changes.push(op.hidden ? "hidden from publishing" : "published"); }
    const res = { op: "set", variable: v.name, collection: col.name, type: v.resolvedType, changes: changes.length ? changes : ["no change"] };
    if (created) res.created = true;
    return res;
  }
  throw new Error('Unknown op "' + op.op + '" (use create_collection, rename_collection, delete_collection, add_mode, rename_mode, delete_mode, set, rename or delete)');
}

/* ---------- binding variables to layers ---------- */
const NODE_FIELDS = ["height", "width", "characters", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "visible",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "minWidth", "maxWidth", "minHeight", "maxHeight",
  "counterAxisSpacing", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "opacity", "gridRowGap", "gridColumnGap"];
const TEXT_FIELDS = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"];
const FIELD_ALIASES = {
  fill: "fills", fills: "fills", background: "fills", color: "fills", stroke: "strokes", strokes: "strokes", strokecolor: "strokes",
  gap: "itemSpacing", spacing: "itemSpacing", rowgap: "counterAxisSpacing",
  padding: ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"],
  paddingx: ["paddingLeft", "paddingRight"], paddinghorizontal: ["paddingLeft", "paddingRight"],
  paddingy: ["paddingTop", "paddingBottom"], paddingvertical: ["paddingTop", "paddingBottom"],
  radius: "CORNERS", cornerradius: "CORNERS", corners: "CORNERS",
  strokewidth: "strokeWeight", size: ["width", "height"], text: "characters", content: "characters"
};
function fieldsFor(node, field) {
  const k = lower(field).replace(/[\s_-]/g, "");
  let f = FIELD_ALIASES[k];
  if (!f) f = NODE_FIELDS.concat(TEXT_FIELDS).filter(function (x) { return lower(x) === k; })[0];
  if (!f) throw new Error('Unknown field "' + field + '" (fill, stroke, width, height, gap, padding, paddingX, radius, opacity, visible, characters, fontSize, lineHeight, …)');
  if (f === "CORNERS") return "topLeftRadius" in node ? ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"] : ["cornerRadius"];
  return Array.isArray(f) ? f : [f];
}
async function loadFontsOf(node) {
  const len = node.characters.length;
  const fonts = len ? node.getRangeAllFontNames(0, len) : (node.fontName === figma.mixed ? [] : [node.fontName]);
  await Promise.all(fonts.map(function (f) { return figma.loadFontAsync(f); }));
}
async function bindOne(node, field, variable, opts) {
  const fields = fieldsFor(node, field);
  const done = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f === "fills" || f === "strokes") {
      if (!(f in node)) throw new Error(node.type + " has no " + f);
      if (node[f] === figma.mixed) throw new Error(node.name + " has different " + f + " per text range");
      const list = node[f].slice();
      const k = (opts && opts.index) || 0;
      if (k > list.length) throw new Error(node.name + " has only " + list.length + " " + f);
      if (!list[k]) {
        if (!variable) continue;
        list[k] = { type: "SOLID", color: { r: 0, g: 0, b: 0 } };
      }
      if (list[k].type !== "SOLID") throw new Error(f + "[" + k + "] of " + node.name + " is " + list[k].type + "; only solid paints can take a colour variable");
      list[k] = figma.variables.setBoundVariableForPaint(list[k], "color", variable);
      node[f] = list;
      done.push(f + "[" + k + "]");
      continue;
    }
    if (TEXT_FIELDS.indexOf(f) >= 0 || (f === "characters" && node.type === "TEXT")) {
      if (node.type !== "TEXT") throw new Error(f + " only applies to text layers (" + node.name + " is " + node.type + ")");
      await loadFontsOf(node);
    } else if (!(f in node)) throw new Error(node.name + " (" + node.type + ") has no " + f);
    node.setBoundVariable(f, variable);
    done.push(f);
  }
  return done;
}
async function resolveNodes(ref) {
  if (ref === undefined || ref === null || ref === "selection") {
    const sel = figma.currentPage.selection.slice();
    if (!sel.length) throw new Error("Nothing is selected: pass nodes: [ids] or select layers in Figma");
    return sel;
  }
  const ids = Array.isArray(ref) ? ref : [ref];
  const out = [];
  for (let i = 0; i < ids.length; i++) out.push(await getNode(String(ids[i])));
  return out;
}
async function saveVersion(title) {
  const r = await figma.saveVersionHistoryAsync(String(title), "Saved by Claude before making changes");
  return r && r.id ? r.id : true;
}

/* ---------- styles and components ---------- */
const STYLE_TYPES = { PAINT: "PAINT", COLOR: "PAINT", COLOUR: "PAINT", FILL: "PAINT", TEXT: "TEXT", TYPOGRAPHY: "TEXT", FONT: "TEXT", EFFECT: "EFFECT", SHADOW: "EFFECT", GRID: "GRID", LAYOUTGRID: "GRID" };
function normStyleType(t) {
  if (!t) return null;
  const k = String(t).toUpperCase().replace(/[\s_-]/g, "");
  if (!STYLE_TYPES[k]) throw new Error('Unknown style type "' + t + '" (PAINT, TEXT, EFFECT or GRID)');
  return STYLE_TYPES[k];
}
async function localStyles(type) {
  if (type === "PAINT") return figma.getLocalPaintStylesAsync();
  if (type === "TEXT") return figma.getLocalTextStylesAsync();
  if (type === "EFFECT") return figma.getLocalEffectStylesAsync();
  return figma.getLocalGridStylesAsync();
}
async function findStyle(type, name) {
  const types = type ? [type] : ["PAINT", "TEXT", "EFFECT", "GRID"];
  let found = [];
  for (let i = 0; i < types.length; i++) {
    const list = await localStyles(types[i]);
    let m = list.filter(function (s) { return s.name === name || s.id === name; });
    if (!m.length) m = list.filter(function (s) { return lower(s.name) === lower(name); });
    found = found.concat(m);
  }
  if (found.length > 1) throw new Error('Several styles are called "' + name + '" (' + found.map(function (s) { return s.type; }).join(", ") + "); add type.");
  return found[0] || null;
}
async function styleOut(s, ctx) {
  const o = { name: s.name, key: s.key, id: s.id };
  if (s.type === "PAINT") o.value = (await Promise.all(s.paints.map(function (p) { return paintText(p, ctx); }))).join(", ");
  else if (s.type === "TEXT") {
    o.value = s.fontName.family + " " + s.fontName.style + " " + round(s.fontSize) + "/" + lhText(s.lineHeight) + (s.letterSpacing && s.letterSpacing.value ? " · " + lsText(s.letterSpacing) : "");
    const bv = s.boundVariables || {};
    const ks = Object.keys(bv);
    if (ks.length) { o.variables = {}; for (let i = 0; i < ks.length; i++) if (bv[ks[i]] && bv[ks[i]].id) o.variables[ks[i]] = await ctx.varLabel(bv[ks[i]].id); }
  } else if (s.type === "EFFECT") o.value = s.effects.map(effectText).join(", ");
  else if (s.type === "GRID") o.value = s.layoutGrids.map(function (g) { return lower(g.pattern) + (g.count ? " ×" + g.count : "") + (g.sectionSize ? " " + g.sectionSize : "") + (g.gutterSize ? " gutter " + g.gutterSize : ""); }).join(", ");
  if (s.description) o.description = clip(s.description, 160);
  return o;
}
function parseLH(v) {
  if (v && typeof v === "object") return v;
  const s = lower(v).trim();
  if (s === "auto") return { unit: "AUTO" };
  if (/%$/.test(s)) return { unit: "PERCENT", value: parseFloat(s) };
  return { unit: "PIXELS", value: parseFloat(s) };
}
function parseLS(v) {
  if (v && typeof v === "object") return v;
  const s = lower(v).trim();
  if (/%$/.test(s)) return { unit: "PERCENT", value: parseFloat(s) };
  return { unit: "PIXELS", value: parseFloat(s) };
}
function effectFrom(e) {
  const t = String(e.type || "DROP_SHADOW").toUpperCase().replace(/[\s-]/g, "_");
  if (t === "DROP_SHADOW" || t === "INNER_SHADOW") {
    const off = e.offset || {};
    const o = {
      type: t,
      color: parseColor(e.color === undefined ? "#00000040" : e.color),
      offset: { x: +(e.x !== undefined ? e.x : (off.x || 0)), y: +(e.y !== undefined ? e.y : (off.y !== undefined ? off.y : 4)) },
      radius: +(e.blur !== undefined ? e.blur : (e.radius !== undefined ? e.radius : 8)),
      spread: +(e.spread || 0),
      visible: e.visible !== false,
      blendMode: e.blendMode || "NORMAL"
    };
    if (t === "DROP_SHADOW" && e.showShadowBehindNode !== undefined) o.showShadowBehindNode = !!e.showShadowBehindNode;
    return o;
  }
  if ((t === "LAYER_BLUR" || t === "BACKGROUND_BLUR") && !e.blurType) return { type: t, radius: +(e.blur !== undefined ? e.blur : (e.radius || 4)), visible: e.visible !== false, blurType: "NORMAL" };
  return Object.assign({}, e, { type: t, visible: e.visible !== false });
}
function paintsFrom(list) {
  return (Array.isArray(list) ? list : [list]).map(function (p) {
    if (typeof p === "string") { const parts = p.split("@"); const c = parseColor(parts[0]); return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: parts[1] !== undefined ? parseFloat(parts[1]) : c.a }; }
    return p;
  });
}
async function styleOp(op, ctx, idx) {
  const kind = lower(op.op || "set");
  if (!op.name) throw new Error(kind + " needs name");
  if (kind === "rename" || kind === "delete") {
    const s = await findStyle(normStyleType(op.type), op.name);
    if (!s) throw new Error('No local style "' + op.name + '"');
    if (kind === "delete") { const n = s.name; s.remove(); return { op: kind, style: n, changes: ["deleted"] }; }
    if (!op.to) throw new Error("rename needs to");
    const old = s.name;
    s.name = String(op.to);
    return { op: kind, style: s.name, changes: [old + " → " + s.name] };
  }
  if (kind !== "set") throw new Error('Unknown op "' + op.op + '" (use set, rename or delete)');
  const type = normStyleType(op.type) || (op.font || op.fontSize ? "TEXT" : op.effects ? "EFFECT" : (op.layoutGrids || op.grids) ? "GRID" : "PAINT");
  let s = await findStyle(type, op.name);
  const created = !s;
  if (!s) {
    s = type === "PAINT" ? figma.createPaintStyle() : type === "TEXT" ? figma.createTextStyle() : type === "EFFECT" ? figma.createEffectStyle() : figma.createGridStyle();
    s.name = String(op.name);
  }
  const changes = [];
  if (op.description !== undefined) { s.description = String(op.description); changes.push("description"); }
  if (type === "PAINT") {
    let list = null;
    if (op.paints) list = paintsFrom(op.paints);
    else if (op.color !== undefined) list = paintsFrom([op.color]);
    if (op.variable) {
      const v = await resolveVariable(op.variable, op.collection, idx);
      const base = list ? list[0] : (s.paints[0] && s.paints[0].type === "SOLID" ? s.paints[0] : { type: "SOLID", color: { r: 0, g: 0, b: 0 } });
      list = [figma.variables.setBoundVariableForPaint(base, "color", v)].concat(list ? list.slice(1) : []);
    }
    if (list) { s.paints = list; changes.push("paints: " + (await Promise.all(s.paints.map(function (p) { return paintText(p, ctx); }))).join(", ")); }
  } else if (type === "TEXT") {
    await figma.loadFontAsync(s.fontName);
    if (op.font) {
      const f = { family: op.font.family || s.fontName.family, style: op.font.style || "Regular" };
      await figma.loadFontAsync(f);
      s.fontName = f;
      changes.push("font " + f.family + " " + f.style);
    }
    if (op.fontSize !== undefined) { s.fontSize = +op.fontSize; changes.push("size " + s.fontSize); }
    if (op.lineHeight !== undefined) { s.lineHeight = parseLH(op.lineHeight); changes.push("line height " + lhText(s.lineHeight)); }
    if (op.letterSpacing !== undefined) { s.letterSpacing = parseLS(op.letterSpacing); changes.push("letter spacing " + lsText(s.letterSpacing)); }
    if (op.paragraphSpacing !== undefined) { s.paragraphSpacing = +op.paragraphSpacing; changes.push("paragraph spacing"); }
    if (op.paragraphIndent !== undefined) { s.paragraphIndent = +op.paragraphIndent; changes.push("paragraph indent"); }
    if (op.textCase) { s.textCase = String(op.textCase).toUpperCase(); changes.push("case " + s.textCase); }
    if (op.textDecoration) { s.textDecoration = String(op.textDecoration).toUpperCase(); changes.push("decoration " + s.textDecoration); }
    if (op.variables) {
      const ks = Object.keys(op.variables);
      for (let i = 0; i < ks.length; i++) {
        const fld = TEXT_FIELDS.filter(function (x) { return lower(x) === lower(ks[i]).replace(/[\s_-]/g, ""); })[0];
        if (!fld) throw new Error('Text styles can bind ' + TEXT_FIELDS.join(", ") + ' (not "' + ks[i] + '")');
        const v = op.variables[ks[i]] === null ? null : await resolveVariable(op.variables[ks[i]], op.collection, idx);
        s.setBoundVariable(fld, v);
        changes.push(fld + " ← " + (v ? v.name : "unbound"));
      }
    }
  } else if (type === "EFFECT") {
    if (op.effects) { s.effects = op.effects.map(effectFrom); changes.push("effects: " + s.effects.map(effectText).join(", ")); }
  } else if (type === "GRID") {
    if (op.layoutGrids || op.grids) { s.layoutGrids = op.layoutGrids || op.grids; changes.push("layout grids"); }
  }
  const res = { op: "set", type: type, style: s.name, key: s.key, changes: changes.length ? changes : ["no change"] };
  if (created) res.created = true;
  return res;
}
function componentOut(n) {
  const o = { name: n.name, type: n.type === "COMPONENT_SET" ? "component set" : "component", key: n.key, id: n.id };
  const pg = pageOf(n);
  if (pg) o.page = pg.name;
  if (n.description) o.description = clip(n.description, 160);
  if (n.type === "COMPONENT_SET") o.variants = n.children.length;
  const d = safe(function () { return n.componentPropertyDefinitions; }, null);
  if (d && Object.keys(d).length) o.properties = defsText(d);
  return o;
}

/* ---------- search, batch edits and polish ---------- */
function upper(s) { return String(s === undefined || s === null ? "" : s).toUpperCase(); }
/* "{color/brand/primary}", "{name} [Collection]", {variable|alias: name, collection?} or {key} */
function isVarRef(v) {
  if (typeof v === "string") return /^\{.+\}(\s*\[[^\]]+\])?$/.test(v.trim());
  return !!(v && typeof v === "object" && !Array.isArray(v) && (v.alias || v.key || v.variable || v.type === "VARIABLE_ALIAS" || (typeof v.id === "string" && /^VariableID:/.test(v.id))));
}
function varRefOf(v) { return v && typeof v === "object" && v.variable ? { alias: v.variable, collection: v.collection } : v; }
function toMatcher(s) {
  const m = /^\/(.+)\/([imsuy]*)$/.exec(String(s));
  if (m) { const re = new RegExp(m[1], m[2]); return function (x) { return re.test(String(x)); }; }
  const q = lower(s);
  return function (x) { return lower(x).indexOf(q) >= 0; };
}
async function scopeRoots(scope, nodeId) {
  if (nodeId) return { roots: [await ensureLoaded(await getNode(nodeId))], label: "layer " + nodeId };
  const s = lower(scope || "page");
  if (s === "selection") {
    const sel = figma.currentPage.selection.slice();
    if (!sel.length) throw new Error("Nothing is selected (use scope: 'page', or select layers in Figma)");
    return { roots: sel, label: "selection (" + sel.length + " layers)" };
  }
  if (s === "file") { await figma.loadAllPagesAsync(); return { roots: figma.root.children.slice(), label: "whole file" }; }
  return { roots: [figma.currentPage], label: "page " + figma.currentPage.name };
}
function descendants(roots, types, cap) {
  const out = [];
  for (let i = 0; i < roots.length; i++) {
    const r = roots[i];
    if (r.type !== "PAGE" && r.type !== "DOCUMENT" && (!types || types.indexOf(r.type) >= 0)) out.push(r);
    if (!("children" in r)) continue;
    const found = types ? r.findAllWithCriteria({ types: types }) : r.findAll();
    for (let j = 0; j < found.length; j++) { if (cap && out.length >= cap) return out; out.push(found[j]); }
  }
  return out;
}
function insideInstance(n) { let q = n.parent; while (q && q.type !== "PAGE") { if (q.type === "INSTANCE") return true; q = q.parent; } return false; }
async function safeMain(n) { try { return await n.getMainComponentAsync(); } catch (e) { return null; } }
async function nodeOut(n, ctx) {
  const o = { id: n.id, name: n.name, type: n.type };
  const p = ancestors(n);
  if (p) o.path = p;
  if ("width" in n) o.size = round(n.width) + "×" + round(n.height);
  if (n.visible === false) o.visible = false;
  if (n.type === "TEXT") {
    o.text = clip(n.characters, 300);
    o.font = n.fontName === figma.mixed ? "mixed" : n.fontName.family + " " + n.fontName.style;
    o.fontSize = n.fontSize === figma.mixed ? "mixed" : round(n.fontSize);
    const ts = safe(function () { return n.textStyleId; }, null);
    if (ts && ts !== figma.mixed) { const l = await ctx.styleLabel(ts); if (l) o.textStyle = l; }
  }
  if (n.type === "INSTANCE") {
    const m = await ctx.main(n);
    if (m) o.component = (m.parent && m.parent.type === "COMPONENT_SET" ? m.parent.name + " / " : "") + m.name;
  }
  return o;
}
/* Depth-first walk for checks: stops at the cap, doesn't go inside instances (their
   insides come from the component) or inside hidden layers. */
function walkForAudit(roots, cap) {
  const out = [], stack = roots.slice().reverse();
  while (stack.length && out.length < cap) {
    const n = stack.pop();
    if (n.type !== "PAGE" && n.type !== "DOCUMENT") out.push(n);
    if (n.type === "INSTANCE" || n.visible === false) continue;
    const kids = safe(function () { return n.children; }, null);
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return { nodes: out, truncated: stack.length > 0 };
}
async function styleIdFor(type, ref) {
  if (ref === null || ref === "") return "";
  const s = String(ref);
  if (/^key:/i.test(s)) return (await figma.importStyleByKeyAsync(s.slice(4).trim())).id;
  const byId = await figma.getStyleByIdAsync(s).catch(function () { return null; });
  if (byId) return byId.id;
  const st = await findStyle(type, s);
  if (st) return st.id;
  throw new Error("No local " + lower(type) + ' style "' + s + '" (for a library style pass "key:<style key>")');
}
function parseVariantName(v) {
  const out = {};
  String(v).split(",").forEach(function (part) {
    const kv = part.split("=");
    if (kv.length === 2) out[lower(kv[0].trim())] = lower(kv[1].trim());
    else if (part.trim()) out._ = lower(part.trim());
  });
  return out;
}
function matchVariant(comp, want) {
  const props = parseVariantName(comp.name);
  return Object.keys(want).every(function (k) { return k === "_" ? lower(comp.name).indexOf(want._) >= 0 : props[k] === want[k]; });
}
/* A component reference: a local component (set) id or name, or a library key ("key:…"). */
async function resolveComponent(ref, variant) {
  const s = String(ref || "").trim();
  if (!s) throw new Error("Say which component");
  let c = null;
  if (/^key:/i.test(s) || /^[0-9a-f]{40}$/i.test(s)) {
    const key = s.replace(/^key:/i, "").trim();
    try { c = await figma.importComponentByKeyAsync(key); }
    catch (e) {
      try { c = await figma.importComponentSetByKeyAsync(key); }
      catch (e2) { throw new Error("No published component or component set with key " + key); }
    }
  } else if (/^I?\d+:\d+/.test(s)) c = await getNode(s);
  else {
    const pick = function (list) {
      const m = list.filter(function (n) { return n.name === s || lower(n.name) === lower(s); });
      return m.filter(function (n) { return !(n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET"); })[0] || m[0] || null;
    };
    c = pick(figma.currentPage.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] }));
    if (!c) { await figma.loadAllPagesAsync(); c = pick(figma.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })); }
    if (!c) throw new Error('No local component "' + s + '". For a library component pass "key:<key>" (get_library with used_remote lists keys).');
  }
  if (c.type === "COMPONENT_SET") {
    let v = c.defaultVariant || c.children[0];
    if (variant) {
      const want = parseVariantName(variant);
      const m = c.children.filter(function (ch) { return matchVariant(ch, want); })[0];
      if (!m) throw new Error('No variant "' + variant + '" in ' + c.name + " (" + c.children.map(function (x) { return x.name; }).join(" | ") + ")");
      v = m;
    }
    return v;
  }
  if (c.type !== "COMPONENT") throw new Error(s + " is a " + c.type + ", not a component");
  return c;
}
async function setVariant(inst, variant) {
  const want = {};
  String(variant).split(",").forEach(function (part) { const kv = part.split("="); if (kv.length === 2) want[kv[0].trim()] = kv[1].trim(); });
  if (!Object.keys(want).length) throw new Error('variant looks like "Size=L, State=Hover"');
  const cur = inst.componentProperties || {};
  const main = await safeMain(inst);
  const defs = main && main.parent && main.parent.type === "COMPONENT_SET" ? safe(function () { return main.parent.componentPropertyDefinitions; }, {}) : {};
  const out = {};
  Object.keys(want).forEach(function (k) {
    const key = Object.keys(cur).filter(function (c) { return cur[c].type === "VARIANT" && lower(c) === lower(k); })[0];
    if (!key) throw new Error('"' + inst.name + '" has no variant property "' + k + '" (has: ' + Object.keys(cur).filter(function (c) { return cur[c].type === "VARIANT"; }).join(", ") + ")");
    const opts = (defs[key] && defs[key].variantOptions) || [];
    out[key] = opts.filter(function (o) { return lower(o) === lower(want[k]); })[0] || want[k];
  });
  inst.setProperties(out);
  return Object.keys(out).map(function (k) { return k + "=" + out[k]; }).join(", ");
}
function setInstanceProps(inst, props) {
  const cur = inst.componentProperties || {};
  const out = {};
  Object.keys(props).forEach(function (k) {
    const key = cur[k] ? k : Object.keys(cur).filter(function (ck) { return lower(ck.split("#")[0]) === lower(k); })[0];
    if (!key) throw new Error('"' + inst.name + '" has no property "' + k + '" (has: ' + Object.keys(cur).map(function (c) { return c.split("#")[0]; }).join(", ") + ")");
    let v = props[k];
    if (cur[key].type === "BOOLEAN") v = v === true || lower(v) === "true";
    else if (cur[key].type !== "INSTANCE_SWAP") v = String(v);
    out[key] = v;
  });
  inst.setProperties(out);
  return Object.keys(out).map(function (k) { return k.split("#")[0]; });
}
async function setLink(n, link) {
  if (!("setReactionsAsync" in n)) throw new Error(n.type + " can't have prototype interactions");
  if (link === null || link === false) { await n.setReactionsAsync([]); return "interactions removed"; }
  const l = typeof link === "string" ? { to: link } : link;
  const trigger = { type: upper(l.trigger || "ON_CLICK") };
  if (["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"].indexOf(trigger.type) < 0) throw new Error("trigger must be ON_CLICK, ON_HOVER, ON_PRESS or ON_DRAG (use run_code for others)");
  let action, what;
  const to = String(l.to || "");
  if (lower(to) === "back") { action = { type: "BACK" }; what = "back"; }
  else if (lower(to) === "close") { action = { type: "CLOSE" }; what = "close overlay"; }
  else if (/^https?:\/\//i.test(to)) { action = { type: "URL", url: to }; what = "open " + to; }
  else {
    const dest = await getNode(to);
    const nav = upper(l.navigation || (l.overlay ? "OVERLAY" : "NAVIGATE"));
    let tr = null;
    if (l.transition !== null && lower(l.transition) !== "none" && lower(l.transition) !== "instant") {
      tr = { type: upper(l.transition || "SMART_ANIMATE"), easing: { type: upper(l.easing || "EASE_OUT") }, duration: (l.duration !== undefined ? +l.duration : 300) / 1000 };
      if (/^(MOVE_IN|MOVE_OUT|PUSH|SLIDE_IN|SLIDE_OUT)$/.test(tr.type)) { tr.direction = upper(l.direction || "LEFT"); tr.matchLayers = !!l.matchLayers; }
    }
    action = { type: "NODE", destinationId: dest.id, navigation: nav, transition: tr };
    what = lower(nav) + " → " + dest.name;
  }
  const keep = (n.reactions || []).filter(function (r) { return r.trigger && r.trigger.type !== trigger.type; }).map(function (r) {
    return JSON.parse(JSON.stringify({ trigger: r.trigger, actions: r.actions || (r.action ? [r.action] : []) }));
  });
  await n.setReactionsAsync(keep.concat([{ trigger: trigger, actions: [action] }]));
  return lower(trigger.type).replace("on_", "on ") + ": " + what;
}
function setRadius(n, r) {
  if (Array.isArray(r)) { n.topLeftRadius = +r[0]; n.topRightRadius = +r[1]; n.bottomRightRadius = +r[2]; n.bottomLeftRadius = +r[3]; }
  else n.cornerRadius = +r;
}
function applySizing(n, s) {
  if (s.w) n.layoutSizingHorizontal = upper(s.w);
  if (s.h) n.layoutSizingVertical = upper(s.h);
}
/* Like Figma's "suggest auto layout": reads how the children are placed now. */
function inferLayout(n) {
  const kids = (n.children || []).filter(function (c) { return c.visible !== false && c.layoutPositioning !== "ABSOLUTE"; });
  if (!kids.length) return { mode: "VERTICAL", gap: 0, padding: [0, 0, 0, 0], align: "MIN", order: [], overlap: false };
  const box = kids.map(function (c) { return { c: c, x: c.x, y: c.y, w: c.width, h: c.height }; });
  let overlap = false;   // e.g. a background shape behind the content: auto layout would stack it
  for (let i = 0; i < box.length && !overlap; i++) for (let j = i + 1; j < box.length && !overlap; j++) {
    const a = box[i], b = box[j];
    const ov = inter({ x: a.x, y: a.y, width: a.w, height: a.h }, { x: b.x, y: b.y, width: b.w, height: b.h });
    if (ov && ov.width > 1 && ov.height > 1) overlap = true;
  }
  const byY = box.slice().sort(function (a, b) { return a.y - b.y; }), byX = box.slice().sort(function (a, b) { return a.x - b.x; });
  let vs = 0, hs = 0;
  const vg = [], hg = [];
  for (let i = 1; i < box.length; i++) {
    const gy = byY[i].y - (byY[i - 1].y + byY[i - 1].h); if (gy >= -1) { vs++; vg.push(Math.max(0, gy)); }
    const gx = byX[i].x - (byX[i - 1].x + byX[i - 1].w); if (gx >= -1) { hs++; hg.push(Math.max(0, gx)); }
  }
  const mode = hs > vs ? "HORIZONTAL" : "VERTICAL";
  const gaps = (mode === "HORIZONTAL" ? hg : vg).sort(function (a, b) { return a - b; });
  const gap = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : 0;
  const mn = function (f) { return Math.min.apply(null, box.map(f)); }, mx = function (f) { return Math.max.apply(null, box.map(f)); };
  const padding = [Math.max(0, Math.round(mn(function (b) { return b.y; }))), Math.max(0, Math.round(n.width - mx(function (b) { return b.x + b.w; }))),
    Math.max(0, Math.round(n.height - mx(function (b) { return b.y + b.h; }))), Math.max(0, Math.round(mn(function (b) { return b.x; })))];
  const near = function (f) { return mx(f) - mn(f) <= 2; };
  let align = "MIN";
  if (mode === "VERTICAL") { if (!near(function (b) { return b.x; })) { if (near(function (b) { return b.x + b.w / 2; })) align = "CENTER"; else if (near(function (b) { return b.x + b.w; })) align = "MAX"; } }
  else if (!near(function (b) { return b.y; })) { if (near(function (b) { return b.y + b.h / 2; })) align = "CENTER"; else if (near(function (b) { return b.y + b.h; })) align = "MAX"; }
  return { mode: mode, gap: gap, padding: padding, align: align, overlap: overlap, order: (mode === "HORIZONTAL" ? byX : byY).map(function (b) { return b.c; }) };
}
function applyLayout(n, L, binds) {
  if (!("layoutMode" in n)) throw new Error(n.type + " can't use auto layout");
  L = Object.assign({}, L);
  let mode = upper(L.mode || (n.layoutMode !== "NONE" ? n.layoutMode : "VERTICAL"));
  let note = "";
  if (mode === "AUTO" || mode === "INFER") {
    const inf = inferLayout(n);
    if (inf.overlap && !L.force) throw new Error(n.name + ": some of its layers overlap (like a background behind the content), so auto layout would stack them and change the look. Group the overlapping layers first, or pass layout {mode: 'AUTO', force: true}.");
    mode = inf.mode;
    ["gap", "padding", "align"].forEach(function (k) { if (L[k] === undefined) L[k] = inf[k]; });
    inf.order.forEach(function (c, i) { n.insertChild(i, c); });
    note = " (from the current positions: gap " + inf.gap + ", padding " + inf.padding.join("/") + ")";
  }
  if (mode === "NONE") { n.layoutMode = "NONE"; return "auto layout off"; }
  const w = n.width, h = n.height, wasNone = n.layoutMode === "NONE";
  n.layoutMode = mode;
  if (wasNone) { safe(function () { n.layoutSizingHorizontal = "FIXED"; n.layoutSizingVertical = "FIXED"; }); safe(function () { n.resize(w, h); }); }
  if (L.gap !== undefined) {
    if (isVarRef(L.gap)) binds.push(["gap", L.gap]);
    else if (lower(L.gap) === "auto") n.primaryAxisAlignItems = "SPACE_BETWEEN";
    else n.itemSpacing = +L.gap;
  }
  if (L.padding !== undefined) {
    if (isVarRef(L.padding)) binds.push(["padding", L.padding]);
    else { const p = PAD(L.padding); n.paddingTop = p[0]; n.paddingRight = p[1]; n.paddingBottom = p[2]; n.paddingLeft = p[3]; }
  }
  if (L.align) n.counterAxisAlignItems = upper(L.align);
  if (L.justify) n.primaryAxisAlignItems = upper(L.justify);
  if (L.wrap !== undefined) n.layoutWrap = L.wrap ? "WRAP" : "NO_WRAP";
  const sw = typeof L.w === "string" ? L.w : null, sh = typeof L.h === "string" ? L.h : null;
  if (sw || sh) applySizing(n, { w: sw, h: sh });
  if (typeof L.w === "number" || typeof L.h === "number") n.resize(typeof L.w === "number" ? L.w : n.width, typeof L.h === "number" ? L.h : n.height);
  return "auto layout " + lower(mode) + note;
}
const TEXT_KEYS = ["text", "characters", "font", "fontSize", "lineHeight", "letterSpacing", "textAlign", "textCase", "textDecoration", "textAutoResize"];
/* Changes one existing layer. Any value given as a variable reference is bound instead of set. */
async function applyProps(n, it, ctx, idx) {
  const ch = [], binds = [];
  const take = function (key, field) { if (it[key] !== undefined && isVarRef(it[key])) { binds.push([field || key, it[key]]); return true; } return false; };
  if (it.name !== undefined) { n.name = String(it.name); ch.push("name"); }
  if (TEXT_KEYS.some(function (k) { return it[k] !== undefined; })) {
    if (n.type !== "TEXT") throw new Error(n.name + " is a " + n.type + ", not a text layer");
    await loadFontsOf(n);
    if (it.font) {
      const cur = n.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : n.fontName;
      const f = { family: it.font.family || cur.family, style: it.font.style || "Regular" };
      await figma.loadFontAsync(f);
      n.fontName = f;
      ch.push("font " + f.family + " " + f.style);
    }
    if (it.fontSize !== undefined && !take("fontSize")) { n.fontSize = +it.fontSize; ch.push("font size"); }
    if (it.lineHeight !== undefined && !take("lineHeight")) { n.lineHeight = parseLH(it.lineHeight); ch.push("line height"); }
    if (it.letterSpacing !== undefined && !take("letterSpacing")) { n.letterSpacing = parseLS(it.letterSpacing); ch.push("letter spacing"); }
    if (it.textAlign) { n.textAlignHorizontal = upper(it.textAlign); ch.push("align"); }
    if (it.textCase) { n.textCase = upper(it.textCase); ch.push("case"); }
    if (it.textDecoration) { n.textDecoration = upper(it.textDecoration); ch.push("decoration"); }
    if (it.textAutoResize) { n.textAutoResize = upper(it.textAutoResize); ch.push("auto resize"); }
    const tk = it.text !== undefined ? "text" : "characters";
    if (it[tk] !== undefined && !take(tk, "characters")) { n.characters = String(it[tk]); ch.push("text"); }
  }
  if (it.x !== undefined) { n.x = +it.x; ch.push("x"); }
  if (it.y !== undefined) { n.y = +it.y; ch.push("y"); }
  const setW = it.width !== undefined && !take("width"), setH = it.height !== undefined && !take("height");
  if (setW || setH) {
    if (!("resize" in n)) throw new Error(n.type + " can't be resized");
    n.resize(setW ? Math.max(0.01, +it.width) : n.width, setH ? Math.max(0.01, +it.height) : n.height);
    ch.push("size");
  }
  if (it.rotation !== undefined) { n.rotation = +it.rotation; ch.push("rotation"); }
  if (it.visible !== undefined && !take("visible")) { n.visible = !!it.visible; ch.push(it.visible ? "shown" : "hidden"); }
  if (it.locked !== undefined) { n.locked = !!it.locked; ch.push(it.locked ? "locked" : "unlocked"); }
  if (it.opacity !== undefined && !take("opacity")) { n.opacity = +it.opacity; ch.push("opacity"); }
  if (it.layout) ch.push(applyLayout(n, it.layout, binds));
  if (it.sizing) { applySizing(n, it.sizing); ch.push("sizing"); }
  if (it.fill !== undefined && !take("fill")) { if (!("fills" in n)) throw new Error(n.type + " has no fills"); n.fills = paintsFrom(it.fill === "none" || it.fill === null ? [] : it.fill); ch.push("fill"); }
  if (it.color !== undefined && !take("color", "fill")) { n.fills = paintsFrom(it.color); ch.push("fill"); }
  if (it.stroke !== undefined && !take("stroke")) { if (!("strokes" in n)) throw new Error(n.type + " has no strokes"); n.strokes = paintsFrom(it.stroke === "none" || it.stroke === null ? [] : it.stroke); ch.push("stroke"); }
  if (it.strokeWeight !== undefined && !take("strokeWeight")) { n.strokeWeight = +it.strokeWeight; ch.push("stroke weight"); }
  if (it.radius !== undefined && !take("radius")) { setRadius(n, it.radius); ch.push("radius"); }
  if (it.effects !== undefined) { n.effects = (it.effects || []).map(effectFrom); ch.push("effects"); }
  if (it.textStyle !== undefined) {
    if (n.type !== "TEXT") throw new Error("textStyle only applies to text layers");
    await loadFontsOf(n);
    const sid = await styleIdFor("TEXT", it.textStyle);
    const st = sid ? await figma.getStyleByIdAsync(sid) : null;
    if (st && st.fontName) await figma.loadFontAsync(st.fontName);
    await n.setTextStyleIdAsync(sid);
    ch.push("text style " + (st ? st.name : "removed"));
  }
  if (it.fillStyle !== undefined) { await n.setFillStyleIdAsync(await styleIdFor("PAINT", it.fillStyle)); ch.push("fill style"); }
  if (it.strokeStyle !== undefined) { await n.setStrokeStyleIdAsync(await styleIdFor("PAINT", it.strokeStyle)); ch.push("stroke style"); }
  if (it.effectStyle !== undefined) { await n.setEffectStyleIdAsync(await styleIdFor("EFFECT", it.effectStyle)); ch.push("effect style"); }
  if (it.variables) Object.keys(it.variables).forEach(function (f) { binds.push([f, it.variables[f]]); });
  for (let i = 0; i < binds.length; i++) {
    const ref = binds[i][1];
    const v = ref === null ? null : await resolveVariable(varRefOf(ref), null, idx);
    const f = await bindOne(n, binds[i][0], v, { index: 0 });
    ch.push((f.length ? f.join("+") : binds[i][0]) + " ← " + (v ? v.name : "unbound"));
  }
  if (it.modes) {
    const cols = Object.keys(it.modes);
    for (let i = 0; i < cols.length; i++) {
      const col = await resolveCollection(cols[i], idx);
      const m = it.modes[cols[i]];
      if (m === null || lower(m) === "auto") n.clearExplicitVariableModeForCollection(col);
      else n.setExplicitVariableModeForCollection(col, modeOrThrow(col, m).modeId);
      ch.push(col.name + " mode " + (m || "auto"));
    }
  }
  if (it.swap !== undefined) {
    if (n.type !== "INSTANCE") throw new Error("swap only works on instances");
    const comp = await resolveComponent(it.swap, it.variant);
    n.swapComponent(comp);
    ch.push("swapped to " + comp.name);
  } else if (it.variant !== undefined) {
    if (n.type !== "INSTANCE") throw new Error("variant only works on instances");
    ch.push("variant " + await setVariant(n, it.variant));
  }
  if (it.properties) {
    if (n.type !== "INSTANCE") throw new Error("properties only work on instances");
    ch.push("properties " + setInstanceProps(n, it.properties).join(", "));
  }
  if (it.link !== undefined) ch.push(await setLink(n, it.link));
  if (it.props) {
    const ks = Object.keys(it.props);
    for (let i = 0; i < ks.length; i++) { await setRawProp(n, ks[i], it.props[ks[i]]); ch.push(ks[i]); }
  }
  if (it.remove) { n.remove(); ch.push("deleted"); }
  return ch;
}

/* ---------- design checks ("tidy and polish") ---------- */
const DEFAULT_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Arrow|Union|Subtract|Intersect|Exclude|Component|Instance|Section|Image|Slice|Boolean|Auto Layout)( \d+)?$/;
const PIXEL_TYPES = ["FRAME", "RECTANGLE", "ELLIPSE", "INSTANCE", "COMPONENT", "GROUP", "SECTION", "TEXT"];
/* Numbers that may be bound automatically when exactly one variable has that value. Sizes, opacity,
   visibility and text are only bound on request: a 24px icon matching space/6 is usually a coincidence. */
const AUTO_BIND = ["itemSpacing", "counterAxisSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "strokeWeight"];
function solidOf(fills) {
  if (!fills || fills === figma.mixed) return null;
  for (let i = fills.length - 1; i >= 0; i--) { const f = fills[i]; if (f.type === "SOLID" && f.visible !== false) return { color: f.color, a: f.opacity === undefined ? 1 : f.opacity }; }
  return null;
}
/* The paint you see on top: a solid colour, "complex" (image, gradient, mixed…), or null (no visible paint). */
function topPaint(fills) {
  if (!fills || fills === figma.mixed) return "complex";
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i];
    if (f.visible === false || f.opacity === 0) continue;
    if (f.type === "SOLID") return { color: f.color, a: f.opacity === undefined ? 1 : f.opacity };
    return "complex";
  }
  return null;
}
function lum(c) { const f = function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
function contrastRatio(a, b) { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
function mix(fg, a, bg) { return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }; }
function coversBox(a, b) { const i = inter(a, b); return !!i && areaOf(i) >= 0.9 * areaOf(b); }
/* The solid colour right behind a layer: shapes under it in the same parents first, then the
   parents' own fills, then the canvas. null when it can't be known (image, gradient, translucent shape). */
function bgBehind(n, depth) {
  const tb = boxOf(n);
  let child = n, q = n.parent;
  depth = depth || 0;
  while (q && q.type !== "PAGE" && q.type !== "DOCUMENT") {
    const kids = safe(function () { return q.children; }, []);
    for (let i = kids.indexOf(child) - 1; i >= 0; i--) {
      const s = kids[i];
      if (s.visible === false || !("fills" in s)) continue;
      const sb = boxOf(s);
      if (!sb || !tb || !coversBox(sb, tb)) continue;
      const f = topPaint(s.fills);
      if (f === null) continue;
      if (f === "complex") return null;
      const op = f.a * (s.opacity === undefined ? 1 : s.opacity);
      if (op >= 0.99 || depth > 6) return f.color;
      if (op <= 0.02) continue;
      const under = bgBehind(s, depth + 1);   // a see-through shape: blend it with what's behind it
      return under ? mix(f.color, op, under) : null;
    }
    if (q.visible !== false && "fills" in q) {
      const f = topPaint(q.fills);
      if (f === "complex") return null;
      if (f) {
        const op = f.a * (q.opacity === undefined ? 1 : q.opacity);
        if (op >= 0.99 || depth > 6) return f.color;
        if (op > 0.02) { const under = bgBehind(q, depth + 1); return under ? mix(f.color, op, under) : null; }
      }
    }
    child = q; q = q.parent;
  }
  const pg = pageOf(n), pb = pg && pg.backgrounds && pg.backgrounds[0];
  return pb && pb.type === "SOLID" ? pb.color : { r: 1, g: 1, b: 1 };
}
function isBold(style) { const s = lower(style); return (s.indexOf("bold") >= 0 && s.indexOf("semi") < 0 && s.indexOf("demi") < 0) || s.indexOf("black") >= 0 || s.indexOf("heavy") >= 0; }
function paintHex(p) { return p && p.type === "SOLID" ? toHex(p.color, p.opacity) : lower(p && p.type); }
function sizingOf(n, axis) {
  const k = axis === "w" ? "layoutSizingHorizontal" : "layoutSizingVertical";
  return k in n ? safe(function () { return n[k]; }, "FIXED") : "FIXED";
}
async function auditNode(n, o) {
  const inInst = insideInstance(n);
  if (o.on("names") && !inInst && DEFAULT_NAME.test(n.name)) o.add("names", "warning", n, "Default layer name");
  if (o.on("hidden") && n.visible === false) o.add("hidden", "info", n, "Hidden layer");
  if (o.on("empty") && !inInst && (n.type === "FRAME" || n.type === "GROUP") && n.children.length === 0 && !solidOf(n.fills) && !(n.strokes && n.strokes.length)) o.add("empty", "info", n, "Empty " + lower(n.type));
  if (o.on("pixels") && !inInst && PIXEL_TYPES.indexOf(n.type) >= 0 && !n.rotation) {
    const auto = n.parent && n.parent.layoutMode && n.parent.layoutMode !== "NONE" && n.layoutPositioning !== "ABSOLUTE";
    const vals = {};
    if (!auto) { vals.x = n.x; vals.y = n.y; }
    if (n.type !== "TEXT" && sizingOf(n, "w") === "FIXED") vals.width = n.width;     // hug/fill sizes follow their content
    if (n.type !== "TEXT" && sizingOf(n, "h") === "FIXED") vals.height = n.height;
    const off = Object.keys(vals).filter(function (k) { return Math.abs(vals[k] - Math.round(vals[k])) > 0.01; });
    if (off.length) o.add("pixels", "warning", n, "Not on whole pixels: " + off.map(function (k) { return k + " " + round(vals[k]); }).join(", "), { fix: "round", axes: off });
  }
  if (o.on("spacing") && !inInst && n.layoutMode && n.layoutMode !== "NONE" && n.layoutMode !== "GRID") {
    const bv = n.boundVariables || {};
    const sp = { gap: bv.itemSpacing || n.primaryAxisAlignItems === "SPACE_BETWEEN" ? null : n.itemSpacing, paddingTop: bv.paddingTop ? null : n.paddingTop, paddingRight: bv.paddingRight ? null : n.paddingRight, paddingBottom: bv.paddingBottom ? null : n.paddingBottom, paddingLeft: bv.paddingLeft ? null : n.paddingLeft };
    const off = Object.keys(sp).filter(function (k) { return sp[k] !== null && Math.abs(sp[k] % o.grid) > 0.01; });
    if (off.length) o.add("spacing", "warning", n, "Spacing off the " + o.grid + "px grid: " + off.map(function (k) { return k + " " + round(sp[k]); }).join(", "));
  }
  if (!inInst && (o.on("bind") || o.on("colors"))) {
    const inf = safe(function () { return n.inferredVariables; }, null);
    const matched = {};
    const styled = {
      fills: !!safe(function () { return n.fillStyleId; }, ""),
      strokes: !!safe(function () { return n.strokeStyleId; }, "")
    };
    if (inf) {
      const fields = Object.keys(inf);
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i], v = inf[f];
        if (!v) continue;
        if (f === "fills" || f === "strokes") {
          if (styled[f]) continue;   // binding would detach its style
          for (let k = 0; k < v.length; k++) {
            if (!v[k] || !v[k].length) continue;
            matched[f + k] = 1;
            const p = n[f] && n[f][k];
            if (!o.on("bind") || !p || p.type !== "SOLID") continue;
            if (v[k].length === 1) o.add("bind", "warning", n, f + "[" + k + "] " + paintHex(p) + " can use the variable " + await o.ctx.varLabel(v[k][0].id), { fix: "bind", field: f === "fills" ? "fill" : "stroke", index: k, variableId: v[k][0].id });
            else o.add("bind", "info", n, f + "[" + k + "] " + paintHex(p) + " matches several variables: " + (await Promise.all(v[k].slice(0, 4).map(function (a) { return o.ctx.varLabel(a.id); }))).join(", ") + " (pick one with bind_variables)");
          }
        } else if (Array.isArray(v) && v.length && o.on("bind") && AUTO_BIND.indexOf(f) >= 0) {
          if (v.length === 1) o.add("bind", "warning", n, f + " " + round(n[f]) + " can use the variable " + await o.ctx.varLabel(v[0].id), { fix: "bind", field: f, variableId: v[0].id });
          else o.add("bind", "info", n, f + " " + round(n[f]) + " matches several variables: " + (await Promise.all(v.slice(0, 4).map(function (a) { return o.ctx.varLabel(a.id); }))).join(", "));
        }
      }
    }
    if (o.on("colors") && o.systemColors) {
      const keys = ["fills", "strokes"];
      for (let i = 0; i < keys.length; i++) {
        const f = keys[i];
        if (!(f in n) || n[f] === figma.mixed || styled[f]) continue;
        n[f].forEach(function (p, k) {
          if (p.type === "SOLID" && p.visible !== false && !(p.boundVariables && p.boundVariables.color) && !matched[f + k]) o.add("colors", "warning", n, "Hard-coded " + (f === "fills" ? "fill" : "stroke") + " " + paintHex(p) + " is not a variable or style");
        });
      }
    }
  }
  if (o.on("text") && n.type === "TEXT" && !inInst && o.hasTextStyles) {
    const ts = safe(function () { return n.textStyleId; }, "");
    const bv = n.boundVariables || {};
    if (!ts && !bv.fontSize && !bv.fontFamily) o.add("text", "warning", n, "Text has no text style");
  }
  if (o.on("contrast") && n.type === "TEXT" && n.visible !== false) {
    const fg = solidOf(n.fills);
    if (fg) {
      const bg = bgBehind(n);
      if (!bg) o.add("contrast", "info", n, "Text over an image, gradient or see-through layer: check its contrast by eye");
      else {
        const col = mix(fg.color, fg.a * (n.opacity === undefined ? 1 : n.opacity), bg);
        const r = contrastRatio(col, bg);
        const size = n.fontSize === figma.mixed ? 0 : n.fontSize;
        const style = n.fontName === figma.mixed ? "" : n.fontName.style;
        const need = size >= 24 || (size >= 18.66 && isBold(style)) ? 3 : 4.5;
        if (r < need) o.add("contrast", "error", n, "Text contrast " + Math.round(r * 100) / 100 + ":1 on " + toHex(bg) + " (WCAG AA needs " + need + ":1)");
      }
    }
  }
  if (o.on("targets") && n.reactions && n.reactions.length && "width" in n && (n.width < 44 || n.height < 44)) o.add("targets", "warning", n, "Tap target " + round(n.width) + "×" + round(n.height) + " is smaller than 44×44");
  if (o.on("autolayout") && !inInst && n.type === "FRAME" && n.layoutMode === "NONE" && n.children.length >= 2 && n.children.length <= 50 && n.parent && n.parent.type !== "PAGE" && n.parent.type !== "SECTION" && !inferLayout(n).overlap) {
    o.add("autolayout", "info", n, "Frame with " + n.children.length + " stacked layers but no auto layout", { fix: "autolayout" });
  }
}

/* ---------- build: JSON spec → nodes ---------- */
const PAD = function (p) { return typeof p === "number" ? [p, p, p, p] : (p.length === 2 ? [p[0], p[1], p[0], p[1]] : p); };
const BUILD_EXTRAS = ["textStyle", "fillStyle", "strokeStyle", "effectStyle", "effects", "variables", "modes", "properties", "opacity", "visible"];
async function buildNode(spec, parent, created, env) {
  const t = String(spec.type || (spec.component ? "INSTANCE" : "FRAME")).toUpperCase();
  let n;
  if (t === "INSTANCE") n = (await resolveComponent(spec.component, spec.variant)).createInstance();
  else if (t === "FRAME") { n = figma.createFrame(); n.fills = []; }
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
  const later = {};   // values given as variable references: bound once the layer exists
  const ref = function (k, v) { if (isVarRef(v)) { later[k] = v; return true; } return false; };
  if (t === "TEXT") {
    const f = spec.font || { family: "Inter", style: "Regular" };
    await figma.loadFontAsync(f);
    n.fontName = f;
    n.characters = String(spec.text === undefined ? "" : spec.text);
    if (spec.fontSize && !ref("fontSize", spec.fontSize)) n.fontSize = spec.fontSize;
    if (spec.lineHeight !== undefined && !ref("lineHeight", spec.lineHeight)) n.lineHeight = parseLH(spec.lineHeight);
    if (spec.letterSpacing !== undefined && !ref("letterSpacing", spec.letterSpacing)) n.letterSpacing = parseLS(spec.letterSpacing);
    if (spec.textAlign) n.textAlignHorizontal = upper(spec.textAlign);
    if (spec.color && !ref("fill", spec.color)) n.fills = paints(spec.color);
  }
  const L = spec.layout;
  if (L && (t === "FRAME")) {
    n.layoutMode = upper(L.mode || "VERTICAL");
    if (L.gap !== undefined && !ref("gap", L.gap)) { if (lower(L.gap) === "auto") n.primaryAxisAlignItems = "SPACE_BETWEEN"; else n.itemSpacing = +L.gap; }
    if (L.padding !== undefined && !ref("padding", L.padding)) { const p = PAD(L.padding); n.paddingTop = p[0]; n.paddingRight = p[1]; n.paddingBottom = p[2]; n.paddingLeft = p[3]; }
    if (L.justify) n.primaryAxisAlignItems = upper(L.justify);
    if (L.align) n.counterAxisAlignItems = upper(L.align);
    if (L.wrap) n.layoutWrap = "WRAP";
  }
  if (spec.size && t !== "SVG") n.resize(spec.size[0], spec.size[1]);
  if (spec.fill !== undefined && !ref("fill", spec.fill)) n.fills = paints(spec.fill);
  if (spec.stroke !== undefined && !ref("stroke", spec.stroke)) n.strokes = paints(spec.stroke);
  if (spec.strokeWeight !== undefined && !ref("strokeWeight", spec.strokeWeight)) n.strokeWeight = spec.strokeWeight;
  if (spec.radius !== undefined && !ref("radius", spec.radius)) setRadius(n, spec.radius);
  const props = spec.props || {};
  const propKeys = Object.keys(props);
  for (let i = 0; i < propKeys.length; i++) {
    const k = propKeys[i];
    if (k === "layoutSizingHorizontal" || k === "layoutSizingVertical") continue;
    await setRawProp(n, k, props[k]);
  }
  if (L && t === "FRAME") {   // hug unless a size or a fixed width/height was given
    const lw = typeof L.w === "string" ? upper(L.w) : L.w, lh = typeof L.h === "string" ? upper(L.h) : L.h;
    if (lw === "HUG" || (lw === undefined && !spec.size)) n.layoutSizingHorizontal = "HUG";
    if (lh === "HUG" || (lh === undefined && !spec.size)) n.layoutSizingVertical = "HUG";
  }
  if (t === "INSTANCE") { if (spec.children && spec.children.length) env.notes.push("children are ignored inside the instance " + n.name + " (use properties)"); }
  else for (const c of (spec.children || [])) await buildNode(c, n, created, env);
  const extra = {};
  BUILD_EXTRAS.forEach(function (k) { if (spec[k] !== undefined) extra[k] = spec[k]; });
  if (Object.keys(later).length) extra.variables = Object.assign({}, later, spec.variables || {});
  if (Object.keys(extra).length) await applyProps(n, extra, env.ctx, env.idx);
  if (spec.link) env.links.push({ node: n, link: spec.link });
  const parentAuto = "layoutMode" in parent && parent.layoutMode !== "NONE";
  function sizing(axis, v) {
    const key = axis === "w" ? "layoutSizingHorizontal" : "layoutSizingVertical";
    if (typeof v === "string") v = upper(v);
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

/* ---------- what the user is doing (activity log) ---------- */
const ACT = [];
const ACT_MAX = 300;
let busy = 0, lastClaudeAt = 0, lastVp = null, lastActivePing = 0, watchedPage = null;
function actor(origin, windowMs) {
  if (origin === "REMOTE") return "collaborator";
  return busy > 0 || Date.now() - lastClaudeAt < (windowMs || 800) ? "claude" : "user";
}
function sameList(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function pingActive(what) {
  const now = Date.now();
  if (now - lastActivePing < 1000) return;
  lastActivePing = now;
  figma.ui.postMessage({ type: "activity", what: what });
}
function record(e) {
  e.t = Date.now();
  if (e.by === "user") pingActive(e.what);
  const last = ACT[ACT.length - 1];
  if (last && last.by === e.by && last.what === e.what && e.t - last.t < 5000) {
    if (e.what === "viewport" || (e.what === "select" && sameList(last.layers, e.layers)) || (e.what === "page" && last.page === e.page) || (e.what === "style" && last.style === e.style)) {
      const times = (last.times || 1) + 1;
      Object.keys(e).forEach(function (k) { last[k] = e[k]; });
      last.times = times;
      return;
    }
    if (e.what === "edit" && sameList(last.layers, e.layers)) {
      last.t = e.t;
      last.times = (last.times || 1) + 1;
      (e.props || []).forEach(function (p) { if (!last.props) last.props = []; if (last.props.indexOf(p) < 0 && last.props.length < 16) last.props.push(p); });
      return;
    }
    if (e.what === "create" || e.what === "delete") {
      last.t = e.t;
      last.count += e.count;
      e.layers.forEach(function (l) { if (last.layers.length < 8 && last.layers.indexOf(l) < 0) last.layers.push(l); });
      return;
    }
  }
  ACT.push(e);
  if (ACT.length > ACT_MAX) ACT.splice(0, ACT.length - ACT_MAX);
}
function onSelectionChange() {
  const sel = figma.currentPage.selection;
  const e = { what: "select", by: actor("LOCAL"), count: sel.length, layers: sel.slice(0, 6).map(label) };
  const tr = textRange();
  if (tr) e.text = tr.node + " [" + tr.start + "–" + tr.end + "]";
  record(e);
}
function onPageChange() {
  watchPage();
  record({ what: "page", by: actor("LOCAL"), page: figma.currentPage.name });
  figma.ui.postMessage({ type: "info", info: { page: figma.currentPage.name } });
}
function onNodeChange(ev) {
  const groups = {}, order = [];
  const changes = (ev && ev.nodeChanges) || [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (tempIds.has(c.id)) continue;
    const what = c.type === "CREATE" ? "create" : c.type === "DELETE" ? "delete" : "edit";
    const by = actor(c.origin, 2000);
    const k = what + "|" + by;
    let g = groups[k];
    if (!g) { g = groups[k] = { what: what, by: by, count: 0, layers: [], props: [] }; order.push(k); }
    g.count++;
    if (g.layers.length < 8) g.layers.push(label(c.node || { id: c.id, type: "?", removed: true }));
    if (c.properties) for (let j = 0; j < c.properties.length && g.props.length < 16; j++) if (g.props.indexOf(c.properties[j]) < 0) g.props.push(c.properties[j]);
  }
  order.forEach(function (k) {
    const g = groups[k];
    const e = { what: g.what, by: g.by, count: g.count, layers: g.layers };
    if (g.props.length) e.props = g.props;
    record(e);
  });
}
function onStyleChange(ev) {
  const ch = (ev && ev.styleChanges) || [];
  for (let i = 0; i < ch.length && i < 10; i++) {
    const c = ch[i];
    const e = { what: "style", by: actor(c.origin, 2000), change: lower(String(c.type).replace("STYLE_", "")), style: c.style ? c.style.name : c.id };
    if (c.properties && c.properties.length) e.props = c.properties.slice(0, 8);
    record(e);
  }
}
function watchPage() {
  if (watchedPage === figma.currentPage) return;
  if (watchedPage) { const old = watchedPage; safe(function () { old.off("nodechange", onNodeChange); }); }
  watchedPage = figma.currentPage;
  safe(function () { watchedPage.on("nodechange", onNodeChange); });
}
function vpSnap() {
  const c = figma.viewport.center, b = figma.viewport.bounds;
  return { x: c.x, y: c.y, z: figma.viewport.zoom, w: b.width, h: b.height };
}
function pollViewport() {
  try {
    const s = vpSnap();
    if (!lastVp) { lastVp = s; return; }
    const moved = Math.abs(s.x - lastVp.x) > lastVp.w * 0.2 || Math.abs(s.y - lastVp.y) > lastVp.h * 0.2 || Math.abs(s.z / lastVp.z - 1) > 0.15;
    if (!moved) return;
    lastVp = s;
    const e = { what: "viewport", by: actor("LOCAL"), zoom: round(s.z) };
    if (figma.currentPage.children.length <= 2000) {
      const f = focusChain(figma.viewport.bounds);
      if (f.length) e.focus = f.map(function (x) { return x.node.name; }).join(" › ");
    }
    record(e);
  } catch (err) { /* the plugin may be closing */ }
}
function activityReport(limit, sinceSec) {
  const now = Date.now();
  let list = ACT;
  if (sinceSec) list = list.filter(function (e) { return now - e.t <= sinceSec * 1000; });
  const pick = list.slice(Math.max(0, list.length - limit));
  const fmt = function (e) {
    const o = { ago: ago(now - e.t), by: e.by, what: e.what };
    ["page", "count", "layers", "props", "text", "zoom", "focus", "style", "change", "times"].forEach(function (k) { if (e[k] !== undefined && e[k] !== null) o[k] = e[k]; });
    return o;
  };
  const lastOf = function (whats, by) {
    for (let i = ACT.length - 1; i >= 0; i--) if (whats.indexOf(ACT[i].what) >= 0 && (!by || ACT[i].by === by)) return fmt(ACT[i]);
    return null;
  };
  return {
    trackingFor: ago(now - STARTED) + " (since Claude Bridge was opened in this file)",
    lastUserSelection: lastOf(["select"], "user"),
    lastUserEdit: lastOf(["edit", "create", "delete", "style"], "user"),
    events: pick.map(fmt)
  };
}

/* ---------- command handlers ---------- */
const handlers = {
  async ping() {
    return { file: figma.root.name, fileKey: fileKey(), page: figma.currentPage.name, editorType: figma.editorType, selection: figma.currentPage.selection.length, version: VERSION, zoom: round(figma.viewport.zoom) };
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
    const max = p.max_size || 1600;
    if (p.node_id) return exportNode(await getNode(p.node_id), p.scale, max);
    const sel = figma.currentPage.selection;
    if (!p.viewport && sel.length === 1) return exportNode(sel[0], p.scale, max);
    if (!p.viewport && sel.length > 1) {
      let u = null;
      sel.forEach(function (n) { const bb = boxOf(n); if (bb) u = unionBox(u, bb); });
      if (u) {
        const pad = Math.max(u.width, u.height) * 0.03;
        return captureRegion({ x: u.x - pad, y: u.y - pad, width: u.width + 2 * pad, height: u.height + 2 * pad }, p.scale || 1, max, "the area around the " + sel.length + " selected layers");
      }
    }
    const z = figma.viewport.zoom;
    return captureRegion(figma.viewport.bounds, p.scale || z, max, "what the user sees on screen (zoom " + Math.round(z * 100) + "%)");
  },
  async get_selection(p) {
    const ctx = makeCtx();
    const sel = figma.currentPage.selection;
    const d = p.depth === undefined ? 1 : p.depth;
    const res = { file: figma.root.name, page: figma.currentPage.name, count: sel.length };
    const tr = textRange();
    if (tr) res.textSelection = tr;
    res.selection = [];
    const detailed = p.brief ? 0 : 25;
    for (let i = 0; i < sel.length && i < 200; i++) res.selection.push(i < detailed ? await describe(sel[i], ctx, d) : summary(sel[i], 0));
    if (sel.length > 200) res.more = sel.length - 200;
    if (sel.length && !p.brief) {
      const sc = safe(function () { return figma.getSelectionColors(); }, null);
      if (sc && sc.paints && sc.paints.length && sc.paints.length <= 40) {
        const cols = [];
        sc.paints.forEach(function (pt) { if (pt.type === "SOLID") { const x = toHex(pt.color, pt.opacity); if (cols.indexOf(x) < 0) cols.push(x); } });
        if (cols.length) res.colors = cols;
        if (sc.styles && sc.styles.length) res.colorStyles = sc.styles.map(function (s) { return s.name; });
      }
    }
    if (!sel.length) res.hint = "Nothing is selected. get_context shows what the user is looking at and did recently.";
    return res;
  },
  async get_context(p) {
    const page = figma.currentPage, sel = page.selection;
    const res = {
      file: figma.root.name,
      page: page.name,
      pageId: page.id,
      pages: figma.root.children.length,
      selection: { count: sel.length, layers: sel.slice(0, 12).map(brief) }
    };
    const fk = fileKey();
    if (fk) res.fileKey = fk;
    if (sel.length > 12) res.selection.more = sel.length - 12;
    const tr = textRange();
    if (tr) res.selection.textEditing = tr;
    res.viewport = viewportInfo(p.depth === undefined ? 2 : p.depth, p.max_layers || 60);
    res.activity = activityReport(p.activity === undefined ? 15 : p.activity, p.since_seconds);
    return res;
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
    const parent = p.parent_id ? await ensureLoaded(await getNode(p.parent_id)) : figma.currentPage;
    if (!("appendChild" in parent)) throw new Error("Parent can't have children: " + parent.type);
    const specs = Array.isArray(p.spec) ? p.spec : [p.spec];
    const created = [], roots = [], errors = [];
    const env = { ctx: makeCtx(), idx: await varIndex(), links: [], notes: [] };
    for (let i = 0; i < specs.length; i++) {
      const start = created.length;
      try { roots.push(await buildNode(specs[i], parent, created, env)); }
      catch (e) {
        // an item either builds completely or not at all, so a retry doesn't leave duplicates
        const mine = created.splice(start);
        if (mine[0]) safe(function () { mine[0].remove(); });
        env.links = env.links.filter(function (l) { return mine.indexOf(l.node) < 0; });
        errors.push({ item: i, name: specs[i] && specs[i].name, error: e && e.message ? e.message : String(e), note: "nothing from this item was kept" });
      }
    }
    for (let i = 0; i < env.links.length; i++) {
      const l = env.links[i];
      try {
        const spec = typeof l.link === "string" ? { to: l.link } : Object.assign({}, l.link);
        const to = String(spec.to || "");
        if (to && !/^(back|close)$/i.test(to) && !/^https?:\/\//i.test(to) && !/^I?\d+:\d+/.test(to)) {
          const target = created.filter(function (n) { return n.name === to; })[0];
          if (!target) throw new Error('no layer named "' + to + '" was created in this build (use a layer id for existing layers)');
          spec.to = target.id;
        }
        await setLink(l.node, spec);
      } catch (e) { errors.push({ link: l.node.name, error: e && e.message ? e.message : String(e) }); }
    }
    const res = { roots: roots.map(function (n) { return summary(n, 0); }), created: created.length };
    if (env.notes.length) res.notes = env.notes;
    if (errors.length) res.errors = errors;
    return res;
  },
  async find_nodes(p) {
    const sc = await scopeRoots(p.scope, p.node_id);
    let types = p.type ? (Array.isArray(p.type) ? p.type : [p.type]).map(upper) : null;
    const byName = p.name ? toMatcher(p.name) : null, byText = p.text ? toMatcher(p.text) : null, byComp = p.component ? toMatcher(p.component) : null;
    if (byText) types = ["TEXT"];
    if (byComp) types = ["INSTANCE"];
    const limit = p.limit || 200, ctx = makeCtx(), cap = byComp ? 5000 : 20000;
    const list = descendants(sc.roots, types, cap);
    const out = [];
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (byName && !byName(n.name)) continue;
      if (byText && !byText(n.characters)) continue;
      if (p.visible_only && n.visible === false) continue;
      if (byComp) {
        const m = await ctx.main(n);
        if (!m) continue;
        const nm = (m.parent && m.parent.type === "COMPONENT_SET" ? m.parent.name + "/" : "") + m.name;
        if (!byComp(nm) && m.key !== p.component) continue;
      }
      count++;
      if (out.length < limit) out.push(await nodeOut(n, ctx));
    }
    const res = { file: figma.root.name, scope: sc.label, count: count, nodes: out };
    if (count > out.length) res.more = count - out.length;
    if (list.length >= cap) res.note = "Searched the first " + cap + " layers only.";
    return res;
  },
  async update_nodes(p) {
    const items = p.items;
    if (!Array.isArray(items) || !items.length) throw new Error("Pass items: [{id, …changes}]");
    if (p.save_version) await saveVersion(p.save_version);
    const ctx = makeCtx(), idx = await varIndex();
    const done = [], errors = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let nodes;
      try {
        const r = it.ids !== undefined ? it.ids : (it.id !== undefined ? it.id : it.node_id);
        if (r === undefined) throw new Error('item needs id (or ids, or "selection")');
        nodes = await resolveNodes(r);
      } catch (e) { errors.push({ item: i, error: e.message }); continue; }
      for (let j = 0; j < nodes.length; j++) {
        const lb = label(nodes[j]);
        try { const ch = await applyProps(nodes[j], it, ctx, idx); done.push(lb + ": " + (ch.length ? ch.join(", ") : "no change")); }
        catch (e) { errors.push({ item: i, node: lb, error: e.message }); }
      }
    }
    const res = { file: figma.root.name, done: done };
    if (errors.length) res.errors = errors;
    return res;
  },
  async audit_design(p) {
    const sel = figma.currentPage.selection;
    const sc = await scopeRoots(p.scope || (p.node_id ? null : (sel.length ? "selection" : "page")), p.node_id);
    const want = p.checks ? (Array.isArray(p.checks) ? p.checks : [p.checks]).map(lower) : null;
    const fixes = (p.fix ? (Array.isArray(p.fix) ? p.fix : [p.fix]) : []).map(lower);
    const limit = p.limit || 150, cap = p.max_layers || 5000;
    const walked = walkForAudit(sc.roots, cap);
    const nodes = walked.nodes;
    const idx = await varIndex();
    const paintStyles = await figma.getLocalPaintStylesAsync(), textStyles = await figma.getLocalTextStylesAsync();
    const issues = [], counts = {};
    const o = {
      ctx: makeCtx(), grid: p.grid || 4,
      systemColors: idx.vars.some(function (v) { return v.resolvedType === "COLOR"; }) || paintStyles.length > 0,
      hasTextStyles: textStyles.length > 0,
      on: function (c) { return !want || want.indexOf(c) >= 0; },
      add: function (code, severity, n, message, extra) {
        counts[code] = (counts[code] || 0) + 1;
        if (issues.length < 2000) issues.push(Object.assign({ check: code, severity: severity, id: n.id, layer: n.name, message: message }, extra || {}));
      }
    };
    for (let i = 0; i < nodes.length; i++) { try { await auditNode(nodes[i], o); } catch (e) { /* skip odd layers */ } }
    const fixed = [];
    if (fixes.length) {
      for (let i = 0; i < issues.length; i++) {
        const is = issues[i];
        if (!is.fix || fixes.indexOf(is.fix) < 0) continue;
        try {
          const n = await getNode(is.id);
          if (is.fix === "bind") { const v = await figma.variables.getVariableByIdAsync(is.variableId); await bindOne(n, is.field, v, { index: is.index || 0 }); }
          else if (is.fix === "round") {
            const ax = is.axes || [];
            if (ax.indexOf("x") >= 0) n.x = Math.round(n.x);
            if (ax.indexOf("y") >= 0) n.y = Math.round(n.y);
            const rw = ax.indexOf("width") >= 0, rh = ax.indexOf("height") >= 0;
            if ((rw || rh) && "resize" in n) {
              // resize() makes both axes fixed: put back hug/fill on the axis we didn't touch
              const sw = sizingOf(n, "w"), sh = sizingOf(n, "h");
              n.resize(rw ? Math.max(1, Math.round(n.width)) : n.width, rh ? Math.max(1, Math.round(n.height)) : n.height);
              if (!rw && sw !== "FIXED") safe(function () { n.layoutSizingHorizontal = sw; });
              if (!rh && sh !== "FIXED") safe(function () { n.layoutSizingVertical = sh; });
            }
          } else if (is.fix === "autolayout") applyLayout(n, { mode: "AUTO" }, []);
          is.fixed = true;
          fixed.push(is.layer + ": " + is.message);
        } catch (e) { is.fixError = e.message; }
      }
    }
    const rank = { error: 0, warning: 1, info: 2 };
    issues.sort(function (a, b) { return rank[a.severity] - rank[b.severity]; });
    const res = { file: figma.root.name, scope: sc.label, checkedLayers: nodes.length, summary: counts, issues: issues.slice(0, limit).map(function (x) { const c = Object.assign({}, x); delete c.variableId; delete c.field; delete c.index; delete c.axes; return c; }) };
    if (walked.truncated) res.note = "Checked the first " + cap + " layers only (instances count as one layer); narrow the scope or raise max_layers.";
    if (issues.length > limit) res.more = issues.length - limit;
    if (fixed.length) res.fixed = fixed.length + " issues fixed (one Cmd+Z undoes them)";
    if (!fixes.length) {
      const can = ["bind", "round", "autolayout"].filter(function (f) { return issues.some(function (x) { return x.fix === f; }); });
      if (can.length) res.canFix = "Run again with fix: " + JSON.stringify(can) + " to apply the safe fixes; names and colours need your judgement (update_nodes).";
    }
    if (!issues.length) res.result = "No issues found.";
    return res;
  },
  async place_image(p) {
    let target;
    if (p.svg) {
      if (p.node_id) throw new Error("An SVG becomes its own layer: use parent_id and x/y instead of node_id");
      const parent = p.parent_id ? await ensureLoaded(await getNode(p.parent_id)) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Parent can't have children: " + parent.type);
      target = figma.createNodeFromSvg(p.svg);
      target.name = p.name || "SVG";
      parent.appendChild(target);
      if (p.width) target.rescale(p.width / target.width);
      position(target, p, parent);
      return { node: summary(target, 0) };
    }
    if (!p.base64) throw new Error("No image data");
    const img = figma.createImage(figma.base64Decode(p.base64));
    const size = await img.getSizeAsync();
    const paint = { type: "IMAGE", imageHash: img.hash, scaleMode: upper(p.scale_mode || "FILL") };
    if (p.node_id) {
      target = await getNode(p.node_id);
      if (!("fills" in target) || target.fills === figma.mixed) throw new Error(target.name + " can't take an image fill");
      target.fills = p.add ? target.fills.concat([paint]) : [paint];
    } else {
      const parent = p.parent_id ? await ensureLoaded(await getNode(p.parent_id)) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Parent can't have children: " + parent.type);
      target = figma.createRectangle();
      target.name = p.name || "Image";
      parent.appendChild(target);
      const w = p.width || size.width;
      const h = p.height || (p.width ? Math.round(size.height * p.width / size.width) : size.height);
      target.resize(w, h);
      target.fills = [paint];
      position(target, p, parent);
    }
    return { node: summary(target, 0), image: { width: size.width, height: size.height } };
  },
  async export_nodes(p) {
    const nodes = await resolveNodes(p.ids && p.ids.length ? p.ids : undefined);
    const fmt = upper(p.format || "PNG");
    if (["PNG", "JPG", "SVG", "PDF"].indexOf(fmt) < 0) throw new Error("format must be PNG, JPG, SVG or PDF");
    const files = [], errors = [];
    for (let i = 0; i < nodes.length && i < 200; i++) {
      const n = nodes[i];
      if (!("exportAsync" in n) || n.type === "PAGE") { errors.push({ id: n.id, layer: n.name, error: n.type + " can't be exported" }); continue; }
      const settings = fmt === "SVG" ? { format: "SVG", svgIdAttribute: !!p.svg_ids } : fmt === "PDF" ? { format: "PDF" } : { format: fmt, constraint: { type: "SCALE", value: p.scale || 1 } };
      try {
        const bytes = await n.exportAsync(settings);
        files.push({ id: n.id, name: n.name, base64: figma.base64Encode(bytes), bytes: bytes.length });
      } catch (e) { errors.push({ id: n.id, layer: n.name, error: e && e.message ? e.message : String(e) }); }
    }
    if (!files.length) throw new Error("Nothing was exported" + (errors.length ? ": " + errors.map(function (x) { return x.layer + " (" + x.error + ")"; }).join("; ") : ""));
    const res = { format: fmt, scale: fmt === "PNG" || fmt === "JPG" ? (p.scale || 1) : undefined, files: files };
    if (errors.length) res.errors = errors;
    return res;
  },
  async delete_nodes(p) {
    const done = [], errors = [];
    for (const id of p.ids || []) {
      try {
        const n = await figma.getNodeByIdAsync(id);
        if (!n) { errors.push({ id: id, error: "not found" }); continue; }
        if (n.type === "PAGE" || n.type === "DOCUMENT") { errors.push({ id: id, error: "pages are never deleted" }); continue; }
        n.remove();
        done.push(id);
      } catch (e) { errors.push({ id: id, error: e && e.message ? e.message : String(e) }); }
    }
    const res = { deleted: done };
    if (errors.length) res.errors = errors;
    return res;
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
  },
  async get_variables(p) {
    const ctx = makeCtx(), idx = await varIndex();
    const q = lower(p.query || ""), type = p.type ? normType(p.type) : null, limit = p.limit || 500;
    const byId = new Map();
    idx.vars.forEach(function (v) { byId.set(v.id, v); });
    const res = { file: figma.root.name, collections: [] };
    let shown = 0, more = 0;
    for (let i = 0; i < idx.cols.length; i++) {
      const c = idx.cols[i];
      if (p.collection && !(c.id === p.collection || lower(c.name).indexOf(lower(p.collection)) >= 0)) continue;
      const oc = { name: c.name, modes: c.modes.map(function (m) { return m.name; }) };
      if (c.modes.length > 1) oc.defaultMode = (findMode(c) || {}).name;
      if (p.ids) oc.id = c.id;
      if (c.hiddenFromPublishing) oc.hiddenFromPublishing = true;
      oc.total = c.variableIds.length;
      oc.variables = [];
      for (let j = 0; j < c.variableIds.length; j++) {
        const v = byId.get(c.variableIds[j]);
        if (!v) continue;
        if (q && lower(v.name).indexOf(q) < 0) continue;
        if (type && v.resolvedType !== type) continue;
        if (shown >= limit) { more++; continue; }
        shown++;
        oc.variables.push(await varOut(v, c, ctx, p));
      }
      res.collections.push(oc);
    }
    if (more) res.more = more + " more variables match: narrow with collection, query or type, or raise limit";
    if (!idx.cols.length) res.note = "This file has no local variables." + (p.library ? "" : " Pass library: true to see variables from enabled libraries.");
    if (p.library) {
      try {
        const cols = await libraryCollectionsList();
        const lists = await Promise.all(cols.map(function (c) { return figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key).catch(function (e) { return { error: String(e && e.message ? e.message : e) }; }); }));
        res.libraries = cols.map(function (c, i) {
          const o = { library: c.libraryName, collection: c.name, key: c.key };
          if (lists[i] && lists[i].error) { o.error = lists[i].error; return o; }
          const vs = lists[i].filter(function (v) { return (!q || lower(v.name).indexOf(q) >= 0) && (!type || v.resolvedType === type); });
          o.total = lists[i].length;
          o.variables = vs.slice(0, limit).map(function (v) { return { name: v.name, type: v.resolvedType, key: v.key }; });
          if (vs.length > limit) o.more = vs.length - limit;
          return o;
        }).filter(function (o) { return !p.collection || lower(o.collection).indexOf(lower(p.collection)) >= 0 || lower(o.library).indexOf(lower(p.collection)) >= 0; });
        if (!cols.length) res.libraryNote = "No library with variables is enabled for this file (Assets panel → Libraries).";
        else res.libraryNote = "Library variables are read-only here. Bind them by name, or import with import_from_library. To change them, open the library file and run Claude Bridge there.";
      } catch (e) { res.libraries = { error: libError(e).message }; }
    }
    return res;
  },
  async set_variables(p) {
    const ops = p.ops;
    if (!Array.isArray(ops) || !ops.length) throw new Error("Pass ops: [ … ]");
    if (p.save_version) await saveVersion(p.save_version);
    const ctx = makeCtx(), idx = await varIndex();
    const results = [];
    for (let i = 0; i < ops.length; i++) {
      try { results.push(await varOp(ops[i], idx, ctx)); }
      catch (e) {
        results.push({ op: ops[i] && ops[i].op, name: ops[i] && (ops[i].name || ops[i].collection), error: e && e.message ? e.message : String(e) });
        return { file: figma.root.name, applied: i, stoppedAt: i, results: results, note: "Stopped at the first error. Ops before it were applied (one Cmd+Z in Figma undoes them all)." };
      }
    }
    return { file: figma.root.name, applied: ops.length, results: results };
  },
  async bind_variables(p) {
    if (p.save_version) await saveVersion(p.save_version);
    const idx = await varIndex();
    const done = [], errors = [];
    const bindings = p.bindings || [];
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      let nodes, variable;
      try {
        if (!b.field) throw new Error("binding needs field");
        nodes = await resolveNodes(b.nodes !== undefined ? b.nodes : b.node_id);
        variable = b.variable === null ? null : await resolveVariable(b.variable, b.collection, idx);
      } catch (e) { errors.push({ binding: i, error: e.message }); continue; }
      const vl = variable ? variable.name + (variable.remote ? " (library)" : "") : "nothing (unbound)";
      for (let j = 0; j < nodes.length; j++) {
        try { const f = await bindOne(nodes[j], b.field, variable, b); done.push(label(nodes[j]) + ": " + (f.length ? f.join(", ") : b.field) + " ← " + vl); }
        catch (e) { errors.push({ binding: i, node: label(nodes[j]), error: e.message }); }
      }
    }
    const modes = p.modes || [];
    for (let i = 0; i < modes.length; i++) {
      const m = modes[i];
      let nodes, col, mode = null;
      const reset = m.mode === null || m.mode === undefined || lower(m.mode) === "auto";
      try {
        nodes = await resolveNodes(m.nodes !== undefined ? m.nodes : m.node_id);
        col = await resolveCollection(m.collection, idx);
        if (!reset) mode = modeOrThrow(col, m.mode);
      } catch (e) { errors.push({ mode: i, error: e.message }); continue; }
      for (let j = 0; j < nodes.length; j++) {
        try {
          if (reset) nodes[j].clearExplicitVariableModeForCollection(col);
          else nodes[j].setExplicitVariableModeForCollection(col, mode.modeId);
          done.push(label(nodes[j]) + ": " + col.name + " mode → " + (reset ? "auto" : mode.name));
        } catch (e) { errors.push({ mode: i, node: label(nodes[j]), error: e.message }); }
      }
    }
    const res = { file: figma.root.name, done: done };
    if (errors.length) res.errors = errors;
    if (!bindings.length && !modes.length) res.note = "Nothing to do: pass bindings and/or modes.";
    return res;
  },
  async get_library(p) {
    const kind = lower(p.kind || "all"), q = lower(p.query || ""), limit = p.limit || 300;
    const want = function (k) { return kind === "all" || kind === k; };
    const match = function (s) { return !q || lower(s).indexOf(q) >= 0; };
    const ctx = makeCtx();
    const res = { file: figma.root.name };
    if (want("styles")) {
      const lists = await Promise.all([figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(), figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync()]);
      const names = ["paint", "text", "effect", "grid"];
      res.styles = {};
      for (let i = 0; i < 4; i++) {
        const l = lists[i].filter(function (s) { return match(s.name); });
        if (!l.length) continue;
        res.styles[names[i]] = [];
        for (let j = 0; j < l.length && j < limit; j++) res.styles[names[i]].push(await styleOut(l[j], ctx));
        if (l.length > limit) res.styles[names[i] + "More"] = l.length - limit;
      }
      if (!Object.keys(res.styles).length) res.styles = "no local styles" + (q ? ' matching "' + p.query + '"' : "");
    }
    if (want("components")) {
      // the whole file when components are asked for (or scope: 'file'); otherwise only the current page, which stays fast on big files
      const wholeFile = lower(p.scope) === "file" || (kind === "components" && lower(p.scope) !== "page");
      let found;
      if (wholeFile) { await figma.loadAllPagesAsync(); found = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }); }
      else { found = figma.currentPage.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }); res.componentsScope = "current page only (kind: 'components' or scope: 'file' lists every page)"; }
      const list = [];
      let more = 0;
      for (let i = 0; i < found.length; i++) {
        const n = found[i];
        if (n.type === "COMPONENT" && n.parent && n.parent.type === "COMPONENT_SET") continue;
        if (!match(n.name)) continue;
        if (list.length >= limit) { more++; continue; }
        list.push(componentOut(n));
      }
      res.components = list.length ? list : "no local components" + (q ? ' matching "' + p.query + '"' : "");
      if (more) res.componentsMore = more;
    }
    if (want("variables")) {
      const cols = await figma.variables.getLocalVariableCollectionsAsync();
      res.variableCollections = { local: cols.filter(function (c) { return match(c.name); }).map(function (c) { return { name: c.name, modes: c.modes.map(function (m) { return m.name; }), variables: c.variableIds.length, key: c.key }; }) };
      try {
        const lib = await libraryCollectionsList();
        res.variableCollections.fromLibraries = lib.filter(function (c) { return match(c.name) || match(c.libraryName); }).map(function (c) { return { library: c.libraryName, name: c.name, key: c.key }; });
      } catch (e) { res.variableCollections.fromLibraries = { error: libError(e).message }; }
    }
    if (want("shaders") && typeof figma.listAvailableShaders === "function") {
      try {
        const sh = await figma.listAvailableShaders();
        if (sh.length || kind === "shaders") res.shaders = sh.filter(function (s) { return match(s.name); }).slice(0, limit).map(function (s) { return { name: s.name, id: s.id, appliesAs: s.type, imported: s.imported }; });
      } catch (e) { if (kind === "shaders") res.shaders = { error: String(e && e.message ? e.message : e) }; }
    }
    if (p.used_remote || kind === "used") {
      const inst = figma.currentPage.findAllWithCriteria({ types: ["INSTANCE"] });
      const map = new Map();
      let scanned = 0;
      for (let i = 0; i < inst.length && scanned < 3000; i++) {
        scanned++;
        let m = null;
        try { m = await inst[i].getMainComponentAsync(); } catch (e) { m = null; }
        if (!m || !m.remote) continue;
        const set = m.parent && m.parent.type === "COMPONENT_SET" ? m.parent : null;
        const k = set ? set.key : m.key;
        let e = map.get(k);
        if (!e) { e = { name: set ? set.name : m.name, kind: set ? "component_set" : "component", key: k, example: label(inst[i]), uses: 0 }; map.set(k, e); }
        e.uses++;
      }
      res.libraryComponentsOnThisPage = Array.from(map.values()).sort(function (a, b) { return b.uses - a.uses; }).slice(0, limit);
      if (inst.length > scanned) res.libraryComponentsNote = "Scanned the first " + scanned + " of " + inst.length + " instances on this page.";
    }
    res.notes = [
      "Local styles, components and variables can be edited here (set_styles, set_variables, run_code).",
      "Library items (from other files) are read-only here: use them, bind them or import them by key. To change one, open its library file, run Claude Bridge there, edit, then publish the library."
    ];
    return res;
  },
  async set_styles(p) {
    const ops = p.ops;
    if (!Array.isArray(ops) || !ops.length) throw new Error("Pass ops: [ … ]");
    if (p.save_version) await saveVersion(p.save_version);
    const ctx = makeCtx(), idx = await varIndex();
    const results = [];
    for (let i = 0; i < ops.length; i++) {
      try { results.push(await styleOp(ops[i], ctx, idx)); }
      catch (e) {
        results.push({ op: ops[i] && ops[i].op, name: ops[i] && ops[i].name, error: e && e.message ? e.message : String(e) });
        return { file: figma.root.name, applied: i, stoppedAt: i, results: results, note: "Stopped at the first error. Ops before it were applied (one Cmd+Z in Figma undoes them all)." };
      }
    }
    return { file: figma.root.name, applied: ops.length, results: results };
  },
  async import_from_library(p) {
    const kind = lower(p.kind || "").replace(/[\s-]/g, "_");
    if (!p.key) throw new Error("Pass key (from get_library or get_variables with library: true)");
    if (kind === "variable") {
      const v = await importVar(p.key);
      const c = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId);
      return { imported: "variable", name: v.name, type: v.resolvedType, collection: c ? c.name : null, id: v.id };
    }
    if (kind === "style") {
      const s = await figma.importStyleByKeyAsync(p.key);
      return { imported: "style", name: s.name, type: s.type, id: s.id };
    }
    if (kind === "component" || kind === "component_set") {
      const c = kind === "component" ? await figma.importComponentByKeyAsync(p.key) : await figma.importComponentSetByKeyAsync(p.key);
      const res = { imported: kind, name: c.name, id: c.id };
      if (p.place === false) return res;
      let comp = c;
      if (c.type === "COMPONENT_SET") {
        comp = c.defaultVariant || c.children[0];
        if (p.variant) {
          const want = parseVariantName(p.variant);
          const v = c.children.filter(function (x) { return matchVariant(x, want); })[0];
          if (!v) throw new Error('No variant "' + p.variant + '" in ' + c.name + " (" + c.children.map(function (x) { return x.name; }).join(" | ") + ")");
          comp = v;
        }
      }
      const parent = p.parent_id ? await ensureLoaded(await getNode(p.parent_id)) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Parent can't have children: " + parent.type);
      const inst = comp.createInstance();
      parent.appendChild(inst);
      position(inst, p, parent);
      res.instance = summary(inst, 0);
      return res;
    }
    throw new Error('kind must be variable, style, component or component_set');
  }
};

/* ---------- wiring ---------- */
const MUTATING = { run_code: 1, build: 1, delete_nodes: 1, set_page: 1, set_variables: 1, bind_variables: 1, set_styles: 1, import_from_library: 1, update_nodes: 1, audit_design: 1, place_image: 1 };
figma.ui.onmessage = async function (msg) {
  if (!msg) return;
  if (msg.type === "ui-ready") {
    figma.ui.postMessage({ type: "hello", info: helloInfo() });
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
    lastClaudeAt = Date.now();
    if (MUTATING[msg.command]) { try { figma.commitUndo(); } catch (e) { /* not available */ } }
    try { lastVp = vpSnap(); } catch (e) { /* closing */ }
  }
};

figma.on("selectionchange", onSelectionChange);
figma.on("currentpagechange", onPageChange);
safe(function () { figma.on("stylechange", onStyleChange); });
watchPage();
safe(cleanupTemp);
setInterval(pollViewport, 1500);
globalThis.__claudeBridge = { version: VERSION, handlers: handlers, activity: ACT, describe: H.describe };
