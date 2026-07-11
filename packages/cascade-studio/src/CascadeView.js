// This file governs the 3D Viewport which displays the 3D Model
// It is also in charge of saving to STL and OBJ
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { HandleManager } from './CascadeViewHandles.js';
import { VIEWPORT_DEFAULTS } from './ThemeManager.js';

const DEFAULT_MATCAP = 'ceramic_lightbulb.png';

/** Base class for a 3D viewport environment.
 *  Includes infinite grid, camera, lights, and orbit controls. */
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
    this.scene.add(this.light);
    this.scene.add(this.light2);

    // Set up the orbit controls, Blender-style: middle-mouse orbits,
    // Shift+middle pans (OrbitControls flips ROTATE→PAN on shift/ctrl/meta
    // itself), wheel zooms. Left is reserved for selection and sketching;
    // right-drag pans as a bonus (and stays available while sketching,
    // where rotate is disabled).
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
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

    // Viewport theme colors (overridden by ThemeManager.applyToViewport
    // right after construction when a Blender theme is active)
    this._vtheme         = Object.assign({}, VIEWPORT_DEFAULTS);

    // State for the Handles
    this.handles         = [];
    this.gizmoMode       = "translate";
    this.gizmoSpace      = "local";

    // Screenshake magnitude (game juice), decays in _animate
    this._shakeMag       = 0;
    // Shake armed to fire when the next model render lands
    this._pendingShake   = 0;

    // Viewport display settings (app-level, not per-model) — persisted
    // locally. Loaded before the matcap so the choice applies from frame one.
    this._viewportSettings = { grid: true, gridScale: 10, matcap: DEFAULT_MATCAP, juice: true };
    try {
      Object.assign(this._viewportSettings, JSON.parse(localStorage.getItem('chisel-viewport') || '{}'));
    } catch (e) { /* corrupted prefs — fall back to defaults */ }

    // Load the matcap material (selection lives in the viewport settings)
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin('');
    this.matcap = this._loadMatcapTexture(this._viewportSettings.matcap);
    this.matcapMaterial = new THREE.MeshMatcapMaterial({
      color: new THREE.Color(0xf5f5f5),
      matcap: this.matcap,
      polygonOffset: true,
      polygonOffsetFactor: 2.0,
      polygonOffsetUnits: 1.0
    });

    // Bare sketch faces (2D profiles awaiting a feature) render as
    // double-sided translucent ghosts — visible from behind, and clearly
    // "profile, not geometry". Tinted by the theme's glow color.
    this.sketchGhostMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this._vtheme.glow),
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
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

    // Create the timeline overlay DOM
    this._createTimelineOverlay();

    // Create the viewport settings popover (bottom-right corner)
    this._createViewportSettingsOverlay();

    // Initialize the Handle Manager (no messageBus needed — app wires events)
    this.handleManager = new HandleManager(this);

    // Pure-Three.js loading indicator: lives in the scene from frame one,
    // long before the OCCT worker has finished fetching/compiling the WASM
    this._createLoadingSpinner();

    // Start the animation loop
    this._animate();
    this.environment.renderer.render(this.environment.scene, this.environment.camera);
  }

  /** A gyroscope model spinning at the orbit target while the kernel warms
   *  up: gyro_main revolves about vertical Y, its child gyro_sub spins on
   *  its horizontal axle. Dismissed by the first real mesh render or an
   *  engine error. Falls back to procedural rings if the glb fails. */
  _createLoadingSpinner() {
    // Headless tests render via swiftshader — a continuously-animating
    // spinner burns a CPU core per worker and starves the WASM compile
    if (navigator.webdriver) { return; }
    new GLTFLoader().load('./icon/gyroscope.glb', (gltf) => {
      if (this._spinnerDismissed) { return; }
      const model = gltf.scene;
      // Re-dress in the app's matcap shading, tinted with the glb's own
      // colors — the exported chrome is fully metallic, which renders
      // near-black without an environment map
      model.traverse((o) => {
        if (!o.isMesh) { return; }
        const tint = (o.material && o.material.color) || new THREE.Color(0xf5f5f5);
        o.material = new THREE.MeshMatcapMaterial({ color: tint, matcap: this.matcap });
      });
      this._spinnerMain = model.getObjectByName('gyro_main');
      this._spinnerSub  = model.getObjectByName('gyro_sub');
      this._mountSpinner(model, 12);
    }, undefined, () => {
      if (this._spinnerDismissed) { return; }
      // Fallback: three nested tumbling rings
      const rings = new THREE.Group();
      const mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(this._vtheme.glow),
        transparent: true,
        opacity: 0.85,
      });
      for (const r of [30, 23, 16]) {
        rings.add(new THREE.Mesh(new THREE.TorusGeometry(r, 1.1, 12, 64), mat));
      }
      this._mountSpinner(rings, 1);
    });
  }

  _mountSpinner(model, scale) {
    const group = new THREE.Group();
    group.name = "Loading Spinner";
    group.add(model);
    group.scale.setScalar(scale);
    group.position.copy(this.environment.controls.target);
    this._spinner = group;
    this.environment.scene.add(group);
    this.environment.viewDirty = true;
  }

  /** Remove the loading spinner, if it's still up (idempotent). The flag
   *  also stops a glb that finishes loading after dismissal from mounting. */
  dismissLoadingSpinner() {
    this._spinnerDismissed = true;
    if (!this._spinner) { return; }
    this.environment.scene.remove(this._spinner);
    this._spinner.traverse((o) => {
      if (o.geometry) { o.geometry.dispose(); }
      if (o.material) { o.material.dispose(); }
    });
    this._spinner = this._spinnerMain = this._spinnerSub = null;
    this.environment.viewDirty = true;
  }

  /** Render mesh data received from the engine.
   *  Replaces the old _registerRenderCallback / "combineAndRenderShapes" handler. */
  renderMeshData(meshData, sceneOptions, shapeRanges) {
    this.dismissLoadingSpinner();  // the real 3D has arrived
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

    this.mainObject = this._buildObjectFromMesh(facelist, edgelist, this._shapeRanges);

    this.boundingBox = new THREE.Box3().setFromObject(this.mainObject);

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
    // An armed commit-shake fires now, on the same frame the new model
    // appears — kicking at commit time would land before the redraw
    if (this._pendingShake) {
      this.shake(this._pendingShake);
      this._pendingShake = 0;
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

  /** Blender-style view presets (numpad 7/1/3 + Shift): swing the camera to
   *  an axis view at its current distance. Directions are Three world axes;
   *  in OCC terms top looks down -Z, front looks from -Y, right from +X. */
  setViewPreset(name) {
    // `up` shapes the tween's roll; `pole` marks views that land on the
    // orbit pole and gives the horizontal bias that keeps their on-screen
    // roll when camera.up is reset to world up afterward (see tween end).
    const VIEWS = {
      top:    { dir: [0, 1, 0],  up: [0, 0, -1], pole: [0, 0, 1] },
      bottom: { dir: [0, -1, 0], up: [0, 0, -1], pole: [0, 0, -1] },  // X mirrors, like Blender
      front:  { dir: [0, 0, 1],  up: [0, 1, 0] },
      back:   { dir: [0, 0, -1], up: [0, 1, 0] },
      right:  { dir: [1, 0, 0],  up: [0, 1, 0] },
      left:   { dir: [-1, 0, 0], up: [0, 1, 0] },
    };
    const v = VIEWS[name];
    if (!v) { return; }
    const env = this.environment;
    const cam = env.camera, ctl = env.controls;
    const target = ctl.target.clone();
    const dist = cam.position.distanceTo(target) || 100;

    // Tween the view DIRECTION (slerp), not the position — a straight
    // position lerp between opposite views passes through the target and
    // makes lookAt degenerate at the midpoint.
    const d0 = cam.position.clone().sub(target).normalize();
    if (d0.lengthSq() < 0.5) { d0.set(0, 0, 1); }
    const d1 = new THREE.Vector3(...v.dir);
    const up0 = cam.up.clone(), up1 = new THREE.Vector3(...v.up);
    const qFull = new THREE.Quaternion().setFromUnitVectors(d0, d1);
    const qNone = new THREE.Quaternion();

    const gen = this._viewTweenGen = (this._viewTweenGen || 0) + 1;
    const dur = 200, start = performance.now();
    const step = (now) => {
      if (this._viewTweenGen !== gen) { return; } // superseded by a newer move
      let k = Math.min(1, (now - start) / dur);
      k = k * k * (3 - 2 * k); // smoothstep
      const q = qNone.clone().slerp(qFull, k);
      cam.position.copy(target).addScaledVector(d0.clone().applyQuaternion(q), dist);
      cam.up.lerpVectors(up0, up1, k).normalize();
      cam.lookAt(target);
      env.viewDirty = true;
      if (k < 1) { requestAnimationFrame(step); }
      else {
        // Land turntable-clean: OrbitControls orbits around world +Y but
        // rolls the view to honor camera.up, so a non-world up left here
        // makes every later orbit fight the user. Top/bottom sit on the
        // orbit pole where world up is degenerate — bias the camera a hair
        // toward the horizontal direction that reproduces the roll the
        // tween just landed on, so the reset is invisible.
        if (v.pole) { cam.position.addScaledVector(new THREE.Vector3(...v.pole), dist * 1e-4); }
        cam.up.set(0, 1, 0);
        cam.lookAt(target);
        ctl.update();
      }
    };
    requestAnimationFrame(step);
  }

  /** Blender-style perspective toggle (numpad 5): swap between perspective
   *  and orthographic projection, preserving the apparent framing. */
  togglePerspective() {
    const env = this.environment;
    if (env.camera.isOrthographicCamera) {
      const ortho = env.camera, persp = this._savedPerspective;
      if (!persp) { return; } // ortho owned by someone else (e.g. sketch mode)
      this._savedPerspective = null;
      const target = env.controls.target;
      const halfH = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      const dist = halfH / Math.tan(persp.fov * Math.PI / 360);
      const dir = ortho.position.clone().sub(target);
      if (dir.lengthSq() < 1e-9) { dir.set(0, 0, 1); } else { dir.normalize(); }
      persp.position.copy(target).addScaledVector(dir, dist);
      persp.up.copy(ortho.up);
      persp.lookAt(target);
      env.camera = persp;
      env.controls.object = persp;
    } else {
      const persp = env.camera;
      const canvas = env.renderer.domElement;
      const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
      const dist = persp.position.distanceTo(env.controls.target);
      const halfH = dist * Math.tan(persp.fov * Math.PI / 360);
      const ortho = new THREE.OrthographicCamera(
        -halfH * aspect, halfH * aspect, halfH, -halfH, -5000, 5000
      );
      ortho.position.copy(persp.position);
      ortho.up.copy(persp.up);
      ortho.lookAt(env.controls.target);
      this._savedPerspective = persp;
      env.camera = ortho;
      env.controls.object = ortho;
    }
    env.controls.update();
    env.viewDirty = true;
  }

  /** Build a THREE.Group from facelist/edgelist mesh data. With shapeRanges,
   *  BRep faces belonging to bare sketch shapes split into a second
   *  double-sided ghost mesh; absolute global face indices are preserved so
   *  provenance (click → code) works identically across both meshes. */
  _buildObjectFromMesh(facelist, edgelist, shapeRanges) {
    let group = new THREE.Group();
    group.name = "shape";
    group.rotation.x = -Math.PI / 2;

    // Global face indices owned by bare sketch shapes (2D profiles)
    let ghostGfi = null;
    if (shapeRanges && shapeRanges.some(r => r.sketch)) {
      ghostGfi = new Set();
      let cum = 0;
      for (const r of shapeRanges) {
        if (r.sketch) { for (let i = 0; i < r.faceCount; i++) { ghostGfi.add(cum + i); } }
        cum += r.faceCount;
      }
    }

    // Add Triangulated Faces to Object — one mesh per bucket (solid/ghost)
    const buildFaceMesh = (entries, material) => {
      let vertices = [], normals = [], triangles = [], uvs = [], colors = [];
      let vInd = 0;
      for (const { face, gfi } of entries) {
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
          colors.push(face.face_index, gfi, 0);
        }

        vInd += face.vertex_coord.length / 3;
      }

      let geometry = new THREE.BufferGeometry();
      geometry.setIndex(triangles);
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setAttribute('uv2', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      let mesh = new THREE.Mesh(geometry, material);
      mesh.name = "Model Faces";  // both buckets pick/raycast identically
      return mesh;
    };

    const solidEntries = [], ghostEntries = [];
    facelist.forEach((face, gfi) => {
      ((ghostGfi && ghostGfi.has(gfi)) ? ghostEntries : solidEntries).push({ face, gfi });
    });

    group.add(buildFaceMesh(solidEntries, this.matcapMaterial));
    if (ghostEntries.length) {
      const ghosts = buildFaceMesh(ghostEntries, this.sketchGhostMaterial);
      ghosts.renderOrder = 1;         // draw after opaque solids
      ghosts.userData.isGhost = true; // hover tint skips ghosts (see _animate)
      group.add(ghosts);
    }

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

    // Edge colors come from the viewport theme: base wire color normally,
    // edge-select color for the highlighted edge (env._vtheme is read at
    // paint time so a theme change repaints existing edges via clearHighlights)
    const env = this;
    let lineGeometry = new THREE.BufferGeometry().setFromPoints(lineVertices);
    let lineColors = [];
    {
      const wire = new THREE.Color(env._vtheme.wire);
      for (let i = 0; i < lineVertices.length; i++) { lineColors.push(wire.r, wire.g, wire.b); }
    }
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
      const wire = new THREE.Color(env._vtheme.wire);
      const sel  = new THREE.Color(env._vtheme.edgeSelect);
      for (let v = 0; v * 3 < this.lineColors.length; v++) {
        const c = (v >= startIndex && v <= endIndex) ? sel : wire;
        this.lineColors[v * 3 + 0] = c.r;
        this.lineColors[v * 3 + 1] = c.g;
        this.lineColors[v * 3 + 2] = c.b;
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
      color: new THREE.Color(this._vtheme.glow), transparent: true, opacity: 0.35,
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

  /** Pick a flat model face under the mouse for sketch-on-face. Returns the
   *  baked plane in OCC space { origin, normal } (mesh vertices are stored in
   *  OCC coords), the ray distance, and the face's triangles in world space
   *  for a hover highlight — or null if nothing/curved is under the cursor. */
  pickFaceAt(event) {
    if (!this.mainObject) { return null; }
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

    const geom = hit.object.geometry;
    const col = geom.getAttribute('color');
    const pos = geom.getAttribute('position');
    const nrm = geom.getAttribute('normal');
    if (!col || !pos || !nrm) { return null; }
    const gfi = col.getY(hit.face.a); // global face index packed into color.y

    // Centroid + averaged normal over this face's vertices (OCC space)
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0, count = 0;
    for (let i = 0; i < pos.count; i++) {
      if (col.getY(i) !== gfi) { continue; }
      cx += pos.getX(i); cy += pos.getY(i); cz += pos.getZ(i);
      nx += nrm.getX(i); ny += nrm.getY(i); nz += nrm.getZ(i);
      count++;
    }
    if (!count) { return null; }
    let origin = [cx / count, cy / count, cz / count];
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-9) { return null; }
    let normal = [nx / nLen, ny / nLen, nz / nLen];

    // Planarity check: reject curved faces (a cylinder side is one "face")
    let maxDev = 0, extent = 0;
    for (let i = 0; i < pos.count; i++) {
      if (col.getY(i) !== gfi) { continue; }
      const dx = pos.getX(i) - origin[0], dy = pos.getY(i) - origin[1], dz = pos.getZ(i) - origin[2];
      maxDev = Math.max(maxDev, Math.abs(dx * normal[0] + dy * normal[1] + dz * normal[2]));
      extent = Math.max(extent, Math.hypot(dx, dy, dz));
    }
    if (maxDev > Math.max(0.05, extent * 0.02)) { return null; } // not flat

    // Snap the origin to clean numbers, then re-project onto the plane so it
    // stays exactly coplanar (the emitted literal reads cleanly).
    const r = (v) => Math.round(v * 100) / 100;
    const ro = [r(origin[0]), r(origin[1]), r(origin[2])];
    const off = (ro[0] - origin[0]) * normal[0] + (ro[1] - origin[1]) * normal[1] + (ro[2] - origin[2]) * normal[2];
    origin = [ro[0] - off * normal[0], ro[1] - off * normal[1], ro[2] - off * normal[2]];

    // Face triangles in world space, for the hover highlight overlay
    this.mainObject.updateMatrixWorld(true);
    const mw = hit.object.matrixWorld;
    const worldTris = [];
    const idx = geom.index;
    if (idx) {
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t);
        if (col.getY(a) !== gfi) { continue; }
        for (const vi of [a, idx.getX(t + 1), idx.getX(t + 2)]) {
          worldTris.push(new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mw));
        }
      }
    }

    return { origin, normal, distance: hit.distance, worldTris };
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
      gridVisible: this._viewportSettings.grid,
      gridMinor: this._viewportSettings.gridScale,
    };
  }

  /** Update a viewport setting, persist it, and apply it to the scene live. */
  setViewportSetting(key, value) {
    this._viewportSettings[key] = value;
    try {
      localStorage.setItem('chisel-viewport', JSON.stringify(this._viewportSettings));
    } catch (e) { /* private mode etc. — setting still applies this session */ }
    if (key === 'matcap') {
      // The face material is shared by every mesh, so swapping its matcap
      // restyles the whole scene (model, history previews) in place
      this.matcap = this._loadMatcapTexture(value);
      this.matcapMaterial.matcap = this.matcap;
      this.matcapMaterial.needsUpdate = true;
    }
    this._updateGroundAndGrid(this.getSceneOptions());
    this._lastSceneOptions = this.getSceneOptions();
    this.environment.viewDirty = true;
  }

  /** Load a matcap texture by filename; a failed load (e.g. a stale
   *  persisted setting after a texture is renamed) reverts to the default. */
  _loadMatcapTexture(file) {
    return this.loader.load('./textures/' + file,
      () => { this.environment.viewDirty = true; },
      undefined,
      () => {
        if (file !== DEFAULT_MATCAP) { this.setViewportSetting('matcap', DEFAULT_MATCAP); }
      });
  }

  /** (Re)create or remove the infinite grid to match sceneOptions. */
  _updateGroundAndGrid(sceneOptions) {
    this.environment.scene.remove(this.grid);
    if (this.grid) { this.grid.material.dispose(); this.grid.geometry.dispose(); }
    if (sceneOptions.gridVisible) {
      this.grid = CascadeEnvironment._makeInfiniteGrid(
        this._vtheme.grid, this._vtheme.gridAlpha, sceneOptions.gridMinor || 10);
      this.environment.scene.add(this.grid);
    }
  }

  /** Blender-style infinite grid: a huge shader plane drawing `minor`-spaced
   *  minor lines and 10×-spaced major lines, anti-aliased via screen-space
   *  derivatives and faded radially with distance from the camera (which is
   *  what lets it read as infinite without fog or a floor plane). */
  static _makeInfiniteGrid(colorHex, opacity, minor = 10.0) {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uColor:     { value: new THREE.Color(colorHex) },
        uOpacity:   { value: opacity },
        uSizeMinor: { value: minor },
        uSizeMajor: { value: minor * 10.0 },
        uDistance:  { value: 4000.0 },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        varying vec3 vWorldPos;
        uniform vec3 uColor;
        uniform float uOpacity, uSizeMinor, uSizeMajor, uDistance;
        float gridLine(float size) {
          vec2 r = vWorldPos.xz / size;
          vec2 g = abs(fract(r - 0.5) - 0.5) / fwidth(r);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          float fade = pow(1.0 - min(distance(cameraPosition.xz, vWorldPos.xz) / uDistance, 1.0), 2.0);
          float alpha = max(gridLine(uSizeMajor), gridLine(uSizeMinor) * 0.4) * fade * uOpacity;
          if (alpha <= 0.002) { discard; }
          gl_FragColor = vec4(uColor, alpha);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(100000, 100000), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.01;
    mesh.name = 'Infinite Grid';
    mesh.renderOrder = -1;  // first among transparents, under highlight overlays
    return mesh;
  }

  /** Apply a viewport color theme (from ThemeManager) live: background
   *  (solid or Blender-style vertical gradient), infinite grid, and a
   *  repaint of any existing edge lines. Pass null for the built-in theme. */
  applyViewportTheme(view) {
    this._vtheme = Object.assign({}, VIEWPORT_DEFAULTS, view || {});
    const env = this.environment;
    const bottom = new THREE.Color(this._vtheme.bgBottom);

    if (this._vtheme.bgTop !== this._vtheme.bgBottom) {
      // Blender-style screen-space vertical gradient
      const canvas = document.createElement('canvas');
      canvas.width = 1; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, this._vtheme.bgTop);
      grad.addColorStop(1, this._vtheme.bgBottom);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1, 256);
      env.scene.background = new THREE.CanvasTexture(canvas);
    } else {
      env.scene.background = bottom.clone();
    }

    env.backgroundColor = bottom.getHex();
    this._updateGroundAndGrid(this.getSceneOptions());

    // Repaint existing model edges with the new wire color
    env.scene.traverse((obj) => { if (obj.clearHighlights) { obj.clearHighlights(); } });
    // Sketch ghosts follow the theme's glow color
    if (this.sketchGhostMaterial) { this.sketchGhostMaterial.color.set(this._vtheme.glow); }
    env.viewDirty = true;
  }

  /** Blender-style viewport settings button + popover in the bottom-right
   *  corner. New display settings (matcap, SSAO, ...) slot into the defs list. */
  _createViewportSettingsOverlay() {
    const settingsDefs = [
      { key: 'grid', label: 'Grid', type: 'checkbox' },
      { key: 'juice', label: 'Screenshake', type: 'checkbox' },
      { key: 'gridScale', label: 'Grid scale', type: 'select', numeric: true, options: [
        { value: 1, label: '1 mm' },
        { value: 10, label: '10 mm' },
        { value: 100, label: '100 mm' },
      ] },
      { key: 'matcap', label: 'Material', type: 'select', options: [
        { value: DEFAULT_MATCAP, label: 'Ceramic bright' },
        { value: 'ceramic_dark.png', label: 'Ceramic dark' },
        { value: 'dullFrontLitMetal.png', label: 'Dull metal' },
        { value: 'fullmetal.png', label: 'Full metal' },
        { value: 'metal_bronze.png', label: 'Bronze' },
        { value: 'clay_green.png', label: 'Clay green' },
        { value: 'hard_surface_red.png', label: 'Hard surface red' },
        { value: 'basic_side.png', label: 'Basic side' },
        { value: 'check_normal+y.png', label: 'Normal check' },
      ] },
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

      const text = document.createElement('span');
      text.textContent = def.label;

      if (def.type === 'select') {
        const select = document.createElement('select');
        select.className = 'cs-vpset-select';
        for (const opt of def.options) {
          const o = document.createElement('option');
          o.value = String(opt.value);
          o.textContent = opt.label;
          select.appendChild(o);
        }
        select.value = String(this._viewportSettings[def.key]);
        select.addEventListener('change', () => {
          this.setViewportSetting(def.key, def.numeric ? Number(select.value) : select.value);
        });
        row.appendChild(text);
        row.appendChild(select);
      } else {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!this._viewportSettings[def.key];
        checkbox.addEventListener('change', () => {
          this.setViewportSetting(def.key, checkbox.checked);
        });
        row.appendChild(checkbox);
        row.appendChild(text);
      }

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

    if (this._spinner) {
      const t = performance.now() / 1000;
      if (this._spinnerMain) {
        // Gyroscope: slow precession about vertical Y, fast rotor on the
        // sub's horizontal axle
        this._spinnerMain.rotation.y = t * 0.7;
        this._spinnerSub.rotation.z = t * 2.8;
      } else {
        const [a, b, c] = this._spinner.children[0].children;
        a.rotation.set(t * 1.3, t * 0.7, 0);
        b.rotation.set(-t * 0.9, 0, t * 1.1);
        c.rotation.set(0, t * 1.2, -t * 0.8);
      }
      this.environment.viewDirty = true;
    }

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
          // Whitening the whole material is imperceptible on the near-white
          // matcap but glaring on translucent sketch ghosts — skip those
          // (restore paths then re-set the unchanged color, harmlessly)
          if (!this.highlightedObj.userData.isGhost) {
            this.highlightedObj.material.color.setHex(0xffffff);
          }
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

    if (this._shakeMag > 0.001) { this.environment.viewDirty = true; }

    if (this.environment.viewDirty) {
      // Screenshake: jitter the camera in its screen plane for this render
      // only (offset → render → restore), so the real camera/controls state
      // is never touched. Amplitude scales with orbit distance so the kick
      // feels the same at any zoom; exponential decay ≈ a third of a second.
      const cam = this.environment.camera;
      let shakeOffset = null;
      if (this._shakeMag > 0.001) {
        const dist = cam.position.distanceTo(this.environment.controls.target);
        const amp = dist * 0.012 * this._shakeMag;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1);
        shakeOffset = right.multiplyScalar((Math.random() * 2 - 1) * amp)
          .add(up.multiplyScalar((Math.random() * 2 - 1) * amp));
        cam.position.add(shakeOffset);
        this._shakeMag *= 0.82;
        if (this._shakeMag < 0.001) { this._shakeMag = 0; }
      }
      this.environment.renderer.render(this.environment.scene, cam);
      if (shakeOffset) { cam.position.sub(shakeOffset); }
      this.environment.viewDirty = false;
    }
  }

  /** Kick off a decaying screenshake (game juice). intensity 1 ≈ a solid
   *  thunk; values stack by taking the max, not adding. Respects the OS
   *  reduced-motion preference. */
  shake(intensity = 1) {
    if (!this._viewportSettings.juice) { return; }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }
    this._shakeMag = Math.max(this._shakeMag || 0, intensity);
    this.environment.viewDirty = true;
  }

  /** Arm a shake that fires when the next model render lands. Use for
   *  commits: evaluation is async, so an immediate shake() would kick
   *  before the model visibly changes and the impact reads as unrelated. */
  shakeOnNextRender(intensity = 1) {
    this._pendingShake = Math.max(this._pendingShake, intensity);
  }

  /** Cancel an armed shake (e.g. the evaluation errored — no new model is
   *  coming, and the charge shouldn't fire on some later unrelated render). */
  disarmShake() {
    this._pendingShake = 0;
  }
}

export { Environment, CascadeEnvironment };
