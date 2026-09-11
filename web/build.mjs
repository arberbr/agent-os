// Production build for the web app.
//
// `vite build` runs the full pipeline: React JSX and Tailwind v4 (via the
// Vite plugin), which emits the compiled stylesheet as a normal imported
// asset, so index.html needs no post-processing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(webDir, 'dist');
const viteBin = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');

execFileSync(process.execPath, [viteBin, 'build'], { stdio: 'inherit', cwd: webDir });

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('[build] index.html missing from dist; vite build failed');
  process.exit(1);
}

console.log('[build] web bundle ready at', distDir);
