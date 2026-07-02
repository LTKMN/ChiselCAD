// This file governs the 3D Viewport which displays the 3D Model
// It is also in charge of saving to STL and OBJ
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { HandleManager } from './CascadeViewHandles.js';

/** Base class for a 3D viewport environment.
 *  Includes floor, grid, fog, camera, lights, and orbit controls. */
class Environment {
  constructor(goldenContainer) {
    this.goldenContainer = goldenContainer;

    // Get the current Width and Height of the Parent Element
    this.parentWidth  = this.goldenContainer.width;
    this.parentHeight = this.goldenContainer.height;

    // Create the Canvas and WebGL Renderer
    this.curCanvas = document.createElement('canvas');
    this.goldenContainer.element.appendChild(this.curCanvas);
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.curCanvas, antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(this.parentWidth, this.parentHeight);
    this.goldenContainer.on('resize', this.onWindowResize.bind(this));

    // Create the Three.js Scene
    this.scene = new THREE.Scene();
    this.backgroundColor  = 0x222222;
    this.scene.background = new THREE.Color(this.backgroundColor);
    this.scene.fog        = new THREE.Fog(this.backgroundColor, 200, 600);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 5000);
    this.camera.position.set(50, 100, 150);
    this.camera.lookAt(0, 45, 0);
    this.camera.aspect = this.parentWidth / this.parentHeight;
    this.camera.updateProjectionMatrix();

    // Create two lights to evenly illuminate the model and cast shadows
    this.light  = new THREE.HemisphereLight(0xffffff, 0x444444);
    this.light.position.set(0, 200, 0);
    this.light2 = new THREE.DirectionalLight(0xbbbbbb);
    this.light2.position.set(6, 50, -12);
    this.light2.castShadow = true;
    this.light2.shadow.camera.top      =  200;
    this.light2.shadow.camera.bottom   = -200;
    this.light2.shadow.camera.left     = -200;
    this.light2.shadow.camera.right    =  200;
    this.light2.shadow.mapSize.width   =  128;
    this.light2.shadow.mapSize.height  =  128;
    this.scene.add(this.light);
    this.scene.add(this.light2);
    this.renderer.shadowMap.enabled    = true;
    this.renderer.shadowMap.type       = THREE.PCFSoftShadowMap;

    // Set up the orbit controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 45, 0);
    this.controls.panSpeed  = 2;
    this.controls.zoomSpeed = 1;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    // Keep track of the last time the scene was interacted with
    this.controls.addEventListener('change', () => this.viewDirty = true);
    this.isVisible = true;
    this.viewDirty = true;
    this.time = new THREE.Clock();
    this.time.autoStart = true;
    this.lastTimeRendered = 0.0;

    this.goldenContainer.layoutManager.eventHub.emit('Start');
  }

  /** Resize the container, canvas, and renderer when the window resizes. */
  onWindowResize() {
    this.goldenContainer.layoutManager.updateSize(
      window.innerWidth,
      window.innerHeight - document.getElementsByClassName('topnav')[0].offsetHeight
    );
    const aspect = this.goldenContainer.width / this.goldenContainer.height;
    if (this.camera.isOrthographicCamera) {
      const halfH = (this.camera.top - this.camera.bottom) / 2;
      this.camera.left = -halfH * aspect;
      this.camera.right = halfH * aspect;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.goldenContainer.width, this.goldenContainer.height);
    this.renderer.render(this.scene, this.camera);
    this.viewDirty = true;
  }
}

/** CAD-specific 3D viewport that extends Environment with shape rendering,
 *  edge/face highlighting, export functionality, and transform gizmos. */
