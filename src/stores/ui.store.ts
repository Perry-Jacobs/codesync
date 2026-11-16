"use client";

import { create } from "zustand";

interface UiState {
  sidebarOpen: boolean;
  railOpen: boolean;
  /**
   * Whether the side rail is actually on screen. On compact widths the rail
   * lives in a drawer, so `railOpen` alone cannot tell us whether chat is
   * visible (it stays true behind the closed drawer).
   */
  railVisible: boolean;
  bottomOpen: boolean;
  bottomTab: "chat" | "video";
  sidePanelTab: "people" | "gallery" | "chat";
  mediaFullscreen: boolean;
  followingId: string | null;
  unreadChat: number;
  shortcutsOpen: boolean;

  setSidebarOpen(open: boolean): void;
  toggleSidebar(): void;
  setRailOpen(open: boolean): void;
  setRailVisible(visible: boolean): void;
  toggleRail(): void;
  setBottomOpen(open: boolean): void;
  setBottomTab(tab: "chat" | "video"): void;
  setSidePanelTab(tab: "people" | "gallery" | "chat"): void;
  setMediaFullscreen(open: boolean): void;
  setFollowing(id: string | null): void;
  incrementUnread(): void;
  clearUnread(): void;
  setShortcutsOpen(open: boolean): void;

  reset(): void;
}

const initial = {
  sidebarOpen: true,
  railOpen: true,
  railVisible: true,
  bottomOpen: true,
  bottomTab: "chat" as const,
  sidePanelTab: "people" as const,
  mediaFullscreen: false,
  followingId: null,
  unreadChat: 0,
  shortcutsOpen: false,
};

export const useUiStore = create<UiState>((set) => ({
  ...initial,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setRailOpen: (railOpen) => set({ railOpen }),
  setRailVisible: (railVisible) => set({ railVisible }),
  toggleRail: () => set((state) => ({ railOpen: !state.railOpen })),
  setBottomOpen: (bottomOpen) => set({ bottomOpen }),
  setBottomTab: (bottomTab) =>
    set({ bottomTab, bottomOpen: true, unreadChat: 0 }),
  setSidePanelTab: (sidePanelTab) =>
    set((state) => ({
      sidePanelTab,
      unreadChat: sidePanelTab === "chat" ? 0 : state.unreadChat,
    })),
  setMediaFullscreen: (mediaFullscreen) => set({ mediaFullscreen }),
  setFollowing: (followingId) => set({ followingId }),
  incrementUnread: () => set((state) => ({ unreadChat: state.unreadChat + 1 })),
  clearUnread: () => set({ unreadChat: 0 }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  reset: () => set({ ...initial }),
}));
