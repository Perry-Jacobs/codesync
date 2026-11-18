"use client";

import * as Y from "yjs";

interface Entry {
  doc: Y.Doc;
  refs: number;
  lastUsed: number;
}

const MAX_CACHED_DOCS = 8;
const docs = new Map<string, Entry>();

export function acquireClientDoc(fileId: string): Y.Doc {
  const existing = docs.get(fileId);
  if (existing) {
    existing.refs += 1;
    existing.lastUsed = Date.now();
    return existing.doc;
  }
  const doc = new Y.Doc();
  docs.set(fileId, { doc, refs: 1, lastUsed: Date.now() });
  evict();
  return doc;
}

export function releaseClientDoc(fileId: string): void {
  const entry = docs.get(fileId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.lastUsed = Date.now();
}

/**
 * Drops every cached client document. The gateway recreates documents from the
 * host's disk whenever a local folder is attached or reloaded, so keeping a
 * document across a workspace reset would merge two independent histories and
 * duplicate its text.
 */
export function resetClientDocs(): void {
  for (const entry of docs.values()) {
    if (entry.refs === 0) entry.doc.destroy();
  }
  docs.clear();
}

export function getClientDoc(fileId: string): Y.Doc | null {
  return docs.get(fileId)?.doc ?? null;
}

function evict(): void {
  if (docs.size <= MAX_CACHED_DOCS) return;
  const idle = [...docs.entries()]
    .filter(([, entry]) => entry.refs === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (docs.size > MAX_CACHED_DOCS && idle.length > 0) {
    const next = idle.shift();
    if (!next) break;
    next[1].doc.destroy();
    docs.delete(next[0]);
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeFullState(doc: Y.Doc): string {
  return toBase64(Y.encodeStateAsUpdate(doc));
}

export function encodeStateVector(doc: Y.Doc): string {
  return toBase64(Y.encodeStateVector(doc));
}

export function applyRemoteUpdate(doc: Y.Doc, update: string): void {
  Y.applyUpdate(doc, fromBase64(update), "remote");
}
