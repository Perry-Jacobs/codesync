export type WorkspaceLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'html'
  | 'css'
  | 'json'
  | 'markdown'
  | 'yaml'
  | 'shell'
  | 'sql'
  | 'plaintext';

const BY_EXTENSION: Record<string, WorkspaceLanguage> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyw: 'python',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  txt: 'plaintext',
};

export function languageFromPath(path: string): WorkspaceLanguage {
  const name = path.split('/').pop() ?? '';
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  return BY_EXTENSION[extension] ?? 'plaintext';
}

export const EDITABLE_EXTENSIONS = new Set(Object.keys(BY_EXTENSION));

export function isEditableFile(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  if (!name.includes('.')) return false;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return EDITABLE_EXTENSIONS.has(extension) && !name.startsWith('.');
}

export function isBinaryName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp4|mp3|woff2?|ttf|otf|wasm|node)$/i.test(name);
}
