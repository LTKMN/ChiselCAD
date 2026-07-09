// CascadeMain.js - ES Module
// This script governs the layout and initialization of all of the sub-windows

import { createDockview } from '../lib/dockview-core/dockview-core.js';
import { CascadeEnvironment } from './CascadeView.js';
import { CascadeEngine, OpenSCADTranspiler } from 'cascade-core';
import { EditorManager } from './EditorManager.js';
import { ConsoleManager } from './ConsoleManager.js';
import { GUIManager } from './GUIManager.js';
import { OpenSCADMonaco } from './openscad/OpenSCADMonaco.js';
import { CascadeAPI } from './CascadeAPI.js';
import { SketchMode } from './SketchMode.js';
import { ThemeManager } from './ThemeManager.js';
import { LLMIntegration } from './LLMIntegration.js';
import { LLMChat } from './LLMChat.js';
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

/** Adapter that wraps a dockview panel to provide a Golden-Layout-compatible container API.
 *  This minimizes changes needed in EditorManager, ConsoleManager, and CascadeView. */
class DockviewContainer {
  constructor(element, panelApi) {
    this.element = element;
    this._panelApi = panelApi;
    this._state = {};
    this._resizeCallbacks = [];

    panelApi.onDidDimensionsChange(() => {
      this._resizeCallbacks.forEach(cb => cb());
    });
  }

  get width()  { return this.element.offsetWidth; }
  get height() { return this.element.offsetHeight; }

  setState(obj) { this._state = obj; }
  getState()    { return this._state; }
  setTitle(title) { this._panelApi.setTitle(title); }

  on(event, callback) {
    if (event === 'resize') {
      this._resizeCallbacks.push(callback);
    }
  }

  // Stub for CascadeView's layoutManager access
  get layoutManager() {
    return {
      eventHub: { emit: () => {} },
      updateSize: () => {}
    };
  }
}

/** Main application class for Cascade Studio.
 *  Manages layout, editor, worker, and UI state. */
class CascadeStudioApp {
  constructor() {
    this.myLayout = null;
    this._dockviewApi = null;
    this.engine = null;
    this.editor = null;
    this.console = null;
    this.gui = null;
    this.viewport = null;
    this.api = null;
    this.startup = null;
    this.file = {};

    // OpenSCAD support
    this._openscadTranspiler = new OpenSCADTranspiler();
    this._openscadMonaco = new OpenSCADMonaco();

    window.workerWorking = false;
  }

  // Backward compatibility: messageBus accessor via engine
  get messageBus() { return this.engine ? this.engine.messageBus : null; }

  /** Start the application: create the engine, wire up events, and initialize. */
  start() {
    // Create the CascadeEngine (wraps Worker + MessageBus)
    const workerPath = typeof ESBUILD !== 'undefined' ? './cascade-worker.js' : './js/CADWorker/CascadeStudioMainWorker.js';
    this.engine = new CascadeEngine({ workerUrl: workerPath });

    // Create subsystem managers
    this.editor = new EditorManager(this);
    this.console = new ConsoleManager(this);
    this.gui = new GUIManager(this);

    // Backward compatibility: expose functions to window for inline HTML event handlers
    window.cascadeApp = this;
    window.saveProject = () => this.saveProject();
    window.loadProject = () => this.loadProject();
    window.loadFiles = (id) => this.loadFiles(id);
    window.clearExternalFiles = () => this.clearExternalFiles();

    // Blender theme import (File ▾ menu + drag-and-drop .xml onto the window)
    this.themeManager = new ThemeManager(this);
    this.themeManager.init();
    window.loadBlenderTheme = () => this.themeManager.loadFromInput('blenderTheme');
    window.resetTheme = () => this.themeManager.reset();

    // Blender-style viewport hotkeys:
    //   N            toggle the floating CAD control panel (sidebar key)
    //   7/1/3        top / front / right view (Shift = bottom / back / left)
    //   5            perspective ↔ orthographic
    // Routing is Blender-like: hovering the 3D canvas claims the keys even
    // while Monaco holds focus (click-to-code focuses the editor, which would
    // otherwise swallow every key after clicking a shape). Typing in a real
    // input/select always wins. View keys match both the number row and the
    // numpad (via e.code, since e.key for Shift+1 is '!'), and are disabled
    // while sketching — sketch mode owns the camera there.
    this._guiPanelHidden = false;
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) { return; }
      const t = e.target;
      const inMonaco = !!(t && t.closest && t.closest('.monaco-editor'));
      if (t && !inMonaco && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) { return; }
      const canvas = this.viewport && this.viewport.environment
        && this.viewport.environment.renderer.domElement;
      if (inMonaco && !(canvas && canvas.matches(':hover'))) { return; } // actually typing code
      if (e.key.toLowerCase() === 'n') {
        this._guiPanelHidden = !this._guiPanelHidden;
        const panel = document.getElementById('guiPanel');
        if (panel) { panel.style.display = this._guiPanelHidden ? 'none' : ''; }
        e.preventDefault(); // don't also type into the editor
        return;
      }

