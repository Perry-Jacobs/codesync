"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BeforeMount, OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { Code2, Loader2 } from "lucide-react";
import { hasCapability } from "@/lib/acl";
import { presenceBus } from "@/lib/buses";
import type { CodeRange } from "@/lib/ws-protocol";
import { throttle } from "@/lib/throttle";
import { useSession } from "@/components/providers/session-provider";
import { useTheme } from "@/components/providers/theme-provider";
import {
  EDITOR_THEME,
  defineThemes,
  editorOptions,
} from "@/components/editor/monaco-setup";
import { bindModelToYText } from "@/components/editor/monaco-yjs-binding";
import {
  RemoteCursorManager,
  type RemoteParticipantCursor,
} from "@/components/editor/remote-cursors";
import { EditorStatusBar } from "@/components/editor/EditorStatusBar";
import { useYjsFile } from "@/hooks/useYjsFile";
import { useRoomStore } from "@/stores/room.store";
import { safeParticipantColor } from "@/utils/color";
import { useUiStore } from "@/stores/ui.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading editor…
    </div>
  ),
});

function toWireRange(selection: Monaco.Selection): CodeRange {
  return {
    startLine: selection.startLineNumber - 1,
    startColumn: selection.startColumn - 1,
    endLine: selection.endLineNumber - 1,
    endColumn: selection.endColumn - 1,
  };
}

