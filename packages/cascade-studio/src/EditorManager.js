// EditorManager.js - Monaco editor management

const monaco = window.monaco;

/** Manages the Monaco code editor instance, mode switching, and code evaluation. */
class EditorManager {
  // Automatic mesh resolution (maxDeviation, mm): coarse while a slider is
  // mid-drag, normal for every settled evaluation (typing, release tick),
  // fine for the debounced background re-mesh once things go quiet.
  static DRAFT_RES = 1.0;
  static REST_RES = 0.1;
  static FINE_RES = 0.01;

  constructor(app) {
    this._app = app;
    this.editor = null;
    this.mode = 'cascadestudio';
    this._extraLibs = [];
    this._codeContainer = null;
    this._openscadProviders = [];
    // Evaluation requested while the worker was busy; fired on completion.
    this._queuedEval = null;
    // True from evaluate start until the full evaluate+mesh promise settles.
    // window.workerWorking is unreliable here: the worker resets it after code
    // evaluation but before meshing, which would let evaluations overlap.
    this._evalInFlight = false;
    // Debounce timer for live evaluation while typing
    this._liveEvalTimer = null;
    // Resolution of the mesh currently on screen (refine-ladder state)
    this._lastMeshedRes = Infinity;
    // Suppresses live evaluation during programmatic setValue calls — those
    // paths (project load, mode switch, runCode) evaluate explicitly themselves
    this._suppressLiveEval = false;
  }

