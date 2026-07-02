/**
 * Postinstall script for cascade-studio.
 * Bundles library ESM modules into single browser-ready files.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');
const monoRoot = path.join(pkgRoot, '..', '..');

// Bundle dockview-core ESM into a single file for buildless browser use
const dvInput = path.join(monoRoot, 'node_modules', 'dockview-core', 'dist', 'esm', 'index.js');
const dvOutput = path.join(pkgRoot, 'lib', 'dockview-core', 'dockview-core.js');

if (fs.existsSync(dvInput)) {
  const dvDir = path.dirname(dvOutput);
  if (!fs.existsSync(dvDir)) { fs.mkdirSync(dvDir, { recursive: true }); }

  esbuild.buildSync({
    entryPoints: [dvInput],
    bundle: true,
    format: 'esm',
    outfile: dvOutput,
    sourcemap: true,
    absWorkingDir: monoRoot,
  });
  console.log('  Bundled dockview-core ESM to', dvOutput);

  // Copy dockview CSS
  const dvCss = path.join(monoRoot, 'node_modules', 'dockview-core', 'dist', 'styles', 'dockview.css');
  if (fs.existsSync(dvCss)) {
    fs.copyFileSync(dvCss, path.join(dvDir, 'dockview.css'));
    console.log('  Copied dockview CSS');
  }
}

// Bundle openscad-parser CJS → ESM for buildless browser use
const opInput = path.join(monoRoot, 'node_modules', 'openscad-parser', 'dist', 'index.js');
const opOutput = path.join(pkgRoot, 'lib', 'openscad-parser', 'openscad-parser.js');

if (fs.existsSync(opInput)) {
  const opDir = path.dirname(opOutput);
  if (!fs.existsSync(opDir)) { fs.mkdirSync(opDir, { recursive: true }); }

  const shim = path.join(__dirname, 'node-shims.cjs');
  esbuild.buildSync({
    entryPoints: [opInput],
    bundle: true,
    format: 'esm',
    outfile: opOutput,
    sourcemap: true,
    alias: { fs: shim, path: shim, os: shim },
    absWorkingDir: monoRoot,
  });
  console.log('  Bundled openscad-parser ESM to', opOutput);
}
