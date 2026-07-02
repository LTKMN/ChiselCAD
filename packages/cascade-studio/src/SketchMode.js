// SketchMode.js — in-viewport sketching, SolidWorks-style: pick a plane, draw
// with line/rect/circle/trim/dimension tools, then commit the result to code.
// The GUI is for creation; the emitted `new Sketch(...)` block is the artifact
// the user edits afterward. Mouse-derived points snap to round numbers; values
// typed into the dimension box are sacred and emitted exactly as given.

import * as THREE from 'three';

const TAU = Math.PI * 2;
const PT_EPS = 1e-3; // endpoint coincidence tolerance (1 micron)

// Sketch planes. `toThree` maps sketch (a,b) → Three.js world coords using the
// same OCC Z-up → Three Y-up convention as the model group (-PI/2 X rotation):
// OCC (x,y,z) → Three (x, z, -y).
const PLANES = {
  XY: {
    label: 'Top (XY)',
    toThree: (a, b) => new THREE.Vector3(a, 0, -b),
    fromThree: (p) => [p.x, -p.z],
    normal: new THREE.Vector3(0, 1, 0),
    camUp: new THREE.Vector3(0, 0, -1),
    orientGrid: (g) => {},
  },
  XZ: {
    label: 'Front (XZ)',
    toThree: (a, b) => new THREE.Vector3(a, b, 0),
    fromThree: (p) => [p.x, p.y],
    normal: new THREE.Vector3(0, 0, 1),
    camUp: new THREE.Vector3(0, 1, 0),
    orientGrid: (g) => { g.rotation.x = Math.PI / 2; },
  },
  YZ: {
    label: 'Right (YZ)',
    toThree: (a, b) => new THREE.Vector3(0, b, -a),
    fromThree: (p) => [-p.z, p.y],
    normal: new THREE.Vector3(1, 0, 0),
    camUp: new THREE.Vector3(0, 1, 0),
    orientGrid: (g) => { g.rotation.z = Math.PI / 2; },
  },
};

const TOOLS = [
  { id: 'select', icon: '➤', label: 'Select', hint: 'Click an element to select it • Delete removes it' },
  { id: 'line',   icon: '╱', label: 'Line',   hint: 'Click to chain lines • click the start point to close • Enter / right-click ends the chain' },
  { id: 'rect',   icon: '▭', label: 'Rect',   hint: 'Click two opposite corners' },
  { id: 'circle', icon: '◯', label: 'Circle', hint: 'Click the center, then a point on the circle' },
  { id: 'trim',   icon: '✂', label: 'Trim',   hint: 'Click the piece of an element to remove (cut at intersections)' },
  { id: 'dim',    icon: '↔', label: 'Dimension', hint: 'Click an element (then optionally a second) • type a value, or a name to create a variable' },
];

const COLOR_ENTITY = 0xe8e8e8;
const COLOR_ACCENT = 0x4CAF50;
const COLOR_REMOVE = 0xff7043;

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

class SketchMode {
  constructor(app) {
    this._app = app;
    this.active = false;
    this.plane = 'XY';
    this.entities = [];
    this.variables = [];   // [{name, value}] created via the dimension box
    this.tool = 'line';
    this._nextId = 1;
    this._undoStack = [];

    // In-progress tool state
    this._chainPrev = null;    // last placed point of the active line chain
    this._chainStart = null;   // first point of the active line chain
    this._rectStart = null;
    this._circleCenter = null;
    this._cursor = null;       // current snapped cursor position
    this._cursorSnapped = false;
    this._hoverTrim = null;    // {ent, ...piece} preview for the trim tool
    this._selectedId = null;
    this._dim = null;          // {aId, bId|null, box, input, info}

    this._raycaster = new THREE.Raycaster();
    this._buildPlanePopover();
  }

  get _vp() { return this._app.viewport; }
  get _env() { return this._app.viewport ? this._app.viewport.environment : null; }
  get _def() { return PLANES[this.plane]; }

  // =====================================================================
  //  Session lifecycle
  // =====================================================================

