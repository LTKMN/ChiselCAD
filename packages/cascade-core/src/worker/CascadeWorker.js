// CascadeWorker - Main CAD worker entry point (cascade-core)

import { CascadeStudioStandardLibrary } from './StandardLibrary.js';
import { CascadeStudioMesher } from './ShapeToMesh.js';
import { CascadeStudioFileIO } from './FileUtils.js';

/** Main CAD worker class. Initializes OpenCascade WASM, loads dependencies,
 *  and orchestrates evaluation/rendering of user CAD code. */
class CascadeStudioWorker {
  constructor() {
    // Define persistent global variables on self for eval() access
    self.oc = null;
    self.externalShapes = {};
    self.sceneShapes = [];
    self.GUIState = {};
    self.fullShapeEdgeHashes = {};
    self.fullShapeFaceHashes = {};
    self.currentShape = null;
    self.messageHandlers = self.messageHandlers || {};

    // Store original console methods
    this.realConsoleLog = console.log;
    this.realConsoleError = console.error;

    // Forward logs and errors to the main thread
    this._setupConsoleOverrides();

    // Shim importScripts for module workers so Emscripten detects ENVIRONMENT_IS_WORKER
    // (Module workers don't have importScripts, causing Emscripten to fall into ENVIRONMENT_IS_SHELL)
    if (typeof importScripts === 'undefined') {
      self.importScripts = function() { throw new Error('importScripts is not supported in module workers'); };
    }

    // Register message handlers
    self.messageHandlers["Evaluate"] = this.evaluate.bind(this);
    self.messageHandlers["combineAndRenderShapes"] = this.combineAndRenderShapes.bind(this);
    self.messageHandlers["meshHistoryStep"] = this.meshHistoryStep.bind(this);
    self.messageHandlers["meshShapesAtLine"] = this.meshShapesAtLine.bind(this);
    // Escape hatch for stale cached shapes: dump the op cache so the next
    // evaluation recomputes (and re-caches) everything from scratch
    self.messageHandlers["clearCache"] = () => {
      for (const hash in self.argCache) { delete self.argCache[hash]; }
    };
  }

  /** Override console.log/error to forward messages to the main thread. */
  _setupConsoleOverrides() {
    const realLog = this.realConsoleLog;
    const realError = this.realConsoleError;

    console.log = function (...args) {
      const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      setTimeout(() => { postMessage({ type: "log", payload: message }); }, 0);
      realLog.apply(console, args);
    };

    console.error = function (err, url, line, colno, errorObj) {
      postMessage({ type: "resetWorking" });
      setTimeout(() => {
        if (err && err.message) {
          err.message = "INTERNAL OPENCASCADE ERROR DURING GENERATE: " + err.message;
          throw err;
        } else {
          throw new Error("INTERNAL OPENCASCADE ERROR: " + err);
        }
      }, 0);
      realError.apply(console, arguments);
    };
  }

  /** Asynchronously load all dependencies and initialize OpenCascade WASM. */
  async init() {
    let initOpenCascade, opentype, potpack;

    try {
      const ocMod = await import('opencascade.js/dist/cascadestudio.js');
      initOpenCascade = ocMod.default;
    } catch(e) {
      postMessage({ type: "log", payload: "ERROR loading opencascade: " + e.message });
      throw e;
    }

    try {
      const otMod = await import('opentype.js/dist/opentype.module.js');
      opentype = otMod.default;
    } catch(e) {
      postMessage({ type: "log", payload: "ERROR loading opentype: " + e.message });
      throw e;
    }

    try {
      const ppMod = await import('potpack');
      potpack = ppMod.default || ppMod.potpack || ppMod;
    } catch(e) {
      postMessage({ type: "log", payload: "ERROR loading potpack: " + e.message });
      throw e;
    }

    self.potpack = potpack;

    // Instantiate class-based modules (populates self.* for eval() access)
    this.standardLibrary = new CascadeStudioStandardLibrary();
    this.mesher = new CascadeStudioMesher();
    this.fileIO = new CascadeStudioFileIO();

    // Preload fonts available via Text3D
    this._loadFonts(opentype);

    // Load the OpenCascade WebAssembly Module (v2 Embind)
    try {
      const openCascade = await initOpenCascade({
        locateFile(path) {
          if (path.endsWith('.wasm')) {
            // In build mode, WASM is copied to the build output directory
            return typeof ESBUILD !== 'undefined' ? './cascadestudio.wasm' : '../../node_modules/opencascade.js/dist/cascadestudio.wasm';
          }
          return path;
        }
      });

      // Register the "OpenCascade" WebAssembly Module under the shorthand "oc"
      self.oc = openCascade;

      // Route incoming messages to registered handlers
      onmessage = function (e) {
        let response = self.messageHandlers[e.data.type](e.data.payload);
        if (response !== undefined || e.data.requestId) {
          const msg = { "type": e.data.type, payload: response };
          if (e.data.requestId) { msg.requestId = e.data.requestId; }
          postMessage(msg);
        }
      };

      // Signal that the worker is ready
      postMessage({ type: "startupCallback" });
    } catch(e) {
      postMessage({ type: "log", payload: "ERROR loading OpenCascade WASM: " + e.message });
      throw e;
    }
  }