      if (!this.viewport || (this.sketchMode && this.sketchMode.active)) { return; }
      const digit = (e.code.match(/^(?:Digit|Numpad)([1357])$/) || [])[1];
      if (!digit) { return; }
      if (digit === '7') { this.viewport.setViewPreset(e.shiftKey ? 'bottom' : 'top'); }
      else if (digit === '1') { this.viewport.setViewPreset(e.shiftKey ? 'back' : 'front'); }
      else if (digit === '3') { this.viewport.setViewPreset(e.shiftKey ? 'left' : 'right'); }
      else if (digit === '5' && !e.shiftKey) { this.viewport.togglePerspective(); }
      else { return; }
      e.preventDefault(); // claimed by the viewport — don't type into the editor
    });

    // Install the programmatic API
    this.api = new CascadeAPI(this);
    this.api.install();

    // In-viewport sketching (topnav "New Sketch" button + tool ribbon)
    this.sketchMode = new SketchMode(this);

    // LLM provider connection (topnav "LLM ▾" menu; chat panel comes later).
    // Must init before initialize() below — the OpenRouter OAuth callback
    // returns ?code=..., which initialize() would misread as a shared project.
    this.llm = new LLMIntegration(this);
    this.llm.init();

    // AI assistant chat strip (mounted into the editor panel by EditorManager)
    this.llmChat = new LLMChat(this);

    // Register OpenSCAD language with Monaco (for syntax highlighting)
    this._openscadMonaco.registerLanguage();

    // Per-mode code stash for switchEditorMode (the mode select lives in the
    // editor panel's status bar and calls back into switchEditorMode)
    this._savedCode = {};

    // Initialize the engine (loads worker + WASM), then start the layout
    this.engine.init().then(() => {
      // The engine is ready — register event handlers and initialize the UI

      // Wire up engine events for GUI controls
      this.gui.registerHandlers(this.engine);

      // Wire up engine events for console (log, error, progress)
      this.engine.on('log', (payload) => { console.log(payload); });
      this.engine.on('error', (payload) => {
        window.workerWorking = false;
        console.error(payload);
      });
      this.engine.on('Progress', (payload) => {
        let el = this.console._consoleContainer?.parentElement?.lastElementChild?.lastElementChild;
        if (el) {
          el.innerText = "> Generating Model" + ".".repeat(payload.opNumber) + ((payload.opType) ? " (" + payload.opType + ")" : "");
        }
      });
      this.engine.on('resetWorking', () => { window.workerWorking = false; });

      // Wire up engine events for viewport
      this.engine.on('modelHistory', (steps) => {
        if (this.viewport) {
          this.viewport.setHistorySteps(steps);
        }
      });

      // Wire up file loading callback
      this.engine.on('loadFiles', (extFiles) => {
        console.log("Storing loaded files!");
        this.console.goldenContainer.setState(extFiles);
      });

      // Wire up file saving callback
      this.engine.on('saveFile', (payload) => {
        let link = document.createElement("a");
        link.href = payload.fileURL;
        link.download = payload.filename;
        link.click();
      });

      // Wire up transform handle creation
      this.engine.on('createTransformHandle', (payload) => {
        if (this.viewport && this.viewport.handleManager) {
          this.viewport.handleManager.createTransformHandle(payload);
        }
      });

      // Backward compat: expose messageHandlers to window
      window.messageHandlers = this.engine.messageBus.handlers;

      // Start the application with startup callback behavior
      this.startup = () => {
        let curState = this.console.goldenContainer?.getState();
        if (curState && Object.keys(curState).length > 0) {
          this.engine.loadPrexistingExternalFiles(curState);
        }
        this.editor.evaluateCode();
      };
      this.startup();
    });

    // Initialize the layout immediately (don't wait for WASM)
    this.initialize();
  }

  /** Initialize the layout and load project content. */
  initialize(projectContent = null) {
    let searchParams = new URLSearchParams(window.location.search || window.location.hash.substr(1));
    let loadFromURL = searchParams.has("code");

    let codeStr = CascadeStudioApp.STARTER_CODE;
    this.gui.state = {};

    if (projectContent) {
      // Load from saved project — extract code and state from the serialized layout
      try {
        let parsed = JSON.parse(projectContent);
        if (parsed._cascadeState) {
          // New Dockview project format
          codeStr = parsed._cascadeState.code || codeStr;
          this.gui.state = parsed._cascadeState.guiState || {};
        } else if (parsed.content || parsed.root) {
          // Legacy GoldenLayout project format — extract code from componentState
          let code = this._extractLegacyCode(parsed);
          if (code) { codeStr = code; }
        }
      } catch (e) {
        console.error("Failed to parse project:", e);
      }
    } else if (loadFromURL) {
      codeStr = CascadeStudioApp.decode(searchParams.get("code"));
      this.gui.state = JSON.parse(CascadeStudioApp.decode(searchParams.get("gui")));
    }

    // Dispose previous layout
    if (this._dockviewApi) {
      this._dockviewApi.dispose();
      this._dockviewApi = null;
    }

    const appBody = document.getElementById("appbody");
    appBody.innerHTML = '';

    // Set layout height (everything above the app body counts: topnav, sketch ribbon, ...)
    appBody.style.height = (window.innerHeight - appBody.getBoundingClientRect().top) + 'px';

    this._dockviewApi = createDockview(appBody, {
      className: 'dockview-theme-dark',
      disableFloatingGroups: true,
      createComponent: (options) => {
        const element = document.createElement('div');
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.overflow = 'hidden';

        return {
          element,
          init: (params) => {
            const container = new DockviewContainer(element, params.api);

            switch (options.name) {
              case 'codeEditor':
                container.setState({ code: params.params?.code || codeStr });
                this.editor.initPanel(container, container.getState());
                break;
              case 'cascadeView':
                container.setState(params.params?.guiState || this.gui.state);
                this._initCascadeView(container, container.getState());
                break;
              case 'console':
                this.console.initPanel(container);
                break;
            }
          }
        };
      }
    });

    // Add panels — use vertical stack on mobile, side-by-side on desktop
    const isMobile = window.innerHeight > window.innerWidth;

    if (isMobile) {
      // Mobile: cascadeView on top, editor below, console at bottom
      const viewPanel = this._dockviewApi.addPanel({
        id: 'cascadeView',
        component: 'cascadeView',
        title: 'CAD View',
        params: { guiState: this.gui.state }
      });

      this._dockviewApi.addPanel({
        id: 'codeEditor',
        component: 'codeEditor',
        title: '* Untitled',
        params: { code: codeStr },
        position: { referencePanel: 'cascadeView', direction: 'below' }
      });

      const consolePanel = this._dockviewApi.addPanel({
        id: 'console',
        component: 'console',
        title: 'Console',
        position: { referencePanel: 'codeEditor', direction: 'below' }
      });

      // Set proportions once the dockview grid is actually ready (the exact
      // frame varies with panel init time, so retry until the size sticks)
      this._applyPanelSizes(() => {
        const h = appBody.offsetHeight;
        viewPanel.group.api.setSize({ height: Math.floor(h * 0.25) });
        consolePanel.group.api.setSize({ height: Math.floor(h * 0.05) });
        return Math.abs(viewPanel.group.height - h * 0.25) < 40;
      });
    } else {
      // Desktop: editor left, cascadeView right, console below view
      const editorPanel = this._dockviewApi.addPanel({
        id: 'codeEditor',
        component: 'codeEditor',
        title: '* Untitled',
        params: { code: codeStr }
      });

      const viewPanel = this._dockviewApi.addPanel({
        id: 'cascadeView',
        component: 'cascadeView',
        title: 'CAD View',
        params: { guiState: this.gui.state },
        position: { referencePanel: 'codeEditor', direction: 'right' }
      });

      const consolePanel = this._dockviewApi.addPanel({
        id: 'console',
        component: 'console',
        title: 'Console',
        position: { referencePanel: 'cascadeView', direction: 'below' }
      });

      // Initial proportions: editor ~30% wide, console ~15% tall. Applied
      // once the dockview grid is actually ready — the exact frame varies
      // with panel init time, so retry until the size sticks (a one-shot
      // 50ms timeout silently lost this race and left dockview's 50/50).
      this._applyPanelSizes(() => {
        const w = appBody.offsetWidth, h = appBody.offsetHeight;
        editorPanel.group.api.setSize({ width: Math.floor(w * 0.3) });
        consolePanel.group.api.setSize({ height: Math.floor(h * 0.15) });
        return Math.abs(editorPanel.group.width - w * 0.3) < 40 &&
               Math.abs(consolePanel.group.height - h * 0.15) < 40;
      });
    }

    // Resize the layout when the browser resizes
    if (this._updateLayoutSize) {
      window.removeEventListener('resize', this._updateLayoutSize);
      window.removeEventListener('orientationchange', this._updateLayoutSize);
    }
    this._updateLayoutSize = () => {
      const h = window.innerHeight - appBody.getBoundingClientRect().top;
      appBody.style.height = h + 'px';
    };
    window.addEventListener('resize', this._updateLayoutSize);
    window.addEventListener('orientationchange', this._updateLayoutSize);
    requestAnimationFrame(this._updateLayoutSize);
  }

  /** Apply initial panel proportions, retrying until dockview accepts them.
   *  `apply` sets the sizes and returns true when they verifiably took. */
  _applyPanelSizes(apply) {
    let tries = 0;
    const tick = () => {
      let ok = false;
      try { ok = apply(); } catch (e) { /* groups not ready yet */ }
      if (!ok && ++tries < 20) { setTimeout(tick, 50); }
    };
    setTimeout(tick, 50);
  }

  /** Initialize the Three.js 3D Viewport. */
  _initCascadeView(container, state) {
    this.gui.state = state;
    container.setState(this.gui.state);

    if (this.viewport) {
      this.viewport.active = false;
      this.viewport = null;
    }

    let floatingGUIContainer = document.createElement("div");
    floatingGUIContainer.className = 'gui-panel';
    floatingGUIContainer.id = "guiPanel";
    // The panel is recreated with the viewport — keep the N-key hidden state
    if (this._guiPanelHidden) { floatingGUIContainer.style.display = 'none'; }
    container.element.appendChild(floatingGUIContainer);

    this.viewport = new CascadeEnvironment(
      container, this,
      CascadeStudioApp.getNewFileHandle, CascadeStudioApp.writeFile, CascadeStudioApp.downloadFile
    );
    window.threejsViewport = this.viewport;

    // (Re)build the feature/sketch command bar inside the new viewport panel
    if (this.sketchMode) { this.sketchMode.attachToViewport(); }

    // Re-apply any active Blender theme to the freshly created viewport
    if (this.themeManager) { this.themeManager.applyToViewport(); }

    // Wire timeline step changes to editor line highlighting
    this._historyDecorations = [];
    this.viewport._onHistoryStepChange = (lineNumber) => {
      let editor = window.monacoEditor;
      if (!editor) return;
      if (lineNumber && lineNumber > 0) {
        this._historyDecorations = editor.deltaDecorations(this._historyDecorations, [{
          range: new monaco.Range(lineNumber, 1, lineNumber, 1),
          options: {
            isWholeLine: true,
            className: 'cs-history-line-highlight',
            glyphMarginClassName: 'cs-history-glyph'
          }
        }]);
        editor.revealLineInCenter(lineNumber);
      } else {
        this._historyDecorations = editor.deltaDecorations(this._historyDecorations, []);
      }
    };
  }

  /** Serialize the project's current state into a .json file and save it. */
  async saveProject() {
    let currentCode = this.editor.getCode();
    if (!this.file.handle) {
      this.file.handle = await CascadeStudioApp.getNewFileHandle(
        "Cascade Studio project files", "application/json", "json"
      );
    }

    // Save as a custom format with layout + cascade state
    let projectData = {
      _cascadeState: {
        code: currentCode,
        guiState: this.gui.state,
        externalFiles: this.console.goldenContainer.getState()
      }
    };
    if (this._dockviewApi) {
      projectData._dockviewLayout = this._dockviewApi.toJSON();
    }

    CascadeStudioApp.writeFile(this.file.handle, JSON.stringify(projectData, null, 2)).then(() => {
      this.editor.container.setTitle(this.file.handle.name);
      console.log("Saved project to " + this.file.handle.name);
      this.file.content = currentCode;
    });
  }

  /** Load a .json file as the current project. */
  async loadProject() {
    if (window.workerWorking) { return; }

    [this.file.handle] = await CascadeStudioApp.getNewFileHandle(
      'Cascade Studio project files', 'application/json', 'json', true
    );
    let fileSystemFile = await this.file.handle.getFile();
    let jsonContent = await fileSystemFile.text();
    window.history.replaceState({}, 'Cascade Studio', '?');
    this.initialize(jsonContent);
    this.editor.container.setTitle(this.file.handle.name);
    this.file.content = this.editor.getCode();
  }

  /** Trigger the CAD WebWorker to load one or more .stl, .step, or .iges files. */
  loadFiles(fileElementID = "files") {
    let files = document.getElementById(fileElementID).files;
    this.engine.importFiles(files);
  }

  /** Clear all externally loaded files from the `externalFiles` dict. */
  clearExternalFiles() {
    this.engine.clearExternalFiles();
    this.console.goldenContainer.setState({});
  }

  /** Switch the editor language mode (called from the editor panel's
   *  status-bar select). Stashes the current mode's code so switching
   *  back restores it. */
  switchEditorMode(newMode) {
    if (newMode === this.editor.mode) { return; }
    this._savedCode[this.editor.mode] = this.editor.getCode();
    this.editor.setMode(newMode);
    const starter = newMode === 'openscad'
      ? CascadeStudioApp.OPENSCAD_STARTER_CODE
      : CascadeStudioApp.STARTER_CODE;
    this.editor.setCode(this._savedCode[newMode] || starter);
    // Re-fit camera and auto-evaluate
    if (this.viewport) { this.viewport._fitOnNextRender = true; }
    this.editor.evaluateCode();
  }

  /** Extract code from a legacy GoldenLayout project file. */
  _extractLegacyCode(parsed) {
    // Recursively search for componentState.code in GoldenLayout config
    function findCode(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (obj.componentState && obj.componentState.code) return obj.componentState.code;
      for (let key of ['content', 'root', 'children']) {
        if (Array.isArray(obj[key])) {
          for (let child of obj[key]) {
            let result = findCode(child);
            if (result) return result;
          }
        }
      }
      return null;
    }
    return findCode(parsed);
  }

  // --- Static utility methods ---

  /** Get a new file handle via the File System Access API. */
  static async getNewFileHandle(desc, mime, ext, open = false) {
    const options = {
      types: [{
        description: desc,
        accept: { [mime]: ['.' + ext] },
      }],
    };
    if (open) {
      return await window.showOpenFilePicker(options);
    } else {
      return await window.showSaveFilePicker(options);
    }
  }

  /** Write contents to a file handle. */
  static async writeFile(fileHandle, contents) {
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
  }

  /** Download data as a file via a temporary anchor element. */
  static async downloadFile(data, name, mime, ext) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement("a");
    a.download = name + "." + ext;
    a.style.display = "none";
    a.href = window.URL.createObjectURL(blob);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(a.href);
  }

  /** Decode a base64+compressed string to the original. Uses fflate. */
  static decode(string) {
    const compressed = Uint8Array.from(atob(decodeURIComponent(string)), c => c.charCodeAt(0));
    return strFromU8(inflateSync(compressed));
  }

  /** Encode a string to a base64+compressed version. Uses fflate. */
  static encode(string) {
    const compressed = deflateSync(strToU8(string));
    // Build binary string in chunks to avoid stack overflow with large data
    let binaryStr = '';
    const chunkSize = 8192;
    for (let i = 0; i < compressed.length; i += chunkSize) {
      binaryStr += String.fromCharCode.apply(null, compressed.subarray(i, i + chunkSize));
    }
    return encodeURIComponent(btoa(binaryStr));
  }

  /** Returns true if item is indexable like an array. */
  static isArrayLike(item) {
    return (
      Array.isArray(item) ||
      (!!item &&
        typeof item === "object" &&
        item.hasOwnProperty("length") &&
        typeof item.length === "number" &&
        item.length > 0 &&
        (item.length - 1) in item
      )
    );
  }
}