  begin(planeKey) {
    if (this.active || !this._vp || !this._featureRow) { return; }
    this._endPick();
    this.active = true;
    this.plane = planeKey;
    this.entities = [];
    this.variables = [];
    this._undoStack = [];
    this._nextId = 1;
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

    // Canvas + keyboard listeners
    const canvas = env.renderer.domElement;
    this._listeners = [
      [canvas, 'mousedown', (e) => this._onMouseDown(e)],
      [canvas, 'mousemove', (e) => this._onMouseMove(e)],
      [canvas, 'dblclick', (e) => { e.preventDefault(); this._endChain(); }],
      [canvas, 'contextmenu', (e) => this._onContextMenu(e)],
      [window, 'keydown', (e) => this._onKeyDown(e)],
    ];
    this._listeners.forEach(([el, ev, fn]) => el.addEventListener(ev, fn));
    canvas.style.cursor = 'crosshair';

    // Swap the command bar to sketch tools
    this._featureRow.style.display = 'none';
    this._sketchRow.style.display = 'flex';
    this._hint.style.display = '';
    this._planeBadge.textContent = this.plane + ' · ' + this._def.label.split(' ')[0];

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
    this._featureRow.style.display = 'flex';
    this._hint.style.display = 'none';
  }

  _resetToolState() {
    this._chainPrev = null;
    this._chainStart = null;
    this._rectStart = null;
    this._circleCenter = null;
    this._hoverTrim = null;
    this._selectedId = null;
    this._closeDimBox();
  }

  // =====================================================================
  //  Plane picker popover (shared, body-level so nothing clips it)
  // =====================================================================

  _buildPlanePopover() {
    const pop = document.createElement('div');
    pop.className = 'cs-plane-pop';
    pop.style.display = 'none';
    for (const key of Object.keys(PLANES)) {
      const item = document.createElement('a');
      item.href = '#';
      item.textContent = PLANES[key].label;
      item.addEventListener('click', (e) => {
        e.preventDefault();
        pop.style.display = 'none';
        this.begin(key);
      });
      pop.appendChild(item);
    }
    document.body.appendChild(pop);
    this._planePop = pop;

    document.addEventListener('mousedown', (e) => {
      if (pop.style.display !== 'none' && !pop.contains(e.target) && e.target !== this._sketchBtn) {
        pop.style.display = 'none';
      }
    });
  }