  /** Preload the various fonts available via Text3D. */
  _loadFonts(opentype) {
    const fontBase = typeof ESBUILD !== 'undefined' ? './fonts/' : '../../fonts/';
    const preloadedFonts = [
      fontBase + 'Roboto.ttf',
      fontBase + 'Papyrus.ttf',
      fontBase + 'Consolas.ttf'
    ];
    self.loadedFonts = {};
    preloadedFonts.forEach((fontURL) => {
      // { isUrl: true } forces XHR instead of require('fs') since workers lack `window`
      opentype.load(fontURL, function (err, font) {
        if (err) { console.log(err); }
        let fontName = fontURL.split("./fonts/")[1] || fontURL.split("/fonts/")[1];
        fontName = fontName.split(".ttf")[0];
        self.loadedFonts[fontName] = font;
      }, { isUrl: true });
    });
  }

  /** Evaluate user CAD code (the contents of the Editor Window) and set the GUI State. */
  evaluate(payload) {
    self.opNumber = 0;
    // Each evaluation owns the scene from scratch. (Meshing no longer clears
    // sceneShapes — it must stay re-meshable for background refinement.)
    self.sceneShapes = [];
    self.GUIState = payload.GUIState || {};
    // Caching is always on unless the caller explicitly disables it
    if (!("Cache?" in self.GUIState)) { self.GUIState["Cache?"] = true; }

    // Reset cache counters and modeling history for this evaluation
    this.standardLibrary.utils.cacheHits = 0;
    this.standardLibrary.utils.cacheMisses = 0;
    self.cacheHits = 0;
    self.cacheMisses = 0;
    self.modelHistory = [];
    this.standardLibrary.utils.modelHistory = self.modelHistory;
    this.standardLibrary.utils._pendingHistoryOp = null;

    try {
      eval(payload.code);
    } catch (e) {
      setTimeout(() => {
        e.message = "Line " + self.currentLineNumber + ": " + self.currentOp + "() encountered  " + e.message;
        throw e;
      }, 0);
    } finally {
      // Flush the final operation's history step
      self.flushHistoryStep();

      // Send lightweight history metadata to main thread (no shape data)
      postMessage({
        type: "modelHistory",
        payload: self.modelHistory.map((step, i) => ({
          index: i,
          fnName: step.fnName,
          lineNumber: step.lineNumber,
          shapeCount: step.shapeCount,
          // Shape hashes present after this step — lets the main thread map
          // scene shapes back to the line of the op that created them
          hashes: step.shapes.map(s => (s && s.hash !== undefined) ? s.hash : null),
        }))
      });

      postMessage({ type: "log", payload: "Cache: " + self.cacheHits + " hits, " + self.cacheMisses + " misses" });
      postMessage({ type: "resetWorking" });
      // Clean cache; remove unused objects
      let usedHashes = this.standardLibrary.utils.usedHashes;
      for (let hash in self.argCache) {
        if (!usedHashes.hasOwnProperty(hash)) { delete self.argCache[hash]; }
      }
      for (let key in usedHashes) { delete usedHashes[key]; }
    }
  }

