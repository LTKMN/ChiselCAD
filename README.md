# ChiselCAD

**A code-first parametric CAD tool for the browser — sketch it with the mouse, keep it as code.**

ChiselCAD is a personal, opinionated fork of [zalo's CascadeStudio](https://github.com/zalo/CascadeStudio). It runs the full [OpenCascade](https://github.com/Open-Cascade-SAS/OCCT) (OCCT 8.0) kernel compiled to WebAssembly, with a Three.js viewport and a Monaco editor, and it is built around one workflow: **draw a sketch, pull it into a feature, tune the numbers in code, export for 3D printing.**

The guiding idea is **GUI for creation, code for editing.** Authoring geometry from scratch in text is slow, so you click out lines, rectangles, circles and constraints directly in the 3D view. But the moment a sketch is committed it becomes plain JavaScript in the editor — and from then on the *code is the model*. Changing a radius means editing the literal (the model re-evaluates live as you type); there is no hidden sketch state, no open/edit/save modal loop, no property dialogs to hunt through.

<p align="center">
  <img src="./packages/cascade-studio/icon/Variety.png" height="170">
  <img src="./packages/cascade-studio/icon/Fillet.png" height="170">
  <img src="./packages/cascade-studio/icon/RotatedExtrusion.png" height="170">
  <img src="./packages/cascade-studio/icon/Loft.png" height="170">
</p>

> Forked from CascadeStudio. The upstream engine, standard library and JavaScript/OpenSCAD editor remain under their original MIT license; the additions this fork makes are **source-available for non-commercial use** (see [License](#license)). The rename and in-app branding are an ongoing cleanup, so parts of the source still read `CascadeStudio` internally.

## What this fork adds

- **In-viewport sketching** — hit Sketch and pick your plane right in the 3D view: ghost quads for the three origin planes, or any *flat face of the model* (sketch-on-face). The camera flattens square-on into an orthographic view with a grid aligned to the picked plane. Draw with Line, Rect, Circle, Trim and Dimension tools; snapping keeps mouse-derived values on clean round numbers while anything you *type* is treated as exact and left untouched. Saving emits a tidy `new Sketch(...).LineTo(...).End(true).Face()` block into the editor as a single undoable edit — face sketches bake their plane as `{ origin, normal, xDir }` literals, so the code stands alone.
- **Blender-style navigation** — middle-mouse orbits, Shift+middle (or right-drag) pans, wheel zooms. The left button is reserved for selecting and sketching.
- **A lightweight constraint solver** — a small relaxation solver (sequential projection, no heavyweight algebraic engine) keeps a deliberately short list of relations satisfied: **anchor, horizontal, vertical, parallel, perpendicular, equal, concentric, tangent**, plus persistent **dimensions**. Endpoints that snap together are genuinely *shared* points, so corners stay closed through any edit. Drag a point or edge and everything constrained to it follows in real time. Over-constrain it and the offending relations simply tint red — no modal "mating error" dialogs.
- **Feasibility feedback that floats** — when a dimension or relation can't be satisfied, ChiselCAD finds the nearest legal value and floats a message up from the cursor (RollerCoaster-Tycoon style), e.g. *"this line can't be longer than 28.28 here — held by anchors + dimensions."* The rejected edit reverts cleanly instead of leaving red behind.
- **A feature command bar** — one click to Extrude / Revolve / Loft / Pipe the latest sketch, or to Fillet / Chamfer / Union / Cut / Intersect by *clicking the bodies in the viewport*. Each emits code with the key number (depth, angle, radius) pre-selected so you can immediately type over it. Picking a sketch face auto-wraps it in a plane-aware `Extrude`, so "cut this sketch out of that solid" is two clicks.
- **Live evaluation** — the model re-evaluates continuously as you type (debounced) and while you drag GUI sliders; evaluations serialize and coalesce so heavy models stay responsive.
- **Bidirectional code ↔ 3D ↔ GUI linking** — the cursor's line highlights its GUI control and glows the geometry that line produced; clicking a shape in the viewport selects the whole block of code that built it and jumps the cursor to its defining line.
- **A Blender-style viewport popover** — ground plane and grid toggles moved out of the control panel into a bottom-right ◐ popover that applies live and persists across sessions.

## Everything inherited from CascadeStudio

- **Powerful standard library** for primitives, booleans, sweeps, lofts, fillets, and more
- **Sketch API** with a plane parameter (`new Sketch([x,y], 'XZ')`) for drawing in XY, XZ, or YZ
- **Selector API** for querying edges and faces: `Edges(shape).parallel([0,0,1]).max([0,0,1]).indices()`
- **Measurement functions**: `Volume()`, `SurfaceArea()`, `CenterOfMass()`
- **JavaScript and OpenSCAD** editor modes with **IntelliSense** autocomplete (full TypeScript defs + JSDoc)
- **Modeling history timeline** to scrub through build steps in the 3D viewport
- **Agent API** (`window.CascadeAPI`) for programmatic control via Playwright or developer tooling
- **Reusable CAD engine** — the `cascade-core` package embeds CAD modeling in any web app, no GUI required
- Access to the full OpenCASCADE kernel via the `oc.` namespace, with automatic caching of standard-library operations
- `.STEP` / `.IGES` / `.STL` import and `.STEP` / `.STL` / `.OBJ` export
- URL serialization of code and GUI state for easy sharing, plus Save/Load of full projects
- Integrated GUI system (sliders, checkboxes, buttons) via Tweakpane

## Getting Started

```bash
npm install
npm run build
npx http-server ./packages/cascade-studio/dist -p 8080 -c-1
# Open http://localhost:8080
```

Use `-c-1` to disable caching, and a **new port** whenever you change JS, since browsers cache ES modules aggressively. Every build logs `Chisel build: <timestamp>` to the console — if a change doesn't seem to take, check that stamp first.

### The sketch → feature → code loop

1. Click **✎ Sketch** in the command bar and pick a plane. The view flattens and the sketch tools appear.
2. Draw with **Line / Rect / Circle** (keys `L` / `R` / `C`). Endpoints snap to existing points, the origin, and the grid.
3. Switch to **Select**, then add relations from the Relations row or with the hotkeys — `A`nchor, `H`orizontal, `V`ertical, `P`arallel, perpendicular (`X`), `E`qual, concentric (`Q`), tan`G`ent. Drag points to see the solver hold everything together.
4. Use **Dimension** (`D`) to pin a length or radius. Type a number for an exact value, or a *word* to create a `let` variable the sketch drives.
5. **Save** — the sketch is written into the editor as code.
6. Back in feature mode, click **Extrude** (or Revolve / Loft / Pipe), or **Cut** / **Union** / **Fillet** and click the bodies involved. Tweak the pre-selected number and the model updates live.

### Standard Library

```javascript
// Primitives
Box(x, y, z, centered?)
Sphere(radius)
Cylinder(radius, height, centered?)
Cone(r1, r2, height)
Circle(radius, wire?)          // wire=true for Loft/Pipe, false for Extrude
Polygon(points, wire?)
Text3D(text, size, height, font?)

// Sketch API — draw in any plane
let face = new Sketch([0, 0])           // default XY plane
  .LineTo([20, 0]).Fillet(3)
  .LineTo([20, 10]).Fillet(3)
  .LineTo([0, 10])
  .End(true).Face();

let profile = new Sketch([0, 0], "XZ")  // XZ plane for Revolve profiles
  .LineTo([15, 0]).LineTo([10, 8]).LineTo([0, 8])
  .End(true).Face();
Revolve(profile, 360);

// Transforms — all return NEW shapes
Translate([x, y, z], shape)
Rotate([ax, ay, az], degrees, shape)
Scale(factor, shape)
Mirror([vx, vy, vz], shape)

// Booleans
Union(shapes)
Difference(mainBody, [tools])
Intersection(shapes)

// Operations
Extrude(face, [dx, dy, dz], keepFace?)
Revolve(shape, degrees, [ax, ay, az]?)
Loft([wires])
Pipe(shape, wirePath)
Offset(shape, distance)
FilletEdges(shape, radius, edgeIndices)
ChamferEdges(shape, distance, edgeIndices)

// Selectors
Edges(shape).ofType("Line"|"Circle").parallel([axis]).max([axis]).min([axis]).indices()
Faces(shape).ofType("Plane"|"Cylinder").max([axis]).indices()

// Measurement
Volume(shape)
SurfaceArea(shape)
CenterOfMass(shape)
```

### OpenSCAD Mode

Switch to OpenSCAD via the dropdown in the top navigation bar; ChiselCAD transpiles it to the JavaScript standard library.

```openscad
difference() {
    cube([20, 20, 20], center=true);
    sphere(r=12);
}
```

### Using cascade-core in Your Own Project

The CAD engine is a standalone package with no GUI dependencies:

```javascript
import { CascadeEngine } from 'cascade-core';

const engine = new CascadeEngine({ workerUrl: './cascade-worker.js' });
await engine.init();

const result = await engine.evaluate(`
  let box = Box(20, 20, 20);
  FilletEdges(box, 3, Edges(box).max([0,0,1]).indices());
`);

// result.meshData = { faces: [...], edges: [...] }
// Render with Three.js, Babylon.js, or any WebGL framework
```

## Agent API

ChiselCAD exposes `window.CascadeAPI` for programmatic control via [Playwright](https://playwright.dev/) or other browser automation.

```javascript
// Navigate and wait for WASM to load
await page.goto('http://localhost:8080');
await page.waitForFunction(() => window.CascadeAPI?.isReady());

// Learn the API
const guide = await page.evaluate(() => CascadeAPI.getQuickStart());

// Run CAD code and check results
const result = await page.evaluate(code => CascadeAPI.runCode(code), `
  let profile = new Sketch([0, 0], "XZ")
    .LineTo([15, 0]).LineTo([10, 8]).LineTo([0, 8])
    .End(true).Face();
  Revolve(profile, 360);
`);
// result = { success: true, errors: [], logs: [...], historySteps: [...] }

// Set camera angle and take a screenshot
await page.evaluate(() => {
  CascadeAPI.setCameraAngle(30, 20);    // azimuth, elevation
  CascadeAPI.saveScreenshot('model.png');
});
```

## Architecture

An npm workspaces monorepo with two packages. (The on-disk package names are still `cascade-core` and `cascade-studio` from upstream; renaming them is part of the ongoing cleanup.)

- **`cascade-core`** — Reusable CAD engine (no GUI dependencies): the Web Worker, OpenCascade WASM, and mesher.
- **`cascade-studio`** — The browser IDE: Three.js viewport, Monaco editor, Tweakpane GUI, and the sketch/feature tooling.

```
packages/
  cascade-core/
    src/
      engine/
        CascadeEngine.js       ← Main-thread API wrapping Worker + MessageBus
        MessageBus.js          ← Typed worker message routing
      worker/
        CascadeWorker.js       ← Web Worker entry; evaluates user code
        StandardLibrary.js     ← CAD primitives (Box, Sphere, Sketch, etc.)
        ShapeToMesh.js         ← OpenCascade shape → mesh triangulation
        FileUtils.js           ← STEP/IGES/STL import/export
      openscad/
        OpenSCADTranspiler.js  ← OpenSCAD → JS transpiler
      index.js                 ← Package entry point

  cascade-studio/
    src/
      main.js                  ← ESM entry point
      CascadeMain.js           ← App shell, Dockview layout
      CascadeAPI.js            ← window.CascadeAPI for agent/programmatic use
      CascadeView.js           ← 3D viewport (Three.js), modeling timeline
      SketchMode.js            ← In-viewport sketching, constraints, feature bar
      EditorManager.js         ← Monaco editor, live code evaluation
      ConsoleManager.js        ← Console panel, log/error capture
      GUIManager.js            ← Tweakpane GUI panel (sliders, checkboxes)
    css/, textures/, icon/, lib/  ← Static assets

test/                            ← Playwright tests (monorepo root)
```

The build system uses **esbuild**. `npm run build` builds `cascade-core` first (worker bundle + WASM + fonts), then `cascade-studio` (main app bundle + static assets), outputting to `packages/cascade-studio/dist/`.

## Testing

A Playwright suite covers primitives, transforms, booleans, operations, selectors, OpenSCAD, exports, and regression scenarios.

```bash
npm run build
npx playwright test    # 12 tests, ~25s
```

WebGL rendering in headless mode requires `--use-gl=angle --use-angle=swiftshader` (configured in `playwright.config.js`). If Chromium is missing, run `npx playwright install chromium` first.

## Credits

ChiselCAD is a fork of **[CascadeStudio](https://github.com/zalo/CascadeStudio)** by [Johnathon Selstad (@zalo)](https://github.com/zalo) — all of the kernel, standard library, editor and engine groundwork is his, and remains under his MIT license. This fork adds the in-viewport sketch/constraint/feature workflow and various quality-of-life changes for a personal 3D-printing setup.

Built on:

- [opencascade.js](https://github.com/donalffons/opencascade.js) — CAD kernel (OCCT 8.0.0 RC4 via Embind)
- [Three.js](https://github.com/mrdoob/three.js/) r170 — 3D rendering
- [Monaco Editor](https://github.com/microsoft/monaco-editor) — code editor with IntelliSense
- [Dockview](https://github.com/mathuo/dockview) — panel layout system
- [Tweakpane](https://github.com/cocopon/tweakpane) v4 — GUI controls
- [opentype.js](https://github.com/opentypejs/opentype.js) — font parsing for Text3D
- [fflate](https://github.com/101arrowz/fflate) — URL code compression
- [potpack](https://github.com/mapbox/potpack) — texture atlas packing
- [esbuild](https://github.com/evanw/esbuild) — bundler
- [Playwright](https://playwright.dev/) — testing

## License

ChiselCAD carries two sets of terms, both in the [LICENSE](./LICENSE) file:

- **Upstream CascadeStudio code** — MIT License, © 2020 Johnathon Selstad. Unchanged and irrevocable.
- **ChiselCAD's own additions** — source-available for **non-commercial use** (personal, hobbyist, educational, research), © 2026 Brennan. They may not be sold or built into a commercial product or service without written permission.

Because the upstream base is MIT, anyone remains free to use *CascadeStudio itself* however they like; the non-commercial terms apply only to the code this fork adds. This is not legal advice — if the distinction ever matters to you commercially, have a lawyer look it over.
