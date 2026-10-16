// Plugin main-thread handlers (figma-plugin/code.js) against a mock Figma API.
// Run: node test/plugin.test.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");

/* ---------------- a small fake Figma ---------------- */
const MIXED = Symbol("mixed");
const clock = { t: 1700000000000 };
const tick = (ms) => { clock.t += ms; };
let ids = 0; const all = new Map(); const fonts = new Set(); const errors = [];
const CONTAINERS = ["FRAME", "PAGE", "SECTION", "DOCUMENT", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP"];
function node(type, extra) {
  const n = Object.assign({ id: (++ids) + ":1", type, name: type, x: 0, y: 0, width: 100, height: 100, parent: null, visible: true, locked: false, opacity: 1, rotation: 0, blendMode: "PASS_THROUGH", _pd: {} }, extra || {});
  if (type === "PAGE" || type === "DOCUMENT") { delete n.x; delete n.y; delete n.width; delete n.height; delete n.rotation; delete n.opacity; delete n.blendMode; }
  n.boundVariables = n.boundVariables || {};
  n.explicitVariableModes = n.explicitVariableModes || {};
  if (CONTAINERS.includes(type)) n.children = n.children || [];
  if (["FRAME", "RECTANGLE", "ELLIPSE", "TEXT", "COMPONENT", "INSTANCE", "SECTION", "COMPONENT_SET"].includes(type)) {
    if (!n.fills) n.fills = type === "FRAME" ? [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }] : [];
    n.strokes = n.strokes || []; n.strokeWeight = 1; n.effects = n.effects || [];
  }
  if (["FRAME", "RECTANGLE", "COMPONENT", "INSTANCE", "COMPONENT_SET"].includes(type)) Object.assign(n, { cornerRadius: n.cornerRadius || 0, topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0 });
  if (["FRAME", "COMPONENT", "INSTANCE", "COMPONENT_SET"].includes(type)) Object.assign(n, { layoutMode: n.layoutMode || "NONE", itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", counterAxisSpacing: 0, layoutWrap: "NO_WRAP" }, extra || {});
  if (type === "TEXT") {
    Object.assign(n, { fontName: { family: "Inter", style: "Regular" }, fontSize: 12, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 }, textAlignHorizontal: "LEFT", textAutoResize: "WIDTH_AND_HEIGHT", textCase: "ORIGINAL", textDecoration: "NONE" }, extra || {});
    n._chars = "";
    Object.defineProperty(n, "characters", { get() { return this._chars; }, set(v) { const f = this.fontName; if (!fonts.has(f.family + f.style)) errors.push("chars before font"); this._chars = v; }, enumerable: true });
    n.getRangeAllFontNames = function () { return [this.fontName]; };
  }
  if (type !== "PAGE" && type !== "DOCUMENT") {
    Object.defineProperty(n, "absoluteBoundingBox", { get() { let x = this.x, y = this.y, q = this.parent; while (q && q.type !== "PAGE" && q.type !== "DOCUMENT") { x += q.x; y += q.y; q = q.parent; } return { x, y, width: this.width, height: this.height }; }, enumerable: false });
  }
  n.appendChild = function (c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.push(c); };
  n.insertChild = function (i, c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.splice(i, 0, c); };
  n.resize = function (w, h) {
    if (!(w > 0 && h > 0)) errors.push("bad resize");
    this.width = w; this.height = h;
    if (this.layoutMode && this.layoutMode !== "NONE") { lsh = "FIXED"; lsv = "FIXED"; }   // like Figma: resize() fixes both axes
  };
  n.rescale = function (k) { this.width *= k; this.height *= k; };
  n.remove = function () { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; (function drop(x) { all.delete(x.id); (x.children || []).forEach(drop); })(this); figma._removed.push(this.id); };
  n.exportAsync = async function (opts) { n._lastExport = opts; figma._exports.push({ id: n.id, opts, indexInPage: n.parent ? n.parent.children.indexOf(n) : -1, fills: n.fills }); return new Uint8Array([137, 80, 78, 71, 1, 2, 3]); };
  n.getPluginData = function (k) { return this._pd[k] || ""; };
  n.setPluginData = function (k, v) { this._pd[k] = v; };
  n.setBoundVariable = function (field, v) {
    if (typeof v === "string") errors.push("setBoundVariable with an id string (deprecated in dynamic-page)");
    const textField = ["fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "lineHeight", "paragraphSpacing", "paragraphIndent"].includes(field);
    if (textField && this.type === "TEXT" && !fonts.has(this.fontName.family + this.fontName.style)) errors.push("text binding before font load");
    if (!v) delete this.boundVariables[field]; else this.boundVariables[field] = textField ? [{ type: "VARIABLE_ALIAS", id: v.id }] : { type: "VARIABLE_ALIAS", id: v.id };
  };
  n.setExplicitVariableModeForCollection = function (col, modeId) { if (typeof col === "string") errors.push("mode with collection id string"); this.explicitVariableModes[col.id] = modeId; };
  n.clearExplicitVariableModeForCollection = function (col) { delete this.explicitVariableModes[col.id]; };
  n.findAllWithCriteria = function (crit) {
    if (this.type === "DOCUMENT" && !figma._allPagesLoaded) errors.push("document search before loadAllPagesAsync");
    const out = [];
    (function walk(x) { for (const c of x.children || []) { if (!crit.types || crit.types.includes(c.type)) out.push(c); walk(c); } })(this);
    return out;
  };
  n.findAll = function (cb) {
    if (this.type === "DOCUMENT" && !figma._allPagesLoaded) errors.push("document search before loadAllPagesAsync");
    const out = [];
    (function walk(x) { for (const c of x.children || []) { if (!cb || cb(c)) out.push(c); walk(c); } })(this);
    return out;
  };
  n.on = function (ev, fn) { (this._ev = this._ev || {})[ev] = fn; };
  n.off = function (ev, fn) { if (this._ev && this._ev[ev] === fn) delete this._ev[ev]; };
  if (type !== "PAGE" && type !== "DOCUMENT") {
    n.reactions = [];
    n.setReactionsAsync = async function (rs) {
      for (const r of rs) { if (!r.trigger || !Array.isArray(r.actions) || r.action) errors.push("bad reaction " + JSON.stringify(r)); for (const a of r.actions || []) if (a.type === "NODE" && !all.get(a.destinationId)) errors.push("reaction to a missing node"); }
      this.reactions = rs;
    };
    Object.defineProperty(n, "inferredVariables", { get() { return inferVars(this); }, enumerable: false });
    n.setFillStyleIdAsync = async function (id) { this.fillStyleId = id; };
    n.setStrokeStyleIdAsync = async function (id) { this.strokeStyleId = id; };
    n.setEffectStyleIdAsync = async function (id) { this.effectStyleId = id; };
    n.setTextStyleIdAsync = async function (id) {
      const s = styles.find((x) => x.id === id);
      if (s && !fonts.has(s.fontName.family + s.fontName.style)) errors.push("text style applied before its font was loaded");
      this.textStyleId = id;
      if (s) { this.fontName = s.fontName; this.fontSize = s.fontSize; }
    };
  }
  let lsh, lsv;
  Object.defineProperty(n, "layoutSizingHorizontal", { get() { return lsh || "FIXED"; }, set(v) { check(n, v, "H"); lsh = v; }, enumerable: false });
  Object.defineProperty(n, "layoutSizingVertical", { get() { return lsv || "FIXED"; }, set(v) { check(n, v, "V"); lsv = v; }, enumerable: false });
  all.set(n.id, n);
  return n;
}
function check(n, v) {
  const auto = (x) => x && x.layoutMode && x.layoutMode !== "NONE";
  if (v === "HUG" && !(n.type === "TEXT" || auto(n))) errors.push("HUG on non-auto " + n.name);
  if (v === "FILL" && !auto(n.parent)) errors.push("FILL without auto parent " + n.name);
}

/* variables */
const collections = [], variables = [];
let vc = 0, vs = 0, ms = 0;
const DEFAULTS = { COLOR: { r: 0, g: 0, b: 0, a: 1 }, FLOAT: 0, STRING: "", BOOLEAN: false };
function makeCollection(name, remote) {
  const first = (++ms) + ":0";
  const c = {
    id: "VariableCollectionId:" + (++vc), name, key: "colkey" + vc, remote: !!remote, hiddenFromPublishing: false, modes: [{ modeId: first, name: "Mode 1" }], defaultModeId: first,
    get variableIds() { return variables.filter((v) => v.variableCollectionId === c.id).map((v) => v.id); },
    addMode(n) { if (c.remote) throw new Error("remote"); if (c.modes.length >= 4) throw new Error("in addMode: Limited to 4 modes only"); const id = (++ms) + ":0"; c.modes.push({ modeId: id, name: n }); variables.filter((v) => v.variableCollectionId === c.id).forEach((v) => { v.valuesByMode[id] = v.valuesByMode[c.defaultModeId]; }); return id; },
    renameMode(id, n) { c.modes.find((m) => m.modeId === id).name = n; },
    removeMode(id) { c.modes = c.modes.filter((m) => m.modeId !== id); },
    remove() { collections.splice(collections.indexOf(c), 1); for (let i = variables.length - 1; i >= 0; i--) if (variables[i].variableCollectionId === c.id) variables.splice(i, 1); }
  };
  collections.push(c);
  return c;
}
function makeVariable(name, col, type, remote) {
  const v = {
    id: "VariableID:" + (++vs), name, key: "varkey" + vs, resolvedType: type, variableCollectionId: col.id, remote: !!remote, description: "", hiddenFromPublishing: false, scopes: ["ALL_SCOPES"], codeSyntax: {}, valuesByMode: {},
    setValueForMode(m, val) {
      if (v.remote) throw new Error("Cannot edit a remote variable");
      if (!col.modes.find((x) => x.modeId === m)) throw new Error("Invalid mode");
      if (val && val.type === "VARIABLE_ALIAS") { const t = variables.find((x) => x.id === val.id); if (!t) throw new Error("alias target missing"); if (t.resolvedType !== type) throw new Error("Mismatched alias type"); }
      else if (type === "COLOR" && !(val && typeof val === "object" && "r" in val)) throw new Error("Expected color");
      else if (type === "FLOAT" && typeof val !== "number") throw new Error("Expected number");
      else if (type === "STRING" && typeof val !== "string") throw new Error("Expected string");
      else if (type === "BOOLEAN" && typeof val !== "boolean") throw new Error("Expected boolean");
      v.valuesByMode[m] = val;
    },
    setVariableCodeSyntax(p, s) { v.codeSyntax[p] = s; },
    removeVariableCodeSyntax(p) { delete v.codeSyntax[p]; },
    remove() { variables.splice(variables.indexOf(v), 1); }
  };
  col.modes.forEach((m) => { v.valuesByMode[m.modeId] = DEFAULTS[type]; });
  variables.push(v);
  return v;
}
/* inferredVariables: hard-coded values that equal exactly the value of some variable */
const rgbKey = (c) => [c.r, c.g, c.b].map((v) => Math.round(v * 255)).join(",");
function inferVars(n) {
  const out = {};
  const valueOf = (v) => { const c = collections.find((x) => x.id === v.variableCollectionId); return c ? v.valuesByMode[c.defaultModeId] : undefined; };
  if (n.fills && n.fills !== MIXED && n.fills.length) {
    const arr = n.fills.map((p) => {
      if (p.type !== "SOLID" || (p.boundVariables && p.boundVariables.color)) return [];
      return variables.filter((v) => { const val = valueOf(v); return v.resolvedType === "COLOR" && val && val.r !== undefined && rgbKey(val) === rgbKey(p.color); }).map((v) => ({ type: "VARIABLE_ALIAS", id: v.id }));
    });
    if (arr.some((a) => a.length)) out.fills = arr;
  }
  for (const f of ["itemSpacing", "paddingLeft", "paddingTop", "paddingRight", "paddingBottom", "cornerRadius", "width", "height"]) {
    if (typeof n[f] === "number" && n[f] !== 0 && !(n.boundVariables && n.boundVariables[f])) {
      const m = variables.filter((v) => v.resolvedType === "FLOAT" && valueOf(v) === n[f]).map((v) => ({ type: "VARIABLE_ALIAS", id: v.id }));
      if (m.length) out[f] = m;
    }
  }
  return out;
}
/* components: instances know their main component, their properties, variants and swaps */
const parseVariant = (name) => { const o = {}; String(name).split(",").forEach((p) => { const kv = p.split("="); if (kv.length === 2) o[kv[0].trim()] = kv[1].trim(); }); return o; };
function attachCreateInstance(c) {
  c.createInstance = function () {
    const main = this, set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
    const inst = node("INSTANCE", { name: set ? set.name : main.name, width: main.width, height: main.height });
    inst._main = main;
    inst.getMainComponentAsync = async function () { return this._main; };
    const props = {};
    if (set) { const pv = parseVariant(main.name); Object.keys(pv).forEach((k) => { props[k] = { type: "VARIANT", value: pv[k] }; }); }
    Object.assign(props, JSON.parse(JSON.stringify(main._props || {})));
    inst.componentProperties = props;
    inst.setProperties = function (o) {
      for (const k of Object.keys(o)) { if (!this.componentProperties[k]) throw new Error("Could not find a component property with name: '" + k + "'"); this.componentProperties[k].value = o[k]; }
      const s = this._main.parent;
      if (s && s.type === "COMPONENT_SET") {
        const want = {}; Object.keys(this.componentProperties).forEach((k) => { if (this.componentProperties[k].type === "VARIANT") want[k] = this.componentProperties[k].value; });
        const m = s.children.find((ch) => Object.keys(want).every((k) => parseVariant(ch.name)[k] === want[k]));
        if (!m) throw new Error("No variant matches " + JSON.stringify(want));
        this._main = m;
      }
    };
    inst.swapComponent = function (comp) { if (comp.type !== "COMPONENT") throw new Error("swapComponent needs a component"); this._main = comp; };
    current.appendChild(inst);
    return inst;
  };
}
let imgSeq = 0;

/* a published library ("Savepet DS") with one variable collection and one component set */
const LIB = { cols: [{ key: "libcol1", name: "Brand", libraryName: "Savepet DS" }], vars: { libcol1: [{ name: "brand/primary", key: "libvar1", resolvedType: "COLOR", value: { r: 0.486, g: 0.227, b: 0.929, a: 1 } }, { name: "space/4", key: "libvar2", resolvedType: "FLOAT", value: 16 }] } };
let remoteBrand = null;
const imported = new Map();
async function importLibVar(key) {
  if (imported.has(key)) return imported.get(key);
  const lv = LIB.vars.libcol1.find((x) => x.key === key);
  if (!lv) throw new Error("No published variable with that key");
  if (!remoteBrand) { remoteBrand = makeCollection("Brand", true); remoteBrand.key = "libcol1"; }
  const v = makeVariable(lv.name, remoteBrand, lv.resolvedType, true);
  v.valuesByMode[remoteBrand.defaultModeId] = lv.value;
  imported.set(key, v);
  return v;
}

/* styles */
const styles = []; let st = 0;
function makeStyle(type, extra) {
  const s = Object.assign({ id: "S:" + (++st) + ",", key: "stylekey" + st, type, name: type + " style", description: "", remote: false, remove() { styles.splice(styles.indexOf(s), 1); } }, extra || {});
  if (type === "PAINT") s.paints = [];
  if (type === "TEXT") {
    let fn = { family: "Inter", style: "Regular" }, fsz = 12;
    s.boundVariables = {};
    Object.defineProperty(s, "fontName", { get() { return fn; }, set(v) { if (!fonts.has(v.family + v.style)) errors.push("style font not loaded"); fn = v; }, enumerable: true });
    Object.defineProperty(s, "fontSize", { get() { return fsz; }, set(v) { if (!fonts.has(fn.family + fn.style)) errors.push("style size before font load"); fsz = v; }, enumerable: true });
    Object.assign(s, { lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PERCENT", value: 0 }, paragraphSpacing: 0, paragraphIndent: 0, textCase: "ORIGINAL", textDecoration: "NONE" });
    s.setBoundVariable = function (f, v) { if (!v) delete s.boundVariables[f]; else s.boundVariables[f] = { type: "VARIABLE_ALIAS", id: v.id }; };
  }
  if (type === "EFFECT") s.effects = [];
  if (type === "GRID") s.layoutGrids = [];
  styles.push(s);
  return s;
}

/* shaders: an effect shader and a fill shader. Like Figma: applying one that isn't imported fails, properties are
   keyed by definition id, and reads come back with every property (defaults included) and propertyMetadata. */
const SHADERS = [
  { id: "shader-grain", name: "Film grain", type: "effect", imported: false, defs: { "p:amt": { name: "Amount", type: "NUMBER", defaultValue: 0.3 }, "p:tint": { name: "Tint", type: "COLOR", defaultValue: { r: 0, g: 0, b: 0, a: 1 } }, "p:mono": { name: "Monochrome", type: "BOOLEAN", defaultValue: true } } },
  { id: "shader-mesh", name: "Mesh gradient", type: "fill", imported: true, defs: { "p:colors": { name: "Colors", type: "GRADIENT" }, "p:center": { name: "Center", type: "POINT", defaultValue: { x: 0.5, y: 0.5 } }, "p:glow": { name: "Glow color", type: "COLOR" } } }
];
const shaderImports = [];
function shaderOut(s) { const o = { id: s.id, name: s.name, type: s.type, imported: s.imported }; if (s.imported) o.propertyDefinitions = s.defs; return o; }
function guardFx(n) {
  for (const key of ["fills", "strokes", "effects"]) {
    let val = n[key] || [];
    Object.defineProperty(n, key, {
      get() { return val; },
      set(v) {
        for (const x of v) {
          if (x.type !== "SHADER") continue;
          const s = SHADERS.find((q) => q.id === x.id);
          if (!s) { errors.push("unknown shader " + x.id); continue; }
          if (!s.imported) errors.push("Shader not imported. Call figma.importShaderById(id) first.");
          if ((s.type === "effect") !== (key === "effects")) errors.push(s.name + " applied to " + key);
          for (const k of Object.keys(x.properties || {})) if (!s.defs[k]) errors.push("unknown shader property " + k);
          if ("propertyMetadata" in x) errors.push("propertyMetadata written back");
          if (key === "effects" && typeof x.visible !== "boolean") errors.push("shader effect without visible");
        }
        val = v.map((x) => {
          if (x.type !== "SHADER") return x;
          const s = SHADERS.find((q) => q.id === x.id), props = {};
          if (s) for (const k of Object.keys(s.defs)) if (s.defs[k].defaultValue !== undefined) props[k] = s.defs[k].defaultValue;
          return Object.assign({}, x, { properties: Object.assign(props, x.properties || {}), propertyMetadata: s ? s.defs : {} });
        });
      },
      configurable: true, enumerable: true
    });
  }
}

/* document */
const doc = node("DOCUMENT", { name: "Take-home.fig" });
const page1 = node("PAGE", { name: "Page 1" }); doc.appendChild(page1);
page1.backgrounds = [{ type: "SOLID", color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1, visible: true }];
page1.selection = []; page1.selectedTextRange = null;
let current = page1;
let uiHandler = null; const toUI = [];
const listeners = {};
const viewport = { center: { x: 500, y: 400 }, zoom: 1, screen: { w: 1000, h: 800 } };
const figma = {
  editorType: "figma",
  mixed: MIXED,
  _removed: [], _exports: [], _commits: 0, _versions: [], _allPagesLoaded: false,
  get root() { return doc; },
  get currentPage() { return current; },
  showUI() { }, ui: { postMessage(m) { toUI.push(m); }, set onmessage(f) { uiHandler = f; } },
  on(ev, fn) { listeners[ev] = fn; },
  off(ev) { delete listeners[ev]; },
  commitUndo() { figma._commits++; },
  async saveVersionHistoryAsync(title) { figma._versions.push(title); return { id: "v" + figma._versions.length }; },
  async loadFontAsync(f) { fonts.add(f.family + f.style); },
  async loadAllPagesAsync() { figma._allPagesLoaded = true; },
  async getNodeByIdAsync(id) { return all.get(id) || null; },
  async setCurrentPageAsync(p) { current = p; if (listeners.currentpagechange) listeners.currentpagechange(); },
  createPage() { const p = node("PAGE"); p.selection = []; p.backgrounds = page1.backgrounds; doc.appendChild(p); return p; },
  createFrame() { const n = node("FRAME"); current.appendChild(n); return n; },
  createText() { const n = node("TEXT"); current.appendChild(n); return n; },
  createRectangle() { const n = node("RECTANGLE"); n.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }]; current.appendChild(n); return n; },
  createEllipse() { const n = node("ELLIPSE"); current.appendChild(n); return n; },
  createSection() { const n = node("SECTION"); current.appendChild(n); return n; },
  createLine() { const n = node("LINE"); current.appendChild(n); return n; },
  createNodeFromSvg() { const n = node("FRAME", { width: 24, height: 24 }); current.appendChild(n); return n; },
  base64Encode(b) { return Buffer.from(b).toString("base64"); },
  base64Decode(s) { return new Uint8Array(Buffer.from(s, "base64")); },
  createImage(bytes) {
    const png = bytes[0] === 0x89 && bytes[1] === 0x50, jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpg) throw new Error("Image type is unsupported");
    const hash = "imghash" + (++imgSeq);
    return { hash, async getSizeAsync() { return { width: 640, height: 480 }; } };
  },
  async listAvailableShaders() { return SHADERS.map(shaderOut); },
  async importShaderById(id) { const s = SHADERS.find((x) => x.id === id); if (!s) throw new Error("Shader not found"); s.imported = true; shaderImports.push(id); return shaderOut(s); },
  getSelectionColors() { return { paints: current.selection.flatMap((n) => (n.fills && n.fills !== MIXED ? n.fills : [])), styles: [] }; },
  viewport: {
    get center() { return viewport.center; }, set center(c) { viewport.center = c; },
    get zoom() { return viewport.zoom; }, set zoom(z) { viewport.zoom = z; },
    get bounds() { const w = viewport.screen.w / viewport.zoom, h = viewport.screen.h / viewport.zoom; return { x: viewport.center.x - w / 2, y: viewport.center.y - h / 2, width: w, height: h }; },
    scrollAndZoomIntoView(ns) { figma._zoomed = ns.map((n) => n.id); const b = ns[0].absoluteBoundingBox; viewport.center = { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }
  },
  variables: {
    async getLocalVariableCollectionsAsync() { return collections.filter((c) => !c.remote); },
    async getLocalVariablesAsync(t) { return variables.filter((v) => !v.remote && (!t || v.resolvedType === t)); },
    async getVariableByIdAsync(id) { return variables.find((v) => v.id === id) || null; },
    async getVariableCollectionByIdAsync(id) { return collections.find((c) => c.id === id) || null; },
    createVariableCollection(name) { return makeCollection(name); },
    createVariable(name, col, type) {
      if (typeof col === "string") errors.push("createVariable with a collection id (deprecated in dynamic-page)");
      if (variables.find((v) => v.variableCollectionId === col.id && v.name === name)) throw new Error("Duplicate variable name");
      return makeVariable(name, col, type);
    },
    createVariableAlias(v) { return { type: "VARIABLE_ALIAS", id: v.id }; },
    setBoundVariableForPaint(paint, field, v) { const p = JSON.parse(JSON.stringify(paint)); if (v) { p.boundVariables = { color: { type: "VARIABLE_ALIAS", id: v.id } }; if (v.resolvedType !== "COLOR") throw new Error("not a colour variable"); } else delete p.boundVariables; return p; },
    importVariableByKeyAsync: importLibVar
  },
  _teamLibraryAllowed: true,
  get teamLibrary() {
    if (!figma._teamLibraryAllowed) throw new Error('in get_teamLibrary: "teamlibrary" permission not specified in manifest.json.');
    return {
      async getAvailableLibraryVariableCollectionsAsync() { return LIB.cols.slice(); },
      async getVariablesInLibraryCollectionAsync(key) { return (LIB.vars[key] || []).map((v) => ({ name: v.name, key: v.key, resolvedType: v.resolvedType })); }
    };
  },
  async getStyleByIdAsync(id) { return styles.find((s) => s.id === id) || null; },
  async getLocalPaintStylesAsync() { return styles.filter((s) => s.type === "PAINT" && !s.remote); },
  async getLocalTextStylesAsync() { return styles.filter((s) => s.type === "TEXT" && !s.remote); },
  async getLocalEffectStylesAsync() { return styles.filter((s) => s.type === "EFFECT" && !s.remote); },
  async getLocalGridStylesAsync() { return styles.filter((s) => s.type === "GRID" && !s.remote); },
  createPaintStyle() { return makeStyle("PAINT"); },
  createTextStyle() { return makeStyle("TEXT"); },
  createEffectStyle() { return makeStyle("EFFECT"); },
  createGridStyle() { return makeStyle("GRID"); },
  async importStyleByKeyAsync(key) { if (key !== "libstyle1") throw new Error("not published"); return makeStyle("PAINT", { name: "Brand/Primary", remote: true }); },
  async importComponentByKeyAsync(key) { if (key !== libButtonL.key) throw new Error("not published"); return libButtonL; },
  async importComponentSetByKeyAsync(key) { if (key !== libButtonSet.key) throw new Error("not published"); return libButtonSet; }
};
/* library component set "Button" with two variants; it lives outside this document */
const libButtonSet = node("COMPONENT_SET", { name: "Button", key: "libset1", remote: true });
const libButtonM = node("COMPONENT", { name: "Size=M", key: "libcomp1", remote: true, width: 120, height: 40 });
const libButtonL = node("COMPONENT", { name: "Size=L", key: "libcomp2", remote: true, width: 160, height: 48 });
libButtonSet.appendChild(libButtonM); libButtonSet.appendChild(libButtonL);
libButtonSet.defaultVariant = libButtonM;
libButtonSet.componentPropertyDefinitions = { Size: { type: "VARIANT", defaultValue: "M", variantOptions: ["M", "L"] }, "Label#1:0": { type: "TEXT", defaultValue: "Play now" } };
for (const c of [libButtonM, libButtonL]) { c._props = { "Label#1:0": { type: "TEXT", value: "Play now" } }; attachCreateInstance(c); }

const code = fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
const intervals = [];
const sandbox = { figma, __html__: "<html>", console, Promise, Object, Array, Math, String, JSON, Uint8Array, Map, Set, Error, parseInt, parseFloat, isFinite, Number, RegExp, Symbol, Date: { now: () => clock.t }, setInterval: (fn) => { intervals.push(fn); return intervals.length; }, setTimeout };
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
let mid = 0;
async function cmd(command, params) {
  const id = ++mid; toUI.length = 0;
  await uiHandler({ type: "command", id, command, params });
  return toUI.find((m) => m.id === id);
}
function ok(r) { assert.ok(r && r.ok, r && r.error); return r.result; }
function emitSelection(nodes, textRange) { current.selection = nodes; current.selectedTextRange = textRange || null; listeners.selectionchange(); }
function emitNodeChange(changes) { current._ev.nodechange({ nodeChanges: changes }); }

(async () => {
  /* hello, ping, run_code, undo steps */
  await uiHandler({ type: "ui-ready" });
  assert.equal(toUI[0].type, "hello"); assert.equal(toUI[0].info.file, "Take-home.fig"); assert.equal(toUI[0].info.version, "1.3.0"); assert.ok(toUI[0].info.session);
  console.log("hello OK (version + session)");
  let r = ok(await cmd("ping"));
  assert.equal(r.page, "Page 1"); assert.equal(r.version, "1.3.0"); console.log("ping OK");

  const commits0 = figma._commits;
  r = ok(await cmd("run_code", { code: "const f = figma.createFrame(); f.name = 'Card'; f.resize(358, 200); f.fills = h.solid('#15121F'); log('made', f.name); return f;" }));
  assert.equal(r.value.name, "Card"); assert.deepEqual(r.logs, ["made Card"]);
  assert.equal(figma._commits, commits0 + 1, "each changing command is its own undo step");
  const cardId = r.value.id; console.log("run_code OK + commitUndo");
  r = ok(await cmd("run_code", { code: "globalThis.lib = { n: 41 }; return 1" }));
  r = ok(await cmd("run_code", { code: "return globalThis.lib.n + 1" }));
  assert.equal(r.value, 42); console.log("globalThis persists between calls OK");
  r = ok(await cmd("run_code", { code: "return {a:[1,2,{b:figma.currentPage}], c: undefined}" }));
  console.log("serialisation OK →", JSON.stringify(r.value));
  r = await cmd("run_code", { code: "this is not js" });
  assert.ok(!r.ok && /compile/.test(r.error));
  r = await cmd("run_code", { code: "throw new Error('nope')" });
  assert.ok(!r.ok && r.error === "nope"); console.log("compile/runtime errors OK");

  /* build (unchanged behaviour) */
  r = ok(await cmd("build", { spec: { type: "FRAME", name: "Screen", size: [390, 844], fill: "#0A0912", layout: { mode: "VERTICAL", gap: 12, padding: [16, 16], w: 390, h: 844 }, children: [
    { type: "TEXT", name: "Title", text: "Daily Lucky Bonus", font: { family: "Be Vietnam Pro", style: "Bold" }, fontSize: 20, color: "#F5F3FF", fillWidth: true },
    { type: "FRAME", name: "Card", fill: "#15121F@0.9", radius: 20, layout: { mode: "HORIZONTAL", gap: 8, padding: 16, w: "FILL" }, children: [{ type: "ELLIPSE", size: [24, 24], fill: "#F5B83D" }, { type: "SVG", svg: "<svg width='24' height='24'></svg>", size: [20, 20] }] }
  ] } }));
  assert.equal(r.created, 5);
  const screen = all.get(r.roots[0].id);
  screen.x = 600; screen.y = 0;
  assert.equal(screen.layoutMode, "VERTICAL"); assert.equal(screen.layoutSizingHorizontal, "FIXED");
  assert.equal(screen.children[1].layoutSizingHorizontal, "FILL"); assert.equal(screen.children[1].fills[0].opacity, 0.9);
  console.log("build OK → created", r.created, "nodes");

  /* variables: create, update, alias, copy to missing modes, errors */
  r = ok(await cmd("set_variables", { ops: [
    { op: "create_collection", collection: "Primitives" },
    { op: "set", collection: "Primitives", name: "color/violet/600", value: "#7C3AED" },
    { op: "set", collection: "Primitives", name: "color/gray/900", value: "#111111" },
    { op: "create_collection", collection: "Theme", modes: ["Light", "Dark"] },
    { op: "set", collection: "Theme", name: "bg/surface", values: { Light: "#FFFFFF", Dark: "{color/gray/900}" }, scopes: ["frame_fill", "SHAPE_FILL"], code_syntax: { WEB: "var(--bg-surface)" } },
    { op: "set", collection: "Theme", name: "text/accent", values: { Light: "{color/violet/600}" } },
    { op: "set", collection: "Theme", name: "space/md", type: "FLOAT", value: 16, description: "Default gap" },
    { op: "set", collection: "Theme", name: "flags/beta", value: true }
  ] }));
  assert.equal(r.applied, 8, JSON.stringify(r));
  assert.deepEqual(r.results[3].modes, ["Light", "Dark"]);
  assert.ok(r.results[5].changes.some((c) => /Dark = \{color\/violet\/600\} \[Primitives\] \(copied\)/.test(c)), JSON.stringify(r.results[5]));
  assert.equal(r.results[7].type, "BOOLEAN");
  const accent = variables.find((v) => v.name === "text/accent");
  assert.equal(accent.resolvedType, "COLOR");
  console.log("set_variables create OK →", r.results.map((x) => x.op + ":" + (x.variable || x.collection)).join(", "));

  r = ok(await cmd("set_variables", { ops: [{ op: "set", collection: "theme", name: "bg/surface", values: { light: "#FAFAFA" } }] }));
  assert.deepEqual(r.results[0].changes, ["Light: #FFFFFF → #FAFAFA"]); console.log("set_variables update shows before → after:", r.results[0].changes[0]);

  r = ok(await cmd("set_variables", { ops: [
    { op: "rename", collection: "Theme", name: "flags/beta", to: "flags/beta-enabled" },
    { op: "set", collection: "Theme", name: "space/md", values: { Sepia: 4 } },
    { op: "delete", collection: "Theme", name: "space/md" }
  ] }));
  assert.equal(r.applied, 1); assert.equal(r.stoppedAt, 1); assert.ok(/No mode "Sepia"/.test(r.results[1].error));
  assert.ok(variables.find((v) => v.name === "flags/beta-enabled") && variables.find((v) => v.name === "space/md"), "stops at the first error");
  console.log("set_variables stops at first error OK →", r.results[1].error);

  r = ok(await cmd("get_variables", {}));
  const theme = r.collections.find((c) => c.name === "Theme");
  const surf = theme.variables.find((v) => v.name === "bg/surface");
  assert.deepEqual(surf.values, { Light: "#FAFAFA", Dark: "{color/gray/900} [Primitives]" });
  assert.deepEqual(surf.scopes, ["FRAME_FILL", "SHAPE_FILL"]); assert.equal(surf.codeSyntax.WEB, "var(--bg-surface)");
  assert.equal(r.collections.find((c) => c.name === "Primitives").variables[0].value, "#7C3AED");
  console.log("get_variables OK →", JSON.stringify(surf));
  r = ok(await cmd("get_variables", { query: "space", type: "FLOAT", library: true }));
  assert.equal(r.collections.find((c) => c.name === "Theme").variables.length, 1);
  assert.equal(r.libraries[0].library, "Savepet DS"); assert.deepEqual(r.libraries[0].variables.map((v) => v.name), ["space/4"]);
  console.log("get_variables filters + library listing OK");
  figma._teamLibraryAllowed = false;
  r = ok(await cmd("get_variables", { library: true }));
  assert.ok(/teamlibrary/.test(r.libraries.error)); console.log("missing teamlibrary permission explained OK");
  figma._teamLibraryAllowed = true;

  /* bind variables to layers, including a library variable, and set modes */
  const title = screen.children[0], card = screen.children[1];
  r = ok(await cmd("bind_variables", {
    bindings: [
      { nodes: [screen.id], field: "fill", variable: "bg/surface" },
      { nodes: [card.id], field: "gap", variable: "space/4" },
      { nodes: [card.id, title.id], field: "padding", variable: "space/md" },
      { nodes: [title.id], field: "fontSize", variable: "{space/md}" },
      { nodes: [card.id], field: "radius", variable: { alias: "space/md", collection: "Theme" } },
      { nodes: [title.id], field: "fill", variable: "brand/primary" }
    ],
    modes: [{ nodes: [screen.id], collection: "Theme", mode: "Dark" }]
  }));
  assert.equal(screen.fills[0].boundVariables.color.id, variables.find((v) => v.name === "bg/surface").id);
  assert.equal(card.boundVariables.itemSpacing.id, imported.get("libvar2").id, "library variable imported by name");
  assert.equal(card.boundVariables.paddingLeft.id, variables.find((v) => v.name === "space/md").id);
  assert.equal(title.boundVariables.fontSize[0].id, variables.find((v) => v.name === "space/md").id);
  assert.equal(card.boundVariables.topLeftRadius.id, variables.find((v) => v.name === "space/md").id);
  assert.equal(title.fills[0].boundVariables.color.id, imported.get("libvar1").id);
  assert.equal(r.errors.length, 1); assert.ok(/has no paddingTop|has no padding/i.test(r.errors[0].error), JSON.stringify(r.errors));
  const themeCol = collections.find((c) => c.name === "Theme");
  assert.equal(screen.explicitVariableModes[themeCol.id], themeCol.modes.find((m) => m.name === "Dark").modeId);
  console.log("bind_variables OK →", r.done.length, "bound,", r.errors.length, "expected error:", r.errors[0].error);
  r = ok(await cmd("bind_variables", { bindings: [{ nodes: [card.id], field: "gap", variable: null }], modes: [{ nodes: [screen.id], collection: "Theme", mode: null }] }));
  assert.ok(!card.boundVariables.itemSpacing && !screen.explicitVariableModes[themeCol.id]); console.log("unbind + mode reset OK");
  r = ok(await cmd("bind_variables", { bindings: [{ nodes: [card.id], field: "gap", variable: "nope/missing" }] }));
  assert.ok(/No variable "nope\/missing"/.test(r.errors[0].error)); console.log("unknown variable →", r.errors[0].error);

  r = ok(await cmd("set_variables", { ops: [{ op: "set", collection: "Brand", name: "brand/primary", value: "#000000" }] }));
  assert.ok(/No local collection "Brand"/.test(r.results[0].error));
  r = ok(await cmd("set_variables", { ops: [{ op: "delete", name: "brand/primary" }] }));
  assert.ok(/No local variable/.test(r.results[0].error)); console.log("library variables are not editable here OK");

  /* selection details */
  screen.layoutMode = "VERTICAL"; card.layoutMode = "HORIZONTAL";
  await cmd("bind_variables", { bindings: [{ nodes: [card.id], field: "gap", variable: "space/4" }], modes: [{ nodes: [screen.id], collection: "Theme", mode: "Dark" }] });
  const inst = libButtonL.createInstance(); card.appendChild(inst);
  const ps = makeStyle("PAINT", { name: "Surface/Card" }); card.fillStyleId = ps.id;
  tick(5000);
  emitSelection([card, inst]);
  r = ok(await cmd("get_selection", {}));
  const dc = r.selection[0], di = r.selection[1];
  assert.equal(dc.path, "Screen"); assert.equal(dc.autoLayout.direction, "HORIZONTAL"); assert.equal(dc.sizing, "FILL × HUG");
  assert.equal(dc.variables.itemSpacing, "space/4 [Brand, library]"); assert.equal(dc.variables.paddingLeft, "space/md [Theme]");
  assert.equal(dc.styles.fill, "Surface/Card"); assert.equal(dc.fills[0], "#15121FE6");
  assert.equal(di.component.main, "Button"); assert.equal(di.component.variant, "Size=L"); assert.equal(di.component.source, "library"); assert.equal(di.component.setKey, "libset1");
  assert.equal(di.component.properties["Label#1:0"], "Play now");
  assert.ok(r.colors.includes("#15121FE6"));
  console.log("get_selection details OK →", JSON.stringify(dc).slice(0, 260) + "…");
  emitSelection([screen]);
  r = ok(await cmd("get_selection", { depth: 0 }));
  assert.deepEqual(r.selection[0].modes, { Theme: "Dark" }); assert.equal(r.selection[0].fills[0], "#0A0912 ← bg/surface [Theme]");
  emitSelection([title], { node: title, start: 6, end: 11 });
  r = ok(await cmd("get_selection", {}));
  assert.equal(r.textSelection.selected, "Lucky"); assert.equal(r.selection[0].text.font, "Be Vietnam Pro Bold");
  assert.equal(r.selection[0].variables.fontSize, "space/md [Theme]");
  console.log("text range + typography OK →", JSON.stringify(r.textSelection));

  /* activity log: user vs Claude vs collaborators */
  tick(10000);
  emitSelection([card]);
  emitNodeChange([{ type: "PROPERTY_CHANGE", id: title.id, origin: "LOCAL", node: title, properties: ["characters"] }]);
  tick(1000);
  emitNodeChange([{ type: "PROPERTY_CHANGE", id: title.id, origin: "LOCAL", node: title, properties: ["fontSize"] }]);
  emitNodeChange([{ type: "CREATE", id: "77:1", origin: "REMOTE", node: { id: "77:1", type: "RECTANGLE", name: "Sticker" } }]);
  const sentActivity = toUI.filter((m) => m.type === "activity");
  assert.ok(sentActivity.length >= 1, "user activity is reported to the bridge");
  await cmd("focus", { ids: [title.id] });
  emitSelection([title]);
  r = ok(await cmd("get_context", { activity: 10 }));
  const ev = r.activity.events;
  const userSel = ev.find((e) => e.what === "select" && e.by === "user" && e.layers[0].startsWith("Card"));
  const edit = ev.find((e) => e.what === "edit" && e.by === "user");
  assert.ok(userSel, JSON.stringify(ev)); assert.deepEqual(edit.props, ["characters", "fontSize"]); assert.equal(edit.times, 2);
  assert.ok(ev.find((e) => e.what === "create" && e.by === "collaborator"));
  assert.equal(ev[ev.length - 1].by, "claude", "selection made by the focus command is Claude's");
  assert.ok(r.activity.lastUserEdit.layers[0].startsWith("Title"));
  console.log("activity log OK →", ev.map((e) => e.by + ":" + e.what).join(", "));

  /* viewport: what is on screen, and the frame in focus */
  const other = figma.createFrame(); other.name = "Far away"; other.x = 5000; other.y = 5000;
  viewport.center = { x: 795, y: 422 }; viewport.zoom = 1;
  r = ok(await cmd("get_context", { activity: 0 }));
  assert.equal(r.viewport.focus.name, "Screen"); assert.equal(r.viewport.zoom, 1);
  const names = r.viewport.layers.map((l) => l.name);
  assert.ok(names.includes("Screen") && !names.includes("Far away"), names.join(","));
  const scr = r.viewport.layers.find((l) => l.name === "Screen");
  assert.ok(scr.children.find((c) => c.name === "Card"));
  assert.equal(r.selection.count, 1);
  console.log("get_context viewport OK →", JSON.stringify(r.viewport).slice(0, 240) + "…");
  viewport.center = { x: 3000, y: 3000 };
  r = ok(await cmd("get_context", { activity: 0 }));
  assert.ok(!r.viewport.focus && r.viewport.note, "empty canvas"); console.log("empty viewport OK →", r.viewport.note);

  /* viewport polling records the user's panning, not Claude's */
  intervals.forEach((f) => f());
  viewport.center = { x: 795, y: 422 };
  tick(3000);
  intervals.forEach((f) => f());
  r = ok(await cmd("get_context", { activity: 3 }));
  const vpEv = r.activity.events.find((e) => e.what === "viewport");
  assert.ok(vpEv && vpEv.by === "user" && /Screen/.test(vpEv.focus), JSON.stringify(r.activity.events));
  console.log("viewport activity OK →", JSON.stringify(vpEv));

  /* screenshots: one layer, several layers (area), the user's screen */
  emitSelection([screen]);
  r = ok(await cmd("screenshot", {}));
  assert.ok(r.base64.length > 0 && r.width === 390 && r.id === screen.id);
  r = ok(await cmd("screenshot", { node_id: screen.id, scale: 2 }));
  assert.equal(screen._lastExport.constraint.type, "HEIGHT"); console.log("screenshot layer + clamp OK");
  const commitsBefore = figma._commits;
  figma._exports.length = 0; figma._removed.length = 0;
  emitSelection([]);
  viewport.zoom = 0.5;
  r = ok(await cmd("screenshot", {}));
  let ex = figma._exports[0];
  assert.equal(ex.opts.contentsOnly, false); assert.equal(ex.indexInPage, 0, "capture rectangle sits under everything");
  assert.equal(ex.fills[0].color.r, 0.9, "uses the canvas colour");
  assert.ok(figma._removed.includes(ex.id), "temporary rectangle removed");
  assert.ok(!current.children.some((c) => c.getPluginData && c.getPluginData("claude-temp")));
  assert.equal(r.width, 1000); assert.equal(r.height, 800); assert.equal(r.region.width, 2000);
  assert.equal(figma._commits, commitsBefore, "a screenshot is not an undo step");
  emitNodeChange([{ type: "CREATE", id: ex.id, origin: "LOCAL", node: { id: ex.id, type: "RECTANGLE", removed: true } }]);
  r = ok(await cmd("get_context", { activity: 50 }));
  assert.ok(!r.activity.events.some((e) => (e.layers || []).some((l) => l.indexOf(ex.id) >= 0)), "capture rectangle is not reported as activity");
  console.log("screenshot of the screen OK →", JSON.stringify(ex.opts));
  emitSelection([title, card]);
  figma._exports.length = 0;
  r = ok(await cmd("screenshot", { max_size: 500 }));
  ex = figma._exports[0];
  assert.equal(ex.opts.contentsOnly, false); assert.ok(/2 selected layers/.test(r.name)); assert.ok(r.width <= 500 && r.height <= 500);
  console.log("screenshot of several selected layers OK →", r.name, r.width + "×" + r.height);

  /* styles */
  r = ok(await cmd("set_styles", { save_version: "Before styles", ops: [
    { op: "set", type: "PAINT", name: "Brand/Accent", color: "#7C3AED", description: "Main accent" },
    { op: "set", type: "paint", name: "Surface/Bg", variable: "bg/surface" },
    { op: "set", type: "TEXT", name: "Body/M", font: { family: "Be Vietnam Pro", style: "Medium" }, fontSize: 16, lineHeight: "150%", letterSpacing: "-1%", variables: { fontSize: "space/md" } },
    { op: "set", type: "EFFECT", name: "Shadow/Card", effects: [{ type: "DROP_SHADOW", color: "#00000033", y: 4, blur: 12 }, { type: "LAYER_BLUR", blur: 2 }] },
    { op: "rename", name: "Surface/Card", to: "Surface/Card-old" }
  ] }));
  assert.equal(r.applied, 5, JSON.stringify(r)); assert.deepEqual(figma._versions, ["Before styles"]);
  const tStyle = styles.find((s) => s.name === "Body/M");
  assert.equal(tStyle.fontSize, 16); assert.deepEqual(tStyle.lineHeight, { unit: "PERCENT", value: 150 }); assert.deepEqual(tStyle.letterSpacing, { unit: "PERCENT", value: -1 });
  assert.equal(styles.find((s) => s.name === "Surface/Bg").paints[0].boundVariables.color.id, variables.find((v) => v.name === "bg/surface").id);
  const eff = styles.find((s) => s.name === "Shadow/Card").effects;
  assert.deepEqual(eff[0].offset, { x: 0, y: 4 }); assert.equal(eff[0].radius, 12); assert.equal(eff[1].blurType, "NORMAL");
  console.log("set_styles OK →", r.results.map((x) => x.style).join(", "));
  r = ok(await cmd("set_styles", { ops: [{ op: "set", type: "PAINT", name: "Brand/Accent", color: "#6D28D9" }, { op: "delete", type: "PAINT", name: "Nope" }] }));
  assert.equal(r.applied, 1); assert.ok(/No local style/.test(r.results[1].error)); console.log("set_styles update + error OK");

  /* library overview + imports */
  const localSet = node("COMPONENT_SET", { name: "Chip", key: "localset1", description: "Filter chip" });
  const chipA = node("COMPONENT", { name: "State=Default" }); const chipB = node("COMPONENT", { name: "State=Active" });
  localSet.appendChild(chipA); localSet.appendChild(chipB);
  localSet.defaultVariant = chipA;
  attachCreateInstance(chipA); attachCreateInstance(chipB);
  localSet.componentPropertyDefinitions = { State: { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Active"] } };
  page1.appendChild(localSet);
  r = ok(await cmd("get_library", { used_remote: true }));
  assert.ok(r.styles.paint.find((s) => s.name === "Brand/Accent" && s.value === "#6D28D9"));
  assert.ok(r.styles.text.find((s) => s.name === "Body/M" && /Be Vietnam Pro Medium 16\/150%/.test(s.value)));
  assert.equal(r.components[0].name, "Chip"); assert.equal(r.components[0].variants, 2); assert.equal(r.components[0].properties.State, 'VARIANT: Default | Active (default "Default")');
  assert.equal(r.variableCollections.fromLibraries[0].library, "Savepet DS");
  assert.equal(r.libraryComponentsOnThisPage[0].name, "Button"); assert.equal(r.libraryComponentsOnThisPage[0].uses, 1);
  console.log("get_library OK →", JSON.stringify({ styles: Object.keys(r.styles), components: r.components.length, remote: r.libraryComponentsOnThisPage }));
  viewport.center = { x: 1000, y: 1000 }; viewport.zoom = 1;
  r = ok(await cmd("import_from_library", { kind: "component_set", key: "libset1", variant: "size=l" }));
  const placed = all.get(r.instance.id);
  assert.equal((await placed.getMainComponentAsync()).name, "Size=L"); assert.equal(placed.x, 920); assert.equal(placed.y, 976);
  r = ok(await cmd("import_from_library", { kind: "variable", key: "libvar1" }));
  assert.equal(r.collection, "Brand");
  r = await cmd("import_from_library", { kind: "style", key: "nope" });
  assert.ok(!r.ok); console.log("import_from_library OK");
  r = ok(await cmd("get_library", { kind: "shaders" }));
  assert.equal(r.shaders[0].name, "Film grain"); assert.ok(!r.shaders[0].properties, "not imported yet");
  assert.equal(r.shaders[1].properties.Colors, "gradient"); assert.equal(r.shaders[1].properties.Center, "point (default (0.5, 0.5))");
  assert.ok(/update_nodes/.test(r.shadersHow)); console.log("shaders listed OK");

  /* shaders: imported on first use, properties by name, effect vs fill, updated in place, removed */
  const grainBox = figma.createRectangle(); grainBox.name = "Grain box"; guardFx(grainBox);
  grainBox.effects = [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, visible: true, blendMode: "NORMAL" }];
  r = ok(await cmd("update_nodes", { items: [{ id: grainBox.id, shader: { name: "film grain", properties: { amount: 0.6, Tint: "#FF000080" } } }] }));
  assert.ok(/shader Film grain added to effects \(Amount, Tint\)/.test(r.done[0]), r.done[0]);
  assert.deepEqual(shaderImports, ["shader-grain"], "imported once, on first use");
  assert.equal(grainBox.effects.length, 2); assert.equal(grainBox.effects[0].type, "DROP_SHADOW", "existing effects kept");
  let fx = grainBox.effects[1];
  assert.equal(fx.properties["p:amt"], 0.6); assert.equal(fx.properties["p:tint"].r, 1); assert.ok(Math.abs(fx.properties["p:tint"].a - 128 / 255) < 1e-9);
  r = ok(await cmd("update_nodes", { items: [{ id: grainBox.id, shader: { name: "Film grain", properties: { "Monochrome": "off" } } }] }));
  assert.ok(/updated on effects \(Monochrome\)/.test(r.done[0]), r.done[0]);
  fx = grainBox.effects[1];
  assert.equal(grainBox.effects.length, 2, "applying it again updates, no duplicate");
  assert.equal(fx.properties["p:mono"], false); assert.equal(fx.properties["p:amt"], 0.6, "other properties kept");
  r = ok(await cmd("run_code", { code: "return await h.describe(await figma.getNodeByIdAsync('" + grainBox.id + "'))" }));
  assert.ok(r.value.effects[1].indexOf("shader Film grain (Amount 0.6, Tint #FF000080, Monochrome false)") === 0, r.value.effects[1]);
  // a fill shader goes on fills (on top) or strokes; gradients and points from short forms; a colour bound to a variable
  r = ok(await cmd("update_nodes", { items: [
    { id: grainBox.id, shader: { name: "Mesh", properties: { Colors: ["#000000", "#FFFFFF"], Center: [0.25, 0.75], "glow color": "{bg/surface}" } } },
    { id: grainBox.id, shader: { name: "Mesh gradient", target: "effect" } },
    { id: grainBox.id, shader: { name: "Film grain", target: "stroke" } },
    { id: grainBox.id, shader: { name: "Film grain", properties: { Speed: 2 } } },
    { id: grainBox.id, shader: "Plasma" }
  ] }));
  const mesh = grainBox.fills[grainBox.fills.length - 1];
  assert.equal(grainBox.fills.length, 2); assert.equal(grainBox.fills[0].type, "SOLID"); assert.equal(mesh.type, "SHADER");
  assert.deepEqual(mesh.properties["p:colors"].stops.map((s) => s.position), [0, 1]); assert.equal(mesh.properties["p:colors"].stops[1].color.g, 1);
  assert.deepEqual(mesh.properties["p:center"], { x: 0.25, y: 0.75 });
  assert.equal(mesh.properties["p:glow"].type, "VARIABLE_ALIAS"); assert.equal(mesh.properties["p:glow"].id, variables.find((v) => v.name === "bg/surface").id);
  assert.equal(r.errors.length, 4);
  assert.ok(/is a fill shader/.test(r.errors[0].error) && /is an effect shader/.test(r.errors[1].error), JSON.stringify(r.errors));
  assert.ok(/no property "Speed".*Amount \(number\)/.test(r.errors[2].error), r.errors[2].error);
  assert.ok(/No shader "Plasma".*Available: Film grain, Mesh gradient/.test(r.errors[3].error), r.errors[3].error);
  r = ok(await cmd("run_code", { code: "return await h.describe(await figma.getNodeByIdAsync('" + grainBox.id + "'))" }));
  assert.ok(/^shader Mesh gradient \(.*Glow color ← bg\/surface/.test(r.value.fills[1]), r.value.fills[1]);
  r = ok(await cmd("get_library", { kind: "shaders", query: "grain" }));
  assert.equal(r.shaders.length, 1); assert.equal(r.shaders[0].properties.Amount, "number (default 0.3)", "properties listed once imported");
  // remove one shader, then every shader; other paints and effects stay
  r = ok(await cmd("update_nodes", { items: [{ id: grainBox.id, shader: { name: "Mesh gradient", remove: true } }] }));
  assert.equal(grainBox.fills.length, 1); assert.ok(/removed shader Mesh gradient from fills/.test(r.done[0]));
  ok(await cmd("update_nodes", { items: [{ id: grainBox.id, shader: { name: "Mesh gradient", target: "stroke", opacity: 0.5 } }] }));
  assert.equal(grainBox.strokes[0].type, "SHADER"); assert.equal(grainBox.strokes[0].opacity, 0.5);
  r = ok(await cmd("update_nodes", { items: [{ id: grainBox.id, shader: null }] }));
  assert.ok(/removed 2 shaders/.test(r.done[0]), r.done[0]);
  assert.equal(grainBox.effects.length, 1); assert.equal(grainBox.effects[0].type, "DROP_SHADOW"); assert.equal(grainBox.strokes.length, 0); assert.equal(grainBox.fills.length, 1);
  // build and run_code
  r = ok(await cmd("build", { spec: { type: "RECTANGLE", name: "Noisy card", size: [200, 120], fill: "#222222", shader: { name: "Film grain", properties: { Amount: 0.2 } } } }));
  const noisy = all.get(r.roots[0].id);
  assert.equal(noisy.effects[0].type, "SHADER"); assert.equal(noisy.effects[0].properties["p:amt"], 0.2); assert.equal(noisy.effects[0].visible, true);
  r = ok(await cmd("run_code", { code: "const n = await figma.getNodeByIdAsync('" + noisy.id + "'); return await h.shader(n, null)" }));
  assert.equal(r.value, "removed 1 shader"); assert.equal(noisy.effects.length, 0);
  ok(await cmd("delete_nodes", { ids: [grainBox.id, noisy.id] }));
  console.log("shaders applied, updated and removed OK");

  /* batch edits: text, styles, variables, variants, properties, prototype links */
  r = ok(await cmd("update_nodes", { items: [
    { id: title.id, text: "Phần thưởng mỗi ngày", textStyle: "Body/M", color: "{text/accent}" },
    { id: card.id, name: "Promo card", fill: "{bg/surface}", radius: 16, layout: { gap: 12 } },
    { id: inst.id, variant: "size=m", properties: { label: "Chơi ngay" } },
    { id: card.id, link: { to: other.id, transition: "smart_animate", duration: 250 } },
    { id: "999:9", name: "nope" },
    { id: title.id, gap: 4, layout: { mode: "VERTICAL" } }
  ] }));
  assert.equal(title.characters, "Phần thưởng mỗi ngày"); assert.equal(title.textStyleId, styles.find((s) => s.name === "Body/M").id);
  assert.equal(title.fills[0].boundVariables.color.id, variables.find((v) => v.name === "text/accent").id);
  assert.equal(card.name, "Promo card"); assert.equal(card.fills[0].boundVariables.color.id, variables.find((v) => v.name === "bg/surface").id);
  assert.equal(card.cornerRadius, 16); assert.equal(card.itemSpacing, 12);
  assert.equal(inst._main.name, "Size=M"); assert.equal(inst.componentProperties["Label#1:0"].value, "Chơi ngay");
  const act = card.reactions[0].actions[0];
  assert.equal(act.destinationId, other.id); assert.equal(act.transition.type, "SMART_ANIMATE"); assert.equal(act.transition.duration, 0.25);
  assert.equal(r.errors.length, 2); assert.ok(/not found/i.test(r.errors[0].error)); assert.ok(/can't use auto layout/.test(r.errors[1].error));
  console.log("update_nodes OK →", r.done.length, "changed;", r.errors.map((e) => e.error).join(" | "));

  /* auto layout from the current positions (like "suggest auto layout") */
  const stack = figma.createFrame(); stack.name = "Stack"; stack.x = 0; stack.y = 3000; stack.resize(200, 200);
  const mk = (name, y, h) => { const n = figma.createRectangle(); n.name = name; n.x = 16; n.y = y; n.resize(100, h); return n; };
  const A = mk("A", 20, 30), B = mk("B", 60, 36), C = mk("C", 110, 20), D = mk("D", 142, 20);
  [C, A, D, B].forEach((n) => stack.appendChild(n));
  r = ok(await cmd("update_nodes", { items: [{ id: stack.id, layout: { mode: "AUTO" } }] }));
  assert.equal(stack.layoutMode, "VERTICAL"); assert.equal(stack.itemSpacing, 12);
  assert.deepEqual([stack.paddingTop, stack.paddingRight, stack.paddingBottom, stack.paddingLeft], [20, 84, 38, 16]);
  assert.deepEqual(stack.children.map((c) => c.name), ["A", "B", "C", "D"]); assert.equal(stack.width, 200);
  console.log("inferred auto layout OK →", r.done[0]);

  /* search */
  r = ok(await cmd("find_nodes", { text: "mỗi ngày" }));
  assert.equal(r.count, 1); assert.equal(r.nodes[0].id, title.id); assert.equal(r.nodes[0].textStyle, "Body/M");
  r = ok(await cmd("find_nodes", { name: "/^(card|promo)/i", type: "FRAME" }));
  assert.deepEqual(r.nodes.map((n) => n.name).sort(), ["Card", "Promo card"]);
  r = ok(await cmd("find_nodes", { component: "button" }));
  assert.equal(r.count, 2); assert.ok(/Button \/ Size=/.test(r.nodes[0].component));
  emitSelection([screen]);
  r = ok(await cmd("find_nodes", { scope: "selection", type: "TEXT" }));
  assert.equal(r.count, 1); assert.equal(r.scope, "selection (1 layers)");
  console.log("find_nodes OK");

  /* design check + safe fixes */
  fonts.add("InterRegular");
  const audit = figma.createFrame(); audit.name = "Audit me"; audit.x = 0; audit.y = 2000; audit.resize(300, 300);
  const faint = figma.createText(); faint.name = "Faint"; faint.characters = "Faint"; faint.fills = [{ type: "SOLID", color: { r: 0.6, g: 0.6, b: 0.6 }, opacity: 1 }]; faint.fontSize = 14; audit.appendChild(faint);
  const rect7 = figma.createRectangle(); rect7.name = "Rectangle 7"; rect7.x = 10.5; rect7.fills = [{ type: "SOLID", color: { r: 0x11 / 255, g: 0x11 / 255, b: 0x11 / 255 }, opacity: 1 }]; audit.appendChild(rect7);
  const row = figma.createFrame(); row.name = "Row"; row.layoutMode = "HORIZONTAL"; row.itemSpacing = 10; audit.appendChild(row);
  const ghost = figma.createRectangle(); ghost.name = "Old badge"; ghost.visible = false; audit.appendChild(ghost);
  r = ok(await cmd("audit_design", { node_id: audit.id }));
  const codes = r.issues.map((i) => i.check + ":" + i.layer);
  ["contrast:Faint", "names:Rectangle 7", "pixels:Rectangle 7", "bind:Rectangle 7", "spacing:Row", "hidden:Old badge", "text:Faint"].forEach((c) => assert.ok(codes.includes(c), c + " missing from " + codes.join(", ")));
  assert.equal(r.issues[0].severity, "error"); assert.ok(/2\.\d+:1/.test(r.issues[0].message)); assert.ok(/fix/.test(r.canFix));
  console.log("audit_design OK →", JSON.stringify(r.summary), "|", r.issues[0].message);
  r = ok(await cmd("audit_design", { node_id: audit.id, fix: ["bind", "round"], checks: ["bind", "pixels"] }));
  assert.equal(rect7.fills[0].boundVariables.color.id, variables.find((v) => v.name === "color/gray/900").id); assert.equal(rect7.x, 11);
  assert.ok(/2 issues fixed/.test(r.fixed), JSON.stringify(r));
  console.log("audit_design fixes OK →", r.fixed);

  /* images and SVGs */
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64");
  viewport.center = { x: 1000, y: 1000 };
  r = ok(await cmd("place_image", { base64: png, name: "Hero photo", width: 320 }));
  const hero = all.get(r.node.id);
  assert.equal(hero.width, 320); assert.equal(hero.height, 240); assert.equal(hero.x, 840); assert.equal(hero.fills[0].type, "IMAGE"); assert.equal(hero.fills[0].scaleMode, "FILL");
  r = ok(await cmd("place_image", { base64: png, node_id: card.id, scale_mode: "fit" }));
  assert.equal(card.fills[0].scaleMode, "FIT");
  r = ok(await cmd("place_image", { svg: "<svg/>", name: "Logo", x: 10, y: 20 }));
  assert.equal(all.get(r.node.id).x, 10);
  r = await cmd("place_image", { base64: Buffer.from("hello").toString("base64") });
  assert.ok(!r.ok && /unsupported/.test(r.error)); console.log("place_image OK");

  /* exports */
  r = ok(await cmd("export_nodes", { format: "svg" }));
  assert.equal(r.files[0].name, "Screen"); assert.equal(screen._lastExport.format, "SVG");
  r = ok(await cmd("export_nodes", { ids: [screen.id, title.id], format: "PNG", scale: 2 }));
  assert.equal(r.files.length, 2); assert.deepEqual(title._lastExport.constraint, { type: "SCALE", value: 2 }); console.log("export_nodes OK");

  /* generate with the design system: instances, variables, styles, modes, links */
  r = ok(await cmd("build", { spec: [
    { type: "FRAME", name: "Home 2", x: 0, y: 4000, size: [390, 844], fill: "{bg/surface}", layout: { mode: "VERTICAL", gap: "{space/md}", padding: 16, w: 390, h: 844 }, modes: { Theme: "Dark" }, children: [
      { component: "Chip", variant: "State=Active", name: "Filter" },
      { component: "key:libset1", variant: "Size=L", properties: { Label: "Go" }, link: "Details 2" },
      { type: "TEXT", name: "Hello", text: "Hi", textStyle: "Body/M", color: "{text/accent}" }
    ] },
    { type: "FRAME", name: "Details 2", x: 500, y: 4000, size: [390, 844] }
  ] }));
  const home = all.get(r.roots[0].id), details = all.get(r.roots[1].id);
  const [filter, libInst, hello] = home.children;
  assert.equal(home.fills[0].boundVariables.color.id, variables.find((v) => v.name === "bg/surface").id);
  assert.equal(home.boundVariables.itemSpacing.id, variables.find((v) => v.name === "space/md").id);
  assert.equal(home.explicitVariableModes[themeCol.id], themeCol.modes.find((m) => m.name === "Dark").modeId);
  assert.equal(filter._main.name, "State=Active"); assert.equal(filter.name, "Filter");
  assert.equal(libInst._main.name, "Size=L"); assert.equal(libInst.componentProperties["Label#1:0"].value, "Go");
  assert.equal(libInst.reactions[0].actions[0].destinationId, details.id);
  assert.equal(hello.textStyleId, styles.find((s) => s.name === "Body/M").id); assert.equal(hello.fills[0].boundVariables.color.id, variables.find((v) => v.name === "text/accent").id);
  console.log("build with the design system OK →", r.created, "layers");

  /* review fixes: sizes, alpha, case, Variable objects, rollback, overlap, careful rounding, contrast, deletes */
  r = ok(await cmd("build", { spec: [
    { type: "FRAME", name: "Sized", size: [390, 844], fill: "#00000080", layout: { mode: "vertical", gap: "auto", justify: "space_between" } },
    { type: "FRAME", name: "Hugging", layout: { mode: "HORIZONTAL" } }
  ] }));
  const sized = all.get(r.roots[0].id), hugging = all.get(r.roots[1].id);
  assert.equal(sized.width, 390); assert.equal(sized.layoutSizingVertical, "FIXED", "a size wins over hug");
  assert.equal(sized.layoutMode, "VERTICAL"); assert.equal(sized.primaryAxisAlignItems, "SPACE_BETWEEN");
  assert.ok(Math.abs(sized.fills[0].opacity - 0.502) < 0.01, "#RRGGBBAA keeps its alpha");
  assert.equal(hugging.layoutSizingHorizontal, "HUG");
  r = ok(await cmd("run_code", { code: "const v = await h.variable('space/md'); const n = await figma.getNodeByIdAsync('" + sized.id + "'); await h.bind(n, 'gap', v); return n.boundVariables.itemSpacing.id === v.id" }));
  assert.equal(r.value, true, "h.bind takes a local Variable object");
  const before = all.size;
  r = ok(await cmd("build", { spec: [{ type: "FRAME", name: "Kept" }, { type: "FRAME", name: "Broken", children: [{ type: "TEXT", text: "a" }, { component: "No such component" }] }] }));
  assert.equal(r.roots.length, 1); assert.equal(r.errors[0].item, 1); assert.ok(/No local component/.test(r.errors[0].error));
  assert.ok(![...all.values()].some((n) => n.name === "Broken"), "a failed item leaves nothing behind");
  assert.equal(all.size, before + 1);
  console.log("build fixes OK (size vs hug, alpha, case, rollback)");

  const card2 = figma.createFrame(); card2.name = "Card with bg"; card2.resize(200, 120);
  const bgShape = figma.createRectangle(); bgShape.name = "BG"; bgShape.resize(200, 120); card2.appendChild(bgShape);
  const lbl = figma.createText(); lbl.name = "Label"; lbl.characters = "Hi"; lbl.x = 20; lbl.y = 20; lbl.resize(60, 20); card2.appendChild(lbl);
  r = ok(await cmd("update_nodes", { items: [{ id: card2.id, layout: { mode: "AUTO" } }] }));
  assert.ok(/overlap/.test(r.errors[0].error) && card2.layoutMode === "NONE", "overlapping layers are not stacked");
  r = ok(await cmd("update_nodes", { items: [{ id: card2.id, layout: { mode: "AUTO", force: true } }] }));
  assert.equal(card2.layoutMode, "VERTICAL");
  console.log("auto layout overlap guard OK");

  // contrast looks at the shape behind the text, and gives up on images
  const darkCard = figma.createFrame(); darkCard.name = "Dark card"; darkCard.resize(200, 100); darkCard.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  const darkBg = figma.createRectangle(); darkBg.name = "Dark bg"; darkBg.resize(200, 100); darkBg.fills = [{ type: "SOLID", color: { r: 0.05, g: 0.05, b: 0.08 } }]; darkCard.appendChild(darkBg);
  const white = figma.createText(); white.name = "White text"; white.characters = "Bonus"; white.x = 10; white.y = 10; white.resize(80, 20); white.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; darkCard.appendChild(white);
  const photoCard = figma.createFrame(); photoCard.name = "Photo card"; photoCard.resize(200, 100);
  const photo = figma.createRectangle(); photo.name = "Photo"; photo.resize(200, 100); photo.fills = [{ type: "IMAGE", imageHash: "x", scaleMode: "FILL" }]; photoCard.appendChild(photo);
  const onPhoto = figma.createText(); onPhoto.name = "On photo"; onPhoto.characters = "Hey"; onPhoto.x = 10; onPhoto.y = 10; onPhoto.resize(40, 20); onPhoto.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]; photoCard.appendChild(onPhoto);
  r = ok(await cmd("audit_design", { node_id: darkCard.id, checks: ["contrast"] }));
  assert.equal(r.issues.length, 0, "white on the dark shape is fine: " + JSON.stringify(r.issues));
  r = ok(await cmd("audit_design", { node_id: photoCard.id, checks: ["contrast"] }));
  assert.equal(r.issues[0].severity, "info"); assert.ok(/by eye/.test(r.issues[0].message));
  // a see-through tint over a dark card is blended, not given up on
  const tintCard = figma.createFrame(); tintCard.name = "Tint card"; tintCard.resize(200, 100); tintCard.fills = [{ type: "SOLID", color: { r: 0.06, g: 0.07, b: 0.1 } }];
  const tint = figma.createRectangle(); tint.name = "Tint"; tint.resize(200, 100); tint.fills = [{ type: "SOLID", color: { r: 0.13, g: 0.77, b: 0.37 }, opacity: 0.08 }]; tintCard.appendChild(tint);
  const dim = figma.createText(); dim.name = "Dim label"; dim.characters = "saved"; dim.x = 10; dim.y = 10; dim.resize(40, 14); dim.fontSize = 11; dim.fills = [{ type: "SOLID", color: { r: 0.3, g: 0.33, b: 0.38 } }]; tintCard.appendChild(dim);
  const bright = figma.createText(); bright.name = "Bright label"; bright.characters = "Live"; bright.x = 10; bright.y = 40; bright.resize(40, 14); bright.fills = [{ type: "SOLID", color: { r: 0.9, g: 0.93, b: 0.97 } }]; tintCard.appendChild(bright);
  r = ok(await cmd("audit_design", { node_id: tintCard.id, checks: ["contrast"] }));
  assert.equal(r.issues.length, 1, JSON.stringify(r.issues)); assert.equal(r.issues[0].layer, "Dim label"); assert.equal(r.issues[0].severity, "error");
  console.log("contrast with background shapes and images OK");

  // rounding only touches the axes that are off, and keeps hugging
  const hugRow = figma.createFrame(); hugRow.name = "Hug row"; hugRow.layoutMode = "HORIZONTAL"; hugRow.x = 3.5; hugRow.width = 120.4; hugRow.height = 31.3;
  hugRow.layoutSizingHorizontal = "FIXED"; hugRow.layoutSizingVertical = "HUG";
  r = ok(await cmd("audit_design", { node_id: hugRow.id, checks: ["pixels"], fix: ["round"] }));
  assert.equal(hugRow.x, 4); assert.equal(hugRow.width, 120); assert.equal(hugRow.layoutSizingVertical, "HUG", "hug height kept");
  assert.ok(/x 3\.5/.test(r.issues[0].message) && !/height/.test(r.issues[0].message), r.issues[0].message);
  // a width that happens to match a spacing token is not bound automatically; styled fills are left alone
  const icon = figma.createFrame(); icon.name = "Icon box"; icon.resize(16, 16); icon.fills = [{ type: "SOLID", color: { r: 0x11 / 255, g: 0x11 / 255, b: 0x11 / 255 } }]; icon.fillStyleId = ps.id;
  r = ok(await cmd("audit_design", { node_id: icon.id, checks: ["bind"] }));
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
  r = ok(await cmd("delete_nodes", { ids: [icon.id, "404:1"] }));
  assert.deepEqual(r.deleted, [icon.id]); assert.equal(r.errors[0].error, "not found");
  console.log("audit rounding/binding care + delete errors OK");

  /* pages, focus, delete, unknown */
  r = ok(await cmd("set_page", { name: "02 Mobile", create: true }));
  assert.ok(figma.currentPage.name === "02 Mobile");
  assert.ok(toUI.find((m) => m.type === "info" && m.info.page === "02 Mobile"), "page changes are reported to the bridge");
  r = ok(await cmd("list_pages", {}));
  assert.equal(r.pages.length, 2);
  r = ok(await cmd("get_context", { activity: 2 }));
  assert.equal(r.page, "02 Mobile"); assert.ok(r.activity.events.find((e) => e.what === "page"));
  assert.ok(current._ev && current._ev.nodechange && !page1._ev.nodechange, "edits are watched on the current page only");
  r = ok(await cmd("focus", { ids: [screen.id] }));
  assert.ok(figma.currentPage === page1 && figma._zoomed[0] === screen.id); console.log("set_page/list_pages/focus OK");
  r = ok(await cmd("delete_nodes", { ids: [cardId, "999:1"] }));
  assert.deepEqual(r.deleted, [cardId]);
  r = await cmd("nope", {});
  assert.ok(!r.ok && /Unknown command/.test(r.error));
  assert.equal(sandbox.__claudeBridge.version, "1.3.0");
  assert.deepEqual(errors, []);
  console.log("ALL PLUGIN TESTS PASSED (API rule violations: " + errors.length + ")");
})().catch((e) => { console.error("FAILED", e); console.error("API rule violations:", errors); process.exit(1); });
