"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 420;
export const RAIL_MIN_WIDTH = 280;
export const RAIL_MAX_WIDTH = 520;

interface WorkspaceLayoutState {
  sidebarWidth: number;
  railWidth: number;
  setSidebarWidth(width: number): void;
  setRailWidth(width: number): void;
}

function clamp(width: number, min: number, max: number): number {
  return Math.min(Math.max(width, min), max);
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: 190,
      railWidth: 288,
      setSidebarWidth: (sidebarWidth) =>
        set({
          sidebarWidth: clamp(
            sidebarWidth,
            SIDEBAR_MIN_WIDTH,
            SIDEBAR_MAX_WIDTH,
          ),
        }),
      setRailWidth: (railWidth) =>
        set({ railWidth: clamp(railWidth, RAIL_MIN_WIDTH, RAIL_MAX_WIDTH) }),
    }),
    {
      name: "codesync-workspace-layout",
      skipHydration: true,
    },
  ),
);
