"use client";

import { MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui.store";
import { ChatPanel } from "./ChatPanel";
import { ParticipantRail } from "./ParticipantRail";

type PanelTab = "people" | "chat";

interface SidePanelProps {
  onOpenWaiting(): void;
  variant?: "desktop" | "drawer";
}

/** Right-hand rail: the people list and session chat share one column. */
export function SidePanel({
  onOpenWaiting,
  variant = "desktop",
}: SidePanelProps) {
  const unreadChat = useUiStore((state) => state.unreadChat);
  const tab = useUiStore((state) => state.sidePanelTab);
  const setTab = useUiStore((state) => state.setSidePanelTab);
  const panelId =
    variant === "drawer" ? "drawer-session-panel" : "desktop-session-panel";

  const tabButton = (value: PanelTab, label: string, icon: React.ReactNode) => {
    const active = tab === value;
    return (
      <button
        key={value}
        type="button"
        role="tab"
        id={`${panelId}-tab-${value}`}
        aria-selected={active}
        aria-controls={`${panelId}-${value}`}
        tabIndex={active ? 0 : -1}
        onClick={() => setTab(value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setTab(value === "people" ? "chat" : "people");
          window.requestAnimationFrame(() => {
            document
              .getElementById(
                `${panelId}-tab-${value === "people" ? "chat" : "people"}`,
              )
              ?.focus();
          });
        }}
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded-lg border font-semibold uppercase tracking-wider transition-all duration-150",
          variant === "drawer" ? "h-10 text-xs" : "h-7 text-[11px]",
          active
            ? "border-border/80 bg-background/70 text-foreground shadow-sm"
            : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/30 hover:text-foreground",
        )}
      >
        {icon}
        {label}
        {value === "chat" && unreadChat > 0 ? (
          <span className="rounded-full bg-primary px-1 text-[8px] font-bold text-primary-foreground">
            {unreadChat > 9 ? "9+" : unreadChat}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-card">
      <div
        role="tablist"
        aria-label="Session panels"
        className={cn(
          "flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/20",
          variant === "drawer" ? "h-12 px-3" : "h-10 px-2.5",
        )}
      >
        {tabButton("people", "People", <Users className="h-3 w-3" />)}
        {tabButton("chat", "Chat", <MessageSquare className="h-3 w-3" />)}
      </div>

      <div
        id={`${panelId}-people`}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-people`}
        hidden={tab !== "people"}
        className={cn(
          "min-h-0 flex-1 flex-col",
          tab === "people" ? "flex" : "hidden",
        )}
      >
        <ParticipantRail onOpenWaiting={onOpenWaiting} variant={variant} />
      </div>
      <div
        id={`${panelId}-chat`}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-chat`}
        hidden={tab !== "chat"}
        className={cn(
          "min-h-0 flex-1 flex-col",
          tab === "chat" ? "flex" : "hidden",
        )}
      >
        <ChatPanel variant={variant} />
      </div>
    </aside>
  );
}
