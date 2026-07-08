// SketchMode.js — in-viewport sketching, SolidWorks-style: pick a plane, draw
// with line/rect/circle/trim/dimension tools, then commit the result to code.
// The GUI is for creation; the emitted `new Sketch(...)` block is the artifact
// the user edits afterward. Mouse-derived points snap to round numbers; values
// typed into the dimension box are sacred and emitted exactly as given.
//
// Constraints: endpoints/centers are SHARED [x,y] arrays (coincidence is
// topology, not a constraint). A small set of relations — anchor, horizontal,
// vertical, parallel, perpendicular, equal, concentric, tangent — plus
// persistent dimensions are kept satisfied by a lightweight relaxation solver
// (sequential projection from current geometry). Anchored points never move;
// an over-constrained sketch simply fails to converge and the offending
// relation glyphs tint red. Emitted code still bakes the solved coordinates.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const PT_EPS = 1e-3; // endpoint coincidence tolerance (1 micron)

// Sketch planes are defined in OCC space by an origin and two orthonormal
// axis directions (xDir, yDir); the sketch's local (a, b) coordinates map to
// origin + a*xDir + b*yDir. Everything the viewport needs (toThree, fromThree,
// normal, camUp, grid) is derived from that frame, so an arbitrary face plane
// works exactly like a cardinal one. Three world coords follow the model
// group's OCC Z-up → Three Y-up convention (-PI/2 X rotation): (x,y,z)→(x,z,-y).
const OCC2THREE = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
const cross3 = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot3 = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const norm3 = (a) => { const L = Math.hypot(a[0],a[1],a[2]) || 1; return [a[0]/L, a[1]/L, a[2]/L]; };

/** Build a plane object from an OCC origin + two OCC axis directions. */
function makePlane(occOrigin, occX, occY, opts = {}) {
  const O = occOrigin, X = occX, Y = occY;
  const occNormal = cross3(X, Y);
  const origin3 = OCC2THREE(O);
  const x3 = OCC2THREE(X).normalize();
  const y3 = OCC2THREE(Y).normalize();
  const normal = new THREE.Vector3().crossVectors(x3, y3).normalize();
  return {
    key: opts.key || null,
    label: opts.label || 'On face',
    occOrigin: O, occX: X, occY: Y, occNormal,
    origin3, x3, y3, normal, camUp: y3.clone(),
    toThree(a, b) { return origin3.clone().addScaledVector(x3, a).addScaledVector(y3, b); },
    fromThree(p) { const d = p.clone().sub(origin3); return [d.dot(x3), d.dot(y3)]; },
  };
}

/** Bake a picked model face into a sketch plane: orthonormal frame with yDir
 *  pointing "up" (world Z projected onto the plane; world Y for horizontal
 *  faces). Kept identical on both sides so emitted xDir round-trips exactly. */
function makeFacePlane(origin, normal) {
  const N = norm3(normal);
  const up = Math.abs(N[2]) < 0.99 ? [0, 0, 1] : [0, 1, 0];
  let Y = norm3([up[0] - dot3(up, N) * N[0], up[1] - dot3(up, N) * N[1], up[2] - dot3(up, N) * N[2]]);
  const X = cross3(Y, N); // X × Y = N (right-handed)
  return makePlane(origin, X, Y, { label: 'On face' });
}

const CARDINAL = {
  XY: () => makePlane([0, 0, 0], [1, 0, 0], [0, 1, 0], { key: 'XY', label: 'Top (XY)' }),
  XZ: () => makePlane([0, 0, 0], [1, 0, 0], [0, 0, 1], { key: 'XZ', label: 'Front (XZ)' }),
  YZ: () => makePlane([0, 0, 0], [0, 1, 0], [0, 0, 1], { key: 'YZ', label: 'Right (YZ)' }),
};

const TOOLS = [
  { id: 'select', icon: '➤', label: 'Select', hint: 'Click selects (Shift adds) • drag moves • Del deletes • relation buttons below constrain the selection' },
  { id: 'line',   icon: '╱', label: 'Line',   hint: 'Click to chain lines • click the start point to close • Enter / right-click ends the chain' },
  { id: 'rect',   icon: '▭', label: 'Rect',   hint: 'Click two opposite corners' },
  { id: 'circle', icon: '◯', label: 'Circle', hint: 'Click the center, then a point on the circle' },
  { id: 'trim',   icon: '✂', label: 'Trim',   hint: 'Click the piece of an element to remove (cut at intersections)' },
  { id: 'dim',    icon: '↔', label: 'Dimension', hint: 'Click an element, then optionally a second — including dashed model edges • type a value, or a name to create a variable' },
];

// Relations the user can apply to the current selection. Keys work in the
// Select tool while something is selected (they don't collide with the tool
// shortcuts L/R/C/T/D).
const RELATIONS = [
  { id: 'anchor',     icon: '⚓', label: 'Anchor',     key: 'a', hint: 'Pin the selected point in place (or an element to pin its points). Click again to un-pin' },
  { id: 'horizontal', icon: '━', label: 'Horiz',      key: 'h', hint: 'Make the selected line(s) horizontal' },
  { id: 'vertical',   icon: '┃', label: 'Vert',       key: 'v', hint: 'Make the selected line(s) vertical' },
  { id: 'parallel',   icon: '∥', label: 'Parallel',   key: 'p', hint: 'Make two selected lines parallel' },
  { id: 'perp',       icon: '⊥', label: 'Perp',       key: 'x', hint: 'Make two selected lines perpendicular' },
  { id: 'equal',      icon: '＝', label: 'Equal',      key: 'e', hint: 'Equal length (two lines) or equal radius (two circles/arcs)' },
  { id: 'concentric', icon: '◎', label: 'Concentric', key: 'q', hint: 'Make two circles/arcs share a center' },
  { id: 'tangent',    icon: '⌒', label: 'Tangent',    key: 'g', hint: 'Line ↔ circle or circle ↔ circle tangency' },
];
const RELATION_KEYS = Object.fromEntries(RELATIONS.map(r => [r.key, r.id]));

const GLYPHS = {
  anchor: '⚓', horizontal: 'H', vertical: 'V', parallel: '∥',
  perp: '⊥', equal: '=', concentric: '◎', tangent: '⌒',
};

// Sketch palette — mutable so a Blender theme import can restyle it
// (colors are read at draw/creation time; applies from the next repaint on)
const SKETCH_PALETTE_DEFAULTS = {
  entity: 0xe8e8e8, accent: 0x4CAF50, remove: 0xff7043,
  glyphRel: '#9e9e9e', glyphDim: '#4CAF50', glyphSel: '#ffffff', glyphBad: '#ff5252',
};
let COLOR_ENTITY = SKETCH_PALETTE_DEFAULTS.entity;
let COLOR_ACCENT = SKETCH_PALETTE_DEFAULTS.accent;
let COLOR_REMOVE = SKETCH_PALETTE_DEFAULTS.remove;
let GLYPH_REL = SKETCH_PALETTE_DEFAULTS.glyphRel;   // relation glyphs — quiet gray
let GLYPH_DIM = SKETCH_PALETTE_DEFAULTS.glyphDim;   // dimension values — accent
let GLYPH_SEL = SKETCH_PALETTE_DEFAULTS.glyphSel;   // selected glyph
let GLYPH_BAD = SKETCH_PALETTE_DEFAULTS.glyphBad;   // unsatisfiable (over-constrained)

/** Restyle the sketch overlay from a theme ({entity, accent, glyphRel,
 *  glyphDim} as CSS hex strings) or back to defaults with null. */
export function applySketchTheme(sketch) {
  const hexToInt = (h) => parseInt(String(h).replace('#', ''), 16);
  COLOR_ENTITY = sketch && sketch.entity ? hexToInt(sketch.entity) : SKETCH_PALETTE_DEFAULTS.entity;
  COLOR_ACCENT = sketch && sketch.accent ? hexToInt(sketch.accent) : SKETCH_PALETTE_DEFAULTS.accent;
  GLYPH_REL = sketch && sketch.glyphRel ? sketch.glyphRel : SKETCH_PALETTE_DEFAULTS.glyphRel;
  GLYPH_DIM = sketch && sketch.glyphDim ? sketch.glyphDim : SKETCH_PALETTE_DEFAULTS.glyphDim;
}

// ---------- small 2D helpers ----------
const sub2 = (p, q) => [p[0] - q[0], p[1] - q[1]];
const add2 = (p, q) => [p[0] + q[0], p[1] + q[1]];
const scale2 = (p, s) => [p[0] * s, p[1] * s];
const dot2 = (p, q) => p[0] * q[0] + p[1] * q[1];
const cross2 = (p, q) => p[0] * q[1] - p[1] * q[0];
const len2 = (p) => Math.hypot(p[0], p[1]);
const dist2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const samePt = (p, q) => dist2(p, q) < PT_EPS;
const norm2pi = (a) => ((a % TAU) + TAU) % TAU;
const arcPt = (e, ang) => [e.c[0] + e.r * Math.cos(ang), e.c[1] + e.r * Math.sin(ang)];

/** Format a number for code emission: up to 4 decimals, no float noise. */
function fmt(n) {
  let v = parseFloat(n.toFixed(4));
  if (Object.is(v, -0)) { v = 0; }
  return String(v);
}

/** Intersection of segment a-b with segment c-d → t on a-b, or null. */
function segSegT(a, b, c, d) {
  const r = sub2(b, a), s = sub2(d, c);
  const den = cross2(r, s);
  if (Math.abs(den) < 1e-12) { return null; }
  const t = cross2(sub2(c, a), s) / den;
  const u = cross2(sub2(c, a), r) / den;
  if (u < -1e-9 || u > 1 + 1e-9) { return null; }
  return t;
}

/** Intersections of segment a-b (as infinite param t) with circle (c, r) → t values. */
function segCircleTs(a, b, c, r) {
  const d = sub2(b, a), f = sub2(a, c);
  const A = dot2(d, d);
  if (A < 1e-12) { return []; }
  const B = 2 * dot2(f, d);
  const C = dot2(f, f) - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) { return []; }
  const s = Math.sqrt(disc);
  return [(-B - s) / (2 * A), (-B + s) / (2 * A)];
}

/** Intersection angles on circle (c1, r1) with circle (c2, r2). */
function circleCircleAngles(c1, r1, c2, r2) {
  const d = dist2(c1, c2);
  if (d < 1e-9 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) { return []; }
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = Math.sqrt(Math.max(0, h2));
  const base = Math.atan2(c2[1] - c1[1], c2[0] - c1[0]);
  const off = Math.atan2(h, a);
  if (h < 1e-9) { return [norm2pi(base)]; }
  return [norm2pi(base - off), norm2pi(base + off)];
}

/** Is angle within the arc's ccw domain [a0, a1]? */
function angInArc(e, ang) {
  const sweep = e.a1 - e.a0;
  const d = norm2pi(ang - e.a0);
  return d <= sweep + 1e-9;
}

/** Wrap an undirected-line angle difference into (-π/2, π/2]. */
function wrapHalfPi(a) {
  a = ((a % Math.PI) + Math.PI) % Math.PI;
  return a > Math.PI / 2 ? a - Math.PI : a;
}

const lineAngle = (e) => Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);

class SketchMode {
  constructor(app) {
    this._app = app;
    this.active = false;
    this.plane = 'XY';
    this._planeDef = CARDINAL.XY();
    this.entities = [];
    this.points = [];      // [{id, p:[x,y]}] — shared endpoint/center arrays
    this.constraints = []; // [{id, type, ...}] — relations + persistent dimensions
    this.tool = 'line';
    this._nextId = 1;
    this._nextPtId = 1;
    this._undoStack = [];

    // In-progress tool state
    this._chainPrev = null;    // last placed point of the active line chain
    this._chainStart = null;   // first point of the active line chain
    this._rectStart = null;
    this._circleCenter = null;
    this._cursor = null;       // current snapped cursor position
    this._cursorSnapped = false;
    this._hoverTrim = null;    // {ent, ...piece} preview for the trim tool
    this._sel = [];            // [{kind:'ent'|'pt'|'con', id}]
    this._dragCand = null;     // pending/active drag in the select tool
    this._dim = null;          // {aId, bId|null, box, input, info}
    this._glyphHits = [];      // constraint glyph hitboxes in sketch coords
    this._texCache = new Map();
    this._warnedUnsat = false;

    this._raycaster = new THREE.Raycaster();
  }

  get _vp() { return this._app.viewport; }
  get _env() { return this._app.viewport ? this._app.viewport.environment : null; }
  get _def() { return this._planeDef; }

  // =====================================================================
  //  Session lifecycle
  // =====================================================================

  /** Start a sketch session on a plane object (cardinal or baked face). */
  begin(planeDef) {
    if (this.active || !this._vp || !this._featureRow) { return; }
    if (typeof planeDef === 'string') { planeDef = CARDINAL[planeDef](); }
    this._endPlanePick();
    this._endPick();
    this.active = true;
    this._planeDef = planeDef;
    this.plane = planeDef.key || 'custom';
    this.entities = [];
    this.points = [];
    this.constraints = [];
    this._undoStack = [];
    this._nextId = 1;
    this._nextPtId = 1;
    this._warnedUnsat = false;
    this._resetToolState();

    const env = this._env;
    this._savedRotate = env.controls.enableRotate;
    env.controls.enableRotate = false;
    this._vp.sketchActive = true;

    // Overlay groups: static (grid/origin), committed entities, live preview
    this._staticGroup = new THREE.Group();
    this._entityGroup = new THREE.Group();
    this._previewGroup = new THREE.Group();
    // Nudge drawing toward the camera so it never z-fights coplanar model faces
    const nudge = this._def.normal.clone().multiplyScalar(0.05);
    this._entityGroup.position.copy(nudge);
    this._previewGroup.position.copy(nudge);
    env.scene.add(this._staticGroup, this._entityGroup, this._previewGroup);
    this._buildStaticOverlay();
    this._buildRefEntities();

    // Canvas + keyboard listeners
    const canvas = env.renderer.domElement;
    // Re-render on zoom/pan so glyph sprites keep a constant pixel size
    const zoomFn = () => {
      if (this._zoomRaf) { return; }
      this._zoomRaf = requestAnimationFrame(() => {
        this._zoomRaf = 0;
        if (this.active) { this._renderEntities(); }
      });
    };
    this._listeners = [
      [canvas, 'mousedown', (e) => this._onMouseDown(e)],
      [canvas, 'mousemove', (e) => this._onMouseMove(e)],
      [canvas, 'mouseup', (e) => { if (e.button === 0) { this._finishDrag(); } }],
      [canvas, 'dblclick', (e) => { e.preventDefault(); this._endChain(); }],
      [canvas, 'contextmenu', (e) => this._onContextMenu(e)],
      [window, 'keydown', (e) => this._onKeyDown(e)],
      [env.controls, 'change', zoomFn],
    ];
    this._listeners.forEach(([el, ev, fn]) => el.addEventListener(ev, fn));
    canvas.style.cursor = 'crosshair';

    // Swap the command bar to sketch tools
    this._featureRow.style.display = 'none';
    this._sketchRow.style.display = 'flex';
    this._relRow.style.display = 'flex';
    this._hint.style.display = '';
    this._planeBadge.textContent = this._def.key
      ? this._def.key + ' · ' + this._def.label.split(' ')[0]
      : '⬗ ' + this._def.label;

    this.setTool('line');
    this._flattenCamera();
  }

