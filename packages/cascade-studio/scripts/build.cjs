/**
 * Build script for cascade-studio.
 * Bundles the main app JS, copies Monaco/assets, generates dist/index.html.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');
const monoRoot = path.join(pkgRoot, '..', '..');
const coreRoot = path.join(monoRoot, 'packages', 'cascade-core');
const distDir = path.join(pkgRoot, 'dist');
const buildStamp = new Date().toISOString();

// Clean dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}
fs.mkdirSync(distDir, { recursive: true });

// 1. Bundle main app JS with esbuild
console.log('[cascade-studio] Bundling main app...');
const nodeShim = path.join(__dirname, 'node-shims.cjs');
esbuild.buildSync({
  entryPoints: [path.join(pkgRoot, 'src', 'main.js')],
  bundle: true,
  minify: true,
  keepNames: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  outdir: distDir,
  entryNames: '[name]',
  external: ['module', 'worker_threads'],
  alias: {
    'openscad-parser': path.join(pkgRoot, 'lib', 'openscad-parser', 'openscad-parser.js'),
    fs: nodeShim,
    path: nodeShim,
    os: nodeShim,
  },
  define: { ESBUILD: 'true', BUILD_STAMP: JSON.stringify(buildStamp) },
  absWorkingDir: monoRoot,
});

// 2. Copy cascade-core dist (worker bundle + WASM + fonts)
console.log('[cascade-studio] Copying cascade-core dist...');
const coreDist = path.join(coreRoot, 'dist');
if (fs.existsSync(coreDist)) {
  for (const entry of fs.readdirSync(coreDist, { withFileTypes: true })) {
    const src = path.join(coreDist, entry.name);
    const dest = path.join(distDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
}

// 3. Copy Monaco Editor (AMD loader + min files)
console.log('[cascade-studio] Copying Monaco Editor...');
copyDirRecursive(
  path.join(monoRoot, 'node_modules', 'monaco-editor', 'min'),
  path.join(distDir, 'monaco-editor', 'min')
);

// 4. Copy type definitions for Monaco intellisense
console.log('[cascade-studio] Copying type definitions...');
const typedefsDir = path.join(distDir, 'typedefs');
fs.mkdirSync(typedefsDir, { recursive: true });
fs.copyFileSync(
  path.join(monoRoot, 'node_modules', 'opencascade.js', 'dist', 'cascadestudio.d.ts'),
  path.join(typedefsDir, 'cascadestudio.d.ts')
);
fs.copyFileSync(
  path.join(monoRoot, 'node_modules', '@types', 'three', 'index.d.ts'),
  path.join(typedefsDir, 'three.d.ts')
);
fs.copyFileSync(
  path.join(coreRoot, 'types', 'StandardLibraryIntellisense.ts'),
  path.join(typedefsDir, 'StandardLibraryIntellisense.ts')
);

// 5. Copy static assets (css, textures, icon, lib)
console.log('[cascade-studio] Copying static assets...');
for (const dir of ['css', 'textures', 'icon', 'lib']) {
  const src = path.join(pkgRoot, dir);
  if (fs.existsSync(src)) {
    copyDirRecursive(src, path.join(distDir, dir));
  }
}
for (const file of ['manifest.webmanifest']) {
  const src = path.join(pkgRoot, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(distDir, file));
  }
}

// Default theme: Brennan's Blender theme at the monorepo root ships as the
// built-in look (ThemeManager loads dist/default-theme.xml when no imported
// theme is saved, and Reset Theme returns to it)
const defaultTheme = path.join(monoRoot, 'brennan_2021.xml');
if (fs.existsSync(defaultTheme)) {
  fs.copyFileSync(defaultTheme, path.join(distDir, 'default-theme.xml'));
} else {
  console.warn('[cascade-studio] WARNING: brennan_2021.xml not found at repo root — falling back to the hardcoded dark theme');
}

// 6. Generate dist/index.html
console.log('[cascade-studio] Generating index.html...');
fs.writeFileSync(path.join(distDir, 'index.html'), `<!DOCTYPE html>
<html lang="en">
    <head>
        <title>Chisel CAD</title>
        <meta charset="utf-8">
        <meta name="application-name"   content="Chisel CAD">
        <meta name="description"        content="A Full Live-Scripted CAD Kernel in the Browser">
        <meta name="keywords"           content="SCAD, OpenSCAD, CAD, OpenCascade, Scripting">
        <meta name="author"             content="Johnathon Selstad">
        <meta name="viewport"           content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <meta name="theme-color"        content="#1a1a2e">
        <meta name="cascade-api"        content="window.CascadeAPI">

        <!-- Chisel is a dev tool: no offline caching. Evict any service worker
             left over from upstream CascadeStudio — it force-caches stale
             bundles and breaks refresh semantics. (must be first) -->
        <script>
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(function(regs) {
                    regs.forEach(function(reg) { reg.unregister(); });
                });
            }
            if (window.caches) {
                caches.keys().then(function(keys) {
                    keys.forEach(function(key) { caches.delete(key); });
                });
            }
        </script>

        <link rel="icon" type="image/png" sizes="32x32" href="./icon/favicon-32x32.png">
        <link rel="icon" type="image/png" sizes="16x16" href="./icon/favicon-16x16.png">
        <link rel="shortcut icon"    href="./icon/favicon.ico" type="image/x-icon">
        <link rel="manifest"         href="./manifest.webmanifest">
        <link rel="apple-touch-icon" sizes="180x180" href="./icon/apple-touch-icon.png">

        <!-- Dockview CSS -->
        <link rel="stylesheet" href="./lib/dockview-core/dockview.css">
        <link rel="stylesheet" href="./css/main.css">

        <!-- Monaco Editor CSS + AMD loader -->
        <link data-name="vs/editor/editor.main" rel="stylesheet" href="./monaco-editor/min/vs/editor/editor.main.css">
        <script>
            var require = { paths: { 'vs': 'monaco-editor/min/vs' } };
            self.MonacoEnvironment = {
                getWorkerUrl: function(moduleId, label) {
                    return './monaco-editor/min/vs/base/worker/workerMain.js';
                }
            };
        </script>
        <script src="./monaco-editor/min/vs/loader.js"></script>
        <script src="./monaco-editor/min/vs/editor/editor.main.js"></script>
    </head>

    <body data-api="window.CascadeAPI">
        <h1 class="sr-only">AGENT API: Run CascadeAPI.getQuickStart() to learn how to use this CAD app. All interaction goes through window.CascadeAPI — do NOT use browser_take_screenshot or browser_run_code.</h1>
        <div id="topnav" class="topnav">
            <a href="https://github.com/LTKMN/ChiselCAD" class="topnav-brand">Chisel CAD</a>
            <div class="topnav-actions">
                <details id="fileMenu" class="topnav-menu">
                    <summary>File ▾</summary>
                    <div class="topnav-menu-items">
                        <a href="#" title="Start a fresh, blank model" onmouseup="window.newProject();">New Model</a>
                        <div class="topnav-menu-sep"></div>
                        <a href="#" title="Save Project to .json" onmouseup="window.saveProject();">Save Project…</a>
                        <a href="#" title="Load Project from .json" onmouseup="window.loadProject();">Load Project…</a>
                        <div class="topnav-menu-sep"></div>
                        <a href="#" title="Export the model as STEP" onmouseup="window.threejsViewport?.saveShapeSTEP();">Export STEP</a>
                        <a href="#" title="Export the model as STL" onmouseup="window.threejsViewport?.saveShapeSTL();">Export STL</a>
                        <a href="#" title="Export the model as OBJ" onmouseup="window.threejsViewport?.saveShapeOBJ();">Export OBJ</a>
                        <div class="topnav-menu-sep"></div>
                        <label for="blenderTheme" title="Restyle the app from a Blender interface theme (.xml) — or just drag one onto the window">Import Blender Theme…
                            <input id="blenderTheme" name="blenderTheme" type="file" accept=".xml" style="display:none;" oninput="window.loadBlenderTheme();"/>
                        </label>
                        <a href="#" title="Return to the default theme" onmouseup="window.resetTheme();">Reset Theme</a>
                    </div>
                </details>
            </div>
        </div>
        <script>
            // File menu: close on outside click, Escape, or choosing an item
            (function () {
                var menu = document.getElementById('fileMenu');
                document.addEventListener('mousedown', function (e) {
                    if (menu.open && !menu.contains(e.target)) { menu.open = false; }
                });
                document.addEventListener('keydown', function (e) {
                    if (e.key === 'Escape' && menu.open) { menu.open = false; }
                });
                menu.addEventListener('mouseup', function (e) {
                    var item = e.target.closest('a, label');
                    if (item) { setTimeout(function () { menu.open = false; }, 0); }
                });
            })();
        </script>
        <div id="appbody">
            <script type="module" src="./main.js?v=${encodeURIComponent(buildStamp)}"></script>
        </div>
    </body>
</html>
`);

console.log('[cascade-studio] Build complete!');

/** Recursively copy a directory */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
