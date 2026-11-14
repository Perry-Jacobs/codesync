// Publishes Monaco's prebuilt AMD bundle so the editor loads without
// webpack worker plumbing. Runs automatically on predev / prebuild.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const target = join(root, 'public', 'monaco', 'vs');

if (!existsSync(source)) {
  console.error('[monaco] node_modules/monaco-editor/min/vs not found. Run npm install first.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
console.log('[monaco] copied min/vs -> public/monaco/vs');