export function EditorPane() {
  const { send } = useSession();
  const { theme } = useTheme();
  const files = useWorkspaceStore((state) => state.files);
  const tabs = useWorkspaceStore((state) => state.tabs);
  const activeFileId = useWorkspaceStore((state) => state.activeFileId);
  const self = useRoomStore((state) => state.self);
  const participants = useRoomStore((state) => state.participants);
  const followingId = useUiStore((state) => state.followingId);
  const setFollowing = useUiStore((state) => state.setFollowing);

  const file = useMemo(
    () => files.find((entry) => entry.fileId === activeFileId) ?? null,
    [files, activeFileId],
  );
  const tab = tabs.find((entry) => entry.fileId === activeFileId) ?? null;
  const canEdit = hasCapability(self, "edit_code");
  const { doc, text, synced } = useYjsFile(activeFileId);

  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const managerRef = useRef<RemoteCursorManager | null>(null);
  const remoteStateRef = useRef(new Map<string, RemoteParticipantCursor>());
  const followingRef = useRef<string | null>(followingId);
  followingRef.current = followingId;

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.onDidChangeCursorPosition((event) => {
      setPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
    setMounted(true);
  };

  const handleBeforeMount: BeforeMount = (monaco) => {
    defineThemes(monaco);
  };

  // Create/destroy the remote cursor layer with the editor instance.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!mounted || !editor || !monaco) return;
    const manager = new RemoteCursorManager(monaco, editor);
    managerRef.current = manager;
    return () => {
      manager.dispose();
      managerRef.current = null;
    };
  }, [mounted]);

  // Rebind Monaco to the active document (tab switch, doc identity change).
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!mounted || !editor || !monaco || !doc || !text) return;
    const model = editor.getModel();
    if (model && file) monaco.editor.setModelLanguage(model, file.lang);
    return bindModelToYText(monaco, editor, doc, text);
  }, [mounted, doc, text, file]);

  // A new file starts with a clean cursor layer.
  useEffect(() => {
    remoteStateRef.current.clear();
    managerRef.current?.clear();
  }, [activeFileId]);

  // Drop cursors of participants who left or lost edit access. Presence is an
  // editing affordance: a read-only viewer should not leave a cursor behind.
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const visible = new Set(
      participants
        .filter((entry) => hasCapability(entry, "edit_code"))
        .map((entry) => entry.id),
    );
    for (const id of remoteStateRef.current.keys()) {
      if (!visible.has(id)) {
        remoteStateRef.current.delete(id);
        manager.remove(id);
      }
    }
  }, [participants]);

  // Publish local cursor, selection and viewport.
  useEffect(() => {
    const editor = editorRef.current;
    if (!mounted || !editor || !activeFileId || !canEdit) return;

    const publishCursor = throttle((line: number, column: number) => {
      send("cursor_move", { fileId: activeFileId, line, column });
    }, 70);
    const publishSelection = throttle((ranges: CodeRange[]) => {
      send("selection_change", { fileId: activeFileId, ranges });
    }, 140);
    const publishViewport = throttle((topLine: number) => {
      send("viewport_change", { fileId: activeFileId, topLine });
    }, 300);

    const selectionSub = editor.onDidChangeCursorSelection((event) => {
      const head = event.selection.getPosition();
      publishCursor(head.lineNumber - 1, head.column - 1);
      publishSelection(
        event.selection.isEmpty() ? [] : [toWireRange(event.selection)],
      );
    });
    const scrollSub = editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged) return;
      const top = editor.getVisibleRanges()[0]?.startLineNumber ?? 1;
      publishViewport(top - 1);
    });

    return () => {
      publishCursor.cancel();
      publishSelection.cancel();
      publishViewport.cancel();
      selectionSub.dispose();
      scrollSub.dispose();
    };
  }, [mounted, activeFileId, canEdit, send]);

  // Apply remote presence.
  useEffect(() => {
    const manager = managerRef.current;
    const editor = editorRef.current;
    if (!mounted || !editor || !manager || !activeFileId) return;

    return presenceBus.on((event) => {
      if (event.fileId !== activeFileId) return;
      const participant = participants.find(
        (entry) => entry.id === event.participantId,
      );
      if (!participant || !hasCapability(participant, "edit_code")) return;

      const existing = remoteStateRef.current.get(participant.id) ?? {
        participantId: participant.id,
        name: participant.name,
        color: safeParticipantColor(participant.color),
        line: 0,
        column: 0,
      };
      const next: RemoteParticipantCursor = {
        ...existing,
        name: participant.name,
        color: safeParticipantColor(participant.color),
      };

      if (event.kind === "cursor") {
        next.line = event.line;
        next.column = event.column;
      } else if (event.kind === "selection") {
        next.ranges = event.ranges;
      } else if (event.kind === "viewport") {
        if (followingRef.current === participant.id) {
          editor.revealLineNearTop(Math.max(1, event.topLine + 1));
        }
        return;
      }

      remoteStateRef.current.set(participant.id, next);
      manager.update(next);

      if (event.kind === "cursor" && followingRef.current === participant.id) {
        editor.revealLineInCenterIfOutsideViewport(Math.max(1, event.line + 1));
      }
    });
  }, [mounted, activeFileId, participants]);

  // Clicking a collaborator's avatar follows their viewport.
  useEffect(() => {
    if (!followingId) return;
    const participant = participants.find((entry) => entry.id === followingId);
    if (!participant || !hasCapability(participant, "edit_code")) {
      setFollowing(null);
      return;
    }
    const cursor = remoteStateRef.current.get(followingId);
    if (cursor)
      editorRef.current?.revealLineInCenterIfOutsideViewport(cursor.line + 1);
  }, [followingId, participants, setFollowing]);

  if (!file || !tab) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-card px-5 text-center">
        <div className="max-w-sm rounded-2xl border border-border bg-muted/30 px-8 py-7 shadow-sm">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-sm">
            <Code2 className="h-5 w-5" />
          </span>
          <h2 className="mt-4 text-base font-semibold text-foreground">
            No file open
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {canEdit
              ? "Pick a file from the explorer, or create one to start collaborating."
              : "Ask the host for edit access, or open a file from the explorer to read along."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="relative min-h-0 flex-1">
        <MonacoEditor
          height="100%"
          path={file.path}
          defaultLanguage={file.lang}
          defaultValue=""
          theme={theme === "dark" ? EDITOR_THEME.dark : EDITOR_THEME.light}
          beforeMount={handleBeforeMount}
          onMount={handleMount}
          options={editorOptions(canEdit)}
        />
        {followingId ? (
          <button
            type="button"
            onClick={() => setFollowing(null)}
            className="absolute right-4 top-3 z-10 rounded-full border border-border bg-card/95 px-3 py-1 text-[11px] font-medium text-foreground shadow-lg backdrop-blur"
          >
            Following{" "}
            {participants.find((entry) => entry.id === followingId)?.name ??
              "collaborator"}
            <span className="ml-2 text-muted-foreground">Esc to stop</span>
          </button>
        ) : null}
      </div>
      <EditorStatusBar
        language={file.lang}
        line={position.line}
        column={position.column}
        canEdit={canEdit}
        synced={synced}
      />
    </div>
  );
}
