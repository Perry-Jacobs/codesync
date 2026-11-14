import type { FileMeta } from '@/lib/ws-protocol';

export interface TreeNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  meta?: FileMeta;
  children: TreeNode[];
}

function makeDirNode(path: string, name: string): TreeNode {
  return { name, path, kind: 'dir', children: [] };
}

/**
 * Turns the flat, path-keyed file list from the gateway into a sorted tree.
 * Implicit directories (files without an explicit dir entry) are synthesized.
 */
export function buildFileTree(files: FileMeta[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();

  const ensureDir = (segments: string[]): TreeNode[] => {
    let current = roots;
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let node = dirs.get(prefix);
      if (!node) {
        node = makeDirNode(prefix, segment);
        dirs.set(prefix, node);
        current.push(node);
      }
      current = node.children;
    }
    return current;
  };

  for (const file of files) {
    if (!file.path) continue;
    const segments = file.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    const parentSegments = segments.slice(0, -1);
    const parent = ensureDir(parentSegments);
    const name = segments[segments.length - 1] as string;

    if (file.kind === 'dir') {
      const existing = dirs.get(file.path);
      if (existing) {
        existing.meta = file;
      } else {
        const node = makeDirNode(file.path, name);
        node.meta = file;
        dirs.set(file.path, node);
        parent.push(node);
      }
      continue;
    }

    const node: TreeNode = {
      name,
      path: file.path,
      kind: 'file',
      meta: file,
      children: [],
    };
    parent.push(node);
  }

  const sortNodes = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const node of nodes) if (node.children.length > 0) sortNodes(node.children);
  };
  sortNodes(roots);
  return roots;
}

/** All ancestor directory paths for a dotted path (used for auto-expand). */
export function ancestorPaths(path: string): string[] {
  const segments = path.split('/').filter(Boolean);
  const result: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    result.push(segments.slice(0, index).join('/'));
  }
  return result;
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) return false;
  return trimmed.length <= 120;
}

export function entryExtension(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
}
