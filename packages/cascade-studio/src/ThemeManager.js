/**
 * ThemeManager — Blender interface-theme (.xml) import.
 *
 * Parses the named hex colors out of a Blender theme XML (wcol_regular,
 * view_3d gradients, panel colors, edge/object selection colors) and maps
 * them onto:
 *   - the app's `--cs-*` CSS custom properties (all UI chrome follows), and
 *   - the Three.js viewport (background gradient, infinite grid,
 *     wire/edge-select colors, click-to-code glow), and
 *   - the sketch-mode overlay palette.
 *
 * Import paths: File ▾ → "Import Blender Theme…", or drag a .xml onto the
 * window. The theme persists in localStorage and reapplies on startup and
 * whenever the viewport panel is recreated.
 */

import { applySketchTheme } from './SketchMode.js';

const STORAGE_KEY = 'chisel-blender-theme';

/** The Blender theme that ships as the app's default look (copied into dist
 *  by the build from brennan_2021.xml at the monorepo root). Loaded when no
 *  imported theme is saved; "Reset Theme" returns to it. If the fetch or
 *  parse fails, the hardcoded dark palette in main.css/VIEWPORT_DEFAULTS
 *  simply stays in effect. */
const DEFAULT_THEME_URL = './default-theme.xml';

/** The built-in dark theme's viewport colors (mirrors the hardcoded
 *  defaults in CascadeView). Used when no Blender theme is active. */
export const VIEWPORT_DEFAULTS = {
  bgTop: '#222222',      // equal top/bottom = solid background
  bgBottom: '#222222',
  grid: '#cccccc',
  gridAlpha: 0.3,
  wire: '#000000',
  edgeSelect: '#ffffff',
  glow: '#4CAF50',       // click-to-code line-highlight overlay
};

// ---------- color math (hex strings in, hex strings out) ----------

/** #rgb / #rrggbb / #rrggbbaa → {r,g,b,a} in 0..1. Returns null if invalid. */
function parseHex(str) {
  if (typeof str !== 'string') { return null; }
  const s = str.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{8}$/.test(s)) { return null; }
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16) / 255,
      g: parseInt(s[1] + s[1], 16) / 255,
      b: parseInt(s[2] + s[2], 16) / 255, a: 1,
    };
  }
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
    a: s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex(c) {
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}

/** Blend t of `b` into `a` (t=0 → a, t=1 → b), ignoring alpha. */
function mix(aHex, bHex, t) {
  const a = parseHex(aHex), b = parseHex(bHex);
  return toHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
}

/** Alpha-composite fg over bg, returning opaque hex. */
function over(fgHex, bgHex) {
  const f = parseHex(fgHex), b = parseHex(bgHex);
  if (!f) { return bgHex; }
  if (!b) { return toHex(f); }
  return toHex({
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
  });
}

export class ThemeManager {
  constructor(app) {
    this._app = app;
    this.theme = null;   // {name, css: {...}, view: {...}, sketch: {...}} or null (built-in)
    this._appliedCssKeys = [];
  }

