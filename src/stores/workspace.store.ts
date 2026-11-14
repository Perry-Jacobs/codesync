"use client";

import { create } from "zustand";
import type { FileMeta, WorkspaceMode } from "@/lib/ws-protocol";

export interface OpenTab {
  fileId: string;
  path: string;
}

export type WorkspaceSavePhase =
  "idle" | "saving" | "success" | "partial" | "empty" | "failed";

export interface WorkspaceSaveState {
  phase: WorkspaceSavePhase;
  operationId: string | null;
  total: number;
  saved: number;
  failed: number;
  failures: Array<{ path: string; error: string }>;
}

interface WorkspaceState {
  files: FileMeta[];
  tabs: OpenTab[];
  activeFileId: string | null;
  mode: WorkspaceMode;
  rootName: string | null;
  /** True when the host has an active FileSystemDirectoryHandle. */
  hostFolderConnected: boolean;
  /** Bumped whenever the whole workspace is replaced (folder attach/detach). */
  revision: number;
  save: WorkspaceSaveState;
  setFiles(files: FileMeta[]): void;
  openFile(file: Pick<FileMeta, "fileId" | "path">): void;
  closeTab(fileId: string): void;
  setActive(fileId: string): void;
  closeOtherTabs(fileId: string): void;
  setMode(mode: WorkspaceMode, rootName: string | null): void;
  setHostFolderConnected(connected: boolean): void;
  setSaveState(save: WorkspaceSaveState): void;
  reset(files: FileMeta[], mode: WorkspaceMode, rootName: string | null): void;
  upsertMeta(meta: FileMeta): void;
  removePath(path: string): void;
  movePath(from: string, to: string, meta?: FileMeta): void;
  clear(): void;
}

const MAX_TABS = 8;

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  files: [],
  tabs: [],
  activeFileId: null,
  mode: "virtual",
  rootName: null,
  hostFolderConnected: false,
  revision: 0,
  save: {
    phase: "idle",
    operationId: null,
    total: 0,
    saved: 0,
    failed: 0,
    failures: [],
  },

  setFiles: (files) => {
    const alive = new Set(files.map((file) => file.fileId));
    const tabs = get().tabs.filter((tab) => alive.has(tab.fileId));
    const active = get().activeFileId;
    set({
      files,
      tabs,
      activeFileId:
        active && alive.has(active) ? active : (tabs[0]?.fileId ?? null),
    });
  },

  openFile: (file) => {
    const { tabs } = get();
    if (tabs.some((tab) => tab.fileId === file.fileId)) {
      set({ activeFileId: file.fileId });
      return;
    }
    const nextTabs = [...tabs, { fileId: file.fileId, path: file.path }].slice(
      -MAX_TABS,
    );
    set({ tabs: nextTabs, activeFileId: file.fileId });
  },

  closeTab: (fileId) => {
    const { tabs, activeFileId } = get();
    const index = tabs.findIndex((tab) => tab.fileId === fileId);
    const nextTabs = tabs.filter((tab) => tab.fileId !== fileId);
    let nextActive = activeFileId;
    if (activeFileId === fileId) {
      nextActive =
        nextTabs[Math.max(0, index - 1)]?.fileId ?? nextTabs[0]?.fileId ?? null;
    }
    set({ tabs: nextTabs, activeFileId: nextActive });
  },

  setActive: (fileId) => set({ activeFileId: fileId }),
  closeOtherTabs: (fileId) => {
    const tab = get().tabs.find((entry) => entry.fileId === fileId);
    if (!tab) return;
    set({ tabs: [tab], activeFileId: fileId });
  },

  setMode: (mode, rootName) => set({ mode, rootName }),
  setHostFolderConnected: (hostFolderConnected) => set({ hostFolderConnected }),
  setSaveState: (save) => set({ save }),

  reset: (files, mode, rootName) =>
    set((state) => ({
      files,
      tabs: [],
      activeFileId: null,
      mode,
      rootName,
      revision: state.revision + 1,
    })),

  upsertMeta: (meta) =>
    set((state) => {
      const index = state.files.findIndex(
        (file) => file.fileId === meta.fileId,
      );
      const files = [...state.files];
      if (index >= 0) files[index] = meta;
      else files.push(meta);
      files.sort((a, b) => a.path.localeCompare(b.path));
      const tabs = state.tabs.map((tab) =>
        tab.fileId === meta.fileId ? { ...tab, path: meta.path } : tab,
      );
      return { files, tabs };
    }),

  removePath: (path) =>
    set((state) => {
      const removed = state.files.filter(
        (file) => file.path === path || file.path.startsWith(`${path}/`),
      );
      const removedIds = new Set(removed.map((file) => file.fileId));
      const files = state.files.filter((file) => !removedIds.has(file.fileId));
      const tabs = state.tabs.filter((tab) => !removedIds.has(tab.fileId));
      const activeFileId =
        state.activeFileId && removedIds.has(state.activeFileId)
          ? (tabs[0]?.fileId ?? null)
          : state.activeFileId;
      return { files, tabs, activeFileId };
    }),

  movePath: (from, to, meta) =>
    set((state) => {
      const files = state.files.map((file) => {
        if (meta && file.fileId === meta.fileId) return { ...meta, path: to };
        if (file.path === from) return { ...file, path: to };
        if (file.path.startsWith(`${from}/`)) {
          return { ...file, path: `${to}${file.path.slice(from.length)}` };
        }
        return file;
      });
      files.sort((a, b) => a.path.localeCompare(b.path));
      const tabs = state.tabs.map((tab) => {
        if (meta && tab.fileId === meta.fileId) return { ...tab, path: to };
        if (tab.path === from) return { ...tab, path: to };
        if (tab.path.startsWith(`${from}/`)) {
          return { ...tab, path: `${to}${tab.path.slice(from.length)}` };
        }
        return tab;
      });
      return { files, tabs };
    }),

  clear: () =>
    set((state) => ({
      files: [],
      tabs: [],
      activeFileId: null,
      mode: "virtual",
      rootName: null,
      hostFolderConnected: false,
      revision: state.revision + 1,
      save: {
        phase: "idle",
        operationId: null,
        total: 0,
        saved: 0,
        failed: 0,
        failures: [],
      },
    })),
}));
