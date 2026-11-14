"use client";

import type * as Monaco from "monaco-editor";
import type { CodeRange } from "@/lib/ws-protocol";
import { hashString } from "@/lib/utils";
import { safeParticipantColor } from "@/utils/color";

export interface RemoteParticipantCursor {
  participantId: string;
  name: string;
  color: string;
  /** Zero-based line/column, matching the wire protocol. */
  line: number;
  column: number;
  ranges?: CodeRange[];
}

interface LabelEntry {
  widget: Monaco.editor.IContentWidget;
  node: HTMLDivElement;
  position: Monaco.editor.IContentWidgetPosition;
}

const colorClasses = new Map<string, string>();
let styleElement: HTMLStyleElement | null = null;

function ensureColorClass(rawColor: string): string {
  const color = safeParticipantColor(rawColor);
  const className = `rc-${hashString(color).toString(36)}`;
  if (colorClasses.has(color)) return colorClasses.get(color) as string;
  if (typeof document !== "undefined") {
    if (!styleElement) {
      styleElement = document.createElement("style");
      styleElement.dataset.codesync = "remote-cursor-colors";
      document.head.appendChild(styleElement);
    }
    styleElement.appendChild(
      document.createTextNode(`.${className}{--rc-color:${color};}`),
    );
  }
  colorClasses.set(color, className);
  return className;
}

/**
 * Renders remote carets as content widgets (exact positioning, label pill) and
 * remote selections as Monaco decorations.
 */
export class RemoteCursorManager {
  private readonly widgets = new Map<string, LabelEntry>();
  private readonly states = new Map<string, RemoteParticipantCursor>();
  private readonly selections: Monaco.editor.IEditorDecorationsCollection;

  constructor(
    private readonly monaco: typeof Monaco,
    private readonly editor: Monaco.editor.IStandaloneCodeEditor,
  ) {
    this.selections = editor.createDecorationsCollection([]);
  }

  update(cursor: RemoteParticipantCursor): void {
    this.states.set(cursor.participantId, cursor);
    this.updateWidget(cursor);
    this.renderSelections();
  }

  remove(participantId: string): void {
    this.states.delete(participantId);
    const entry = this.widgets.get(participantId);
    if (entry) {
      this.editor.removeContentWidget(entry.widget);
      this.widgets.delete(participantId);
    }
    this.renderSelections();
  }

  clear(): void {
    for (const id of [...this.widgets.keys()]) this.remove(id);
    this.selections.clear();
  }

  dispose(): void {
    this.clear();
    this.selections.clear();
  }

  private positionOf(cursor: RemoteParticipantCursor): Monaco.Position {
    const model = this.editor.getModel();
    const lineCount = model?.getLineCount() ?? 1;
    const lineNumber = Math.min(Math.max(1, cursor.line + 1), lineCount);
    const maxColumn = model?.getLineMaxColumn(lineNumber) ?? 1;
    const column = Math.min(Math.max(1, cursor.column + 1), maxColumn);
    return new this.monaco.Position(lineNumber, column);
  }

  private preferenceFor(): Monaco.editor.ContentWidgetPositionPreference {
    // EXACT anchors the widget to the top-left of the caret's line. The caret
    // fills the line and the name pill is offset above it with CSS.
    return this.monaco.editor.ContentWidgetPositionPreference.EXACT;
  }

  private applyPlacement(
    node: HTMLDivElement,
    position: Monaco.Position,
  ): void {
    const lineHeight = this.editor.getOption(
      this.monaco.editor.EditorOption.lineHeight,
    );
    node.style.setProperty("--rc-line-height", `${lineHeight}px`);
    // The pill normally floats above the caret. On line 1 there is no room, so
    // it flips below instead of covering the tab strip.
    node.classList.toggle("rc-first-line", position.lineNumber <= 1);
  }

  private updateWidget(cursor: RemoteParticipantCursor): void {
    const position = this.positionOf(cursor);
    let entry = this.widgets.get(cursor.participantId);

    if (!entry) {
      const node = document.createElement("div");
      node.className = "remote-caret-widget";
      this.applyPlacement(node, position);
      const caret = document.createElement("div");
      caret.className = "remote-caret";
      const label = document.createElement("div");
      label.className = "remote-cursor-label";
      node.append(caret, label);
      const participantId = cursor.participantId;
      const widget: Monaco.editor.IContentWidget = {
        getId: () => `codesync-cursor-${participantId}`,
        getDomNode: () => node,
        getPosition: () => entry?.position ?? null,
        allowEditorOverflow: false,
      };
      entry = {
        widget,
        node,
        position: {
          position,
          preference: [this.preferenceFor()],
        },
      };
      this.widgets.set(participantId, entry);
      this.editor.addContentWidget(widget);
    }

    entry.position = {
      position,
      preference: [this.preferenceFor()],
    };
    this.applyPlacement(entry.node, position);
    entry.node.style.setProperty(
      "--rc-color",
      safeParticipantColor(cursor.color),
    );
    const label = entry.node.querySelector(".remote-cursor-label");
    if (label) label.textContent = cursor.name;
    this.editor.layoutContentWidget(entry.widget);
  }

  private renderSelections(): void {
    const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
    const model = this.editor.getModel();
    const lineCount = model?.getLineCount() ?? 1;

    for (const state of this.states.values()) {
      if (!state.ranges || state.ranges.length === 0) continue;
      const colorClass = ensureColorClass(state.color);
      for (const range of state.ranges.slice(0, 4)) {
        const startLine = Math.min(Math.max(1, range.startLine + 1), lineCount);
        const endLine = Math.min(
          Math.max(startLine, range.endLine + 1),
          lineCount,
        );
        const startColumn = Math.max(1, range.startColumn + 1);
        const endColumn = Math.max(1, range.endColumn + 1);
        if (startLine === endLine && startColumn === endColumn) continue;
        decorations.push({
          range: new this.monaco.Range(
            startLine,
            startColumn,
            endLine,
            endColumn,
          ),
          options: {
            className: `remote-selection ${colorClass}`,
            stickiness:
              this.monaco.editor.TrackedRangeStickiness
                .NeverGrowsWhenTypingAtEdges,
            hoverMessage: { value: state.name },
          },
        });
      }
    }

    this.selections.set(decorations);
  }
}
