/**
 * Build script for cascade-core.
 * Bundles the worker with esbuild, copies WASM + fonts.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');
const monoRoot = path.join(pkgRoot, '..', '..');
const distDir = path.join(pkgRoot, 'dist');

// Clean dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}
fs.mkdirSync(distDir, { recursive: true });

// 1. Bundle the worker entry point
console.log('[cascade-core] Bundling worker...');
esbuild.buildSync({
  entryPoints: [path.join(pkgRoot, 'src', 'worker', 'CascadeWorker.js')],
  bundle: true,
  minify: true,
  keepNames: true,
  sourcemap: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(distDir, 'cascade-worker.js'),
  external: ['fs', 'path', 'os', 'module', 'worker_threads'],
  loader: { '.wasm': 'file' },
  define: { ESBUILD: 'true' },
  absWorkingDir: monoRoot,
});

// 2. Copy OpenCascade WASM to dist/
console.log('[cascade-core] Copying WASM...');
const wasmSrc = path.join(monoRoot, 'node_modules', 'opencascade.js', 'dist', 'cascadestudio.wasm');
if (fs.existsSync(wasmSrc)) {
  fs.copyFileSync(wasmSrc, path.join(distDir, 'cascadestudio.wasm'));
}

// 3. Copy fonts to dist/fonts/
console.log('[cascade-core] Copying fonts...');
const fontsDir = path.join(pkgRoot, 'fonts');
const distFontsDir = path.join(distDir, 'fonts');
if (fs.existsSync(fontsDir)) {
  fs.mkdirSync(distFontsDir, { recursive: true });
  for (const file of fs.readdirSync(fontsDir)) {
    fs.copyFileSync(path.join(fontsDir, file), path.join(distFontsDir, file));
  }
}

console.log('[cascade-core] Build complete!');