  /** End the session. commit=true emits code into the editor. */
  end(commit) {
    if (!this.active) { return; }
    this._closeDimBox();

    if (commit && this.entities.length > 0) {
      const code = this._emitCode();
      this._app.editor.appendCode(code);
    }

    this.active = false;
    const env = this._env;
    if (env) {
      this._exitOrtho();
      env.controls.enableRotate = this._savedRotate;
      env.renderer.domElement.style.cursor = '';
      for (const g of [this._staticGroup, this._entityGroup, this._previewGroup]) {
        if (!g) continue;
        env.scene.remove(g);
        g.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
      }
      env.viewDirty = true;
    }
    this._staticGroup = this._entityGroup = this._previewGroup = null;
    if (this._vp) { this._vp.sketchActive = false; }

    if (this._listeners) {
      this._listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
      this._listeners = null;
    }

    // Swap the command bar back to feature buttons
    this._sketchRow.style.display = 'none';
    this._relRow.style.display = 'none';
    this._featureRow.style.display = 'flex';
    this._hint.style.display = 'none';

    for (const entry of this._texCache.values()) { entry.tex.dispose(); }
    this._texCache.clear();
  }

  _resetToolState() {
    this._chainPrev = null;
    this._chainStart = null;
    this._rectStart = null;
    this._circleCenter = null;
    this._hoverTrim = null;
    this._sel = [];
    this._dragCand = null;
    this._glyphHits = [];
    this._closeDimBox();
  }

  // =====================================================================
  //  Plane pick — choose the sketch plane by clicking in the 3D view:
  //  a translucent ghost quad for each origin plane, or any flat model face.
  //  Hover highlights the target; a click (not an orbit-drag) begins the
  //  sketch there. Orbit/pan stay live so you can look before you leap.
  // =====================================================================

