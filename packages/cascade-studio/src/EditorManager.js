// EditorManager.js - Monaco editor management

const monaco = window.monaco;

/** Manages the Monaco code editor instance, mode switching, and code evaluation. */
class EditorManager {
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

    // Live evaluation: re-evaluate shortly after the user stops typing, so the
    // model, GUI panel, and console track the code without needing F5
    this.editor.onDidChangeModelContent(() => {
      this.clearLineageHighlight();
      if (this._suppressLiveEval) { return; }
      clearTimeout(this._liveEvalTimer);
      this._liveEvalTimer = setTimeout(() => { this.evaluateCode(); }, 600);
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
        if (this._app.viewport) { this._app.viewport.highlightShapesAtLine(line); }
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
   *  Returns a promise that resolves once this request's evaluation (immediate or
   *  queued) has fully completed, including meshing and rendering. */
  evaluateCode(saveToURL = false, { keepGUI = false } = {}) {
    return new Promise((resolve) => {
      this._requestEval(saveToURL, keepGUI, resolve);
    });
  }

  /** True while an evaluation is in flight or queued. */
  get hasPendingEvaluation() {
    return this._evalInFlight || !!this._queuedEval;
  }

  _requestEval(saveToURL, keepGUI, resolve) {
    if (this._evalInFlight || window.workerWorking) {
      // Coalesce: any queued full rebuild outranks a live (keepGUI) update,
      // and a queued save-to-URL request is preserved
      if (!this._queuedEval) {
        this._queuedEval = { keepGUI: true, saveToURL: false, resolvers: [] };
      }
      this._queuedEval.keepGUI = this._queuedEval.keepGUI && keepGUI;
      this._queuedEval.saveToURL = this._queuedEval.saveToURL || saveToURL;
      this._queuedEval.resolvers.push(resolve);
      return;
    }
    if (!this._app.engine || !this._app.engine.isReady) { resolve(); return; }
    window.workerWorking = true;
    this._evalInFlight = true;

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
    this._app.engine.evaluate(codeToEval, {
      guiState: this._app.gui.state,
      sceneOptions: this._app.viewport ? this._app.viewport.getSceneOptions() : undefined,
    }).then((result) => {
      if (this._app.viewport && result.meshData) {
        this._app.viewport.renderMeshData(result.meshData, result.sceneOptions, result.shapeRanges);
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
          this._requestEval(queued.saveToURL, queued.keepGUI, done);
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