  _togglePlanePopover(btn) {
    const pop = this._planePop;
    if (pop.style.display === 'none') {
      const r = btn.getBoundingClientRect();
      pop.style.left = r.left + 'px';
      pop.style.top = (r.bottom + 4) + 'px';
      pop.style.display = 'block';
    } else {
      pop.style.display = 'none';
    }
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

    // --- Hint line ---
    this._hint = document.createElement('div');
    this._hint.className = 'cs-featbar-hint';
    this._hint.style.display = 'none';

    bar.appendChild(featureRow);
    bar.appendChild(sketchRow);
    bar.appendChild(this._hint);
    this._featureRow = featureRow;
    this._sketchRow = sketchRow;
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

  // =====================================================================
  //  Feature buttons — emit code templates targeting the latest sketch /
  //  solids, with the key value pre-selected for immediate editing
  // =====================================================================

  /** Sketch variables declared at the top level, in order: [{name, plane}].
   *  Line-start anchored so block-scoped declarations don't leak in. */
  _findSketches(code) {
    const seen = new Map(); // name → plane, insertion order = recency
    const re = /^let\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Sketch\s*\(\s*\[[^\]]*\]\s*(?:,\s*['"](XY|XZ|YZ)['"])?/gm;
    for (const m of code.matchAll(re)) {
      seen.delete(m[1]);
      seen.set(m[1], m[2] || 'XY');
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

  /** Extrude direction that grows toward the side the sketch was drawn from. */
  _extrudeDirFor(plane) {
    return { XY: '[0, 0, 20]', XZ: '[0, -20, 0]', YZ: '[20, 0, 0]' }[plane] || '[0, 0, 20]';
  }

  _runFeature(id, btn) {
    if (id === 'sketch') {
      if (!this.active) { this._togglePlanePopover(btn); }
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
        select = '20(?=[,\\]])';
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
        snippet = `let ${pathVar} = BSpline(${paths[lastSk.plane]}, false);\n` +
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
    const wrap = (n) => {
      const sk = sketchOf(n);
      return sk ? `Extrude(${n}, ${this._extrudeDirFor(sk.plane)})` : n;
    };
    const anyWrapped = picked.some(n => sketchOf(n));
    let snippet = null, select = anyWrapped ? '20(?=[,\\]])' : null;

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
        snippet = `let ${nv('solid')} = Difference(${wrap(picked[0])}, [${wrap(picked[1])}]);`;
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
    this._selectedId = null;
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
    const target = new THREE.Vector3(0, 0, 0);
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
  //  Static overlay (plane grid + origin marker)
  // =====================================================================

  _buildStaticOverlay() {
    const grid = new THREE.GridHelper(500, 50, 0x4CAF50, 0x888888);
    grid.material.transparent = true;
    grid.material.opacity = 0.12;
    this._def.orientGrid(grid);
    this._staticGroup.add(grid);

    // Origin cross in the sketch plane
    const mk = (a, b) => this._def.toThree(a, b);
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
    const plane = new THREE.Plane(this._def.normal, 0);
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
   *  Returns {pt, onPoint} — onPoint means an exact-coordinate snap was hit. */
  _snap(raw, shiftKey) {
    const tol = this._pixelWorld(10);
    const candidates = [[0, 0]];
    for (const ent of this.entities) {
      if (ent.type === 'line') { candidates.push(ent.a, ent.b); }
      else if (ent.type === 'circle') { candidates.push(ent.c); }
      else if (ent.type === 'arc') { candidates.push(ent.c, arcPt(ent, ent.a0), arcPt(ent, ent.a1)); }
    }
    if (this._chainStart) { candidates.push(this._chainStart); }
    let best = null, bestD = tol;
    for (const c of candidates) {
      const d = dist2(raw, c);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) { return { pt: [best[0], best[1]], onPoint: true }; }
    const step = shiftKey ? 0.1 : 1; // Shift = fine snap
    return {
      pt: [Math.round(raw[0] / step) * step, Math.round(raw[1] / step) * step],
      onPoint: false,
    };
  }

  // =====================================================================
  //  Mouse handlers
  // =====================================================================

  _onMouseMove(e) {
    if (!this.active) { return; }
    const raw = this._eventToSketchRaw(e);
    if (!raw) { return; }
    const snap = this._snap(raw, e.shiftKey);
    this._cursor = snap.pt;
    this._cursorSnapped = snap.onPoint;

    if (this.tool === 'trim') {
      this._hoverTrim = this._trimPieceAt(raw);
    }
    this._renderPreview();
  }

  _onMouseDown(e) {
    if (!this.active || e.button !== 0) { return; }
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
          this.entities.push({ id: this._nextId++, type: 'line', a: this._chainPrev, b: pt });
          if (this._chainStart && samePt(pt, this._chainStart)) {
            this._endChain(); // closed the loop
          } else {
            this._chainPrev = pt;
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
            const c = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
            for (let i = 0; i < 4; i++) {
              this.entities.push({ id: this._nextId++, type: 'line', a: c[i], b: c[(i + 1) % 4] });
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
            this.entities.push({ id: this._nextId++, type: 'circle', c: this._circleCenter, r: r });
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
        const hit = this._hitEntity(raw);
        this._selectedId = hit ? hit.ent.id : null;
        this._renderEntities();
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
      if (this._dim) { this._closeDimBox(); }
      else if (this._chainPrev || this._rectStart || this._circleCenter) {
        this._endChain();
        this._rectStart = null;
        this._circleCenter = null;
      } else if (this.tool !== 'select') {
        this.setTool('select');
      }
      this._renderPreview();
    } else if (e.key === 'Enter') {
      this._endChain();
      this._renderPreview();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.tool === 'select' && this._selectedId !== null) {
      this._pushUndo();
      this.entities = this.entities.filter(en => en.id !== this._selectedId);
      this._selectedId = null;
      this._renderEntities();
      this._renderPreview();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      this._undo();
    } else if (e.ctrlKey || e.metaKey || e.altKey) { /* leave browser/app combos alone */ }
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

  _pushUndo() {
    this._undoStack.push(JSON.stringify({ entities: this.entities, variables: this.variables }));
    if (this._undoStack.length > 100) { this._undoStack.shift(); }
  }

  _undo() {
    const snap = this._undoStack.pop();
    if (!snap) { return; }
    const state = JSON.parse(snap);
    this.entities = state.entities;
    this.variables = state.variables;
    this._selectedId = null;
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
      if (o.id === ent.id) { continue; }
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
      if (o.id === ent.id) { continue; }
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
    if (!hit) { return null; }
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

    if (piece.whole) { return; }

    if (ent.type === 'line') {
      if (piece.lo > 1e-6) {
        this.entities.push({ id: this._nextId++, type: 'line', a: ent.a, b: lerp2(ent.a, ent.b, piece.lo) });
      }
      if (piece.hi < 1 - 1e-6) {
        this.entities.push({ id: this._nextId++, type: 'line', a: lerp2(ent.a, ent.b, piece.hi), b: ent.b });
      }
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

    const info = this._dimInfo(hit.ent.id, null);
    if (!info) { return; }
    this._openDimBox(e, hit.ent.id, info);
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
        return { kind: 'distance', value: Math.abs(d), dir: d >= 0 ? nUnit : scale2(nUnit, -1), aId, bId };
      }
    }
    const delta = sub2(anchor(B), anchor(A));
    const d = len2(delta);
    if (d < 1e-9) { return null; }
    return { kind: 'distance', value: d, dir: scale2(delta, 1 / d), aId, bId };
  }

  /** Apply a new value. Typed values are exact — never rounded or snapped. */
  _applyDim(info, newValue, varName) {
    this._pushUndo();
    const A = this.entities.find(e => e.id === info.aId);
    if (!A) { return; }

    if (info.bId === null) {
      if (info.kind === 'length') {
        const L = dist2(A.a, A.b);
        if (L > 1e-9 && Math.abs(newValue - L) > 1e-12) {
          const u = scale2(sub2(A.b, A.a), 1 / L);
          const delta = scale2(u, newValue - L);
          const oldB = A.b.slice();
          A.b = add2(A.b, delta);
          this._stretchCoincident([oldB], delta, A.id);
        }
        if (varName) { A.lenVar = varName; }
      } else {
        A.r = newValue;
        if (varName) { A.rVar = varName; }
      }
    } else {
      const B = this.entities.find(e => e.id === info.bId);
      if (B) {
        const delta = scale2(info.dir, newValue - info.value);
        this._translateEntity(B, delta);
      }
      if (varName) {
        console.log('Sketch: variable "' + varName + '" was created, but distance dimensions emit literal coordinates for now.');
      }
    }
    if (varName) { this.variables.push({ name: varName, value: newValue }); }
    this._renderEntities();
  }

  /** Move a whole entity; line endpoints drag coincident line endpoints along
   *  (simple stretch — keeps rectangles closed when one side moves). */
  _translateEntity(e, delta) {
    if (e.type === 'line') {
      const olds = [e.a.slice(), e.b.slice()];
      e.a = add2(e.a, delta);
      e.b = add2(e.b, delta);
      this._stretchCoincident(olds, delta, e.id);
    } else {
      e.c = add2(e.c, delta);
    }
  }

  _stretchCoincident(oldPts, delta, excludeId) {
    for (const o of this.entities) {
      if (o.id === excludeId || o.type !== 'line') { continue; }
      for (const p of oldPts) {
        if (samePt(o.a, p)) { o.a = add2(o.a, delta); }
        if (samePt(o.b, p)) { o.b = add2(o.b, delta); }
      }
    }
  }

  _openDimBox(e, aId, info) {
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
    input.value = fmt(info.value);
    input.title = 'Enter a value, a name (creates a variable), or name=value';
    box.appendChild(input);
    panel.appendChild(box);

    this._dim = { aId, bId: null, box, input, info };
    this._selectedId = aId;

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
      this._closeDimBox();
      this._applyDim(info, value, varName);
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

  _renderEntities() {
    if (!this._entityGroup) { return; }
    this._disposeChildren(this._entityGroup);
    for (const ent of this.entities) {
      const isSel = ent.id === this._selectedId || (this._dim && (ent.id === this._dim.aId || ent.id === this._dim.bId));
      this._entityGroup.add(this._makeLine(this._entityPoints(ent), isSel ? COLOR_ACCENT : COLOR_ENTITY));
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

  /** Group line/arc entities into connected chains (ordered segment walks). */
  _buildChains() {
    const segs = this.entities.filter(e => e.type === 'line' || e.type === 'arc');
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
    const planeArg = this.plane === 'XY' ? '' : `, '${this.plane}'`;
    const existing = this._app.editor.getCode();
    const out = [];
    out.push(`// --- Sketch (${this.plane} plane) ---`);

    for (const v of this.variables) {
      if (new RegExp('\\b(let|const|var)\\s+' + v.name + '\\b').test(existing)) {
        out.push(`// (dimension uses existing variable "${v.name}")`);
      } else {
        out.push(`let ${v.name} = ${fmt(v.value)};`);
      }
    }

    const chains = this._buildChains();
    const circles = this.entities.filter(e => e.type === 'circle');

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