class CascadeEnvironment {
  constructor(goldenContainer, app, getNewFileHandle, writeFile, downloadFile) {
    this.active          = true;
    this.goldenContainer = goldenContainer;
    this.environment     = new Environment(this.goldenContainer);
    this._app            = app;

    // State for the Hover Highlighting
    this.raycaster       = new THREE.Raycaster();
    this.highlightedObj  = null;
    this.fogDist         = 200;

    // State for the Handles
    this.handles         = [];
    this.gizmoMode       = "translate";
    this.gizmoSpace      = "local";

    // Load the Shiny Dull Metal Matcap Material
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('');
    this.matcap = this.loader.load('./textures/dullFrontLitMetal.png', () => {
      this.environment.viewDirty = true;
    });
    this.matcapMaterial = new THREE.MeshMatcapMaterial({
      color: new THREE.Color(0xf5f5f5),
      matcap: this.matcap,
      polygonOffset: true,
      polygonOffsetFactor: 2.0,
      polygonOffsetUnits: 1.0
    });

    // Store dependencies for export methods
    this._getNewFileHandle = getNewFileHandle;
    this._writeFile = writeFile;
    this._downloadFile = downloadFile;

    // Modeling history timeline state
    this._historySteps = [];       // Metadata from worker: [{fnName, lineNumber, shapeCount, volume, surfaceArea, solidCount}, ...]
    this._historyMeshCache = {};   // stepIndex → [facelist, edgelist]
    this._historyCurrentStep = -1; // -1 = showing final result (default)
    this._historyObject = null;    // THREE.Group for the history preview
    this._historyPending = false;  // True while awaiting worker mesh response
    this._lastSceneOptions = {};

    // Cursor-line → 3D highlight state
    this._lineHighlightObject = null;  // THREE.Group overlay for the highlighted line
    this._lineHighlightCache = {};     // lineNumber → meshData (cleared per evaluation)
    this._highlightedLine = null;
    // Click → code state: per-scene-shape {hash, faceCount} in mesh order
    this._shapeRanges = [];

    // Fit camera on first render so the orbit target centers on the model
    this._isFirstRender = true;

    // Set up mouse tracking
    this.mouse = { x: 0, y: 0 };
    this.goldenContainer.element.addEventListener('mousemove', (event) => {
      this.mouse.x =   (event.offsetX / this.goldenContainer.width) * 2 - 1;
      this.mouse.y = - (event.offsetY / this.goldenContainer.height) * 2 + 1;
    }, false);

    // Click (not orbit-drag) on the model → jump to the code line that made it
    const canvas = this.environment.renderer.domElement;
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this._clickStart = { x: e.clientX, y: e.clientY }; }
    });
    canvas.addEventListener('mouseup', (e) => {
      const start = this._clickStart;
      this._clickStart = null;
      if (!start || e.button !== 0) { return; }
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (dx * dx + dy * dy > 25) { return; } // that was an orbit/pan drag
      if (this.sketchActive) { return; }      // sketch mode owns clicks
      // Feature pick mode (Cut/Union/Fillet target selection) eats clicks
      if (this._app.sketchMode && this._app.sketchMode.handleViewportClick(e)) { return; }
      this._jumpToCodeAtMouse(e);
    });

    // Viewport display settings (app-level, not per-model) — persisted locally
    this._viewportSettings = { groundPlane: true, grid: true };
    try {
      Object.assign(this._viewportSettings, JSON.parse(localStorage.getItem('chisel-viewport') || '{}'));
    } catch (e) { /* corrupted prefs — fall back to defaults */ }

    // Create the timeline overlay DOM
    this._createTimelineOverlay();

    // Create the viewport settings popover (bottom-right corner)
    this._createViewportSettingsOverlay();

    // Initialize the Handle Manager (no messageBus needed — app wires events)
    this.handleManager = new HandleManager(this);

    // Start the animation loop
    this._animate();
    this.environment.renderer.render(this.environment.scene, this.environment.camera);
  }

  /** Render mesh data received from the engine.
   *  Replaces the old _registerRenderCallback / "combineAndRenderShapes" handler. */
  renderMeshData(meshData, sceneOptions, shapeRanges) {
    if (!meshData) return;
    const { faces: facelist, edges: edgelist } = meshData;
    window.workerWorking = false;
    if (!facelist) { return; }
    if (!sceneOptions) { sceneOptions = {}; }
    this._lastSceneOptions = sceneOptions;

    // New evaluation: stale provenance and line highlights are invalid
    this._shapeRanges = shapeRanges || [];
    this._lineHighlightCache = {};
    this._highlightedLine = null;
    this._clearLineHighlight();

    // The old mainObject is dead! Long live the mainObject!
    this.environment.scene.remove(this.mainObject);

    this._updateGroundAndGrid(sceneOptions);

    this.mainObject = this._buildObjectFromMesh(facelist, edgelist);

    // Expand fog distance to enclose the current object
    this.boundingBox = new THREE.Box3().setFromObject(this.mainObject);
    this.fogDist = Math.max(this.fogDist, this.boundingBox.min.distanceTo(this.boundingBox.max) * 1.5);
    this.environment.scene.fog = new THREE.Fog(this.environment.backgroundColor, this.fogDist, this.fogDist + 400);

    // Cache the final mesh data for the timeline's last step
    this._finalMeshData = [facelist, edgelist];

    // Reset timeline to show final result
    this._historyCurrentStep = -1;
    if (this._historyObject) {
      this.environment.scene.remove(this._historyObject);
      this._historyObject = null;
    }

    this.environment.scene.add(this.mainObject);
    if (this._isFirstRender || this._fitOnNextRender) {
      this._isFirstRender = false;
      this._fitOnNextRender = false;
      this.fitCamera();
    }
    this.environment.viewDirty = true;
    console.log("Generation Complete!");
  }

  /** Set history steps metadata. Replaces the old "modelHistory" handler. */
  setHistorySteps(steps) {
    this._historySteps = steps || [];
    this._historyMeshCache = {};
    this._historyCurrentStep = -1;
    this._updateTimelineDOM();
  }

  /** Fit the camera to frame the current model with a 3/4 elevated view.
   *  Always uses Y-up (the model group's -PI/2 X rotation maps OCC Z-up to Three.js Y-up). */
  fitCamera() {
    if (!this.mainObject && !this._historyObject) return;
    const target = this._historyObject || this.mainObject;
    const box = new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // Distance to fit the object in the camera frustum
    const fov = this.environment.camera.fov * (Math.PI / 180);
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.5;

    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3(1, 0.5, 1).normalize();

    this.environment.camera.up.copy(up);
    this.environment.camera.position.copy(center).addScaledVector(dir, dist);
    this.environment.controls.target.copy(center);
    this.environment.camera.lookAt(center);
    this.environment.controls.update();
    this.environment.viewDirty = true;
  }

  /** Set the camera angle using azimuth and elevation (in degrees). */
  setCameraAngle(azimuthDeg, elevationDeg) {
    this.fitCamera();

    const camera = this.environment.camera;
    const controls = this.environment.controls;
    const target = controls.target.clone();
    const dist = camera.position.distanceTo(target);
    const up = camera.up.clone().normalize();

    const az = ((azimuthDeg != null) ? azimuthDeg : 45) * Math.PI / 180;
    const el = ((elevationDeg != null) ? elevationDeg : 30) * Math.PI / 180;

    let temp = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    let right = new THREE.Vector3().crossVectors(temp, up).normalize();
    let forward = new THREE.Vector3().crossVectors(up, right).normalize();

    const cosEl = Math.cos(el);
    const sinEl = Math.sin(el);
    const dir = new THREE.Vector3()
      .addScaledVector(forward, cosEl * Math.cos(az))
      .addScaledVector(right, cosEl * Math.sin(az))
      .addScaledVector(up, sinEl)
      .normalize();

    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    controls.update();
    this.environment.viewDirty = true;
    this.environment.renderer.render(this.environment.scene, camera);
  }

  /** Build a THREE.Group from facelist/edgelist mesh data. */
  _buildObjectFromMesh(facelist, edgelist) {
    let group = new THREE.Group();
    group.name = "shape";
    group.rotation.x = -Math.PI / 2;

    // Add Triangulated Faces to Object
    let vertices = [], normals = [], triangles = [], uvs = [], colors = [];
    let vInd = 0; let globalFaceIndex = 0;
    facelist.forEach((face) => {
      vertices.push(...face.vertex_coord);
      normals.push(...face.normal_coord);
      uvs.push(...face.uv_coord);

      for (let i = 0; i < face.tri_indexes.length; i += 3) {
        triangles.push(
          face.tri_indexes[i + 0] + vInd,
          face.tri_indexes[i + 1] + vInd,
          face.tri_indexes[i + 2] + vInd
        );
      }

      for (let i = 0; i < face.vertex_coord.length; i += 3) {
        colors.push(face.face_index, globalFaceIndex, 0);
      }

      globalFaceIndex++;
      vInd += face.vertex_coord.length / 3;
    });

    let geometry = new THREE.BufferGeometry();
    geometry.setIndex(triangles);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    let model = new THREE.Mesh(geometry, this.matcapMaterial);
    model.castShadow = true;
    model.name = "Model Faces";
    group.add(model);

    // Add Highlightable Edges to Object
    let lineVertices = []; let globalEdgeIndices = [];
    let curGlobalEdgeIndex = 0;
    let globalEdgeMetadata = {}; globalEdgeMetadata[-1] = { start: -1, end: -1 };
    edgelist.forEach((edge) => {
      let edgeMetadata = {};
      edgeMetadata.localEdgeIndex = edge.edge_index;
      edgeMetadata.start = globalEdgeIndices.length;
      for (let i = 0; i < edge.vertex_coord.length - 3; i += 3) {
        lineVertices.push(new THREE.Vector3(
          edge.vertex_coord[i], edge.vertex_coord[i + 1], edge.vertex_coord[i + 2]
        ));
        lineVertices.push(new THREE.Vector3(
          edge.vertex_coord[i + 3], edge.vertex_coord[i + 1 + 3], edge.vertex_coord[i + 2 + 3]
        ));
        globalEdgeIndices.push(curGlobalEdgeIndex);
        globalEdgeIndices.push(curGlobalEdgeIndex);
      }
      edgeMetadata.end = globalEdgeIndices.length - 1;
      globalEdgeMetadata[curGlobalEdgeIndex] = edgeMetadata;
      curGlobalEdgeIndex++;
    });

    let lineGeometry = new THREE.BufferGeometry().setFromPoints(lineVertices);
    let lineColors = [];
    for (let i = 0; i < lineVertices.length; i++) { lineColors.push(0, 0, 0); }
    lineGeometry.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3));
    let lineMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff, linewidth: 1.5, vertexColors: true
    });
    let line = new THREE.LineSegments(lineGeometry, lineMaterial);
    line.globalEdgeIndices = globalEdgeIndices;
    line.name = "Model Edges";
    line.lineColors = lineColors;
    line.globalEdgeMetadata = globalEdgeMetadata;
    line.highlightEdgeAtLineIndex = function (lineIndex) {
      let edgeIndex  = lineIndex >= 0 ? this.globalEdgeIndices[lineIndex] : lineIndex;
      let startIndex = this.globalEdgeMetadata[edgeIndex].start;
      let endIndex   = this.globalEdgeMetadata[edgeIndex].end;
      for (let i = 0; i < this.lineColors.length; i++) {
        let colIndex       = Math.floor(i / 3);
        this.lineColors[i] = (colIndex >= startIndex && colIndex <= endIndex) ? 1 : 0;
      }
      this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.lineColors, 3));
    }.bind(line);
    line.getEdgeMetadataAtLineIndex = function (lineIndex) {
      return this.globalEdgeMetadata[this.globalEdgeIndices[lineIndex]];
    }.bind(line);
    line.clearHighlights = function () {
      return this.highlightEdgeAtLineIndex(-1);
    }.bind(line);
    group.add(line);

    return group;
  }

  /** Create the timeline overlay DOM elements. */
  /** Highlight the geometry produced by the op(s) on a source line with a
   *  translucent overlay. Pass a line with no ops (or -1) to clear. */
  highlightShapesAtLine(lineNumber) {
    if (lineNumber === this._highlightedLine) { return; }
    this._highlightedLine = lineNumber;

    const hasOp = this._historySteps.some(s => s.lineNumber === lineNumber);
    if (!hasOp) { this._clearLineHighlight(); return; }

    const cached = this._lineHighlightCache[lineNumber];
    if (cached !== undefined) { this._showLineHighlight(cached); return; }

    // Don't queue highlight meshing behind an active evaluation — the cursor
    // will re-trigger once things settle
    if (window.workerWorking) { return; }

    this._app.engine.meshShapesAtLine(lineNumber).then((meshData) => {
      this._lineHighlightCache[lineNumber] = meshData || null;
      if (this._highlightedLine === lineNumber) { this._showLineHighlight(meshData); }
    }).catch(() => { /* worker busy or line vanished — next cursor move retries */ });
  }

  /** Replace the current line-highlight overlay with one built from meshData. */
  _showLineHighlight(meshData) {
    this._clearLineHighlight();
    if (!meshData) { return; }
    const [facelist] = meshData;
    if (!facelist || facelist.length === 0) { return; }

    const vertices = [], triangles = [];
    let vInd = 0;
    facelist.forEach((face) => {
      vertices.push(...face.vertex_coord);
      for (let i = 0; i < face.tri_indexes.length; i += 3) {
        triangles.push(
          face.tri_indexes[i + 0] + vInd,
          face.tri_indexes[i + 1] + vInd,
          face.tri_indexes[i + 2] + vInd
        );
      }
      vInd += face.vertex_coord.length / 3;
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(triangles);
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.MeshBasicMaterial({
      color: 0x4CAF50, transparent: true, opacity: 0.35,
      depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -4.0, polygonOffsetUnits: -4.0,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 999;

    const group = new THREE.Group();
    group.rotation.x = -Math.PI / 2;  // same OCC Z-up → Three Y-up mapping as the model
    group.add(mesh);

    this._lineHighlightObject = group;
    this.environment.scene.add(group);
    this.environment.viewDirty = true;
  }

  /** Remove the line-highlight overlay, if any. */
  _clearLineHighlight() {
    if (!this._lineHighlightObject) { return; }
    this.environment.scene.remove(this._lineHighlightObject);
    this._lineHighlightObject.traverse((o) => {
      if (o.geometry) { o.geometry.dispose(); }
      if (o.material) { o.material.dispose(); }
    });
    this._lineHighlightObject = null;
    this.environment.viewDirty = true;
  }

  /** Raycast a mouse event against the model → the clicked scene shape's
   *  history hash, or null. */
  _shapeHashAtMouse(event) {
    if (!this.mainObject || this._shapeRanges.length === 0) { return null; }

    const canvas = this.environment.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.environment.camera);
    const hits = this.raycaster.intersectObject(this.mainObject, true);
    const hit = hits.find(h => h.object.name === "Model Faces");
    if (!hit || !hit.face) { return null; }

    // The mesh's color channel packs (local face index, global face index, 0)
    const globalFaceIndex = hit.object.geometry.getAttribute('color').getY(hit.face.a);

    // Map global face index → scene shape via cumulative face ranges
    let cumulative = 0;
    for (const range of this._shapeRanges) {
      cumulative += range.faceCount;
      if (globalFaceIndex < cumulative) { return range.hash; }
    }
    return null;
  }

  /** The shape under the mouse and the source line of the op that created it
   *  (its first appearance in the history). Used by feature pick mode. */
  shapeInfoAtMouse(event) {
    const hash = this._shapeHashAtMouse(event);
    if (hash === null || hash === undefined) { return null; }
    const step = this._historySteps.find(s => (s.hashes || []).includes(hash));
    return { hash, definingLine: (step && step.lineNumber >= 1) ? step.lineNumber : -1 };
  }

  /** Raycast a click against the model; jump the editor to the line whose op
   *  created the clicked shape. */
  _jumpToCodeAtMouse(event) {
    const hash = this._shapeHashAtMouse(event);
    if (hash === null || hash === undefined) { return; }

    // Highlight the shape's full lineage — every line whose op contributed to
    // it — with the cursor at the block's first (defining) line
    const lines = this._lineageLines(hash);
    if (lines.length === 0) { return; }
    this._app.editor.highlightLineage(lines, Math.min(...lines));
  }

  /** All source lines that contributed to building the shape with this hash:
   *  the op that created it, the ops that created the shapes it consumed, and
   *  so on back to the first primitive. Derived from history hash sets — an
   *  op's parents are the shapes present before it but gone after it. */
  _lineageLines(hash) {
    const steps = this._historySteps;
    const hashSets = steps.map(s => new Set((s.hashes || []).filter(h => h !== null && h !== undefined)));

    const lines = new Set();
    const visited = new Set();
    const visit = (h) => {
      if (h === null || h === undefined || visited.has(h)) { return; }
      visited.add(h);
      const k = hashSets.findIndex(set => set.has(h));
      if (k === -1) { return; }
      if (steps[k].lineNumber >= 1) { lines.add(steps[k].lineNumber); }
      if (k > 0) {
        for (const parent of hashSets[k - 1]) {
          if (!hashSets[k].has(parent)) { visit(parent); }
        }
      }
    };
    visit(hash);
    return [...lines];
  }

  /** Scene options derived from viewport settings, sent with each evaluation. */
  getSceneOptions() {
    return {
      groundPlaneVisible: this._viewportSettings.groundPlane,
      gridVisible: this._viewportSettings.grid,
    };
  }

  /** Update a viewport setting, persist it, and apply it to the scene live. */
  setViewportSetting(key, value) {
    this._viewportSettings[key] = value;
    try {
      localStorage.setItem('chisel-viewport', JSON.stringify(this._viewportSettings));
    } catch (e) { /* private mode etc. — setting still applies this session */ }
    this._updateGroundAndGrid(this.getSceneOptions());
    this._lastSceneOptions = this.getSceneOptions();
    this.environment.viewDirty = true;
  }

  /** (Re)create or remove the ground plane and grid to match sceneOptions. */
  _updateGroundAndGrid(sceneOptions) {
    this.environment.scene.remove(this.groundMesh);
    if (sceneOptions.groundPlaneVisible) {
      this.groundMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2000, 2000),
        new THREE.MeshPhongMaterial({
          color: 0x080808, depthWrite: true, dithering: true,
          polygonOffset: true,
          polygonOffsetFactor: 6.0, polygonOffsetUnits: 1.0
        })
      );
      this.groundMesh.position.y = -0.1;
      this.groundMesh.rotation.x = -Math.PI / 2;
      this.groundMesh.receiveShadow = true;
      this.environment.scene.add(this.groundMesh);
    }

    this.environment.scene.remove(this.grid);
    if (sceneOptions.gridVisible) {
      this.grid = new THREE.GridHelper(2000, 20, 0xcccccc, 0xcccccc);
      this.grid.position.y = -0.01;
      this.grid.material.opacity = 0.3;
      this.grid.material.transparent = true;
      this.environment.scene.add(this.grid);
    }
  }

  /** Blender-style viewport settings button + popover in the bottom-right
   *  corner. New display settings (matcap, SSAO, ...) slot into the defs list. */
  _createViewportSettingsOverlay() {
    const settingsDefs = [
      { key: 'groundPlane', label: 'Ground Plane' },
      { key: 'grid', label: 'Grid' },
    ];

    const container = document.createElement('div');
    container.className = 'cs-vpset';
    this.goldenContainer.element.appendChild(container);

    const popover = document.createElement('div');
    popover.className = 'cs-vpset-popover';
    popover.style.display = 'none';

    const title = document.createElement('div');
    title.className = 'cs-vpset-title';
    title.textContent = 'Viewport';
    popover.appendChild(title);

    for (const def of settingsDefs) {
      const row = document.createElement('label');
      row.className = 'cs-vpset-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!this._viewportSettings[def.key];
      checkbox.addEventListener('change', () => {
        this.setViewportSetting(def.key, checkbox.checked);
      });

      const text = document.createElement('span');
      text.textContent = def.label;

      row.appendChild(checkbox);
      row.appendChild(text);
      popover.appendChild(row);
    }

    const button = document.createElement('button');
    button.className = 'cs-vpset-btn';
    button.type = 'button';
    button.title = 'Viewport settings';
    button.textContent = '◐';
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.style.display = popover.style.display === 'none' ? 'block' : 'none';
    });

    // Close when clicking anywhere outside the popover
    document.addEventListener('mousedown', (e) => {
      if (popover.style.display !== 'none' && !container.contains(e.target)) {
        popover.style.display = 'none';
      }
    });

    container.appendChild(popover);
    container.appendChild(button);
  }

  _createTimelineOverlay() {
    this._timelineContainer = document.createElement('div');
    this._timelineContainer.className = 'cs-timeline';
    this._timelineContainer.style.display = 'none';
    this.goldenContainer.element.appendChild(this._timelineContainer);

    // Track container holds the step icons
    this._timelineTrack = document.createElement('div');
    this._timelineTrack.className = 'cs-timeline-track';
    this._timelineContainer.appendChild(this._timelineTrack);

    // Scrubbing state
    this._isScrubbing = false;

    this._timelineTrack.addEventListener('mousedown', (e) => {
      this._isScrubbing = true;
      this._scrubToPosition(e);
    });
    window.addEventListener('mousemove', (e) => {
      if (this._isScrubbing) this._scrubToPosition(e);
    });
    window.addEventListener('mouseup', () => {
      this._isScrubbing = false;
    });
  }

  /** Map a mouse event to the closest timeline step element. */
  _scrubToPosition(e) {
    let children = this._timelineTrack.children;
    if (children.length === 0) return;

    let mouseX = e.clientX;
    let closestIndex = 0;
    let closestDist = Infinity;
    for (let i = 0; i < children.length; i++) {
      let rect = children[i].getBoundingClientRect();
      let centerX = rect.left + rect.width / 2;
      let dist = Math.abs(mouseX - centerX);
      if (dist < closestDist) {
        closestDist = dist;
        closestIndex = i;
      }
    }

    if (closestIndex >= this._historySteps.length) {
      this._showFinalResult();
    } else {
      this._showHistoryStep(closestIndex);
    }
  }

  /** Show the final (fully evaluated) result. */
  _showFinalResult() {
    if (this._historyCurrentStep === -1) return;
    this._historyCurrentStep = -1;

    if (this._historyObject) {
      this.environment.scene.remove(this._historyObject);
      this._historyObject = null;
    }
    if (this.mainObject) {
      this.mainObject.visible = true;
    }

    this._updateTimelineHighlight();
    this.environment.viewDirty = true;

    if (this._onHistoryStepChange) this._onHistoryStepChange(null);
  }

  /** Show an intermediate history step. Triangulates lazily via engine request. */
  async _showHistoryStep(stepIndex) {
    if (stepIndex === this._historyCurrentStep) return;
    if (this._historyPending) return;
    this._historyCurrentStep = stepIndex;
    this._updateTimelineHighlight();

    let step = this._historySteps[stepIndex];
    if (this._onHistoryStepChange && step) {
      this._onHistoryStepChange(step.lineNumber);
    }

    if (this.mainObject) {
      this.mainObject.visible = false;
    }

    if (this._historyMeshCache[stepIndex]) {
      this._displayHistoryMesh(this._historyMeshCache[stepIndex]);
      return;
    }

    if (step && step.shapeCount === 0) {
      this._displayHistoryMesh(null);
      return;
    }

    // Request triangulation from engine
    this._historyPending = true;
    try {
      let meshData = await this._app.engine.meshHistoryStep(
        stepIndex,
        this._lastSceneOptions.meshRes || 0.1
      );
      this._historyMeshCache[stepIndex] = meshData;
      if (this._historyCurrentStep === stepIndex) {
        this._displayHistoryMesh(meshData);
      }
    } finally {
      this._historyPending = false;
    }
  }

  /** Display a pre-triangulated history mesh in the scene. */
  _displayHistoryMesh(meshData) {
    if (this._historyObject) {
      this.environment.scene.remove(this._historyObject);
      this._historyObject = null;
    }

    if (meshData) {
      let [facelist, edgelist] = meshData;
      if (facelist && facelist.length > 0) {
        this._historyObject = this._buildObjectFromMesh(facelist, edgelist);
        this.environment.scene.add(this._historyObject);
      }
    }

    this.environment.viewDirty = true;
  }

  /** Update the timeline DOM to reflect current history steps. */
  _updateTimelineDOM() {
    if (this._historySteps.length <= 1) {
      this._timelineContainer.style.display = 'none';
      return;
    }

    this._timelineContainer.style.display = '';
    this._timelineTrack.innerHTML = '';

    const iconMap = {
      'Box': '\u25A1', 'Sphere': '\u25CB', 'Cylinder': '\u25AD',
      'Cone': '\u25B3', 'Polygon': '\u2B23', 'Circle': '\u25EF',
      'BSpline': '\u223F', 'Text3D': 'T', 'Wedge': '\u25C7',
      'Translate': '\u2192', 'Rotate': '\u21BB', 'Mirror': '\u2194', 'Scale': '\u2922',
      'Union': '\u222A', 'Difference': '\u2216', 'Intersection': '\u2229',
      'Extrude': '\u2191', 'Revolve': '\u21BA', 'Offset': '\u29C9',
      'Pipe': '\u2240', 'Loft': '\u22C8', 'Fillet': '\u25E0',
      'Chamfer': '\u25FA', 'Section': '\u2500', 'Shell': '\u25A2',
      'Sketch': '\u270E', 'MakeSolid': '\u25A0', 'MakeWire': '\u2312',
    };

    for (let i = 0; i <= this._historySteps.length; i++) {
      let dot = document.createElement('div');
      dot.className = 'cs-timeline-step';

      if (i < this._historySteps.length) {
        let step = this._historySteps[i];
        dot.textContent = iconMap[step.fnName] || '\u2022';
        dot.title = `${step.fnName}() — line ${step.lineNumber} (${step.shapeCount} shape${step.shapeCount !== 1 ? 's' : ''})`;
      } else {
        dot.textContent = '\u2713';
        dot.title = 'Final result';
        dot.classList.add('cs-timeline-final');
      }

      this._timelineTrack.appendChild(dot);
    }

    this._updateTimelineHighlight();
  }

  /** Highlight the current step in the timeline. */
  _updateTimelineHighlight() {
    let steps = this._timelineTrack.children;
    for (let i = 0; i < steps.length; i++) {
      let isActive;
      if (this._historyCurrentStep === -1) {
        isActive = (i === steps.length - 1);
      } else {
        isActive = (i === this._historyCurrentStep);
      }
      steps[i].classList.toggle('cs-timeline-active', isActive);
    }
  }

  /** Save the current shape to .step. */
  async saveShapeSTEP() {
    try {
      const stepContent = await this._app.engine.exportSTEP();
      if (window.showSaveFilePicker) {
        const fileHandle = await this._getNewFileHandle("STEP files", "text/plain", "step");
        this._writeFile(fileHandle, stepContent).then(() => {
          console.log("Saved STEP to " + fileHandle.name);
        });
      } else {
        await this._downloadFile(stepContent, "Untitled", "model/step", "step");
      }
    } catch (e) {
      console.error("Failed to export STEP: " + e.message);
    }
  }

  /** Save the current shape to an ASCII .stl. */
  async saveShapeSTL() {
    let stlExporter = new STLExporter();
    let result = stlExporter.parse(this.mainObject);
    if (window.showSaveFilePicker) {
      const fileHandle = await this._getNewFileHandle("STL files", "text/plain", "stl");
      this._writeFile(fileHandle, result).then(() => {
        console.log("Saved STL to " + fileHandle.name);
      });
    } else {
      await this._downloadFile(result, "Untitled", "model/stl", "stl");
    }
  }

  /** Save the current shape to .obj. */
  async saveShapeOBJ() {
    let objExporter = new OBJExporter();
    let result = objExporter.parse(this.mainObject);
    if (window.showSaveFilePicker) {
      const fileHandle = await this._getNewFileHandle("OBJ files", "text/plain", "obj");
      this._writeFile(fileHandle, result).then(() => {
        console.log("Saved OBJ to " + fileHandle.name);
      });
    } else {
      await this._downloadFile(result, "Untitled", "model/obj", "obj");
    }
  }

  /** Clear all transform handles. Delegates to HandleManager. */
  clearTransformHandles() {
    this.handleManager.clearTransformHandles();
  }

  /** Animation loop - handles highlighting and rendering. */
  _animate() {
    if (!this.active) { return; }

    requestAnimationFrame(() => this._animate());

    if (this.mainObject && !this.sketchActive) {
      this.raycaster.setFromCamera(this.mouse, this.environment.camera);
      let intersects = this.raycaster.intersectObjects(this.mainObject.children);
      if (this.environment.controls.state < 0 && intersects.length > 0) {
        let isLine = intersects[0].object.type === "LineSegments";
        let newIndex = isLine
          ? intersects[0].object.getEdgeMetadataAtLineIndex(intersects[0].index).localEdgeIndex
          : intersects[0].object.geometry.attributes.color.getX(intersects[0].face.a);
        if (this.highlightedObj != intersects[0].object || this.highlightedIndex !== newIndex) {
          if (this.highlightedObj) {
            this.highlightedObj.material.color.setHex(this.highlightedObj.currentHex);
            if (this.highlightedObj && this.highlightedObj.clearHighlights) {
              this.highlightedObj.clearHighlights();
            }
          }
          this.highlightedObj = intersects[0].object;
          this.highlightedObj.currentHex = this.highlightedObj.material.color.getHex();
          this.highlightedObj.material.color.setHex(0xffffff);
          this.highlightedIndex = newIndex;
          if (isLine) { this.highlightedObj.highlightEdgeAtLineIndex(intersects[0].index); }
          this.environment.viewDirty = true;
        }

        let indexHelper = (isLine ? "Edge" : "Face") + " Index: " + this.highlightedIndex;
        this.goldenContainer.element.title = indexHelper;
      } else {
        if (this.highlightedObj) {
          this.highlightedObj.material.color.setHex(this.highlightedObj.currentHex);
          if (this.highlightedObj.clearHighlights) { this.highlightedObj.clearHighlights(); }
          this.environment.viewDirty = true;
        }
        this.highlightedObj = null;
        this.goldenContainer.element.title = "";
      }
    }

    if (this.handles && this.handles.length > 0) {
      for (let i = 0; i < this.handles.length; i++) {
        this.environment.viewDirty = this.handles[i].dragging || this.environment.viewDirty;
      }
    }

    if (this.environment.viewDirty) {
      this.environment.renderer.render(this.environment.scene, this.environment.camera);
      this.environment.viewDirty = false;
    }
  }
}

export { Environment, CascadeEnvironment };