  /** Load the persisted (or shipped default) theme and register the
   *  drag-and-drop handlers. */
  init() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        this.theme = JSON.parse(saved);
        this._applyCss();
        this._applySketch();
      }
    } catch (e) { this.theme = null; }
    if (!this.theme) { this._loadDefaultTheme(); }

    // Drag-and-drop: .xml → Blender theme, CAD files → import. Always claim
    // file drops so a stray drop can't navigate away and lose the project.
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer || e.dataTransfer.files.length === 0) { return; }
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      const xml = files.find(f => /\.xml$/i.test(f.name));
      if (xml) {
        xml.text().then((text) => this.loadXML(text, xml.name));
        return;
      }
      const cad = files.filter(f => /\.(step|stp|iges|igs|stl)$/i.test(f.name));
      if (cad.length > 0 && this._app.engine) { this._app.engine.importFiles(cad); }
    });
  }

  /** Parse a Blender theme XML string, apply it everywhere, and persist it. */
  loadXML(xmlText, name) {
    let theme;
    try {
      theme = ThemeManager.parseBlenderTheme(xmlText);
    } catch (e) {
      console.error('Could not read "' + name + '" as a Blender theme: ' + e.message);
      return;
    }
    theme.name = name || 'blender-theme.xml';
    this.theme = theme;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch (e) { /* private mode */ }
    this._applyCss();
    this._applySketch();
    this.applyToViewport();
    console.log('Applied Blender theme: ' + theme.name);
  }

  /** Read the theme file chosen in a hidden <input type=file>. */
  loadFromInput(inputId) {
    const input = document.getElementById(inputId);
    const file = input && input.files && input.files[0];
    if (!file) { return; }
    file.text().then((text) => this.loadXML(text, file.name));
    input.value = '';  // allow re-importing the same file
  }

  /** Return to the shipped default theme (or the hardcoded dark palette if
   *  the default theme file is missing). */
  reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    this.theme = null;
    const rootStyle = document.documentElement.style;
    this._appliedCssKeys.forEach((k) => rootStyle.removeProperty(k));
    this._appliedCssKeys = [];
    this._applySketch();
    this.applyToViewport();
    this._loadDefaultTheme();
    console.log('Theme reset to default.');
  }

  /** Fetch and apply the shipped default theme without persisting it —
   *  it's the baseline, not an import. No-ops quietly if unavailable. */
  _loadDefaultTheme() {
    fetch(DEFAULT_THEME_URL)
      .then((r) => (r.ok ? r.text() : null))
      .then((text) => {
        if (!text || this.theme) { return; }  // an import won the race — keep it
        const theme = ThemeManager.parseBlenderTheme(text);
        theme.name = 'default (brennan_2021)';
        this.theme = theme;
        this._applyCss();
        this._applySketch();
        this.applyToViewport();
      })
      .catch(() => { /* no default theme shipped — hardcoded dark stays */ });
  }

  /** Push the active theme's viewport colors into the current viewport.
   *  Called after import/reset and whenever the viewport is recreated. */
  applyToViewport() {
    const vp = this._app.viewport;
    if (vp && vp.applyViewportTheme) {
      vp.applyViewportTheme(this.theme ? this.theme.view : null);
    }
  }

  _applyCss() {
    if (!this.theme || !this.theme.css) { return; }
    const rootStyle = document.documentElement.style;
    this._appliedCssKeys = Object.keys(this.theme.css);
    for (const [key, value] of Object.entries(this.theme.css)) {
      rootStyle.setProperty(key, value);
    }
  }

  _applySketch() {
    applySketchTheme(this.theme ? this.theme.sketch : null);
  }

  /** Blender theme XML → {css, view, sketch}. Throws on unparseable input;
   *  individual missing colors fall back to the built-in palette so partial
   *  or unusual theme files still apply what they have. */
  static parseBlenderTheme(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) { throw new Error('not valid XML'); }

    // Attribute reader: returns an opaque hex (#rrggbb) or the fallback.
    const at = (el, attrName, fallback) => {
      const c = el && parseHex(el.getAttribute(attrName));
      return c ? toHex(c) : fallback;
    };
    // Like `at`, but keeps alpha info: returns {hex, a} or null.
    const atA = (el, attrName) => {
      const c = el && parseHex(el.getAttribute(attrName));
      return c ? { hex: toHex(c), a: c.a } : null;
    };

    const q = (sel) => doc.querySelector(sel);
    const regular = q('wcol_regular > ThemeWidgetColors');
    const v3d     = q('view_3d > ThemeView3D');
    const space   = q('view_3d ThemeSpaceGradient, view_3d ThemeSpaceGeneric');
    const grad    = q('view_3d ThemeGradientColors');
    const panel   = q('view_3d ThemePanelColors');
    if (!regular && !v3d) { throw new Error('no <wcol_regular> or <ThemeView3D> found — is this a Blender interface theme?'); }

    // --- UI chrome ---
    const bgPrimary = at(panel, 'back', '#222222');
    const headerRaw = panel && panel.getAttribute('header');  // keeps alpha for compositing
    const css = {};
    css['--cs-bg-primary']   = bgPrimary;
    css['--cs-bg-secondary'] = at(space, 'tab_back', mix(bgPrimary, '#000000', 0.35));
    css['--cs-bg-surface']   = parseHex(headerRaw) ? over(headerRaw, bgPrimary) : mix(bgPrimary, '#ffffff', 0.05);
    css['--cs-bg-elevated']  = at(regular, 'inner', mix(bgPrimary, '#ffffff', 0.12));

    const text = at(space, 'text', at(regular, 'text', '#e6e6e6'));
    css['--cs-text-primary']   = at(space, 'text_hi', mix(text, '#ffffff', 0.5));
    css['--cs-text-secondary'] = text;
    css['--cs-text-muted']     = mix(text, bgPrimary, 0.5);

    const accent = at(regular, 'inner_sel', '#4CAF50');
    css['--cs-accent']        = accent;
    css['--cs-accent-hover']  = mix(accent, '#ffffff', 0.15);
    css['--cs-accent-dim']    = mix(accent, '#000000', 0.2);
    css['--cs-border']        = at(regular, 'outline', mix(bgPrimary, '#000000', 0.3));
    css['--cs-border-active'] = accent;
    css['--cs-scrollbar-thumb'] = mix(text, bgPrimary, 0.55);

    // --- 3D viewport ---
    // Blender gradient naming: high_gradient = top of screen, gradient = bottom.
    // background_type SINGLE_COLOR uses only `gradient`.
    const gradType = (grad && grad.getAttribute('background_type')) || 'SINGLE_COLOR';
    const bgBottom = at(grad, 'gradient', '#222222');
    const bgTop    = gradType === 'SINGLE_COLOR' ? bgBottom : at(grad, 'high_gradient', bgBottom);
    const gridC    = atA(v3d, 'grid') || { hex: VIEWPORT_DEFAULTS.grid, a: VIEWPORT_DEFAULTS.gridAlpha };
    const wire     = at(v3d, 'wire', VIEWPORT_DEFAULTS.wire);

    const view = {
      bgTop: bgTop,
      bgBottom: bgBottom,
      grid: gridC.hex,
      gridAlpha: Math.max(0.05, gridC.a),
      wire: wire,
      edgeSelect: at(v3d, 'edge_select', VIEWPORT_DEFAULTS.edgeSelect),
      glow: at(v3d, 'object_active', at(v3d, 'object_selected', VIEWPORT_DEFAULTS.glow)),
    };

    // --- Sketch-mode overlay ---
    // Edit-mode wires over the (possibly light) viewport background, with
    // Blender's selection orange for accents.
    const sketchAccent = at(v3d, 'edge_select', accent);
    const sketch = {
      entity: at(v3d, 'wire_edit', wire),
      accent: sketchAccent,
      // Point markers borrow Blender's vertex SELECT color (plain `vertex`
      // is usually black — invisible on a dark viewport background)
      vertex: at(v3d, 'vertex_select', '#ffa726'),
      glyphRel: mix(at(v3d, 'wire_edit', wire), bgBottom, 0.4),
      glyphDim: sketchAccent,
    };

    return { css: css, view: view, sketch: sketch };
  }
}