  _startPlanePick(btn) {
    if (this.active) { return; }
    this._endPick();
    if (this._planePick) { this._endPlanePick(); return; } // toggle off
    const env = this._env;
    if (!env) { return; }

    const S = 120; // ghost half-extent (world units)
    const group = new THREE.Group();
    const ghosts = [];
    for (const key of ['XY', 'XZ', 'YZ']) {
      const pd = CARDINAL[key]();
      const c = [[-S, -S], [S, -S], [S, S], [-S, S]].map(([a, b]) => pd.toThree(a, b));
      const fillGeo = new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]);
      const fill = new THREE.Mesh(fillGeo, new THREE.MeshBasicMaterial({
        color: COLOR_ACCENT, transparent: true, opacity: 0.06,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...c, c[0]]),
        new THREE.LineBasicMaterial({ color: COLOR_ACCENT, transparent: true, opacity: 0.3 }));
      const g = new THREE.Group();
      g.add(fill, edge);
      g.userData = { key, pd, fill, edge };
      group.add(g);
      ghosts.push(g);
    }
    env.scene.add(group);
    this._planePick = { group, ghosts, faceHi: null, btn };
    if (btn) { btn.classList.add('active'); }

    const canvas = env.renderer.domElement;
    const move = (e) => this._onPlanePickMove(e);
    const key = (e) => { if (e.key === 'Escape') { this._endPlanePick(); } };
    this._planePick.listeners = [[canvas, 'mousemove', move], [window, 'keydown', key]];
    this._planePick.listeners.forEach(([el, ev, fn]) => el.addEventListener(ev, fn));
    canvas.style.cursor = 'crosshair';
    this._hint.textContent = 'Pick a plane: click a ghost plane or a flat model face to sketch on (Esc cancels)';
    this._hint.style.display = '';
    env.viewDirty = true;
  }

  _endPlanePick() {
    const pp = this._planePick;
    if (!pp) { return; }
    this._clearFaceHi(); // while this._planePick still points at pp
    this._planePick = null;
    const env = this._env;
    if (pp.listeners) { pp.listeners.forEach(([el, ev, fn]) => el.removeEventListener(ev, fn)); }
    if (env) {
      env.scene.remove(pp.group);
      pp.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      env.renderer.domElement.style.cursor = '';
      env.viewDirty = true;
    }
    if (pp.btn) { pp.btn.classList.remove('active'); }
    if (!this.active) { this._hint.style.display = 'none'; }
  }

  /** Ray from a mouse event to the nearest pick target: a ghost plane, or a
   *  flat model face (whichever the cursor is over and nearest to camera). */
  _planePickHit(e) {
    const env = this._env;
    const rect = env.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(ndc, env.camera);

    let ghostHit = null;
    for (const g of this._planePick.ghosts) {
      const hits = this._raycaster.intersectObject(g.userData.fill, false);
      if (hits.length && (!ghostHit || hits[0].distance < ghostHit.distance)) {
        ghostHit = { distance: hits[0].distance, g };
      }
    }
    const face = this._vp.pickFaceAt ? this._vp.pickFaceAt(e) : null;
    if (face && (!ghostHit || face.distance <= ghostHit.distance + 1e-4)) {
      return { type: 'face', plane: makeFacePlane(face.origin, face.normal), worldTris: face.worldTris };
    }
    if (ghostHit) { return { type: 'ghost', plane: ghostHit.g.userData.pd, g: ghostHit.g }; }
    return null;
  }

  _onPlanePickMove(e) {
    if (!this._planePick || e.buttons !== 0) { return; } // skip mid-orbit/pan
    this._lastClient = [e.clientX, e.clientY];
    const hit = this._planePickHit(e);
    for (const g of this._planePick.ghosts) {
      g.userData.fill.material.opacity = 0.06;
      g.userData.edge.material.opacity = 0.3;
    }
    this._clearFaceHi();
    let label = 'Pick a plane: click a ghost plane or a flat model face to sketch on (Esc cancels)';
    if (hit && hit.type === 'ghost') {
      hit.g.userData.fill.material.opacity = 0.2;
      hit.g.userData.edge.material.opacity = 0.95;
      label = hit.plane.label + ' plane — click to sketch here';
    } else if (hit && hit.type === 'face') {
      this._showFaceHi(hit.worldTris);
      label = 'On this face — click to sketch here';
    }
    this._hint.textContent = label;
    this._hint.style.display = ''; // a misclick flash may have hidden it
    this._env.viewDirty = true;
  }

  _showFaceHi(worldTris) {
    this._clearFaceHi();
    const geo = new THREE.BufferGeometry().setFromPoints(worldTris);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: COLOR_ACCENT, transparent: true, opacity: 0.28,
      side: THREE.DoubleSide, depthWrite: false, depthTest: false,
    }));
    mesh.renderOrder = 996;
    this._env.scene.add(mesh);
    if (this._planePick) { this._planePick.faceHi = mesh; }
  }

  _clearFaceHi() {
    const pp = this._planePick;
    if (!pp || !pp.faceHi) { return; }
    this._env.scene.remove(pp.faceHi);
    pp.faceHi.geometry.dispose();
    pp.faceHi.material.dispose();
    pp.faceHi = null;
  }

  // =====================================================================
  //  Command bar (top of the CAD viewport): feature buttons normally,
  //  sketch tools while a sketch session is active
  // =====================================================================

  /** (Re)build the command bar inside the current viewport panel. Called by
   *  the app whenever the viewport is (re)created. */
  attachToViewport() {
    if (!this._vp) { return; }
    if (this.active) { this.end(false); } // viewport is being replaced mid-sketch
    this._endPlanePick();
    this._endPick();
    if (this._bar && this._bar.parentNode) { this._bar.parentNode.removeChild(this._bar); }

    const bar = document.createElement('div');
    bar.className = 'cs-featbar';

    // --- Feature row ---
    const featureRow = document.createElement('div');
    featureRow.className = 'cs-featbar-row';
    const FEATURES = [
      { id: 'sketch',    icon: '✎', label: 'Sketch',    hint: 'Sketch on a plane, then commit it to code' },
      { sep: true },
      { id: 'extrude',   icon: '⇈', label: 'Extrude',   hint: 'Extrude the last sketch into a solid' },
      { id: 'revolve',   icon: '⟲', label: 'Revolve',   hint: 'Revolve the last sketch around an axis' },
      { id: 'loft',      icon: '⌒', label: 'Loft',      hint: 'Loft between the last two sketches' },
      { id: 'pipe',      icon: '∿', label: 'Pipe',      hint: 'Sweep the last sketch along a path' },
      { sep: true },
      { id: 'fillet',    icon: '◠', label: 'Fillet',    hint: 'Round the top edges of the last solid' },
      { id: 'chamfer',   icon: '◺', label: 'Chamfer',   hint: 'Chamfer the top edges of the last solid' },
      { sep: true },
      { id: 'union',     icon: '∪', label: 'Union',     hint: 'Fuse the last two solids' },
      { id: 'cut',       icon: '∖', label: 'Cut',       hint: 'Subtract the last solid from the one before it' },
      { id: 'intersect', icon: '∩', label: 'Intersect', hint: 'Keep the overlap of the last two solids' },
    ];
    for (const f of FEATURES) {
      if (f.sep) {
        const s = document.createElement('span');
        s.className = 'sketch-ribbon-sep';
        featureRow.appendChild(s);
        continue;
      }
      const b = document.createElement('button');
      b.className = 'sketch-tool-btn';
      b.type = 'button';
      b.textContent = f.icon + ' ' + f.label;
      b.title = f.hint;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this._runFeature(f.id, b);
        b.blur();
      });
      if (f.id === 'sketch') { this._sketchBtn = b; }
      featureRow.appendChild(b);
    }

    // --- Sketch row (hidden until a sketch session starts) ---
    const sketchRow = document.createElement('div');
    sketchRow.className = 'cs-featbar-row';
    sketchRow.style.display = 'none';

    this._planeBadge = document.createElement('span');
    this._planeBadge.className = 'sketch-ribbon-plane';
    sketchRow.appendChild(this._planeBadge);

    this._toolButtons = {};
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'sketch-tool-btn';
      b.type = 'button';
      b.textContent = t.icon + ' ' + t.label;
      b.title = t.hint;
      b.addEventListener('click', () => { this.setTool(t.id); b.blur(); });
      this._toolButtons[t.id] = b;
      sketchRow.appendChild(b);
    }

    const sep = document.createElement('span');
    sep.className = 'sketch-ribbon-sep';
    sketchRow.appendChild(sep);

    const save = document.createElement('button');
    save.className = 'sketch-tool-btn sketch-save-btn';
    save.type = 'button';
    save.textContent = '✓ Save';
    save.title = 'Commit this sketch to code';
    save.addEventListener('click', () => this.end(true));
    sketchRow.appendChild(save);

    const cancel = document.createElement('button');
    cancel.className = 'sketch-tool-btn';
    cancel.type = 'button';
    cancel.textContent = '✕ Cancel';
    cancel.title = 'Discard this sketch';
    cancel.addEventListener('click', () => this.end(false));
    sketchRow.appendChild(cancel);

    // --- Relations row (visible while sketching) ---
    const relRow = document.createElement('div');
    relRow.className = 'cs-featbar-row';
    relRow.style.display = 'none';
    const relLabel = document.createElement('span');
    relLabel.className = 'sketch-ribbon-plane';
    relLabel.textContent = 'Relations';
    relRow.appendChild(relLabel);
    for (const rdef of RELATIONS) {
      const b = document.createElement('button');
      b.className = 'sketch-tool-btn';
      b.type = 'button';
      b.textContent = rdef.icon + ' ' + rdef.label;
      b.title = rdef.hint + ' (' + rdef.key.toUpperCase() + ')';
      b.addEventListener('click', () => {
        if (this.tool !== 'select') {
          this.setTool('select');
          this._flashHintSketch('Select element(s), then click ' + rdef.label);
        } else {
          this._applyRelation(rdef.id);
        }
        b.blur();
      });
      relRow.appendChild(b);
    }

    // --- Hint line ---
    this._hint = document.createElement('div');
    this._hint.className = 'cs-featbar-hint';
    this._hint.style.display = 'none';

    bar.appendChild(featureRow);
    bar.appendChild(sketchRow);
    bar.appendChild(relRow);
    bar.appendChild(this._hint);
    this._featureRow = featureRow;
    this._sketchRow = sketchRow;
    this._relRow = relRow;
    this._bar = bar;
    this._vp.goldenContainer.element.appendChild(bar);
  }

  /** Briefly show a message in the bar's hint line (feature-mode feedback). */
  _flashHint(msg) {
    this._hint.textContent = msg;
    this._hint.style.display = '';
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      if (!this.active) { this._hint.style.display = 'none'; }
    }, 3000);
  }

  /** Flash a message while sketching, then restore the current tool's hint. */
  _flashHintSketch(msg) {
    this._hint.textContent = msg;
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      if (!this.active) { return; }
      const t = TOOLS.find(t => t.id === this.tool);
      this._setHint(t ? t.hint : '');
    }, 2500);
  }

  /** Float a message up from a point on screen, fading out as it rises.
   *  kind: 'bad' (refusal, red) or 'info' (guidance, accent). clientPos
   *  defaults to the last mouse position over the canvas. */
  _floatMsg(text, kind, clientPos) {
    const panel = this._vp && this._vp.goldenContainer.element;
    if (!panel) { return; }
    const pRect = panel.getBoundingClientRect();
    const pos = clientPos || this._lastClient ||
      [pRect.left + pRect.width / 2, pRect.top + pRect.height / 2];

    const el = document.createElement('div');
    el.className = 'cs-float-msg ' + (kind || 'bad');
    el.textContent = text;
    // Stagger rapid-fire messages so they don't stack on one spot
    const now = performance.now();
    this._floatStack = (now - (this._lastFloatT || 0) < 500) ? (this._floatStack || 0) + 1 : 0;
    this._lastFloatT = now;
    el.style.left = Math.max(8, Math.min(pRect.width - 8, pos[0] - pRect.left)) + 'px';
    // Never spawn over the command bar (e.g. relation-button clicks) — start
    // below it and drift up toward it instead
    const barBottom = this._bar ? this._bar.offsetHeight : 0;
    const raw = pos[1] - pRect.top - 16 - this._floatStack * 22;
    // Under the bar, staggered messages step down instead of up
    el.style.top = (raw >= barBottom + 34 ? raw : barBottom + 34 + this._floatStack * 22) + 'px';
    panel.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

  /** Screen position of a constraint's geometry (for anchoring a float). */
  _conClient(c) {
    const env = this._env;
    if (!env) { return null; }
    let pt = null;
    if (c.type === 'anchor') { pt = this._ptById(c.ptId); }
    else {
      const ent = c.entId !== undefined ? this._ent(c.entId)
        : (c.aId !== undefined ? this._ent(c.aId) : null);
      if (ent) { pt = this._entGlyphPos(ent).base; }
    }
    if (!pt) { return null; }
    const v = this._def.toThree(pt[0], pt[1]).project(env.camera);
    const rect = env.renderer.domElement.getBoundingClientRect();
    return [
      rect.left + (v.x + 1) / 2 * rect.width,
      rect.top + (1 - (v.y + 1) / 2) * rect.height,
    ];
  }

  // =====================================================================
  //  Feature buttons — emit code templates targeting the latest sketch /
  //  solids, with the key value pre-selected for immediate editing
  // =====================================================================

  /** Sketch variables declared at the top level, in order: [{name, plane}].
   *  Line-start anchored so block-scoped declarations don't leak in. */
  _findSketches(code) {
    const seen = new Map(); // name → plane, insertion order = recency
    const re = /^let\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Sketch\s*\(\s*\[[^\]]*\]\s*(?:,\s*(?:['"](XY|XZ|YZ)['"]|(\{)))?/gm;
    for (const m of code.matchAll(re)) {
      seen.delete(m[1]);
      seen.set(m[1], m[2] || (m[3] ? 'custom' : 'XY'));
    }
    return [...seen.entries()].map(([name, plane]) => ({ name, plane }));
  }

  /** Solid/shape variables assigned at the top level, ordered by their most
   *  recent assignment (reassignment like `x = FilletEdges(x, ...)` counts). */
  _findSolids(code) {
    const makers = 'Extrude|Revolve|RotatedExtrude|Loft|Pipe|Union|Difference|Intersection|' +
                   'Box|Cylinder|Sphere|Cone|Polygon|Text3D|Translate|Rotate|Mirror|Scale|Offset';
    const re = new RegExp('^(?:let\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*(?:' + makers + ')\\s*\\(', 'gm');
    const seen = new Map();
    for (const m of code.matchAll(re)) {
      seen.delete(m[1]);
      seen.set(m[1], true);
    }
    return [...seen.keys()];
  }

  _nextVarName(code, base) {
    let max = 0;
    for (const m of code.matchAll(new RegExp('\\b' + base + '(\\d+)\\b', 'g'))) {
      max = Math.max(max, parseInt(m[1], 10));
    }
    return base + (max + 1);
  }

  /** Extrude argument for a sketch on this plane. Baked face planes use a
   *  scalar (extrudes along the face normal); cardinal planes use a vector
   *  toward the side the sketch was drawn from. */
  _extrudeDirFor(plane) {
    if (plane === 'custom') { return '20'; }
    return { XY: '[0, 0, 20]', XZ: '[0, -20, 0]', YZ: '[20, 0, 0]' }[plane] || '[0, 0, 20]';
  }

  _runFeature(id, btn) {
    if (id === 'sketch') {
      if (!this.active) { this._startPlanePick(btn); }
      return;
    }

    // Targeted features pick their operands by clicking shapes in the viewport
    const PICKS = {
      fillet:    ['Fillet: click the solid to fillet (Esc cancels)'],
      chamfer:   ['Chamfer: click the solid to chamfer (Esc cancels)'],
      union:     ['Union: click the first body', 'Union: click the body or sketch to fuse into it'],
      cut:       ['Cut: click the body to keep', 'Cut: click the body or sketch to subtract'],
      intersect: ['Intersect: click the first body', 'Intersect: click the second body or sketch'],
    };
    if (PICKS[id]) {
      if (this._pick && this._pick.feature === id) { this._endPick(); return; } // toggle off
      this._startPick(id, btn, PICKS[id]);
      return;
    }

    const code = this._app.editor.getCode();
    const sketches = this._findSketches(code);
    const lastSk = sketches[sketches.length - 1];
    const nv = (base) => this._nextVarName(code, base);
    let snippet = null, select = null;

    switch (id) {
      case 'extrude': {
        if (!lastSk) { return this._flashHint('Extrude needs a sketch — draw one first'); }
        snippet = `let ${nv('solid')} = Extrude(${lastSk.name}, ${this._extrudeDirFor(lastSk.plane)});`;
        select = '20(?=[,)\\]])';
        break;
      }
      case 'revolve': {
        if (!lastSk) { return this._flashHint('Revolve needs a sketch — draw one first'); }
        if (lastSk.plane === 'XY') {
          snippet = `// XY profiles revolve around X (revolving around Z would give a flat disk)\n` +
                    `let ${nv('solid')} = Revolve(${lastSk.name}, 360, [1, 0, 0]);`;
        } else {
          snippet = `let ${nv('solid')} = Revolve(${lastSk.name}, 360, [0, 0, 1]);`;
        }
        select = '360';
        break;
      }
      case 'loft': {
        if (sketches.length < 2) { return this._flashHint('Loft needs two sketches (profiles at different positions)'); }
        const a = sketches[sketches.length - 2];
        snippet = `let ${nv('solid')} = Loft([GetWire(${a.name}), GetWire(${lastSk.name})]);`;
        break;
      }
      case 'pipe': {
        if (!lastSk) { return this._flashHint('Pipe needs a sketch profile — draw one first'); }
        const paths = {
          XY: '[[0, 0, 0], [0, 0, 30], [20, 0, 60]]',
          XZ: '[[0, 0, 0], [0, -30, 0], [20, -60, 0]]',
          YZ: '[[0, 0, 0], [30, 0, 0], [60, 0, 20]]',
        };
        const pathVar = nv('path');
        snippet = `let ${pathVar} = BSpline(${paths[lastSk.plane] || paths.XY}, false);\n` +
                  `let ${nv('solid')} = Pipe(${lastSk.name}, ${pathVar});`;
        break;
      }
    }

    if (snippet) { this._app.editor.appendCode(snippet, select); }
  }

  // =====================================================================
  //  Pick mode — click shapes in the viewport to choose feature operands.
  //  Clicked shapes resolve to code variables via history provenance.
  // =====================================================================

  _startPick(feature, btn, prompts) {
    this._endPick();
    if (this.active) { return; } // not while sketching
    this._pick = { feature, btn, prompts, picked: [] };
    btn.classList.add('active');
    this._hint.textContent = prompts[0];
    this._hint.style.display = '';
    this._pickKeyFn = (e) => {
      if (e.key === 'Escape') { this._endPick(); }
    };
    window.addEventListener('keydown', this._pickKeyFn);
  }

  _endPick() {
    if (!this._pick) { return; }
    this._pick.btn.classList.remove('active');
    this._pick = null;
    if (this._pickKeyFn) {
      window.removeEventListener('keydown', this._pickKeyFn);
      this._pickKeyFn = null;
    }
    if (!this.active) { this._hint.style.display = 'none'; }
    if (this._vp) { this._vp.highlightShapesAtLine(-1); } // clear pick glow
  }

  /** Called by the viewport on non-drag clicks. Returns true if consumed. */
  handleViewportClick(e) {
    if (this._planePick) {
      const hit = this._planePickHit(e);
      if (hit) {
        const pd = hit.plane;
        this._endPlanePick();
        this.begin(pd);
      } else {
        this._flashHint('No plane there — click a ghost plane or a flat model face (Esc cancels)');
        this._hint.style.display = '';
      }
      return true;
    }
    if (!this._pick) { return false; }
    const pick = this._pick;

    const info = this._vp.shapeInfoAtMouse(e);
    if (!info || info.definingLine < 1) {
      this._flashHint('No shape there — click a body in the viewport (Esc cancels)');
      this._hint.style.display = '';
      return true;
    }

    // Resolve the clicked shape to the variable assigned on its defining line
    const model = this._app.editor.editor.getModel();
    const lineText = (info.definingLine <= model.getLineCount())
      ? model.getLineContent(info.definingLine) : '';
    const m = lineText.match(/^\s*(?:let|const|var)?\s*([A-Za-z_$][\w$]*)\s*=/);
    if (!m) {
      this._flashHint(`That shape isn't assigned to a variable (line ${info.definingLine}) — give it a name first`);
      this._hint.style.display = '';
      return true;
    }
    const name = m[1];
    if (pick.picked.includes(name)) {
      this._flashHint(`Already picked ${name} — click a different shape`);
      this._hint.style.display = '';
      return true;
    }

    pick.picked.push(name);
    this._vp.highlightShapesAtLine(info.definingLine); // glow acknowledgment

    if (pick.picked.length < pick.prompts.length) {
      this._hint.textContent = pick.prompts[pick.picked.length] + ` (picked: ${name})`;
      return true;
    }

    const feature = pick.feature, picked = pick.picked;
    this._endPick();
    this._emitPicked(feature, picked);
    return true;
  }

  /** Emit the code for a completed pick. Sketch operands are auto-wrapped in
   *  a plane-aware Extrude so "sketch cuts solid" just works. */
  _emitPicked(feature, picked) {
    const code = this._app.editor.getCode();
    const sketches = this._findSketches(code);
    const nv = (base) => this._nextVarName(code, base);
    const sketchOf = (n) => sketches.find(s => s.name === n);
    // Face-plane sketches extrude as a SPAN [start, end] along the face
    // normal, overshooting the surface by 0.5 — baked-plane literals are
    // never exactly on the face, and a tool that starts right at the surface
    // leaves a near-coplanar sliver (z-fighting). Cuts start 0.5 proud and
    // cut in (`into`); bosses bury their root 0.5 and rise out.
    const wrap = (n, into) => {
      const sk = sketchOf(n);
      if (!sk) { return n; }
      if (sk.plane === 'custom') { return `Extrude(${n}, [${into ? '0.5, -20' : '-0.5, 20'}])`; }
      return `Extrude(${n}, ${this._extrudeDirFor(sk.plane)})`;
    };
    const anyWrapped = picked.some(n => sketchOf(n));
    let snippet = null, select = anyWrapped ? '-?20(?=[,)\\]])' : null;

    switch (feature) {
      case 'fillet':
      case 'chamfer': {
        const t = picked[0];
        if (sketchOf(t)) { return this._flashHint('That is a sketch — fillet/chamfer need a solid'); }
        if (feature === 'fillet') {
          snippet = `${t} = FilletEdges(${t}, 2, Edges(${t}).max([0, 0, 1]).indices());`;
          select = '(?<=, )2(?=,)';
        } else {
          snippet = `${t} = ChamferEdges(${t}, 1, Edges(${t}).max([0, 0, 1]).indices());`;
          select = '(?<=, )1(?=,)';
        }
        break;
      }
      case 'union':
        snippet = `let ${nv('solid')} = Union([${wrap(picked[0])}, ${wrap(picked[1])}]);`;
        break;
      case 'cut':
        snippet = `let ${nv('solid')} = Difference(${wrap(picked[0])}, [${wrap(picked[1], true)}]);`;
        break;
      case 'intersect':
        snippet = `let ${nv('solid')} = Intersection([${wrap(picked[0])}, ${wrap(picked[1])}]);`;
        break;
    }

    if (snippet) { this._app.editor.appendCode(snippet, select); }
  }

  setTool(id) {
    this._endChain();
    this._rectStart = null;
    this._circleCenter = null;
    this._hoverTrim = null;
    this._sel = [];
    this._dragCand = null;
    this._closeDimBox();
    this.tool = id;
    for (const [tid, b] of Object.entries(this._toolButtons)) {
      b.classList.toggle('active', tid === id);
    }
    const t = TOOLS.find(t => t.id === id);
    this._setHint(t ? t.hint : '');
    this._renderPreview();
    this._renderEntities();
  }

  _setHint(text) { this._hint.textContent = text; }

  // =====================================================================
  //  Camera
  // =====================================================================

  /** Animate the camera to look square-on at the sketch plane. */
  _flattenCamera() {
    const env = this._env;
    let dist = 160;
    if (this._vp.mainObject) {
      const box = new THREE.Box3().setFromObject(this._vp.mainObject);
      if (!box.isEmpty()) {
        dist = Math.max(120, box.min.distanceTo(box.max) * 1.2);
      }
    }
    const target = this._def.origin3.clone();
    const pos = target.clone().addScaledVector(this._def.normal, dist);
    const up = this._def.camUp.clone();

    const cam = env.camera, ctl = env.controls;
    const p0 = cam.position.clone(), u0 = cam.up.clone(), t0 = ctl.target.clone();
    const dur = 350, start = performance.now();
    const step = (now) => {
      let k = Math.min(1, (now - start) / dur);
      k = k * k * (3 - 2 * k); // smoothstep
      cam.position.lerpVectors(p0, pos, k);
      cam.up.lerpVectors(u0, up, k).normalize();
      ctl.target.lerpVectors(t0, target, k);
      cam.lookAt(ctl.target);
      env.viewDirty = true;
      if (k < 1 && this.active) { requestAnimationFrame(step); }
      else {
        ctl.update();
        // Square-on is where perspective→ortho is least jarring
        if (this.active) { this._enterOrtho(dist); }
        env.viewDirty = true;
      }
    };
    requestAnimationFrame(step);
  }

  /** Swap the viewport to an orthographic camera matching the current framing. */
  _enterOrtho(dist) {
    const env = this._env;
    if (env.camera.isOrthographicCamera) { return; }
    const persp = env.camera;
    const canvas = env.renderer.domElement;
    const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
    const halfH = dist * Math.tan(persp.fov * Math.PI / 360);
    const ortho = new THREE.OrthographicCamera(
      -halfH * aspect, halfH * aspect, halfH, -halfH, -5000, 5000
    );
    ortho.position.copy(persp.position);
    ortho.up.copy(persp.up);
    ortho.lookAt(env.controls.target);
    this._savedCamera = persp;
    env.camera = ortho;
    env.controls.object = ortho;
    env.controls.update();
    env.viewDirty = true;
  }

  /** Restore the perspective camera, preserving the apparent framing
   *  (ortho zoom/pan translate into perspective distance/target). */
  _exitOrtho() {
    const env = this._env;
    if (!env || !this._savedCamera || !env.camera.isOrthographicCamera) { return; }
    const ortho = env.camera;
    const persp = this._savedCamera;
    this._savedCamera = null;
    const target = env.controls.target;
    const halfH = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
    const dist = halfH / Math.tan(persp.fov * Math.PI / 360);
    const dir = ortho.position.clone().sub(target);
    if (dir.lengthSq() < 1e-9) { dir.copy(this._def.normal); } else { dir.normalize(); }
    persp.position.copy(target).addScaledVector(dir, dist);
    persp.up.copy(ortho.up);
    persp.lookAt(target);
    env.camera = persp;
    env.controls.object = persp;
    env.controls.update();
    env.viewDirty = true;
  }

  // =====================================================================
  //  Reference geometry — model edges lying in the sketch plane, projected
  //  to 2D as dashed, locked entities. They snap, take relations, and can
  //  be the second element of a dimension ("place this circle off that
  //  cube edge"), but never move, emit, trim, or delete.
  // =====================================================================

  _buildRefEntities() {
    const edgesObj = this._vp.mainObject &&
      this._vp.mainObject.getObjectByName('Model Edges');
    if (!edgesObj || !edgesObj.globalEdgeMetadata) { return; }
    const pos = edgesObj.geometry.getAttribute('position');
    const def = this._def;
    const O = def.occOrigin, X = def.occX, Y = def.occY, N = def.occNormal;
    const TOL = 0.05;      // in-plane tolerance (mesh verts are float32)
    const r3 = (v) => Math.round(v * 1000) / 1000; // clean snap targets
    let added = 0;

    for (const key of Object.keys(edgesObj.globalEdgeMetadata)) {
      const meta = edgesObj.globalEdgeMetadata[key];
      if (meta.start < 0 || added >= 400) { continue; }

      // Rebuild the polyline from the segment-pair layout (a0,a1)(a1,a2)…
      const pts = [];
      for (let v = meta.start; v <= meta.end; v++) {
        const p = [pos.getX(v), pos.getY(v), pos.getZ(v)];
        const prev = pts[pts.length - 1];
        if (!prev || dist2([prev[0], prev[1]], [p[0], p[1]]) > 1e-9 || Math.abs(prev[2] - p[2]) > 1e-9) {
          pts.push(p);
        }
      }
      if (pts.length < 2) { continue; }

      // Project into sketch coords; skip anything off-plane
      let planar = true;
      const uv = [];
      for (const p of pts) {
        const d = [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
        if (Math.abs(dot3(d, N)) > TOL) { planar = false; break; }
        uv.push([dot3(d, X), dot3(d, Y)]);
      }
      if (!planar) { continue; }

      const a = uv[0], b = uv[uv.length - 1];
      const chord = dist2(a, b);
      if (uv.length === 2 || chord > 1e-6) {
        // Straight? Interior points must hug the chord
        let straight = chord > 1e-6;
        if (straight && uv.length > 2) {
          const ux = (b[0] - a[0]) / chord, uy = (b[1] - a[1]) / chord;
          for (let i = 1; i < uv.length - 1 && straight; i++) {
            const dx = uv[i][0] - a[0], dy = uv[i][1] - a[1];
            if (Math.abs(dx * uy - dy * ux) > 0.01) { straight = false; }
          }
        }
        if (straight) {
          this.entities.push({
            id: this._nextId++, type: 'line', ref: true,
            a: [r3(a[0]), r3(a[1])], b: [r3(b[0]), r3(b[1])],
          });
          added++;
          continue;
        }
      }

      // Closed curve equidistant from its centroid → reference circle
      if (samePt(a, b) && uv.length > 4) {
        let cx = 0, cy = 0;
        for (let i = 0; i < uv.length - 1; i++) { cx += uv[i][0]; cy += uv[i][1]; }
        const c = [cx / (uv.length - 1), cy / (uv.length - 1)];
        let rMin = Infinity, rMax = 0;
        for (const p of uv) {
          const r = dist2(p, c);
          rMin = Math.min(rMin, r); rMax = Math.max(rMax, r);
        }
        if (rMax - rMin < Math.max(0.02, rMax * 0.01)) {
          this.entities.push({
            id: this._nextId++, type: 'circle', ref: true,
            c: [r3(c[0]), r3(c[1])], r: r3((rMin + rMax) / 2),
          });
          added++;
        }
      }
    }
  }

  // =====================================================================
  //  Static overlay (plane grid + origin marker)
  // =====================================================================

  _buildStaticOverlay() {
    // Grid aligned to the plane's own basis, centered on its origin — so a
    // baked face plane gets the same square-on grid a cardinal plane does.
    const mk = (a, b) => this._def.toThree(a, b);
    const half = 250, step = 10;
    const gridPts = [];
    for (let i = -half; i <= half; i += step) {
      gridPts.push(mk(i, -half), mk(i, half), mk(-half, i), mk(half, i));
    }
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(gridPts),
      new THREE.LineBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.12 }));
    this._staticGroup.add(grid);

    // Origin cross in the sketch plane
    const geo = new THREE.BufferGeometry().setFromPoints([mk(-4, 0), mk(4, 0), mk(0, -4), mk(0, 4)]);
    const cross = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: COLOR_ACCENT, transparent: true, opacity: 0.9, depthTest: false,
    }));
    cross.renderOrder = 997;
    this._staticGroup.add(cross);
  }

  // =====================================================================
  //  Mouse → sketch coordinates + snapping
  // =====================================================================

  _eventToSketchRaw(e) {
    const env = this._env;
    const canvas = env.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this._raycaster.setFromCamera(ndc, env.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this._def.normal, this._def.origin3);
    const out = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(plane, out)) { return null; }
    return this._def.fromThree(out);
  }

  /** World-units-per-pixel at the current camera distance / ortho zoom. */
  _pixelWorld(px) {
    const env = this._env;
    const h = env.renderer.domElement.clientHeight || 1;
    if (env.camera.isOrthographicCamera) {
      return px * (env.camera.top - env.camera.bottom) / env.camera.zoom / h;
    }
    const dist = env.camera.position.distanceTo(env.controls.target);
    return px * 2 * dist * Math.tan(env.camera.fov * Math.PI / 360) / h;
  }

  /** Snap a raw point: existing endpoints/centers/origin first, else the grid.
   *  Returns {pt, onPoint} — onPoint means an exact-coordinate snap was hit.
   *  Snapping to a registered point returns the SHARED array so the caller
   *  reuses it (coincidence by topology). excludeArrs skips given refs
   *  (used while dragging a point so it doesn't snap to itself). */
  _snap(raw, shiftKey, excludeArrs) {
    const tol = this._pixelWorld(10);
    const candidates = [{ p: [0, 0], ref: null }];
    for (const ent of this.entities) {
      if (ent.ref) {
        // Reference geometry snaps by POSITION only (copies, never the
        // shared array — refs are locked and must stay independent)
        if (ent.type === 'line') {
          candidates.push({ p: [...ent.a], ref: null }, { p: [...ent.b], ref: null },
                          { p: lerp2(ent.a, ent.b, 0.5), ref: null });
        } else {
          candidates.push({ p: [...ent.c], ref: null });
        }
        continue;
      }
      if (ent.type === 'line') { candidates.push({ p: ent.a, ref: ent.a }, { p: ent.b, ref: ent.b }); }
      else if (ent.type === 'circle') { candidates.push({ p: ent.c, ref: ent.c }); }
      else if (ent.type === 'arc') {
        candidates.push({ p: ent.c, ref: ent.c }, { p: arcPt(ent, ent.a0), ref: null }, { p: arcPt(ent, ent.a1), ref: null });
      }
    }
    if (this._chainStart) { candidates.push({ p: this._chainStart, ref: this._chainStart }); }
    let best = null, bestD = tol;
    for (const c of candidates) {
      if (excludeArrs && c.ref && excludeArrs.has(c.ref)) { continue; }
      const d = dist2(raw, c.p);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) { return { pt: best.ref || [best.p[0], best.p[1]], onPoint: true }; }
    const step = shiftKey ? 0.1 : 1; // Shift = fine snap
    return {
      pt: [Math.round(raw[0] / step) * step, Math.round(raw[1] / step) * step],
      onPoint: false,
    };
  }

  // =====================================================================
  //  Shared points — endpoints/centers are shared [x,y] arrays, so moving
  //  a corner moves every entity that touches it
  // =====================================================================

  /** Canonicalize a point: reuse a registered point within tolerance, else
   *  register a copy. Points at the origin are auto-anchored. */
  _canonPt(p) {
    for (const r of this.points) {
      if (r.p === p || dist2(r.p, p) < PT_EPS) { return r.p; }
    }
    const rec = { id: this._nextPtId++, p: [p[0], p[1]] };
    this.points.push(rec);
    if (samePt(rec.p, [0, 0])) {
      this._addConstraint({ type: 'anchor', ptId: rec.id, at: [0, 0] });
    }
    return rec.p;
  }

  _ptRec(arr) { return this.points.find(r => r.p === arr) || null; }
  _ptById(id) { const r = this.points.find(r => r.id === id); return r ? r.p : null; }
  _ent(id) { return this.entities.find(e => e.id === id) || null; }
  _entPts(e) { return e.type === 'line' ? [e.a, e.b] : [e.c]; }
  _isAnchored(ptId) { return this.constraints.some(c => c.type === 'anchor' && c.ptId === ptId); }

  /** Drop point records no entity references any more (and their anchors). */
  _gcPoints() {
    const used = new Set();
    for (const e of this.entities) { for (const p of this._entPts(e)) { used.add(p); } }
    const gone = new Set(this.points.filter(r => !used.has(r.p)).map(r => r.id));
    if (gone.size === 0) { return; }
    this.points = this.points.filter(r => !gone.has(r.id));
    this.constraints = this.constraints.filter(c => !(c.type === 'anchor' && gone.has(c.ptId)));
  }

  // =====================================================================
  //  Constraints — creation, lookup, deletion
  // =====================================================================

  /** True if adding this H/V constraint would contradict the other one. */
  _hvConflict(c) {
    if (c.type !== 'horizontal' && c.type !== 'vertical') { return false; }
    const other = c.type === 'horizontal' ? 'vertical' : 'horizontal';
    return this.constraints.some(k => k.type === other && k.entId === c.entId);
  }

  _findConstraint(c) {
    return this.constraints.find(k => {
      if (k.type !== c.type) { return false; }
      if (c.type === 'anchor') { return k.ptId === c.ptId; }
      if (c.entId !== undefined) { return k.entId === c.entId; }
      return (k.aId === c.aId && k.bId === c.bId) || (k.aId === c.bId && k.bId === c.aId);
    }) || null;
  }

  /** Add a constraint unless it already exists or contradicts. Returns it. */
  _addConstraint(c) {
    if (this._findConstraint(c) || this._hvConflict(c)) { return null; }
    c.id = this._nextId++;
    this.constraints.push(c);
    return c;
  }

  /** Remove entities plus every constraint referencing them; GC points. */
  _deleteEntities(ids) {
    const gone = new Set(ids);
    this.entities = this.entities.filter(e => !gone.has(e.id));
    this.constraints = this.constraints.filter(c =>
      !(gone.has(c.entId) || gone.has(c.aId) || gone.has(c.bId)));
    this._gcPoints();
  }

  /** Auto-infer horizontal/vertical on a freshly drawn line. Mouse-derived
   *  endpoints within ~5° get squared up; endpoints that landed on existing
   *  geometry are never moved (only tagged when already exact). */
  _inferLineRelation(ent, endpointFixed) {
    const bShared = this.entities.some(e =>
      e !== ent && this._entPts(e).includes(ent.b));
    const fixed = endpointFixed || bShared;
    const dx = ent.b[0] - ent.a[0], dy = ent.b[1] - ent.a[1];
    if (Math.hypot(dx, dy) < 1) { return; }
    const SLOPE = Math.tan(5 * Math.PI / 180);
    if (Math.abs(dy) <= (fixed ? PT_EPS : SLOPE * Math.abs(dx))) {
      if (!fixed) { ent.b[1] = ent.a[1]; }
      this._addConstraint({ type: 'horizontal', entId: ent.id });
    } else if (Math.abs(dx) <= (fixed ? PT_EPS : SLOPE * Math.abs(dy))) {
      if (!fixed) { ent.b[0] = ent.a[0]; }
      this._addConstraint({ type: 'vertical', entId: ent.id });
    }
  }

  /** Apply a relation button/key to the current selection. */
  _applyRelation(id) {
    const ents = this._sel.filter(s => s.kind === 'ent').map(s => this._ent(s.id)).filter(Boolean);
    const pts = this._sel.filter(s => s.kind === 'pt')
      .map(s => this.points.find(r => r.id === s.id)).filter(Boolean);
    const lines = ents.filter(e => e.type === 'line');
    const circs = ents.filter(e => e.type === 'circle' || e.type === 'arc');
    const need = (msg) => { this._flashHintSketch(msg); this._floatMsg(msg, 'info'); };
    const toAdd = [];

    if (id === 'anchor') {
      const targets = [...pts];
      for (const e of ents) {
        for (const p of this._entPts(e)) {
          const r = this._ptRec(p);
          if (r && !targets.includes(r)) { targets.push(r); }
        }
      }
      if (!targets.length) { return need('Anchor: select a point (or an element to pin its points)'); }
      this._pushUndo();
      if (targets.every(r => this._isAnchored(r.id))) {
        const ids = new Set(targets.map(r => r.id));
        this.constraints = this.constraints.filter(c => !(c.type === 'anchor' && ids.has(c.ptId)));
        this._floatMsg('⚓ removed', 'info');
      } else {
        for (const r of targets) {
          this._addConstraint({ type: 'anchor', ptId: r.id, at: [r.p[0], r.p[1]] });
        }
      }
    } else if (id === 'horizontal' || id === 'vertical') {
      const own = lines.filter(l => !l.ref);
      if (!own.length) {
        return need(lines.length ? 'That is reference geometry — it can\'t be constrained directly' : 'Select a line first');
      }
      for (const l of own) { toAdd.push({ type: id, entId: l.id }); }
    } else if (id === 'parallel' || id === 'perp') {
      if (lines.length !== 2) { return need((id === 'perp' ? 'Perpendicular' : 'Parallel') + ' needs two lines — Shift-click the second one'); }
      toAdd.push({ type: id, aId: lines[0].id, bId: lines[1].id });
    } else if (id === 'equal') {
      if (lines.length === 2 && !circs.length) { toAdd.push({ type: 'equal', aId: lines[0].id, bId: lines[1].id }); }
      else if (circs.length === 2 && !lines.length) { toAdd.push({ type: 'equal', aId: circs[0].id, bId: circs[1].id }); }
      else { return need('Equal needs two lines, or two circles/arcs'); }
    } else if (id === 'concentric') {
      if (circs.length !== 2) { return need('Concentric needs two circles/arcs'); }
      toAdd.push({ type: 'concentric', aId: circs[0].id, bId: circs[1].id });
    } else if (id === 'tangent') {
      if (lines.length === 1 && circs.length === 1) {
        toAdd.push({ type: 'tangent', aId: lines[0].id, bId: circs[0].id });
      } else if (circs.length === 2 && !lines.length) {
        const d = dist2(circs[0].c, circs[1].c);
        const internal = Math.abs(d - Math.abs(circs[0].r - circs[1].r)) < Math.abs(d - (circs[0].r + circs[1].r));
        toAdd.push({ type: 'tangent', aId: circs[0].id, bId: circs[1].id, internal });
      } else { return need('Tangent needs a line + a circle, or two circles'); }
    }

    if (toAdd.length) {
      const bothRef = toAdd.find(c => {
        const A = c.aId !== undefined ? this._ent(c.aId) : null;
        const B = c.bId !== undefined ? this._ent(c.bId) : null;
        return A && B && A.ref && B.ref;
      });
      if (bothRef) { return need('Both of those are reference geometry — nothing can move'); }
      const fresh = toAdd.filter(c => !this._findConstraint(c));
      if (!fresh.length) { return need('Already related'); }
      const conflict = fresh.find(c => this._hvConflict(c));
      if (conflict) {
        return need('That line is already ' + (conflict.type === 'horizontal' ? 'vertical' : 'horizontal') + ' — delete that relation first');
      }
      const hadBad = this.constraints.some(k => k.unsat);
      this._pushUndo();
      for (const c of fresh) { this._addConstraint(c); }
      if (!this._solveQuiet() && !hadBad) {
        this._rejectEdit(fresh);
        return;
      }
    } else {
      this._solveQuiet();
    }
    this._renderEntities();
    this._renderPreview();
  }

  // =====================================================================
  //  Solver — sequential projection (PBD-style). Each pass nudges the
  //  geometry toward satisfying every constraint; anchored and dragged
  //  points never move. Runs from current geometry, so the result is
  //  always "the nearest shape that fits".
  // =====================================================================

  /** Solve in place. extraLocked: Set of point arrays pinned by a drag.
   *  Returns true when everything converged. */
  _solve(extraLocked) {
    const locked = new Set(extraLocked || []);
    for (const c of this.constraints) {
      if (c.type !== 'anchor') { continue; }
      const p = this._ptById(c.ptId);
      if (p && !locked.has(p)) { p[0] = c.at[0]; p[1] = c.at[1]; locked.add(p); }
    }
    // Reference geometry (projected model edges) never moves
    for (const e of this.entities) {
      if (!e.ref) { continue; }
      for (const p of this._entPts(e)) { locked.add(p); }
    }
    const w = (p) => (locked.has(p) ? 0 : 1);

    // Iterate in batches, continuing while the worst residual still improves:
    // stiff-but-feasible chains converge slowly but surely, while a genuine
    // conflict plateaus and stops early. Sketch sizes make this cheap.
    const TOL = 0.01, BATCH = 150, MAX_BATCHES = 8;
    let prevWorst = Infinity;
    for (let b = 0; b < MAX_BATCHES; b++) {
      let fixedPoint = false;
      for (let i = 0; i < BATCH; i++) {
        const before = this.points.map(r => [r.p[0], r.p[1]]);
        const radiiBefore = this.entities.map(e => e.r || 0);
        for (const c of this.constraints) { this._project(c, w); }
        let maxMove = 0;
        this.points.forEach((r, j) => {
          maxMove = Math.max(maxMove, Math.abs(r.p[0] - before[j][0]), Math.abs(r.p[1] - before[j][1]));
        });
        this.entities.forEach((e, j) => {
          maxMove = Math.max(maxMove, Math.abs((e.r || 0) - radiiBefore[j]));
        });
        if (maxMove < 1e-10) { fixedPoint = true; break; }
      }
      let worst = 0;
      for (const c of this.constraints) { worst = Math.max(worst, this._residual(c)); }
      if (fixedPoint || worst < TOL * 0.2 || worst > prevWorst * 0.7) { break; }
      prevWorst = worst;
    }

    let anyBad = false;
    for (const c of this.constraints) {
      c.unsat = this._residual(c) > 0.01;
      anyBad = anyBad || c.unsat;
    }
    if (anyBad && !this._warnedUnsat && !this._quietSolve) {
      this._flashHintSketch('Over-constrained — the red relations can\'t all hold (delete one, or remove an anchor)');
    }
    this._warnedUnsat = anyBad;
    return !anyBad;
  }

  /** Move p and q along their connecting line until they are d apart. */
  _projDist(p, q, d, w) {
    const wp = w(p), wq = w(q), tot = wp + wq;
    if (!tot) { return; }
    let dx = q[0] - p[0], dy = q[1] - p[1];
    let L = Math.hypot(dx, dy);
    if (L < 1e-12) {
      if (d < 1e-12) { return; }
      dx = 1; dy = 0; L = 1;
    }
    const err = L - d;
    const ux = dx / L, uy = dy / L;
    p[0] += ux * err * wp / tot; p[1] += uy * err * wp / tot;
    q[0] -= ux * err * wq / tot; q[1] -= uy * err * wq / tot;
  }

  /** Rotate a line by dAng about its most constrained pivot. */
  _rotateToward(e, dAng, w) {
    if (Math.abs(dAng) < 1e-12) { return; }
    const wa = w(e.a), wb = w(e.b);
    if (!wa && !wb) { return; }
    let pivot;
    if (!wa) { pivot = e.a; }
    else if (!wb) { pivot = e.b; }
    else { pivot = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]; }
    const cs = Math.cos(dAng), sn = Math.sin(dAng);
    const rot = (p) => {
      const dx = p[0] - pivot[0], dy = p[1] - pivot[1];
      p[0] = pivot[0] + dx * cs - dy * sn;
      p[1] = pivot[1] + dx * sn + dy * cs;
    };
    if (wa) { rot(e.a); }
    if (wb) { rot(e.b); }
  }

  _lineMobility(e, w) { return (w(e.a) || w(e.b)) ? 1 : 0; }

  /** Stretch/shrink a line to length L, favoring its free endpoint(s). */
  _setLineLen(e, L, w) {
    const cur = dist2(e.a, e.b);
    if (cur < 1e-12 || Math.abs(cur - L) < 1e-12) { return; }
    const wa = w(e.a), wb = w(e.b), tot = wa + wb;
    if (!tot) { return; }
    const ux = (e.b[0] - e.a[0]) / cur, uy = (e.b[1] - e.a[1]) / cur;
    const d = L - cur;
    e.b[0] += ux * d * wb / tot; e.b[1] += uy * d * wb / tot;
    e.a[0] -= ux * d * wa / tot; e.a[1] -= uy * d * wa / tot;
  }

  /** Value of a length/radius dimension on this entity, or null. */
  _dimValueFor(entId, type) {
    const c = this.constraints.find(k => k.type === type && k.entId === entId);
    return c ? c.value : null;
  }

  /** Current distance + measuring direction between two entities (pair dim).
   *  mode is decided ONCE when the dimension is created ('perp' for parallel
   *  lines, else 'center') and stays fixed — re-deciding it mid-solve from
   *  nearly-parallel geometry makes the target flip-flop and never converge. */
  _pairDistGeom(A, B, mode) {
    const mid = (e) => e.type === 'line' ? lerp2(e.a, e.b, 0.5) : e.c;
    const usePerp = A.type === 'line' && B.type === 'line' && (
      mode === 'perp' ||
      (mode === undefined &&
        Math.abs(cross2(sub2(A.b, A.a), sub2(B.b, B.a))) < 1e-6 * len2(sub2(A.b, A.a)) * len2(sub2(B.b, B.a)))
    );
    if (usePerp) {
      const u = sub2(A.b, A.a);
      const L = len2(u);
      if (L > 1e-12) {
        const nu = [-u[1] / L, u[0] / L];
        const d = dot2(sub2(mid(B), mid(A)), nu);
        return { d: Math.abs(d), dir: d >= 0 ? nu : scale2(nu, -1) };
      }
    }
    // One line + one circle/arc → perpendicular distance from the center to
    // the (infinite) line — the natural "place this hole off that edge" dim
    const ln = A.type === 'line' ? A : (B.type === 'line' ? B : null);
    const ci = A.type !== 'line' ? A : (B.type !== 'line' ? B : null);
    if (ln && ci && mode !== 'center') { // 'perp' or undecided
      const u = sub2(ln.b, ln.a);
      const L = len2(u);
      if (L > 1e-12) {
        const nu = [-u[1] / L, u[0] / L];
        const d = dot2(sub2(ci.c, ln.a), nu);      // signed line → center
        let dir = d >= 0 ? nu : scale2(nu, -1);    // toward the center...
        if (ci === A) { dir = scale2(dir, -1); }   // ...flipped so dir runs A → B
        return { d: Math.abs(d), dir };
      }
    }
    if (mode === 'perp') { return null; } // degenerate line
    const delta = sub2(mid(B), mid(A));
    const d = len2(delta);
    if (d < 1e-9) { return null; }
    return { d, dir: scale2(delta, 1 / d) };
  }

  _project(c, w) {
    switch (c.type) {
      case 'anchor': return; // enforced by the locked set
      case 'horizontal':
      case 'vertical': {
        const e = this._ent(c.entId);
        if (!e) { return; }
        const target = c.type === 'horizontal' ? 0 : Math.PI / 2;
        this._rotateToward(e, wrapHalfPi(target - lineAngle(e)), w);
        return;
      }
      case 'parallel':
      case 'perp': {
        const A = this._ent(c.aId), B = this._ent(c.bId);
        if (!A || !B) { return; }
        const off = c.type === 'perp' ? Math.PI / 2 : 0;
        const err = wrapHalfPi(lineAngle(B) - lineAngle(A) - off);
        const mA = this._lineMobility(A, w), mB = this._lineMobility(B, w);
        const tot = mA + mB;
        if (!tot) { return; }
        this._rotateToward(A, err * (mA / tot), w);
        this._rotateToward(B, -err * (mB / tot), w);
        return;
      }
      case 'equal': {
        const A = this._ent(c.aId), B = this._ent(c.bId);
        if (!A || !B) { return; }
        if (A.type === 'line' && B.type === 'line') {
          const dimA = this._dimValueFor(A.id, 'length'), dimB = this._dimValueFor(B.id, 'length');
          const t = dimA !== null ? dimA
            : dimB !== null ? dimB
            : A.ref ? dist2(A.a, A.b)   // a reference sets the target, never moves
            : B.ref ? dist2(B.a, B.b)
            : (dist2(A.a, A.b) + dist2(B.a, B.b)) / 2;
          this._setLineLen(A, t, w);
          this._setLineLen(B, t, w);
        } else if (A.type !== 'line' && B.type !== 'line') {
          const dimA = this._dimValueFor(A.id, 'radius'), dimB = this._dimValueFor(B.id, 'radius');
          const t = dimA !== null ? dimA : dimB !== null ? dimB
            : A.ref ? A.r : B.ref ? B.r : (A.r + B.r) / 2;
          if (!A.ref) { A.r = t; }
          if (!B.ref) { B.r = t; }
        }
        return;
      }
      case 'concentric': {
        const A = this._ent(c.aId), B = this._ent(c.bId);
        if (!A || !B) { return; }
        this._projDist(A.c, B.c, 0, w);
        return;
      }
      case 'tangent': {
        const A = this._ent(c.aId), B = this._ent(c.bId);
        if (!A || !B) { return; }
        const line = A.type === 'line' ? A : (B.type === 'line' ? B : null);
        if (line) {
          const circ = A === line ? B : A;
          const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1];
          const L = Math.hypot(dx, dy);
          if (L < 1e-12) { return; }
          const nx = -dy / L, ny = dx / L;
          const d = (circ.c[0] - line.a[0]) * nx + (circ.c[1] - line.a[1]) * ny;
          const s = d >= 0 ? 1 : -1;
          const err = d - s * circ.r;
          const wc = w(circ.c), wa = w(line.a), wb = w(line.b);
          const mL = (wa && wb) ? 1 : ((wa || wb) ? 0.5 : 0);
          const tot = wc + mL;
          if (!tot) {
            // Everything pinned — let the radius absorb it unless dimensioned
            // (or the circle is reference geometry, which never changes)
            if (!circ.ref && this._dimValueFor(circ.id, 'radius') === null) { circ.r = Math.abs(d); }
            return;
          }
          const dc = err * (wc / tot), dl = mL ? err * (mL / tot) : 0;
          circ.c[0] -= nx * dc; circ.c[1] -= ny * dc;
          if (wa) { line.a[0] += nx * dl; line.a[1] += ny * dl; }
          if (wb) { line.b[0] += nx * dl; line.b[1] += ny * dl; }
        } else {
          const target = c.internal ? Math.abs(A.r - B.r) : A.r + B.r;
          this._projDist(A.c, B.c, target, w);
        }
        return;
      }
      case 'length': {
        const e = this._ent(c.entId);
        if (e) { this._projDist(e.a, e.b, c.value, w); }
        return;
      }
      case 'radius': {
        const e = this._ent(c.entId);
        if (e) { e.r = c.value; }
        return;
      }
      case 'dist': {
        const A = this._ent(c.aId), B = this._ent(c.bId);
        if (!A || !B) { return; }
        const g = this._pairDistGeom(A, B, c.mode);
        if (!g) { return; }
        const err = g.d - c.value;
        const ptsA = this._entPts(A).filter(p => w(p));
        const ptsB = this._entPts(B).filter(p => w(p));
        const mA = ptsA.length ? 1 : 0, mB = ptsB.length ? 1 : 0;
        const tot = mA + mB;
        if (!tot) { return; }
        const [ux, uy] = g.dir;
        for (const p of ptsA) { p[0] += ux * err * (mA / tot); p[1] += uy * err * (mA / tot); }
        for (const p of ptsB) { p[0] -= ux * err * (mB / tot); p[1] -= uy * err * (mB / tot); }
        return;
      }
    }
  }

  /** How far a constraint is from satisfied, in sketch units. */
  _residual(c) {
    const e1 = c.entId !== undefined ? this._ent(c.entId) : null;
    const A = c.aId !== undefined ? this._ent(c.aId) : null;
    const B = c.bId !== undefined ? this._ent(c.bId) : null;
    switch (c.type) {
      case 'anchor': { const p = this._ptById(c.ptId); return p ? dist2(p, c.at) : 0; }
      case 'horizontal': return e1 ? Math.abs(e1.b[1] - e1.a[1]) : 0;
      case 'vertical': return e1 ? Math.abs(e1.b[0] - e1.a[0]) : 0;
      case 'parallel':
      case 'perp': {
        if (!A || !B) { return 0; }
        const off = c.type === 'perp' ? Math.PI / 2 : 0;
        const err = Math.abs(wrapHalfPi(lineAngle(B) - lineAngle(A) - off));
        return err * Math.min(dist2(A.a, A.b), dist2(B.a, B.b)) * 0.5;
      }
      case 'equal': {
        if (!A || !B) { return 0; }
        return A.type === 'line'
          ? Math.abs(dist2(A.a, A.b) - dist2(B.a, B.b))
          : Math.abs(A.r - B.r);
      }
      case 'concentric': return (A && B) ? dist2(A.c, B.c) : 0;
      case 'tangent': {
        if (!A || !B) { return 0; }
        const line = A.type === 'line' ? A : (B.type === 'line' ? B : null);
        if (line) {
          const circ = A === line ? B : A;
          const dx = line.b[0] - line.a[0], dy = line.b[1] - line.a[1];
          const L = Math.hypot(dx, dy);
          if (L < 1e-12) { return 0; }
          const d = ((circ.c[0] - line.a[0]) * -dy + (circ.c[1] - line.a[1]) * dx) / L;
          return Math.abs(Math.abs(d) - circ.r);
        }
        const target = c.internal ? Math.abs(A.r - B.r) : A.r + B.r;
        return Math.abs(dist2(A.c, B.c) - target);
      }
      case 'length': return e1 ? Math.abs(dist2(e1.a, e1.b) - c.value) : 0;
      case 'radius': return e1 ? Math.abs(e1.r - c.value) : 0;
      case 'dist': {
        if (!A || !B) { return 0; }
        const g = this._pairDistGeom(A, B, c.mode);
        return g ? Math.abs(g.d - c.value) : 0;
      }
    }
    return 0;
  }

  _solveQuiet(extraLocked) {
    this._quietSolve = true;
    const ok = this._solve(extraLocked);
    this._quietSolve = false;
    return ok;
  }

  /** Current geometric value of a dimension constraint. */
  _conMeasure(c) {
    const e = c.entId !== undefined ? this._ent(c.entId) : null;
    if (c.type === 'length') { return e ? dist2(e.a, e.b) : null; }
    if (c.type === 'radius') { return e ? e.r : null; }
    if (c.type === 'dist') {
      const A = this._ent(c.aId), B = this._ent(c.bId);
      const g = (A && B) ? this._pairDistGeom(A, B, c.mode) : null;
      return g ? g.d : null;
    }
    return null;
  }

  /** Short "what's fighting it" phrase: constraints sharing geometry with c. */
  _blockerPhrase(c) {
    const entIds = new Set();
    if (c.entId !== undefined) { entIds.add(c.entId); }
    if (c.aId !== undefined) { entIds.add(c.aId); entIds.add(c.bId); }
    const pts = new Set();
    for (const id of entIds) {
      const e = this._ent(id);
      if (e) { for (const p of this._entPts(e)) { pts.add(p); } }
    }
    const names = [];
    const push = (n) => { if (!names.includes(n)) { names.push(n); } };
    for (const id of entIds) {
      const e = this._ent(id);
      if (e && e.ref) { push('the fixed model edge'); }
    }
    for (const k of this.constraints) {
      if (k === c || k.id === c.id) { continue; }
      if (k.type === 'anchor') {
        const p = this._ptById(k.ptId);
        if (p && pts.has(p)) { push('anchors'); }
        continue;
      }
      const kEnts = [k.entId, k.aId, k.bId].filter(x => x !== undefined);
      let touches = kEnts.some(id => entIds.has(id));
      if (!touches) {
        for (const id of kEnts) {
          const e = this._ent(id);
          if (e && this._entPts(e).some(p => pts.has(p))) { touches = true; break; }
        }
      }
      if (!touches) { continue; }
      if (k.type === 'length' || k.type === 'radius' || k.type === 'dist') { push('dimensions'); }
      else if (k.type === 'horizontal' || k.type === 'vertical') { push('H/V relations'); }
      else { push(k.type + ' relations'); }
    }
    return names.length ? 'held by ' + names.slice(0, 3).join(' + ') : '';
  }

  /** A just-applied edit (new dimension value or relation) can't be
   *  satisfied. Find the nearest feasible value, revert the edit (popping
   *  the undo state pushed by the caller), and float an explanation at the
   *  geometry that refused. */
  _rejectEdit(cons, clientPos) {
    this._quietSolve = true;
    // Re-solve with the new constraints projected FIRST, so everything else
    // wins each pass: geometry settles at the nearest feasible state, and a
    // dimension's measure then reads out its actual limit.
    for (const c of cons) {
      const i = this.constraints.indexOf(c);
      if (i > 0) { this.constraints.splice(i, 1); this.constraints.unshift(c); }
    }
    this._solve();
    const c0 = cons[0];
    const achieved = this._conMeasure(c0);
    const blockers = this._blockerPhrase(c0);

    const WORDS = {
      length: ['this line', 'longer', 'shorter'],
      radius: ['this radius', 'bigger', 'smaller'],
      dist: ['this distance', 'more', 'less'],
    };
    // Would the boundary value itself hold? If even that fails, the value is
    // fully determined by the rest of the sketch — say so instead of quoting
    // a longer/shorter bound that also wouldn't work.
    let fullyDetermined = false;
    if (WORDS[c0.type] && achieved !== null) {
      const tryVal = c0.value;
      c0.value = achieved;
      fullyDetermined = !this._solve();
      c0.value = tryVal;
    }

    const snap = this._undoStack.pop();
    if (snap) { this._restoreState(snap); }
    this._solve(); // recompute unsat flags on the restored state
    this._quietSolve = false;

    // Round quoted bounds TOWARD the feasible side so typing the shown
    // number always works. dir: -1 floor (upper bound), +1 ceil (lower), 0 round
    const fmt2 = (n, dir) => {
      const s = dir > 0 ? Math.ceil(n * 100 - 1e-7) : dir < 0 ? Math.floor(n * 100 + 1e-7) : Math.round(n * 100);
      return String(s / 100);
    };
    let msg;
    if (WORDS[c0.type]) {
      const [noun, over, under] = WORDS[c0.type];
      if (fullyDetermined) {
        msg = `${noun} is fixed at ${fmt2(achieved, 0)} by its other relations`;
      } else if (achieved !== null && Math.abs(achieved - c0.value) > 0.005) {
        msg = c0.value > achieved
          ? `${noun} can't be ${over} than ${fmt2(achieved, -1)} here`
          : `${noun} can't be ${under} than ${fmt2(achieved, 1)} here`;
      } else {
        msg = `${noun} can't be ${fmt(c0.value)} and keep its relations`;
      }
    } else {
      const r = RELATIONS.find(r => r.id === c0.type);
      msg = `${r ? r.icon + ' ' + r.label : c0.type} can't hold here`;
    }
    if (blockers) { msg += ' — ' + blockers; }
    this._floatMsg(msg, 'bad', clientPos || this._conClient(c0));
    this._renderEntities();
    this._renderPreview();
  }

  // =====================================================================
  //  Mouse handlers
  // =====================================================================

  _onMouseMove(e) {
    if (!this.active) { return; }
    this._lastClient = [e.clientX, e.clientY];
    const raw = this._eventToSketchRaw(e);
    if (!raw) { return; }

    if (this.tool === 'select' && this._dragCand) {
      if (!(e.buttons & 1)) { this._finishDrag(); }
      else if (this._dragCand.moved || dist2(raw, this._dragCand.start) > this._pixelWorld(4)) {
        this._dragBy(raw, e.shiftKey);
        return;
      }
    }

    const snap = this._snap(raw, e.shiftKey);
    this._cursor = snap.pt;
    this._cursorSnapped = snap.onPoint;

    if (this.tool === 'trim') {
      this._hoverTrim = this._trimPieceAt(raw);
    }
    this._renderPreview();
  }

  // =====================================================================
  //  Select-tool interaction: selection, dragging (live solve), glyphs
  // =====================================================================

  _updateSel(item, add) {
    const idx = this._sel.findIndex(s => s.kind === item.kind && s.id === item.id);
    if (add) {
      if (idx >= 0) { this._sel.splice(idx, 1); } else { this._sel.push(item); }
    } else if (idx < 0) {
      this._sel = [item];
    }
    // clicking an already-selected item without Shift keeps the selection
    // (so a multi-selection can be dragged)
  }

  /** Nearest registered point within pixel tolerance. */
  _pointAt(raw) {
    const tol = this._pixelWorld(8);
    let best = null, bestD = tol;
    for (const r of this.points) {
      const d = dist2(raw, r.p);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  /** Constraint glyph under the cursor, if any (topmost first). */
  _glyphAt(raw) {
    for (let i = this._glyphHits.length - 1; i >= 0; i--) {
      const g = this._glyphHits[i];
      if (Math.abs(raw[0] - g.x) <= g.hw && Math.abs(raw[1] - g.y) <= g.hh) { return g; }
    }
    return null;
  }

  _onSelectDown(e, raw) {
    const g = this._glyphAt(raw);
    if (g) {
      this._sel = [{ kind: 'con', id: g.conId }];
      this._renderEntities();
      const con = this.constraints.find(k => k.id === g.conId);
      if (con && (con.type === 'length' || con.type === 'radius' || con.type === 'dist')) {
        this._openDimBoxForCon(e, con);
      }
      return;
    }
    const pRec = this._pointAt(raw);
    if (pRec) {
      this._updateSel({ kind: 'pt', id: pRec.id }, e.shiftKey);
      this._dragCand = { kind: 'pt', id: pRec.id, start: raw, moved: false };
      this._renderEntities();
      return;
    }
    const hit = this._hitEntity(raw);
    if (hit) {
      this._updateSel({ kind: 'ent', id: hit.ent.id }, e.shiftKey);
      // Reference geometry is selectable (for relations/dimensions) but fixed
      this._dragCand = hit.ent.ref ? null
        : { kind: 'ent', id: hit.ent.id, start: raw, moved: false };
      this._renderEntities();
      return;
    }
    if (!e.shiftKey && this._sel.length) {
      this._sel = [];
      this._renderEntities();
    }
  }

  _dragBy(raw, shiftKey) {
    const cand = this._dragCand;
    if (!cand.moved) {
      if (cand.kind === 'pt') {
        const rec = this.points.find(r => r.id === cand.id);
        if (!rec) { this._dragCand = null; return; }
        if (this._isAnchored(rec.id)) {
          this._flashHintSketch('That point is anchored — delete its ⚓ to move it');
          this._floatMsg('⚓ anchored — Del its anchor to move it', 'info');
          this._dragCand = null;
          return;
        }
        cand.pts = [rec.p];
      } else {
        const ent = this._ent(cand.id);
        if (!ent) { this._dragCand = null; return; }
        const pts = this._entPts(ent).filter(p => {
          const r = this._ptRec(p);
          return !(r && this._isAnchored(r.id));
        });
        if (!pts.length) {
          this._flashHintSketch('That element is fully anchored — delete its ⚓ to move it');
          this._floatMsg('⚓ anchored — Del its anchors to move it', 'info');
          this._dragCand = null;
          return;
        }
        cand.pts = pts;
      }
      cand.base = cand.pts.map(p => [p[0], p[1]]);
      this._pushUndo();
      cand.moved = true;
    }

    if (cand.kind === 'pt') {
      const snap = this._snap(raw, shiftKey, new Set(cand.pts));
      cand.pts[0][0] = snap.pt[0];
      cand.pts[0][1] = snap.pt[1];
      this._cursor = cand.pts[0];
      this._cursorSnapped = snap.onPoint;
    } else {
      const step = shiftKey ? 0.1 : 1;
      const dx = Math.round((raw[0] - cand.start[0]) / step) * step;
      const dy = Math.round((raw[1] - cand.start[1]) / step) * step;
      cand.pts.forEach((p, i) => {
        p[0] = cand.base[i][0] + dx;
        p[1] = cand.base[i][1] + dy;
      });
    }
    this._solve(new Set(cand.pts));
    this._renderEntities();
    this._renderPreview();
  }

  _finishDrag() {
    const cand = this._dragCand;
    this._dragCand = null;
    if (!cand || !cand.moved) { return; }
    if (cand.kind === 'pt') { this._mergeCoincident(cand.pts[0]); }
    this._solve();
    this._renderEntities();
    this._renderPreview();
  }

  /** After dragging a point onto another point, fuse them (topological
   *  coincidence) — unless that would collapse a line to zero length. */
  _mergeCoincident(arr) {
    const rec = this._ptRec(arr);
    if (!rec) { return; }
    const other = this.points.find(r => r !== rec && dist2(r.p, arr) < PT_EPS);
    if (!other) { return; }
    const collapses = this.entities.some(e => e.type === 'line' &&
      ((e.a === arr && e.b === other.p) || (e.b === arr && e.a === other.p)));
    if (collapses) { return; }
    for (const e of this.entities) {
      if (e.a === arr) { e.a = other.p; }
      if (e.b === arr) { e.b = other.p; }
      if (e.c === arr) { e.c = other.p; }
    }
    const anchor = this.constraints.find(k => k.type === 'anchor' && k.ptId === rec.id);
    if (anchor) {
      if (this._isAnchored(other.id)) { this.constraints = this.constraints.filter(k => k !== anchor); }
      else { anchor.ptId = other.id; anchor.at = [other.p[0], other.p[1]]; }
    }
    this.points = this.points.filter(r => r !== rec);
    this._sel = this._sel.filter(s => !(s.kind === 'pt' && s.id === rec.id));
  }

  _onMouseDown(e) {
    if (!this.active || e.button !== 0) { return; }
    this._lastClient = [e.clientX, e.clientY];
    const raw = this._eventToSketchRaw(e);
    if (!raw) { return; }
    const snap = this._snap(raw, e.shiftKey);
    const pt = snap.pt;

    switch (this.tool) {
      case 'line': {
        if (!this._chainPrev) {
          this._chainPrev = pt;
          this._chainStart = pt;
        } else {
          if (samePt(pt, this._chainPrev)) { break; } // ignore zero-length
          this._pushUndo();
          const closes = this._chainStart && samePt(pt, this._chainStart);
          const a = this._canonPt(this._chainPrev);
          const b = this._canonPt(pt);
          const ent = { id: this._nextId++, type: 'line', a, b };
          this.entities.push(ent);
          this._inferLineRelation(ent, snap.onPoint || closes);
          if (closes) {
            this._endChain(); // closed the loop
          } else {
            this._chainPrev = b;
          }
          this._renderEntities();
        }
        break;
      }
      case 'rect': {
        if (!this._rectStart) {
          this._rectStart = pt;
        } else {
          const [x1, y1] = this._rectStart, [x2, y2] = pt;
          if (Math.abs(x2 - x1) > PT_EPS && Math.abs(y2 - y1) > PT_EPS) {
            this._pushUndo();
            const c = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(p => this._canonPt(p));
            for (let i = 0; i < 4; i++) {
              const ent = { id: this._nextId++, type: 'line', a: c[i], b: c[(i + 1) % 4] };
              this.entities.push(ent);
              this._addConstraint({ type: i % 2 === 0 ? 'horizontal' : 'vertical', entId: ent.id });
            }
            this._rectStart = null;
            this._renderEntities();
          }
        }
        break;
      }
      case 'circle': {
        if (!this._circleCenter) {
          this._circleCenter = pt;
        } else {
          // Snapped-to-a-point radius is exact (circle through that point);
          // otherwise round the radius itself so the emitted code is clean
          let r = dist2(this._circleCenter, pt);
          if (!snap.onPoint) { r = Math.round(r / (e.shiftKey ? 0.1 : 1)) * (e.shiftKey ? 0.1 : 1); }
          if (r > PT_EPS) {
            this._pushUndo();
            this.entities.push({ id: this._nextId++, type: 'circle', c: this._canonPt(this._circleCenter), r: r });
            this._circleCenter = null;
            this._renderEntities();
          }
        }
        break;
      }
      case 'trim': {
        const piece = this._trimPieceAt(raw);
        if (piece) {
          this._pushUndo();
          this._applyTrim(piece);
          this._hoverTrim = null;
          this._renderEntities();
        }
        break;
      }
      case 'dim': {
        this._onDimClick(e, raw);
        break;
      }
      case 'select': {
        this._onSelectDown(e, raw);
        break;
      }
    }
    this._renderPreview();
  }

  _onContextMenu(e) {
    e.preventDefault();
    // Right-drag is pan; only treat a stationary right-click as "end chain"
    this._endChain();
    this._rectStart = null;
    this._circleCenter = null;
    this._renderPreview();
  }

  _onKeyDown(e) {
    if (!this.active) { return; }
    if (e.target && ((e.target.tagName === 'INPUT') || (e.target.closest && e.target.closest('.monaco-editor')))) { return; }

    if (e.key === 'Escape') {
      if (this._dragCand) {
        const moved = this._dragCand.moved;
        this._dragCand = null;
        if (moved) { this._undo(); }
      } else if (this._dim) { this._closeDimBox(); }
      else if (this._chainPrev || this._rectStart || this._circleCenter) {
        this._endChain();
        this._rectStart = null;
        this._circleCenter = null;
      } else if (this._sel.length) {
        this._sel = [];
        this._renderEntities();
      } else if (this.tool !== 'select') {
        this.setTool('select');
      }
      this._renderPreview();
    } else if (e.key === 'Enter') {
      this._endChain();
      this._renderPreview();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.tool === 'select' && this._sel.length) {
      this._pushUndo();
      const entIds = this._sel.filter(s => s.kind === 'ent').map(s => s.id)
        .filter(id => { const en = this._ent(id); return !(en && en.ref); });
      const conIds = new Set(this._sel.filter(s => s.kind === 'con').map(s => s.id));
      // "deleting" a selected point removes its anchor (the point itself
      // belongs to whatever entities use it)
      for (const s of this._sel) {
        if (s.kind !== 'pt') { continue; }
        const a = this.constraints.find(k => k.type === 'anchor' && k.ptId === s.id);
        if (a) { conIds.add(a.id); }
      }
      this.constraints = this.constraints.filter(c => !conIds.has(c.id));
      if (entIds.length) { this._deleteEntities(entIds); }
      this._sel = [];
      this._solve();
      this._renderEntities();
      this._renderPreview();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      this._undo();
    } else if (e.ctrlKey || e.metaKey || e.altKey) { /* leave browser/app combos alone */ }
    else if (this.tool === 'select' && this._sel.length && RELATION_KEYS[e.key.toLowerCase()]) {
      this._applyRelation(RELATION_KEYS[e.key.toLowerCase()]);
    }
    else if (e.key.toLowerCase() === 'l') { this.setTool('line'); }
    else if (e.key.toLowerCase() === 'r') { this.setTool('rect'); }
    else if (e.key.toLowerCase() === 'c') { this.setTool('circle'); }
    else if (e.key.toLowerCase() === 't') { this.setTool('trim'); }
    else if (e.key.toLowerCase() === 'd') { this.setTool('dim'); }
  }

  _endChain() {
    this._chainPrev = null;
    this._chainStart = null;
  }

  // =====================================================================
  //  Undo
  // =====================================================================

  /** Serialize with point topology: entities store point ids, not coords,
   *  so restoring keeps endpoints shared. Reference geometry is static
   *  session furniture (its points aren't registered) — it is excluded here
   *  and carried across restores unchanged, keeping its ids stable for any
   *  constraints that mention it. */
  _serialize() {
    const idOf = new Map(this.points.map(r => [r.p, r.id]));
    const ents = this.entities.filter(e => !e.ref).map(e => {
      const o = { ...e };
      if (e.type === 'line') { o.a = idOf.get(e.a); o.b = idOf.get(e.b); }
      else { o.c = idOf.get(e.c); }
      return o;
    });
    return JSON.stringify({
      points: this.points.map(r => ({ id: r.id, p: [r.p[0], r.p[1]] })),
      ents,
      cons: this.constraints,
    });
  }

  _restoreState(json) {
    const s = JSON.parse(json);
    const refs = this.entities.filter(e => e.ref);
    const byId = new Map();
    this.points = s.points.map(r => {
      const rec = { id: r.id, p: [r.p[0], r.p[1]] };
      byId.set(r.id, rec.p);
      return rec;
    });
    this.entities = [...refs, ...s.ents.map(e => {
      const o = { ...e };
      if (e.type === 'line') { o.a = byId.get(e.a); o.b = byId.get(e.b); }
      else { o.c = byId.get(e.c); }
      return o;
    })];
    this.constraints = s.cons;
  }

  _pushUndo() {
    this._undoStack.push(this._serialize());
    if (this._undoStack.length > 100) { this._undoStack.shift(); }
  }

  _undo() {
    const snap = this._undoStack.pop();
    if (!snap) { return; }
    this._restoreState(snap);
    this._sel = [];
    this._dragCand = null;
    this._hoverTrim = null;
    this._renderEntities();
    this._renderPreview();
  }

  // =====================================================================
  //  Hit testing
  // =====================================================================

  /** Nearest entity within pixel tolerance → {ent, t?|ang?} or null. */
  _hitEntity(pt) {
    const tol = this._pixelWorld(9);
    let best = null, bestD = tol;
    for (const ent of this.entities) {
      if (ent.type === 'line') {
        const d = sub2(ent.b, ent.a);
        const L2 = dot2(d, d);
        const t = L2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot2(sub2(pt, ent.a), d) / L2));
        const dd = dist2(pt, lerp2(ent.a, ent.b, t));
        if (dd < bestD) { bestD = dd; best = { ent, t }; }
      } else {
        const dc = dist2(pt, ent.c);
        const dd = Math.abs(dc - ent.r);
        const ang = norm2pi(Math.atan2(pt[1] - ent.c[1], pt[0] - ent.c[0]));
        if (dd < bestD && (ent.type === 'circle' || angInArc(ent, ang))) {
          bestD = dd; best = { ent, ang };
        }
      }
    }
    return best;
  }

  // =====================================================================
  //  Trim
  // =====================================================================

  /** Cut parameters on a line entity from all other entities (sorted t list). */
  _cutsOnLine(ent) {
    const ts = [];
    for (const o of this.entities) {
      if (o.id === ent.id || o.ref) { continue; }
      if (o.type === 'line') {
        const t = segSegT(ent.a, ent.b, o.a, o.b);
        if (t !== null && t > 1e-9 && t < 1 - 1e-9) { ts.push(t); }
      } else {
        for (const t of segCircleTs(ent.a, ent.b, o.c, o.r)) {
          if (t <= 1e-9 || t >= 1 - 1e-9) { continue; }
          if (o.type === 'arc') {
            const p = lerp2(ent.a, ent.b, t);
            const ang = norm2pi(Math.atan2(p[1] - o.c[1], p[0] - o.c[0]));
            if (!angInArc(o, ang)) { continue; }
          }
          ts.push(t);
        }
      }
    }
    return ts.sort((x, y) => x - y);
  }

  /** Cut angles (normalized) on a circle/arc entity from all other entities. */
  _cutsOnCircle(ent) {
    const angles = [];
    for (const o of this.entities) {
      if (o.id === ent.id || o.ref) { continue; }
      if (o.type === 'line') {
        for (const t of segCircleTs(o.a, o.b, ent.c, ent.r)) {
          if (t < -1e-9 || t > 1 + 1e-9) { continue; }
          const p = lerp2(o.a, o.b, t);
          angles.push(norm2pi(Math.atan2(p[1] - ent.c[1], p[0] - ent.c[0])));
        }
      } else {
        for (const ang of circleCircleAngles(ent.c, ent.r, o.c, o.r)) {
          if (o.type === 'arc') {
            // The intersection point must lie on the other arc's span
            const p = arcPt(ent, ang);
            const oAng = norm2pi(Math.atan2(p[1] - o.c[1], p[0] - o.c[0]));
            if (!angInArc(o, oAng)) { continue; }
          }
          angles.push(ang);
        }
      }
    }
    return angles.sort((x, y) => x - y);
  }

  /** The removable piece under the cursor → descriptor for preview/apply. */
  _trimPieceAt(pt) {
    const hit = this._hitEntity(pt);
    if (!hit || hit.ent.ref) { return null; } // reference geometry can't trim
    const ent = hit.ent;

    if (ent.type === 'line') {
      const ts = this._cutsOnLine(ent);
      if (ts.length === 0) { return { ent, whole: true }; }
      const bounds = [0, ...ts, 1];
      let lo = 0, hi = 1;
      for (let i = 0; i < bounds.length - 1; i++) {
        if (hit.t >= bounds[i] && hit.t <= bounds[i + 1]) { lo = bounds[i]; hi = bounds[i + 1]; break; }
      }
      return { ent, lo, hi };
    }

    if (ent.type === 'circle') {
      const angles = this._cutsOnCircle(ent);
      if (angles.length < 2) { return { ent, whole: true }; }
      let i = angles.findIndex((a, idx) => {
        const next = angles[(idx + 1) % angles.length];
        const span = norm2pi(next - a) || TAU;
        return norm2pi(hit.ang - a) <= span;
      });
      if (i === -1) { i = angles.length - 1; }
      const aLo = angles[i], aHi = angles[(i + 1) % angles.length];
      return { ent, aLo, aHi };
    }

    // arc
    const sweep = ent.a1 - ent.a0;
    const inDomain = (a) => norm2pi(a - ent.a0) <= sweep + 1e-9;
    const cuts = this._cutsOnCircle(ent).filter(inDomain)
      .map(a => ent.a0 + norm2pi(a - ent.a0))
      .sort((x, y) => x - y);
    if (cuts.length === 0) { return { ent, whole: true }; }
    const clickA = ent.a0 + norm2pi(hit.ang - ent.a0);
    const bounds = [ent.a0, ...cuts, ent.a1];
    let lo = ent.a0, hi = ent.a1;
    for (let i = 0; i < bounds.length - 1; i++) {
      if (clickA >= bounds[i] && clickA <= bounds[i + 1]) { lo = bounds[i]; hi = bounds[i + 1]; break; }
    }
    return { ent, arcLo: lo, arcHi: hi };
  }

  _applyTrim(piece) {
    const ent = piece.ent;
    this.entities = this.entities.filter(e => e.id !== ent.id);
    // H/V carries over to line pieces; other relations/dims on the trimmed
    // entity no longer describe it and are dropped
    const inherited = this.constraints
      .filter(c => (c.type === 'horizontal' || c.type === 'vertical') && c.entId === ent.id)
      .map(c => c.type);
    this.constraints = this.constraints.filter(c =>
      !(c.entId === ent.id || c.aId === ent.id || c.bId === ent.id));

    if (!piece.whole) {
      if (ent.type === 'line') {
        const pieces = [];
        if (piece.lo > 1e-6) {
          pieces.push({ id: this._nextId++, type: 'line', a: ent.a, b: this._canonPt(lerp2(ent.a, ent.b, piece.lo)) });
        }
        if (piece.hi < 1 - 1e-6) {
          pieces.push({ id: this._nextId++, type: 'line', a: this._canonPt(lerp2(ent.a, ent.b, piece.hi)), b: ent.b });
        }
        for (const p of pieces) {
          for (const t of inherited) { this._addConstraint({ type: t, entId: p.id }); }
        }
        this.entities.push(...pieces);
      } else if (ent.type === 'circle') {
        // Removing (aLo → aHi) leaves an arc from aHi ccw back to aLo
        const a0 = piece.aHi;
        const a1 = a0 + norm2pi(piece.aLo - piece.aHi);
        if (a1 - a0 > 1e-6) {
          this.entities.push({ id: this._nextId++, type: 'arc', c: ent.c, r: ent.r, a0, a1 });
        }
      } else { // arc
        if (piece.arcLo - ent.a0 > 1e-6) {
          this.entities.push({ id: this._nextId++, type: 'arc', c: ent.c, r: ent.r, a0: ent.a0, a1: piece.arcLo });
        }
        if (ent.a1 - piece.arcHi > 1e-6) {
          this.entities.push({ id: this._nextId++, type: 'arc', c: ent.c, r: ent.r, a0: piece.arcHi, a1: ent.a1 });
        }
      }
    }
    this._gcPoints();
  }

  // =====================================================================
  //  Dimension tool
  // =====================================================================

  _onDimClick(e, raw) {
    const hit = this._hitEntity(raw);
    if (this._dim && this._dim.bId === null && hit && hit.ent.id !== this._dim.aId) {
      // Second element → becomes a distance dimension
      this._dim.bId = hit.ent.id;
      const info = this._dimInfo(this._dim.aId, this._dim.bId);
      if (info) {
        this._dim.info = info;
        this._dim.input.value = fmt(info.value);
        this._dim.input.focus();
        this._dim.input.select();
        this._renderEntities();
      }
      return;
    }
    this._closeDimBox();
    if (!hit) { this._renderEntities(); return; }
    if (hit.ent.ref) {
      // A reference can only be the SECOND element (its own size is fixed)
      this._floatMsg('reference — pick your sketch element first, then this edge', 'info');
      return;
    }

    const info = this._dimInfo(hit.ent.id, null);
    if (!info) { return; }
    // An existing dimension on this entity re-opens with its variable binding
    const type = info.kind === 'length' ? 'length' : 'radius';
    const con = this.constraints.find(k => k.type === type && k.entId === hit.ent.id);
    const prefill = con && con.varName ? con.varName + '=' + fmt(con.value) : undefined;
    this._openDimBox(e, hit.ent.id, info, prefill);
    this._renderEntities();
  }

  /** Compute the current value (and how to apply a new one) for a dimension. */
  _dimInfo(aId, bId) {
    const A = this.entities.find(e => e.id === aId);
    if (!A) { return null; }
    if (bId === null || bId === undefined) {
      if (A.type === 'line') {
        return { kind: 'length', value: dist2(A.a, A.b), aId, bId: null };
      }
      return { kind: 'radius', value: A.r, aId, bId: null };
    }
    const B = this.entities.find(e => e.id === bId);
    if (!B) { return null; }
    const anchor = (e) => e.type === 'line' ? lerp2(e.a, e.b, 0.5) : e.c;

    // Parallel lines → perpendicular distance
    if (A.type === 'line' && B.type === 'line') {
      const u = sub2(A.b, A.a), v = sub2(B.b, B.a);
      if (Math.abs(cross2(u, v)) < 1e-6 * len2(u) * len2(v)) {
        const n = [-u[1], u[0]];
        const nUnit = scale2(n, 1 / len2(n));
        const d = dot2(sub2(anchor(B), anchor(A)), nUnit);
        return { kind: 'distance', value: Math.abs(d), dir: d >= 0 ? nUnit : scale2(nUnit, -1), aId, bId, mode: 'perp' };
      }
    }
    // Line + circle/arc → perpendicular distance from the center to the line
    if ((A.type === 'line') !== (B.type === 'line')) {
      const g = this._pairDistGeom(A, B, 'perp');
      if (g) { return { kind: 'distance', value: g.d, dir: g.dir, aId, bId, mode: 'perp' }; }
    }
    const delta = sub2(anchor(B), anchor(A));
    const d = len2(delta);
    if (d < 1e-9) { return null; }
    return { kind: 'distance', value: d, dir: scale2(delta, 1 / d), aId, bId, mode: 'center' };
  }

  /** Apply a new value: create (or update) a persistent dimension constraint
   *  and re-solve. Typed values are exact — never rounded or snapped. An
   *  unsatisfiable value is rejected with a floating explanation of the
   *  actual limit. */
  _applyDim(info, newValue, varName, clientPos) {
    const hadBad = this.constraints.some(k => k.unsat);
    this._pushUndo();
    let c;
    if (info.bId === null || info.bId === undefined) {
      const type = info.kind === 'length' ? 'length' : 'radius';
      c = this.constraints.find(k => k.type === type && k.entId === info.aId)
        || this._addConstraint({ type, entId: info.aId, value: newValue });
    } else {
      c = this._findConstraint({ type: 'dist', aId: info.aId, bId: info.bId })
        || this._addConstraint({ type: 'dist', aId: info.aId, bId: info.bId, value: newValue, mode: info.mode || 'center' });
      if (varName) {
        console.log('Sketch: variable "' + varName + '" was created, but distance dimensions emit literal coordinates for now.');
      }
    }
    if (!c) { return; }
    c.value = newValue;
    if (varName) { c.varName = varName; }
    if (!this._solveQuiet() && !hadBad) {
      this._rejectEdit([c], clientPos);
      return;
    }
    this._renderEntities();
  }

  /** Reopen the edit box for an existing dimension constraint (glyph click). */
  _openDimBoxForCon(e, con) {
    const aId = con.entId !== undefined ? con.entId : con.aId;
    const bId = con.bId !== undefined ? con.bId : null;
    const info = this._dimInfo(aId, bId);
    if (!info) { return; }
    const prefill = con.varName ? con.varName + '=' + fmt(con.value) : fmt(con.value);
    this._openDimBox(e, aId, info, prefill);
  }

  _openDimBox(e, aId, info, prefill) {
    this._closeDimBox();
    const panel = this._vp.goldenContainer.element;
    const pRect = panel.getBoundingClientRect();

    const box = document.createElement('div');
    box.className = 'cs-dim-box';
    box.style.left = (e.clientX - pRect.left + 12) + 'px';
    box.style.top = (e.clientY - pRect.top - 14) + 'px';

    const kind = document.createElement('span');
    kind.className = 'cs-dim-kind';
    kind.textContent = info.kind === 'radius' ? 'R' : (info.kind === 'length' ? 'L' : 'D');
    box.appendChild(kind);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = prefill !== undefined ? prefill : fmt(info.value);
    input.title = 'Enter a value, a name (creates a variable), or name=value';
    box.appendChild(input);
    panel.appendChild(box);

    this._dim = { aId, bId: info.bId !== undefined ? info.bId : null, box, input, info };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { this._closeDimBox(); this._renderEntities(); }
      if (ev.key !== 'Enter') { return; }
      const dim = this._dim;
      if (!dim) { return; }
      const text = input.value.trim();
      let value = null, varName = null;
      let m = text.match(/^(-?\d*\.?\d+)$/);
      if (m) { value = parseFloat(m[1]); }
      else if ((m = text.match(/^([A-Za-z_$][\w$]*)\s*(?:=\s*(-?\d*\.?\d+))?$/))) {
        varName = m[1];
        value = m[2] !== undefined ? parseFloat(m[2]) : dim.info.value;
      }
      if (value === null || !isFinite(value) || value <= 0) {
        input.classList.add('cs-dim-bad');
        return;
      }
      const info = dim.info;
      const bRect = box.getBoundingClientRect();
      this._closeDimBox();
      this._applyDim(info, value, varName, [bRect.left + bRect.width / 2, bRect.top]);
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  _closeDimBox() {
    if (this._dim && this._dim.box && this._dim.box.parentNode) {
      this._dim.box.parentNode.removeChild(this._dim.box);
    }
    this._dim = null;
  }

  // =====================================================================
  //  Overlay rendering
  // =====================================================================

  _disposeChildren(group) {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child.geometry) { child.geometry.dispose(); }
      if (child.material) { child.material.dispose(); }
    }
  }

  _makeLine(points, color, opacity = 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color, transparent: opacity < 1, opacity, depthTest: false,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 998;
    return line;
  }

  /** Dashed line for reference geometry (dash length tracks zoom). */
  _makeDashedLine(points, color, opacity = 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const dash = this._pixelWorld(6);
    const mat = new THREE.LineDashedMaterial({
      color, transparent: true, opacity, depthTest: false,
      dashSize: dash, gapSize: dash * 0.7,
    });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    line.renderOrder = 998;
    return line;
  }

  _entityPoints(ent) {
    const def = this._def;
    if (ent.type === 'line') { return [def.toThree(...ent.a), def.toThree(...ent.b)]; }
    const a0 = ent.type === 'circle' ? 0 : ent.a0;
    const a1 = ent.type === 'circle' ? TAU : ent.a1;
    const n = Math.max(12, Math.ceil(48 * (a1 - a0) / TAU));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const ang = a0 + (a1 - a0) * i / n;
      pts.push(def.toThree(...arcPt(ent, ang)));
    }
    return pts;
  }

  /** Canvas-text sprite for constraint glyphs / dimension values. Textures
   *  are cached per (text, color); materials are per-sprite and disposable. */
  _textSprite(text, color) {
    const key = text + '|' + color;
    let entry = this._texCache.get(key);
    if (!entry) {
      const canvas = document.createElement('canvas');
      let ctx = canvas.getContext('2d');
      const font = '26px "Segoe UI", system-ui, sans-serif';
      ctx.font = font;
      canvas.width = Math.ceil(ctx.measureText(text).width) + 14;
      canvas.height = 36;
      ctx = canvas.getContext('2d'); // resize resets state
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(17, 17, 17, 0.65)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;
      ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      entry = { tex, aspect: canvas.width / canvas.height };
      this._texCache.set(key, entry);
    }
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: entry.tex, depthTest: false, transparent: true,
    }));
    spr.userData.aspect = entry.aspect;
    spr.renderOrder = 999;
    return spr;
  }

  /** Midpoint + outward offset direction for placing an entity's glyphs. */
  _entGlyphPos(ent) {
    if (ent.type === 'line') {
      const m = lerp2(ent.a, ent.b, 0.5);
      const L = dist2(ent.a, ent.b) || 1;
      return { base: m, dir: [-(ent.b[1] - ent.a[1]) / L, (ent.b[0] - ent.a[0]) / L] };
    }
    const ang = ent.type === 'circle' ? Math.PI / 4 : (ent.a0 + ent.a1) / 2;
    return { base: arcPt(ent, ang), dir: [Math.cos(ang), Math.sin(ang)] };
  }

  _renderEntities() {
    if (!this._entityGroup) { return; }
    this._disposeChildren(this._entityGroup);
    const def = this._def;
    const selEnts = new Set(this._sel.filter(s => s.kind === 'ent').map(s => s.id));
    const selPts = new Set(this._sel.filter(s => s.kind === 'pt').map(s => s.id));
    const selCons = new Set(this._sel.filter(s => s.kind === 'con').map(s => s.id));

    for (const ent of this.entities) {
      const isSel = selEnts.has(ent.id) ||
        (this._dim && (ent.id === this._dim.aId || ent.id === this._dim.bId));
      if (ent.ref) {
        this._entityGroup.add(this._makeDashedLine(this._entityPoints(ent),
          isSel ? COLOR_ACCENT : 0x9e9e9e, isSel ? 0.95 : 0.5));
      } else {
        this._entityGroup.add(this._makeLine(this._entityPoints(ent), isSel ? COLOR_ACCENT : COLOR_ENTITY));
      }
    }

    // Endpoint/center markers (selectable, draggable)
    if (this.points.length) {
      const norm = [], sel = [];
      for (const r of this.points) {
        (selPts.has(r.id) ? sel : norm).push(def.toThree(r.p[0], r.p[1]));
      }
      const mkPts = (pts, size, color) => {
        if (!pts.length) { return; }
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const m = new THREE.Points(g, new THREE.PointsMaterial({
          color, size, sizeAttenuation: false, depthTest: false,
        }));
        m.renderOrder = 999;
        this._entityGroup.add(m);
      };
      mkPts(norm, 5, 0xbdbdbd);
      mkPts(sel, 9, COLOR_ACCENT);
    }

    // Constraint glyphs (relations + dimension values), stacked per entity
    this._glyphHits = [];
    const glyphSize = this._pixelWorld(16);
    const stack = new Map();
    const place = (key, base, dir) => {
      const n = stack.get(key) || 0;
      stack.set(key, n + 1);
      const off = this._pixelWorld(10) + glyphSize * (n + 0.5) + (n > 0 ? this._pixelWorld(2) * n : 0);
      return [base[0] + dir[0] * off, base[1] + dir[1] * off];
    };

    for (const con of this.constraints) {
      const isDim = con.type === 'length' || con.type === 'radius' || con.type === 'dist';
      let label = GLYPHS[con.type];
      const targets = [];

      if (con.type === 'anchor') {
        const p = this._ptById(con.ptId);
        if (p) { targets.push({ key: 'p' + con.ptId, base: p, dir: [0.75, 0.75] }); }
      } else if (isDim) {
        label = (con.varName ? con.varName + '=' : '') + fmt(con.value);
        if (con.type === 'radius') { label = 'R ' + label; }
        if (con.type === 'dist') {
          const A = this._ent(con.aId), B = this._ent(con.bId);
          if (A && B) {
            const mA = this._entGlyphPos(A).base, mB = this._entGlyphPos(B).base;
            targets.push({ key: 'c' + con.id, base: lerp2(mA, mB, 0.5), dir: [0, 0] });
          }
        } else {
          const ent = this._ent(con.entId);
          if (ent) { const g = this._entGlyphPos(ent); targets.push({ key: 'e' + ent.id, ...g }); }
        }
      } else if (con.entId !== undefined) {
        const ent = this._ent(con.entId);
        if (ent) { const g = this._entGlyphPos(ent); targets.push({ key: 'e' + ent.id, ...g }); }
      } else {
        for (const id of [con.aId, con.bId]) {
          const ent = this._ent(id);
          if (ent) { const g = this._entGlyphPos(ent); targets.push({ key: 'e' + ent.id, ...g }); }
        }
      }
      if (!label) { continue; }

      const color = con.unsat ? GLYPH_BAD
        : selCons.has(con.id) ? GLYPH_SEL
        : isDim ? GLYPH_DIM : GLYPH_REL;
      for (const t of targets) {
        const pos = place(t.key, t.base, t.dir);
        const spr = this._textSprite(label, color);
        spr.scale.set(glyphSize * spr.userData.aspect, glyphSize, 1);
        spr.position.copy(def.toThree(pos[0], pos[1]));
        this._entityGroup.add(spr);
        this._glyphHits.push({
          x: pos[0], y: pos[1],
          hw: glyphSize * spr.userData.aspect / 2, hh: glyphSize / 2,
          conId: con.id,
        });
      }
    }

    this._env.viewDirty = true;
  }

  _renderPreview() {
    if (!this._previewGroup) { return; }
    this._disposeChildren(this._previewGroup);
    const def = this._def;
    const cur = this._cursor;

    if (cur) {
      // Snap marker
      const geo = new THREE.BufferGeometry().setFromPoints([def.toThree(...cur)]);
      const marker = new THREE.Points(geo, new THREE.PointsMaterial({
        color: COLOR_ACCENT, size: this._cursorSnapped ? 10 : 6, sizeAttenuation: false, depthTest: false,
      }));
      marker.renderOrder = 999;
      this._previewGroup.add(marker);
    }

    if (cur && this.tool === 'line' && this._chainPrev) {
      this._previewGroup.add(this._makeLine([def.toThree(...this._chainPrev), def.toThree(...cur)], COLOR_ACCENT, 0.7));
    }
    if (cur && this.tool === 'rect' && this._rectStart) {
      const [x1, y1] = this._rectStart, [x2, y2] = cur;
      this._previewGroup.add(this._makeLine([
        def.toThree(x1, y1), def.toThree(x2, y1), def.toThree(x2, y2), def.toThree(x1, y2), def.toThree(x1, y1),
      ], COLOR_ACCENT, 0.7));
    }
    if (cur && this.tool === 'circle' && this._circleCenter) {
      const r = dist2(this._circleCenter, cur);
      if (r > PT_EPS) {
        const fake = { type: 'circle', c: this._circleCenter, r };
        this._previewGroup.add(this._makeLine(this._entityPoints(fake), COLOR_ACCENT, 0.7));
      }
    }
    if (this.tool === 'trim' && this._hoverTrim) {
      const piece = this._hoverTrim, ent = piece.ent;
      let pts = null;
      if (piece.whole) { pts = this._entityPoints(ent); }
      else if (ent.type === 'line') {
        pts = [def.toThree(...lerp2(ent.a, ent.b, piece.lo)), def.toThree(...lerp2(ent.a, ent.b, piece.hi))];
      } else if (ent.type === 'circle') {
        const sweep = norm2pi(piece.aHi - piece.aLo) || TAU;
        pts = this._entityPoints({ type: 'arc', c: ent.c, r: ent.r, a0: piece.aLo, a1: piece.aLo + sweep });
      } else {
        pts = this._entityPoints({ type: 'arc', c: ent.c, r: ent.r, a0: piece.arcLo, a1: piece.arcHi });
      }
      if (pts) { this._previewGroup.add(this._makeLine(pts, COLOR_REMOVE)); }
    }

    this._env.viewDirty = true;
  }

  // =====================================================================
  //  Code emission
  // =====================================================================

  /** Group line/arc entities into connected chains (ordered segment walks).
   *  Reference geometry never emits. */
  _buildChains() {
    const segs = this.entities.filter(e => !e.ref && (e.type === 'line' || e.type === 'arc'));
    const key = (p) => p[0].toFixed(3) + ',' + p[1].toFixed(3);
    const ends = (e) => e.type === 'line' ? [e.a, e.b] : [arcPt(e, e.a0), arcPt(e, e.a1)];

    const adj = new Map(); // vertexKey → [{ent, endIndex}]
    for (const e of segs) {
      ends(e).forEach((p, i) => {
        const k = key(p);
        if (!adj.has(k)) { adj.set(k, []); }
        adj.get(k).push({ ent: e, endIndex: i });
      });
    }

    const used = new Set();
    const chains = [];
    const walkFrom = (startEnt, startEndIndex) => {
      const chain = [];
      let ent = startEnt, entry = startEndIndex;
      while (ent && !used.has(ent.id)) {
        used.add(ent.id);
        const [e0, e1] = ends(ent);
        const from = entry === 0 ? e0 : e1;
        const to = entry === 0 ? e1 : e0;
        chain.push({ ent, from, to });
        const nexts = (adj.get(key(to)) || []).filter(x => !used.has(x.ent.id));
        if (nexts.length === 0) { break; }
        ent = nexts[0].ent;
        entry = nexts[0].endIndex;
      }
      return chain;
    };

    // Open chains first (start from degree-1 vertices), then closed loops
    for (const [k, list] of adj) {
      if (list.length !== 1) { continue; }
      const { ent, endIndex } = list[0];
      if (used.has(ent.id)) { continue; }
      chains.push(walkFrom(ent, endIndex));
    }
    for (const e of segs) {
      if (used.has(e.id)) { continue; }
      chains.push(walkFrom(e, 0));
    }

    return chains.filter(c => c.length > 0).map(chain => {
      const closed = chain.length > 1
        ? samePt(chain[0].from, chain[chain.length - 1].to)
        : false;
      // Normalize winding to counter-clockwise: the kernel builds the face
      // directly on the wire, so a clockwise profile yields a face whose
      // normal points away from the viewer (renders as a dark "shadow" and
      // extrudes inside-out). The walk direction is arbitrary — fix it here.
      const poly = [];
      for (const s of chain) {
        poly.push(s.from);
        if (s.ent.type === 'arc') { poly.push(arcPt(s.ent, (s.ent.a0 + s.ent.a1) / 2)); }
      }
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        area += p[0] * q[1] - q[0] * p[1];
      }
      if (area < 0) {
        chain.reverse();
        for (const s of chain) { const t = s.from; s.from = s.to; s.to = t; }
      }
      return { segs: chain, closed };
    });
  }

  /** Is point p inside the polygon approximated by a chain's vertices? */
  _pointInChain(p, chain) {
    const poly = chain.segs.map(s => s.from);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) &&
          p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** Endpoint expression for a line with a length variable attached. */
  _lineEndExpr(seg) {
    const name = seg.ent.lenVar;
    const [px, py] = seg.from, [qx, qy] = seg.to;
    const L = dist2(seg.from, seg.to);
    if (L < 1e-9 || !name) { return `[${fmt(qx)}, ${fmt(qy)}]`; }
    const ux = (qx - px) / L, uy = (qy - py) / L;
    const term = (base, u) => {
      if (Math.abs(u) < 1e-9) { return fmt(base); }
      const mag = Math.abs(Math.abs(u) - 1) < 1e-9 ? name : `${name}*${fmt(Math.abs(u))}`;
      if (Math.abs(base) < 1e-9) { return (u < 0 ? '-' : '') + mag; }
      return `${fmt(base)} ${u < 0 ? '-' : '+'} ${mag}`;
    };
    return `[${term(px, ux)}, ${term(py, uy)}]`;
  }

  _nextSketchIndex() {
    const code = this._app.editor.getCode();
    let max = 0;
    for (const m of code.matchAll(/\bsketch(\d+)\b/g)) {
      max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
  }

  _emitCode() {
    const def = this._def;
    const vec = (v) => `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;
    let planeArg, header;
    if (def.key) {
      planeArg = def.key === 'XY' ? '' : `, '${def.key}'`;
      header = `// --- Sketch (${def.key} plane) ---`;
    } else {
      // Baked face plane: origin + normal + xDir are literals, so the sketch
      // stays put even if the underlying body later changes (code is the artifact).
      planeArg = `, { origin: ${vec(def.occOrigin)}, normal: ${vec(def.occNormal)}, xDir: ${vec(def.occX)} }`;
      header = `// --- Sketch (on face @ ${vec(def.occOrigin)}) ---`;
    }
    const existing = this._app.editor.getCode();
    const out = [];
    out.push(header);

    // Named dimensions become variables; length/radius dims bind the emitted
    // literal to the variable name
    for (const e of this.entities) { delete e.lenVar; delete e.rVar; }
    const variables = [];
    for (const c of this.constraints) {
      if (!c.varName) { continue; }
      if (!variables.some(v => v.name === c.varName)) {
        variables.push({ name: c.varName, value: c.value });
      }
      const ent = c.entId !== undefined ? this._ent(c.entId) : null;
      if (c.type === 'length' && ent) { ent.lenVar = c.varName; }
      if (c.type === 'radius' && ent) { ent.rVar = c.varName; }
    }

    for (const v of variables) {
      if (new RegExp('\\b(let|const|var)\\s+' + v.name + '\\b').test(existing)) {
        out.push(`// (dimension uses existing variable "${v.name}")`);
      } else {
        out.push(`let ${v.name} = ${fmt(v.value)};`);
      }
    }

    const chains = this._buildChains();
    const circles = this.entities.filter(e => e.type === 'circle' && !e.ref);

    // Circles inside a closed chain become holes of that chain's face
    const holesByChain = new Map();
    const standalone = [];
    for (const c of circles) {
      const host = chains.find(ch => ch.closed && this._pointInChain(c.c, ch));
      if (host) {
        if (!holesByChain.has(host)) { holesByChain.set(host, []); }
        holesByChain.get(host).push(c);
      } else {
        standalone.push(c);
      }
    }

    let idx = this._nextSketchIndex();
    for (const chain of chains) {
      const name = `sketch${idx++}`;
      const v0 = chain.segs[0].from;
      if (!chain.closed) { out.push(`// note: open profile — End(true) closes it back to the start point`); }
      let s = `let ${name} = new Sketch([${fmt(v0[0])}, ${fmt(v0[1])}]${planeArg})`;
      for (const seg of chain.segs) {
        if (seg.ent.type === 'line') {
          s += `\n  .LineTo(${this._lineEndExpr(seg)})`;
        } else {
          const e = seg.ent;
          const mid = arcPt(e, (e.a0 + e.a1) / 2);
          s += `\n  .ArcTo([${fmt(mid[0])}, ${fmt(mid[1])}], [${fmt(seg.to[0])}, ${fmt(seg.to[1])}])`;
        }
      }
      s += `\n  .End(true)`;
      for (const hole of (holesByChain.get(chain) || [])) {
        const rExpr = hole.rVar || fmt(hole.r);
        s += `\n  .Circle([${fmt(hole.c[0])}, ${fmt(hole.c[1])}], ${rExpr}, true)`;
      }
      s += `.Face();`;
      out.push(s);
    }

    for (const c of standalone) {
      const name = `sketch${idx++}`;
      const rExpr = c.rVar || fmt(c.r);
      out.push(`let ${name} = new Sketch([${fmt(c.c[0])}, ${fmt(c.c[1])}]${planeArg}).Circle([${fmt(c.c[0])}, ${fmt(c.c[1])}], ${rExpr}).Face();`);
    }

    return out.join('\n');
  }
}

export { SketchMode };