  /** Initialize the editor panel inside a DockviewContainer. */
  initPanel(container, state) {
    if (this.editor) {
      monaco.editor.getModels().forEach(model => model.dispose());
      this.editor = null;
    }

    // Set the Monaco Language Options
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    });
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);

    // Import Typescript Intellisense Definitions
    const isBuilt = typeof ESBUILD !== 'undefined';
    let prefix = window.location.href.startsWith("https://zalo.github.io/") ? "/CascadeStudio/" : "";
    const ocDtsPath = isBuilt ? 'typedefs/cascadestudio.d.ts' : prefix + 'node_modules/opencascade.js/dist/cascadestudio.d.ts';
    const threeDtsPath = isBuilt ? 'typedefs/three.d.ts' : prefix + 'node_modules/@types/three/index.d.ts';
    const libDtsPath = isBuilt ? 'typedefs/StandardLibraryIntellisense.ts' : prefix + 'js/StandardLibraryIntellisense.ts';
    Promise.all([
      fetch(ocDtsPath).then(r => r.text()),
      fetch(threeDtsPath).then(r => r.text()),
      fetch(libDtsPath).then(r => r.text()),
    ]).then(([ocDts, threeDts, libDts]) => {
      this._extraLibs = [
        { content: ocDts, filePath: 'file://' + ocDtsPath },
        { content: threeDts, filePath: 'file://' + threeDtsPath },
        { content: libDts, filePath: 'file://' + libDtsPath },
      ];
      monaco.editor.createModel("", "typescript");
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    }).catch(error => console.log("Error loading type definitions: " + error.message));

    // Check for code serialization as an array
    this._codeContainer = container;
    if (EditorManager._isArrayLike(state.code)) {
      let codeString = "";
      for (let i = 0; i < state.code.length; i++) {
        codeString += state.code[i] + "\n";
      }
      codeString = codeString.slice(0, -1);
      state.code = codeString;
      container.setState({ code: codeString });
    }

    // Panel layout: Monaco fills the top, a slim status bar (language mode)
    // sits along the bottom
    container.element.style.display = 'flex';
    container.element.style.flexDirection = 'column';
    const editorHost = document.createElement('div');
    editorHost.style.flex = '1 1 auto';
    editorHost.style.minHeight = '0';
    container.element.appendChild(editorHost);
    container.element.appendChild(this._buildStatusBar());

    // AI assistant strip (collapsible) below the status bar
    if (this._app.llmChat) { this._app.llmChat.mount(container.element); }

    // Initialize the Monaco Code Editor
    const isMobile = window.innerHeight > window.innerWidth;
    this.editor = monaco.editor.create(editorHost, {
      value: state.code,
      language: "typescript",
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      cursorStyle: 'line',
      cursorWidth: 2,
      wordWrap: isMobile ? 'on' : 'off',
      ...(isMobile && {
        glyphMargin: false,
        folding: false,
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 0,
        lineNumbers: 'off',
        padding: { top: 0, bottom: 0 }
      })
    });
    window.monacoEditor = this.editor;
    this._addFlipValuesAction();

    // Live evaluation: re-evaluate shortly after the user stops typing, so the
    // model, GUI panel, and console track the code without needing F5
    this.editor.onDidChangeModelContent(() => {
      this.clearLineageHighlight();
      if (this._suppressLiveEval) { return; }
      clearTimeout(this._liveEvalTimer);
      clearTimeout(this._refineTimer);  // don't let a refine wedge in front of the coming eval
      this._liveEvalTimer = setTimeout(() => {
        // Code-edit juice: a light kick when the regenerated model lands
        // (commits arm a stronger one — max wins). Errors disarm it.
        if (this._app.viewport) { this._app.viewport.shakeOnNextRender(0.3); }
        // Typing evals mesh at draft res for fast feedback; the refine
        // ladder sharpens to REST_RES then FINE_RES once you pause
        this.evaluateCode(false, { draft: true });
      }, 600);
    });

    // Cursor-line highlighting: light up the GUI control / 3D geometry that
    // the op under the cursor produced. OpenSCAD mode is excluded — its line
    // numbers refer to the transpiled JS, not what the user sees.
    this.editor.onDidChangeCursorPosition((e) => {
      // Lineage highlight survives as long as the cursor stays in its block
      if (this._lineageLines && !this._lineageLines.has(e.position.lineNumber)) {
        this.clearLineageHighlight();
      }
      clearTimeout(this._cursorLineTimer);
      this._cursorLineTimer = setTimeout(() => {
        const line = (this.mode === 'cascadestudio') ? e.position.lineNumber : -1;
        this._app.gui.highlightControlsAtLine(line);
        if (this._app.viewport) {
          this._app.viewport.highlightShapesAtLine(line);
          this._app.viewport.previewPlanesAtLine(line);
        }
      }, 150);
    });

    // Collapse all top-level functions in the Editor
    this._collapseTopLevelFunctions(state.code);

    // Set up keyboard shortcuts
    this._setupKeyboardShortcuts(container);
  }

  /** Bottom strip of the editor panel: the language-mode select (a
   *  code-specific option, so it lives with the code, not in the topnav). */
  _buildStatusBar() {
    const bar = document.createElement('div');
    bar.className = 'cs-editor-statusbar';
    const select = document.createElement('select');
    select.id = 'editorMode';
    select.className = 'topnav-select';
    select.title = 'Editor Language Mode';
    for (const [value, label] of [['cascadestudio', 'CascadeStudio JS'], ['openscad', 'OpenSCAD']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.value = this.mode || 'cascadestudio';
    select.addEventListener('change', (e) => this._app.switchEditorMode(e.target.value));
    bar.appendChild(select);
    return bar;
  }

  /** Legacy: Register the dockable Monaco Code Editor component with Golden Layout.
   *  Now delegates to initPanel. */
  registerComponent(layout) {
    layout.registerComponent('codeEditor', (container, state) => {
      this.initPanel(container, state);
    });
  }

  /** Get the current code from the editor. */
  getCode() {
    return this.editor ? this.editor.getValue() : '';
  }

  /** Move the cursor to a line, scroll it into view, and focus the editor. */
  revealLine(lineNumber) {
    if (!this.editor || !lineNumber || lineNumber < 1) { return; }
    this.editor.setPosition({ lineNumber: lineNumber, column: 1 });
    this.editor.revealLineInCenterIfOutsideViewport(lineNumber);
    this.editor.focus();
  }

  /** Highlight a shape's lineage: tint every contributing line, scroll the
   *  block into view, and put the cursor on focusLine. The highlight clears
   *  when the cursor leaves the block or the code changes. */
  highlightLineage(lines, focusLine) {
    if (!this.editor || !lines || lines.length === 0) { return; }
    this.clearLineageHighlight();

    this._lineageLines = new Set(lines);
    this._lineageDecorations = this.editor.createDecorationsCollection(lines.map(l => ({
      range: new monaco.Range(l, 1, l, 1),
      options: {
        isWholeLine: true,
        className: 'cs-lineage-line',
        linesDecorationsClassName: 'cs-lineage-gutter',
      },
    })));

    const minLine = Math.min(...lines), maxLine = Math.max(...lines);
    this.editor.revealRangeInCenterIfOutsideViewport(new monaco.Range(minLine, 1, maxLine, 1));
    this.editor.setPosition({ lineNumber: focusLine, column: 1 });
    this.editor.focus();
  }

  /** Remove the lineage highlight, if present. */
  clearLineageHighlight() {
    if (this._lineageDecorations) {
      this._lineageDecorations.clear();
      this._lineageDecorations = null;
    }
    this._lineageLines = null;
  }

  /** Back out of every selection-ish highlight at once (ESC): lineage tint,
   *  any pending cursor-line highlight, the 3D overlay, and the hot GUI
   *  control. The cursor-line highlight re-arms on the next cursor move. */
  clearShapeHighlights() {
    clearTimeout(this._cursorLineTimer);
    this.clearLineageHighlight();
    this._app.gui.highlightControlsAtLine(-1);
    if (this._app.viewport) {
      this._app.viewport.highlightShapesAtLine(-1);
      this._app.viewport.previewPlanesAtLine(-1);
    }
  }

  /** Right-click → "Flip Values": swap the two operands of the call or
   *  array under the cursor. Difference(solid1, [solid2]) becomes
   *  Difference(solid2, [solid1]) — the values trade places, the bracket
   *  structure stays put — so reversing a cut/loft direction is one click. */
  _addFlipValuesAction() {
    this.editor.addAction({
      id: 'chisel-flip-values',
      label: 'Flip Values',
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 3.5,
      run: (ed) => {
        const pos = ed.getPosition();
        const model = ed.getModel();
        if (!pos || !model) { return; }
        const line = model.getLineContent(pos.lineNumber);
        const flipped = EditorManager._flipInLine(line, pos.column - 1);
        if (flipped === null) {
          try {
            ed.getContribution('editor.contrib.messageController')
              .showMessage('Nothing to flip here — right-click a call or pair like Fn(a, [b])', pos);
          } catch (e) { /* internal contribution moved — fail quietly */ }
          return;
        }
        ed.executeEdits('chisel-flip', [{
          range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, line.length + 1),
          text: flipped,
        }]);
      },
    });
  }

  /** Swap the two values of the bracket group around `col` (0-based) in
   *  `line`, innermost group first, walking outward. Returns the new line,
   *  or null if nothing swappable is there.
   *  - `[a, b]` swaps its two elements (also reached via `Fn([a, b])`)
   *  - `Fn(a, [b])` swaps the PAYLOADS a and b, leaving the array wrapper
   *    in place; multi-element arrays (vectors, spans) are single values,
   *    so `Fn(a, [x, y, z])` is not swappable at the call level */
  static _flipInLine(line, col) {
    const regions = EditorManager._bracketRegions(line);
    const candidates = regions
      .filter(r => col > r.open && col <= r.close)
      .sort((a, b) => (a.close - a.open) - (b.close - b.open));
    // Fallback: right-clicking anywhere on the line (the `let`, the call
    // name) targets the line's outermost call
    const outermost = regions.filter(r => r.char === '(')
      .sort((a, b) => (b.close - b.open) - (a.close - a.open))[0];
    if (outermost && !candidates.includes(outermost)) { candidates.push(outermost); }

    for (const r of candidates) {
      const elems = EditorManager._topLevelElements(line, r.open + 1, r.close);
      if (r.char === '[' && elems.length === 2) {
        return EditorManager._swapSpans(line, elems[0], elems[1]);
      }
      if (r.char !== '(') { continue; }
      if (elems.length === 1) {
        // Single argument that is itself a two-element array → flip inside
        const [a, b] = elems[0];
        if (line[a] === '[' && line[b - 1] === ']') {
          const inner = EditorManager._topLevelElements(line, a + 1, b - 1);
          if (inner.length === 2) { return EditorManager._swapSpans(line, inner[0], inner[1]); }
        }
        continue;
      }
      if (elems.length !== 2) { continue; }
      const payloads = elems.map(([a, b]) => {
        if (line[a] !== '[' || line[b - 1] !== ']') { return [a, b]; }
        const inner = EditorManager._topLevelElements(line, a + 1, b - 1);
        return inner.length === 1 ? inner[0] : null; // multi-element array: not a slot
      });
      if (payloads[0] && payloads[1]) {
        return EditorManager._swapSpans(line, payloads[0], payloads[1]);
      }
    }
    return null;
  }

  /** Balanced ()/[] regions on a line, string- and //-comment-aware.
   *  0-based open/close indices, in close order (inner before outer). */
  static _bracketRegions(line) {
    const regions = [], stack = [];
    let str = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (str) {
        if (ch === '\\') { i++; }
        else if (ch === str) { str = null; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
      if (ch === '/' && line[i + 1] === '/') { break; }
      if (ch === '(' || ch === '[') { stack.push({ char: ch, open: i }); continue; }
      if (ch === ')' || ch === ']') {
        const want = ch === ')' ? '(' : '[';
        while (stack.length && stack[stack.length - 1].char !== want) { stack.pop(); }
        const top = stack.pop();
        if (top) { regions.push({ char: top.char, open: top.open, close: i }); }
      }
    }
    return regions;
  }

  /** Top-level comma-separated element spans within line[start, end),
   *  whitespace-trimmed; nested brackets and strings don't split. */
  static _topLevelElements(line, start, end) {
    const elems = [];
    let depth = 0, str = null, s = start;
    for (let i = start; i < end; i++) {
      const ch = line[i];
      if (str) {
        if (ch === '\\') { i++; }
        else if (ch === str) { str = null; }
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { str = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
      if (ch === ',' && depth === 0) { elems.push([s, i]); s = i + 1; }
    }
    elems.push([s, end]);
    return elems
      .map(([a, b]) => {
        while (a < b && /\s/.test(line[a])) { a++; }
        while (b > a && /\s/.test(line[b - 1])) { b--; }
        return [a, b];
      })
      .filter(([a, b]) => b > a);
  }

  static _swapSpans(line, [aS, aE], [bS, bE]) {
    if (aS > bS) { [aS, aE, bS, bE] = [bS, bE, aS, aE]; }
    const a = line.slice(aS, aE), b = line.slice(bS, bE);
    return line.slice(0, aS) + b + line.slice(aE, bS) + a + line.slice(bE);
  }

  /** Append a code snippet to the end of the document as a single undoable
   *  edit, reveal it, and focus the editor. Live evaluation picks up the
   *  change like any other edit. Used by SketchMode to commit sketches and
   *  feature templates. selectToken (a regex string) selects the first match
   *  within the inserted text so the key value can be typed over directly. */
  appendCode(snippet, selectToken) {
    if (!this.editor) { return; }
    const model = this.editor.getModel();
    const lastLine = model.getLineCount();
    const lastCol = model.getLineMaxColumn(lastLine);
    const prefix = model.getValue().trim().length > 0 ? '\n\n' : '';
    this.editor.executeEdits('chisel-sketch', [{
      range: new monaco.Range(lastLine, lastCol, lastLine, lastCol),
      text: prefix + snippet + '\n',
    }]);
    const endLine = model.getLineCount();
    let selected = false;
    if (selectToken) {
      const matches = model.findMatches(
        selectToken,
        new monaco.Range(lastLine, 1, endLine, model.getLineMaxColumn(endLine)),
        true, true, null, false
      );
      if (matches.length > 0) {
        this.editor.setSelection(matches[0].range);
        this.editor.revealRangeInCenter(matches[0].range);
        selected = true;
      }
    }
    if (!selected) { this.editor.revealLineInCenter(endLine); }
    this.editor.focus();
  }

  /** Set the code in the editor (programmatic — does not trigger live evaluation). */
  setCode(code) {
    if (!this.editor) { return; }
    this._suppressLiveEval = true;
    try {
      this.editor.setValue(code);
    } finally {
      this._suppressLiveEval = false;
    }
  }

  /** Evaluate the current code: transpile if OpenSCAD, then send to worker via engine.
   *  With keepGUI (live slider updates), the control panel is left intact instead of
   *  being rebuilt. Calls made while an evaluation is in flight coalesce into one
   *  trailing evaluation that fires on completion, so the model always settles on
   *  the latest GUI state.
   *  Mesh resolution is automatic: `draft` (mid-slider-drag) meshes coarse for
   *  responsiveness; everything else meshes at REST_RES, then a debounced
   *  background pass re-meshes the same shapes at FINE_RES once things go quiet.
   *  Returns a promise that resolves once this request's evaluation (immediate or
   *  queued) has fully completed, including meshing and rendering. */
  evaluateCode(saveToURL = false, { keepGUI = false, draft = false } = {}) {
    return new Promise((resolve) => {
      this._requestEval(saveToURL, keepGUI, resolve, draft);
    });
  }

  /** True while an evaluation is in flight or queued. */
  get hasPendingEvaluation() {
    return this._evalInFlight || !!this._queuedEval;
  }

  _requestEval(saveToURL, keepGUI, resolve, draft = false) {
    if (this._evalInFlight || window.workerWorking) {
      // Coalesce: any queued full rebuild outranks a live (keepGUI) update,
      // a queued save-to-URL request is preserved, and any non-draft
      // requester upgrades the queued eval to full resolution
      if (!this._queuedEval) {
        this._queuedEval = { keepGUI: true, saveToURL: false, draft: true, resolvers: [] };
      }
      this._queuedEval.keepGUI = this._queuedEval.keepGUI && keepGUI;
      this._queuedEval.saveToURL = this._queuedEval.saveToURL || saveToURL;
      this._queuedEval.draft = this._queuedEval.draft && draft;
      this._queuedEval.resolvers.push(resolve);
      return;
    }
    if (!this._app.engine || !this._app.engine.isReady) { resolve(); return; }
    window.workerWorking = true;
    this._evalInFlight = true;
    clearTimeout(this._refineTimer);  // a new eval supersedes any pending refine

    monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    let newCode = this.editor.getValue();
    monaco.editor.setModelMarkers(this.editor.getModel(), 'test', []);

    // Clear console and refresh the GUI Panel
    this._app.console.clear();
    if (keepGUI) {
      this._app.gui.beginLiveUpdate();
    } else {
      this._app.gui.reset();
    }
    if (this._app.viewport) this._app.viewport.clearTransformHandles();

    // Transpile OpenSCAD if needed
    let codeToEval = newCode;
    if (this.mode === 'openscad' && this._app._openscadTranspiler) {
      try {
        codeToEval = this._app._openscadTranspiler.transpile(newCode);
      } catch (e) {
        console.error("OpenSCAD transpile error: " + e.message);
        this._app.gui.endLiveUpdate();
        this._evalInFlight = false;
        window.workerWorking = false;
        resolve();
        return;
      }
    }

    // Use CascadeEngine to evaluate and get mesh data
    const evalStart = performance.now();
    this._app.engine.evaluate(codeToEval, {
      guiState: this._app.gui.state,
      maxDeviation: draft ? EditorManager.DRAFT_RES : EditorManager.REST_RES,
      sceneOptions: this._app.viewport ? this._app.viewport.getSceneOptions() : undefined,
    }).then((result) => {
      if (this._app.viewport) {
        // Construction planes ride along even when there's nothing to mesh
        this._app.viewport.scenePlanes = result.scenePlanes || [];
        this._app.viewport.refreshPlanePreview();
        if (result.meshData) {
          this._app.viewport.renderMeshData(result.meshData, result.sceneOptions, result.shapeRanges);
          this._lastMeshedRes = draft ? EditorManager.DRAFT_RES : EditorManager.REST_RES;
          this._scheduleRefine(performance.now() - evalStart);
        }
      }
    }).catch((err) => {
      console.error("Evaluation error: " + err.message);
      window.workerWorking = false;
    }).finally(() => {
      this._evalInFlight = false;
      this._app.gui.endLiveUpdate();
      resolve();
      const queued = this._queuedEval;
      if (queued) {
        // Leave _queuedEval set until the deferred eval starts, so
        // hasPendingEvaluation never reports idle while work remains
        setTimeout(() => {
          this._queuedEval = null;
          const done = () => { queued.resolvers.forEach(r => r()); };
          this._requestEval(queued.saveToURL, queued.keepGUI, done, queued.draft);
        }, 0);
      }
    });

    this._codeContainer.setState({ code: newCode });

    if (saveToURL) {
      const AppClass = this._app.constructor;
      console.log("Saved to URL!");
      window.history.replaceState({}, 'Cascade Studio',
        new URL(
          location.pathname + "?code=" + AppClass.encode(newCode) +
          "&gui=" + AppClass.encode(JSON.stringify(this._app.gui.state)),
          location.href
        ).href
      );
    }

    console.log("Generating Model");
  }

  /** Progressive refinement ladder: after any render, quietly re-mesh the
   *  same shapes one rung sharper once nothing else is happening — draft
   *  evals climb to REST_RES quickly (350ms), then to FINE_RES after a
   *  fuller pause (1s). Only meshing repeats; the code is not re-evaluated.
   *  The FINE rung is skipped for heavy models (slow last meshing) — the
   *  worker is single-threaded, so a long refine would stall the next edit
   *  behind it. A refine result is discarded if a new evaluation starts
   *  while it's in flight (the worker serializes messages, so the new
   *  eval's mesh always lands last anyway — this just avoids a stale flash). */
  _scheduleRefine(lastMeshMs = 0) {
    const next = this._lastMeshedRes > EditorManager.REST_RES ? EditorManager.REST_RES
               : this._lastMeshedRes > EditorManager.FINE_RES ? EditorManager.FINE_RES
               : null;
    if (next === null) { return; }
    if (next === EditorManager.FINE_RES && lastMeshMs > 5000) { return; }
    clearTimeout(this._refineTimer);
    this._refineTimer = setTimeout(() => {
      if (this._evalInFlight || this._queuedEval || window.workerWorking) { return; }
      const t0 = performance.now();
      this._app.engine.remesh(
        next,
        this._app.viewport ? this._app.viewport.getSceneOptions() : undefined
      ).then((result) => {
        if (this._evalInFlight || this._queuedEval) { return; } // superseded
        if (this._app.viewport && result.meshData) {
          // No shake here — refinement should sharpen silently; a kick a
          // second after the user went idle reads as an errant glitch
          this._app.viewport.renderMeshData(result.meshData, result.sceneOptions, result.shapeRanges);
          this._lastMeshedRes = next;
          if (next !== EditorManager.FINE_RES) {
            this._scheduleRefine(performance.now() - t0);  // climb to the next rung
          }
        }
      }).catch(() => { /* worker busy or timeout — the current mesh stands */ });
    }, next === EditorManager.REST_RES ? 350 : 1000);
  }

  /** Set editor mode: 'cascadestudio' or 'openscad'. */
  setMode(newMode) {
    if (newMode === this.mode) return;

    // Swap starter code if current content matches the other mode's starter
    const currentCode = this.editor.getValue();
    const csStarter = this._app.constructor.STARTER_CODE;
    const osStarter = this._app.constructor.OPENSCAD_STARTER_CODE;
    if (newMode === 'openscad' && osStarter && currentCode === csStarter) {
      this.setCode(osStarter);
    } else if (newMode === 'cascadestudio' && currentCode === osStarter) {
      this.setCode(csStarter);
    }

    // Fit camera on the next render after a mode switch
    if (this._app.viewport) {
      this._app.viewport._fitOnNextRender = true;
    }

    this.mode = newMode;

    // Dispose existing OpenSCAD providers
    this._openscadProviders.forEach(d => d.dispose());
    this._openscadProviders = [];

    if (newMode === 'openscad') {
      // Switch to OpenSCAD language
      const model = this.editor.getModel();
      monaco.editor.setModelLanguage(model, 'openscad');

      // Register OpenSCAD providers if available
      if (this._app._openscadMonaco) {
        this._openscadProviders = this._app._openscadMonaco.registerProviders(this.editor);
      }
    } else {
      // Switch back to TypeScript
      const model = this.editor.getModel();
      monaco.editor.setModelLanguage(model, 'typescript');
      monaco.languages.typescript.typescriptDefaults.setExtraLibs(this._extraLibs);
    }
  }

  /** Get the container for the code editor. */
  get container() {
    return this._codeContainer;
  }

  /** Collapse all top-level functions in the editor. */
  _collapseTopLevelFunctions(code) {
    let codeLines = code.split(/\r\n|\r|\n/);
    let collapsed = []; let curCollapse = null;
    for (let li = 0; li < codeLines.length; li++) {
      if (codeLines[li].startsWith("function")) {
        curCollapse = { "startLineNumber": (li + 1) };
      } else if (codeLines[li].startsWith("}") && curCollapse !== null) {
        curCollapse["endLineNumber"] = (li + 1);
        collapsed.push(curCollapse);
        curCollapse = null;
      }
    }
    let mergedViewState = Object.assign(this.editor.saveViewState(), {
      "contributionsState": {
        "editor.contrib.folding": {
          "collapsedRegions": collapsed,
          "lineCount": codeLines.length,
          "provider": "indent"
        },
        "editor.contrib.wordHighlighter": false
      }
    });
    this.editor.restoreViewState(mergedViewState);
  }

  /** Set up keyboard shortcuts for evaluation and save. */
  _setupKeyboardShortcuts(container) {
    document.onkeydown = (e) => {
      if (e.code === 'F5') {
        e.preventDefault();
        this.evaluateCode(true);
        return false;
      }
      if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this._app.saveProject();
        this.evaluateCode(true);
      }
      return true;
    };

    document.onkeyup = (e) => {
      if (!this._app.file.handle || e.which === 0) { return true; }
      if (this._app.file.content == this.editor.getValue()) {
        this._codeContainer.setTitle(this._app.file.handle.name);
      } else {
        this._codeContainer.setTitle('* ' + this._app.file.handle.name);
      }
      return true;
    };
  }

  static _isArrayLike(item) {
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

export { EditorManager };
