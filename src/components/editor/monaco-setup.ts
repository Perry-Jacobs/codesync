"use client";

import { loader } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";

let configured = false;

/**
 * Points Monaco at the static AMD bundle copied by scripts/copy-monaco.mjs and
 * gives workers an absolute URL. Without the absolute worker URL the AMD
 * worker wrapper resolves `cssWorker.js` against `blob:` and fetch throws.
 */
export function configureMonacoLoader(): void {
  if (configured) return;
  if (typeof window !== "undefined") {
    window.MonacoEnvironment = {
      getWorkerUrl: () =>
        new URL(
          "/monaco/vs/base/worker/workerMain.js",
          window.location.origin,
        ).toString(),
    };
  }
  loader.config({ paths: { vs: "/monaco/vs" } });
  configured = true;
}

export const EDITOR_THEME = {
  dark: "codesync-dark",
  light: "codesync-light",
} as const;

// Configure at module load so the loader never falls back to the jsDelivr CDN
// (the CSP only allows same-origin scripts). `loader.config` touches no DOM,
// so this is safe even though client modules are also evaluated on the server.
if (typeof window !== "undefined") configureMonacoLoader();

export function defineThemes(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(EDITOR_THEME.dark, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7d8590", fontStyle: "italic" },
      { token: "keyword", foreground: "c792ea" },
      { token: "string", foreground: "a5d6ff" },
      { token: "number", foreground: "79c0ff" },
      { token: "type", foreground: "ffa657" },
      { token: "function", foreground: "d2a8ff" },
      { token: "variable", foreground: "e6edf3" },
    ],
    colors: {
      "editor.background": "#0d1117",
      "editor.foreground": "#e6edf3",
      "editor.lineHighlightBackground": "#161b2280",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#264f7855",
      "editorCursor.foreground": "#4ea1ff",
      "editorIndentGuide.background1": "#21262d",
      "editorIndentGuide.activeBackground1": "#30363d",
      "editorLineNumber.foreground": "#484f58",
      "editorLineNumber.activeForeground": "#c9d1d9",
      "editorGutter.background": "#0d1117",
      "editorWidget.background": "#161b22",
      "editorWidget.border": "#30363d",
      "editorSuggestWidget.background": "#161b22",
      "editorSuggestWidget.selectedBackground": "#1f6feb33",
      "editorHoverWidget.background": "#161b22",
      "editorHoverWidget.border": "#30363d",
      "minimap.background": "#0d1117",
      "scrollbarSlider.background": "#484f5844",
      "scrollbarSlider.hoverBackground": "#484f5877",
      "scrollbarSlider.activeBackground": "#484f58aa",
    },
  });

  monaco.editor.defineTheme(EDITOR_THEME.light, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6e7781", fontStyle: "italic" },
      { token: "keyword", foreground: "8250df" },
      { token: "string", foreground: "0a3069" },
      { token: "number", foreground: "0550ae" },
      { token: "type", foreground: "953800" },
      { token: "function", foreground: "6639ba" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f6f8fa",
      "editor.selectionBackground": "#b6d7ff",
      "editorCursor.foreground": "#0969da",
      "editorLineNumber.foreground": "#8c959f",
      "editorGutter.background": "#ffffff",
      "minimap.background": "#ffffff",
    },
  });
}

export function editorOptions(
  canEdit: boolean,
): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    readOnly: !canEdit,
    domReadOnly: !canEdit,
    automaticLayout: true,
    fontFamily:
      "'JetBrains Mono', 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12.5,
    lineHeight: 22,
    fontLigatures: true,
    minimap: { enabled: false },
    smoothScrolling: true,
    cursorBlinking: "blink",
    cursorSmoothCaretAnimation: "off",
    cursorWidth: 2,
    renderLineHighlight: "all",
    renderWhitespace: "selection",
    guides: { bracketPairs: true, indentation: true },
    bracketPairColorization: { enabled: true },
    stickyScroll: { enabled: true },
    multiCursorModifier: "alt",
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: "on",
    tabSize: 2,
    insertSpaces: true,
    formatOnPaste: true,
    scrollBeyondLastLine: false,
    padding: { top: 18, bottom: 24 },
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: true,
    showFoldingControls: "mouseover",
    wordWrap: "off",
    mouseWheelZoom: false,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    overviewRulerBorder: false,
    fixedOverflowWidgets: true,
    "semanticHighlighting.enabled": true,
  };
}
