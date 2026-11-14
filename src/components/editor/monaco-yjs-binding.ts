'use client';

import type * as Monaco from 'monaco-editor';
import type * as Y from 'yjs';

/**
 * Minimal, dependency-free Monaco <-> Y.Text binding. We keep our own binding
 * (instead of y-monaco) so remote cursor labels and colors come from the
 * server-stamped participant list rather than Yjs awareness.
 */

interface TextDiff {
  start: number;
  deleteCount: number;
  insert: string;
}

function computeDiff(previous: string, next: string): TextDiff | null {
  if (previous === next) return null;
  const max = Math.min(previous.length, next.length);
  let start = 0;
  while (start < max && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;

  let endPrevious = previous.length;
  let endNext = next.length;
  while (
    endPrevious > start &&
    endNext > start &&
    previous.charCodeAt(endPrevious - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrevious -= 1;
    endNext -= 1;
  }

  return {
    start,
    deleteCount: endPrevious - start,
    insert: next.slice(start, endNext),
  };
}

function applyToText(text: Y.Text, diff: TextDiff, doc: Y.Doc, origin: string): void {
  doc.transact(() => {
    if (diff.deleteCount > 0) text.delete(diff.start, diff.deleteCount);
    if (diff.insert.length > 0) text.insert(diff.start, diff.insert);
  }, origin);
}

function applyToModel(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  diff: TextDiff,
): void {
  const start = model.getPositionAt(diff.start);
  const end = model.getPositionAt(diff.start + diff.deleteCount);
  model.applyEdits([
    {
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: diff.insert,
    },
  ]);
}

export interface BindingOptions {
  /** Called after a local edit lands in the shared document. */
  onLocalChange?: () => void;
}

export function bindModelToYText(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  doc: Y.Doc,
  text: Y.Text,
  options: BindingOptions = {},
): () => void {
  const model = editor.getModel();
  if (!model) return () => undefined;

  let applyingRemote = false;

  const initial = text.toString();
  if (model.getValue() !== initial) {
    applyingRemote = true;
    model.setValue(initial);
    applyingRemote = false;
  }

  const modelSubscription = model.onDidChangeContent(() => {
    if (applyingRemote) return;
    const next = model.getValue();
    const previous = text.toString();
    const diff = computeDiff(previous, next);
    if (!diff) return;
    applyToText(text, diff, doc, 'local');
    options.onLocalChange?.();
  });

  const textObserver = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
    if (transaction.origin === 'local') return;
    const next = event.target.toString();
    const previous = model.getValue();
    const diff = computeDiff(previous, next);
    if (!diff) return;
    applyingRemote = true;
    try {
      applyToModel(monaco, model, diff);
    } finally {
      applyingRemote = false;
    }
  };

  text.observe(textObserver);

  return () => {
    modelSubscription.dispose();
    text.unobserve(textObserver);
  };
}

export function createModel(
  monaco: typeof Monaco,
  value: string,
  language: string,
  path?: string,
): Monaco.editor.ITextModel {
  const uri = path ? monaco.Uri.parse(`codesync:///${path}`) : undefined;
  const existing = uri ? monaco.editor.getModel(uri) : null;
  if (existing) {
    monaco.editor.setModelLanguage(existing, language);
    return existing;
  }
  return monaco.editor.createModel(value, language, uri);
}