  /** Accumulate all shapes in `sceneShapes` into a compound,
   *  triangulate with ShapeToMesh, and return for rendering. */
  combineAndRenderShapes(payload) {
    let oc = self.oc;
    // Initialize currentShape as an empty Compound Solid
    self.currentShape = new oc.TopoDS_Compound();
    let sceneBuilder = new oc.BRep_Builder();
    // Note: BRep_Builder and TopoDS_Compound have no overloaded constructors in v2
    sceneBuilder.MakeCompound(self.currentShape);
    let fullShapeEdgeHashes = {}; let fullShapeFaceHashes = {};
    postMessage({ "type": "Progress", "payload": { "opNumber": self.opNumber++, "opType": "Combining Shapes" } });

    // If there are sceneShapes, iterate through them and add them to currentShape
    if (self.sceneShapes.length > 0) {
      // Provenance: hash + face count per scene shape, in compound order.
      // The viewport uses the cumulative face ranges to map a clicked face
      // back to the shape (and thus the code line) that produced it.
      let shapeRanges = [];
      for (let shapeInd = 0; shapeInd < self.sceneShapes.length; shapeInd++) {
        if (!self.sceneShapes[shapeInd] || !self.sceneShapes[shapeInd].IsNull || self.sceneShapes[shapeInd].IsNull()) {
          console.error("Null Shape detected in sceneShapes; skipping: " + JSON.stringify(self.sceneShapes[shapeInd]));
          continue;
        }
        if (!self.sceneShapes[shapeInd].ShapeType) {
          console.error("Non-Shape detected in sceneShapes; " +
            "are you sure it is a TopoDS_Shape and not something else that needs to be converted to one?");
          console.error(JSON.stringify(self.sceneShapes[shapeInd]));
          continue;
        }

        // Scan the edges and faces and add to the edge list
        Object.assign(fullShapeEdgeHashes, self.ForEachEdge(self.sceneShapes[shapeInd], (index, edge) => { }));
        let faceCount = 0;
        self.ForEachFace(self.sceneShapes[shapeInd], (index, face) => {
          fullShapeFaceHashes[self.oc.OCJS.HashCode(face, 100000000)] = index;
          faceCount++;
        });
        shapeRanges.push({
          hash: self.sceneShapes[shapeInd].hash !== undefined ? self.sceneShapes[shapeInd].hash : null,
          faceCount: faceCount,
        });

        sceneBuilder.Add(self.currentShape, self.sceneShapes[shapeInd]);
      }

      // Use ShapeToMesh to output triangulated faces and discretized edges to the 3D Viewport
      postMessage({ "type": "Progress", "payload": { "opNumber": self.opNumber++, "opType": "Triangulating Faces" } });
      let facesAndEdges = self.ShapeToMesh(self.currentShape,
        payload.maxDeviation || 0.1, fullShapeEdgeHashes, fullShapeFaceHashes);
      // sceneShapes intentionally NOT cleared: the background refine pass
      // re-meshes the same shapes at finer resolution. evaluate() resets it.
      postMessage({ "type": "Progress", "payload": { "opNumber": self.opNumber, "opType": "" } });
      return [facesAndEdges, payload.sceneOptions, shapeRanges];
    } else {
      console.error("There were no scene shapes returned!");
    }
    postMessage({ "type": "Progress", "payload": { "opNumber": self.opNumber, "opType": "" } });
  }

  /** Triangulate and return the shapes from a specific modeling history step.
   *  Called on-demand when the user scrubs the timeline. */
  meshHistoryStep(payload) {
    let step = self.modelHistory[payload.stepIndex];
    if (!step || step.shapes.length === 0) return null;

    let oc = self.oc;
    let compound = new oc.TopoDS_Compound();
    let builder = new oc.BRep_Builder();
    builder.MakeCompound(compound);

    let edgeHashes = {};
    let faceHashes = {};

    for (let shape of step.shapes) {
      if (!shape || shape.IsNull()) continue;
      Object.assign(edgeHashes, self.ForEachEdge(shape, () => {}));
      self.ForEachFace(shape, (index, face) => {
        faceHashes[oc.OCJS.HashCode(face, 100000000)] = index;
      });
      builder.Add(compound, shape);
    }

    let facesAndEdges = self.ShapeToMesh(compound, payload.maxDeviation || 0.1, edgeHashes, faceHashes);
    return facesAndEdges;
  }

  /** Triangulate the shapes that the op(s) on a given source line produced:
   *  the delta between each matching history step and the step before it.
   *  Used by the editor's cursor-to-3D highlight. Returns null if the line
   *  has no ops or the delta is empty. */
  meshShapesAtLine(payload) {
    const history = self.modelHistory;
    if (!history || history.length === 0) return null;

    let oc = self.oc;
    let deltaShapes = [];
    let seenHashes = {};
    for (let i = 0; i < history.length; i++) {
      if (history[i].lineNumber !== payload.lineNumber) continue;
      const prevHashes = {};
      if (i > 0) {
        for (const s of history[i - 1].shapes) {
          if (s && s.hash !== undefined) { prevHashes[s.hash] = true; }
        }
      }
      for (const s of history[i].shapes) {
        if (!s || s.IsNull()) continue;
        const h = s.hash;
        if (h !== undefined && (prevHashes[h] || seenHashes[h])) continue;
        if (h !== undefined) { seenHashes[h] = true; }
        deltaShapes.push(s);
      }
    }
    if (deltaShapes.length === 0) return null;

    let compound = new oc.TopoDS_Compound();
    let builder = new oc.BRep_Builder();
    builder.MakeCompound(compound);
    let edgeHashes = {};
    let faceHashes = {};
    for (let shape of deltaShapes) {
      Object.assign(edgeHashes, self.ForEachEdge(shape, () => {}));
      self.ForEachFace(shape, (index, face) => {
        faceHashes[oc.OCJS.HashCode(face, 100000000)] = index;
      });
      builder.Add(compound, shape);
    }
    return self.ShapeToMesh(compound, payload.maxDeviation || 0.3, edgeHashes, faceHashes);
  }
}

// Bootstrap the worker
const worker = new CascadeStudioWorker();
worker.init();

export { CascadeStudioWorker };