/** Default starter code shown in the editor. */
CascadeStudioApp.STARTER_CODE =
`// Welcome to ChiselCAD!  A Browser-Based Parametric CAD Environment.
// The starter model is a woodworking chisel - adjust the sliders:
let bladeW    = Slider("Blade Width",    20,  6,  40);
let bladeLen  = Slider("Blade Length",   90, 40, 150);
let bladeT    = Slider("Blade Thick",     5,  3,   9);
let shankLen  = Slider("Shank Length",   40, 20,  70);
let shankD    = Slider("Shank Diam",     10,  6,  16);
let handleLen = Slider("Handle Length", 100, 70, 140);
let handleD   = Slider("Handle Diam",    30, 20,  42);
let stamp     = Checkbox("Width Stamp", true);

let shankR   = shankD / 2;
let hr       = handleD / 2;          // handle radius at the swell
let hz       = bladeLen + shankLen;  // height where the handle seats
let ferruleR = Math.min(hr * 0.9, Math.max(hr * 0.72, shankR + 2));

// --- Blade (Sketch in XZ plane + Extrude) ---
// Side profile with a 25-degree cutting bevel at the tip
let bevelRise = bladeT / Math.tan(25 * Math.PI / 180);
let bladeFace = new Sketch([0, 0], "XZ")
  .LineTo([bladeT, bevelRise])   // cutting bevel
  .LineTo([bladeT, bladeLen])    // top side
  .LineTo([0, bladeLen])         // flat back
  .End(true).Face();
let blade = Translate([-bladeT/2, -bladeW/2, 0],
  Extrude(bladeFace, [0, bladeW, 0]));

// ChamferEdges + Selector: ease the four long edges of the blade
let longEdges = Edges(blade).parallel([0, 0, 1]).indices();
blade = ChamferEdges(blade, bladeT * 0.22, longEdges);

// --- Neck (Loft): blend the rectangular blade into the round shank ---
let neckLen = shankLen * 0.45;
let rectWire = Polygon([
  [ bladeT/2, -bladeW/2, bladeLen],
  [ bladeT/2,  bladeW/2, bladeLen],
  [-bladeT/2,  bladeW/2, bladeLen],
  [-bladeT/2, -bladeW/2, bladeLen]], true);
let circWire = Translate([0, 0, bladeLen + neckLen], Circle(shankR, true));
let neck = Loft([rectWire, circWire]);

// --- Shank + Bolster (Cylinder + Cone + Union) ---
let shank = Translate([0, 0, bladeLen + neckLen], Cylinder(shankR, shankLen - neckLen));
let bolsterH = Math.min(8, shankLen * 0.25);
let bolster = Translate([0, 0, hz - bolsterH], Cone(shankR, ferruleR, bolsterH));
let steel = Union([blade, neck, shank, bolster]);

// --- Handle (Sketch profile in XZ + Revolve) ---
// Lathe-turned profile: ferrule band, swell, grip taper, rounded butt
let handleProfile = new Sketch([0, hz], "XZ")
  .LineTo([ferruleR, hz])
  .LineTo([ferruleR, hz + handleLen * 0.14])                    // ferrule band
  .LineTo([hr,        hz + handleLen * 0.40]).Fillet(hr * 0.45) // swell
  .LineTo([hr * 0.86, hz + handleLen * 0.82]).Fillet(hr * 0.9)  // grip taper
  .LineTo([hr * 0.55, hz + handleLen]).Fillet(hr * 0.32)        // shoulder
  .LineTo([0, hz + handleLen])                                  // butt
  .End(true).Face();
let handle = Revolve(handleProfile, 360);

// --- Width stamp (Text3D on the blade face) ---
if (stamp) {
  let label = Rotate([0, 0, 1], -90,
    Text3D(Math.round(bladeW) + "", 7, 0.25, "Consolas"));
  Translate([-(bladeT/2 + 0.5), 3.5, bladeLen * 0.9], label);
}

// --- Measurements ---
console.log("Overall length: " + (bladeLen + shankLen + handleLen).toFixed(0) + " mm");
console.log("Steel volume:   " + Math.abs(Volume(steel)).toFixed(0) + " mm\\u00B3");
console.log("Handle volume:  " + Math.abs(Volume(handle)).toFixed(0) + " mm\\u00B3");`;

