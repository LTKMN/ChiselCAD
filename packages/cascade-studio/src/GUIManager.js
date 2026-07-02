// GUIManager.js - Tweakpane control panel management

import { Pane } from 'tweakpane';

/** Manages the Tweakpane GUI panel and its controls (sliders, buttons, etc.). */
class GUIManager {
  constructor(app) {
    this._app = app;
    this._gui = null;
    this._guiSeparatorAdded = false;
    this._userGui = false;
    // During a live (slider-driven) evaluation the existing pane is kept, so
    // control-creation messages from the worker must not add duplicate bindings.
    this._liveUpdate = false;
    // Controls present in the current pane, keyed by kind:name. Creation is
    // idempotent — a control that already exists is never added again, no
    // matter when its creation message arrives. Cleared on reset().
    this._controls = {};
    this.state = {};
    // Store handler functions for direct calling from reset()
    this._handlers = {};
  }

  /** True if the control already exists in the current pane (or a live update
   *  is in progress, where the pane is kept as-is). */
  _hasControl(key) {
    return this._liveUpdate || (key in this._controls);
  }

  /** Register engine event handlers for GUI control creation. */
  registerHandlers(engine) {
    this._handlers["addSlider"] = (payload) => {
      if (!(payload.name in this.state)) { this.state[payload.name] = payload.default; }
      const key = 'slider:' + payload.name;
      if (this._hasControl(key)) { return; }
      const params = { min: payload.min, max: payload.max, step: payload.step };
      if (payload.dp) { params.format = v => v.toFixed(payload.dp); }

      this._addSeparator();
      const slider = this._gui.addBinding(this.state, payload.name, params);
      this._controls[key] = slider;

      // Live update: re-evaluate on every tick while dragging. keepGUI leaves
      // the pane intact so the slider isn't destroyed under the pointer, and
      // evaluateCode coalesces ticks that arrive while the kernel is busy.
      slider.on('change', () => { this._delayReload({ keepGUI: true }); });
    };

    this._handlers["addButton"] = (payload) => {
      const key = 'button:' + payload.name;
      if (this._hasControl(key)) { return; }
      this._addSeparator();
      const buttonParams = { title: payload.name };
      if (payload.label) { buttonParams.label = payload.label; }
      const button = this._gui.addButton(buttonParams);
      this._controls[key] = button;
      if (typeof payload.callback === 'function') {
        button.on('click', payload.callback);
      } else {
        button.on('click', () => { this._delayReload(); });
      }
    };

    this._handlers["addCheckbox"] = (payload) => {
      if (!(payload.name in this.state)) { this.state[payload.name] = payload.default || false; }
      const key = 'checkbox:' + payload.name;
      if (this._hasControl(key)) { return; }
      this._addSeparator();
      const checkbox = this._gui.addBinding(this.state, payload.name);
      this._controls[key] = checkbox;
      checkbox.on('change', () => {
        this._delayReload();
      });
    };

    this._handlers["addTextbox"] = (payload) => {
      if (!(payload.name in this.state)) { this.state[payload.name] = payload.default || ''; }
      const key = 'textbox:' + payload.name;
      if (this._hasControl(key)) { return; }
      this._addSeparator();
      const input = this._gui.addBinding(this.state, payload.name);
      this._controls[key] = input;
      input.on('change', e => {
        if (e.last) { this._delayReload(); }
      });
    };

    this._handlers["addDropdown"] = (payload) => {
      if (!(payload.name in this.state)) { this.state[payload.name] = payload.default || ''; }
      const key = 'dropdown:' + payload.name;
      if (this._hasControl(key)) { return; }
      const options = payload.options || {};
      this._addSeparator();
      const input = this._gui.addBinding(this.state, payload.name, { options });
      this._controls[key] = input;
      input.on('change', () => { this._delayReload(); });
    };

    // Register with the engine event system
    for (const type of Object.keys(this._handlers)) {
      engine.on(type, this._handlers[type]);
    }
  }

  /** Enter live-update mode: keep the existing pane, ignore control creation. */
  beginLiveUpdate() { this._liveUpdate = true; }

  /** Exit live-update mode after an evaluation completes. */
  endLiveUpdate() { this._liveUpdate = false; }

  /** Reset the GUI panel and add default controls before evaluation. */
  reset() {
    this._liveUpdate = false;
    if (this._gui) { this._gui.dispose(); }
    // Clear any DOM left behind by the disposed pane before creating the new
    // one — a stacked panel is never acceptable, whatever dispose() did.
    const container = document.getElementById('guiPanel');
    if (container) { container.innerHTML = ''; }
    this._gui = new Pane({
      title: 'Cascade Control Panel',
      container: container,
      expanded: !navigator.webdriver && window.innerWidth >= window.innerHeight,
    });
    this._guiSeparatorAdded = false;
    this._userGui = false;
    this._controls = {};

    // Add built-in controls directly. Refresh View is the cache escape hatch:
    // it dumps the worker's op cache and re-evaluates everything from scratch.
    this._handlers["addButton"]({ name: "Refresh View", callback: () => {
      this._app.engine.clearCache();
      this._app.editor.evaluateCode(true);
    } });
    this._handlers["addSlider"]({ name: "MeshRes", default: 0.1, min: 0.01, max: 2, step: 0.01, dp: 2 });
    this._userGui = true;
  }

  /** Add a separator before user-defined controls. */
  _addSeparator() {
    if (this._userGui && !this._guiSeparatorAdded) {
      this._guiSeparatorAdded = true;
      this._gui.addBlade({ view: 'separator' });
    }
  }

  /** Workaround for Tweakpane errors during change event callbacks. */
  _delayReload(opts) {
    setTimeout(() => { this._app.editor.evaluateCode(false, opts); }, 0);
  }
}

export { GUIManager };