/** Default OpenSCAD starter code shown when switching to OpenSCAD mode. */
CascadeStudioApp.OPENSCAD_STARTER_CODE =
`// Parametric Bolt and Nut
// Demonstrates modules, intersection, difference, and transforms

hex_r = 10;
hex_h = 6;
bore_r = 5;
shaft_r = 4.8;
shaft_h = 25;

// Hex prism: three intersecting boxes
module hex(r, h) {
  intersection() {
    cube([r * 2, r * 1.73, h], center = true);
    rotate([0, 0, 60])
      cube([r * 2, r * 1.73, h], center = true);
    rotate([0, 0, -60])
      cube([r * 2, r * 1.73, h], center = true);
  }
}

// Bolt head
hex(hex_r, hex_h);

// Shaft
translate([0, 0, hex_h / 2])
  cylinder(h = shaft_h, r = shaft_r);

// Washer
translate([0, 0, shaft_h])
  difference() {
    cylinder(h = 2, r = hex_r - 1);
    cylinder(h = 3, r = bore_r);
  }

// Nut with bore hole
translate([0, 0, shaft_h + 2])
  difference() {
    hex(hex_r, hex_h);
    cylinder(h = hex_h + 1, r = bore_r, center = true);
  }
`;

export { CascadeStudioApp };
