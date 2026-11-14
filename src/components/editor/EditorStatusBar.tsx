"use client";

import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  Loader2,
  Lock,
  PencilLine,
  Radio,
  Unlock,
} from "lucide-react";
import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useRoomStore } from "@/stores/room.store";
import { useWorkspaceStore } from "@/stores/workspace.store";

interface EditorStatusBarProps {
  language: string;
  line: number;
  column: number;
  canEdit: boolean;
  synced: boolean;
}

export function EditorStatusBar({
  language,
  line,
  column,
  canEdit,
  synced,
}: EditorStatusBarProps) {
  const { send } = useSession();
  const connection = useRoomStore((state) => state.connection);
  const save = useWorkspaceStore((state) => state.save);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    setRequested(false);
  }, [canEdit]);

  const connectionTone =
    connection === "open"
      ? "bg-emerald-500"
      : connection === "reconnecting" || connection === "connecting"
        ? "bg-amber-400"
        : "bg-rose-500";

  const saveLabel =
    save.phase === "saving"
      ? "Saving…"
      : save.phase === "success"
        ? "Saved"
        : save.phase === "partial"
          ? `${save.saved}/${save.total} saved`
          : save.phase === "failed"
            ? "Save failed"
            : save.phase === "empty"
              ? "Nothing to save"
              : null;

  const requestEdit = (): void => {
    send("request_edit", { note: "Can I help edit?" });
    setRequested(true);
  };

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-2 border-t border-border bg-muted/30 px-2.5 text-[11px] text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="inline-flex items-center gap-1.5"
          aria-live="polite"
          title={`Connection ${connection}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", connectionTone)} />
          <span className="hidden sm:inline">
            {connection === "open" ? "Connected" : connection}
          </span>
        </span>
        <span className="hidden sm:inline">
          Ln {line}, Col {column}
        </span>
        <span className="hidden md:inline">UTF-8</span>
        <span className="hidden md:inline">LF</span>
        <span className="max-w-28 truncate capitalize">{language}</span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {saveLabel ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium",
              save.phase === "saving" && "text-amber-600 dark:text-amber-300",
              save.phase === "success" &&
                "text-emerald-600 dark:text-emerald-300",
              (save.phase === "partial" || save.phase === "failed") &&
                "text-rose-600 dark:text-rose-300",
              save.phase === "empty" && "text-muted-foreground",
            )}
            title={
              save.failures.length > 0
                ? save.failures
                    .map((failure) => `${failure.path}: ${failure.error}`)
                    .join("\n")
                : undefined
            }
          >
            {save.phase === "saving" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : save.phase === "success" ? (
              <Check className="h-3 w-3" />
            ) : save.phase === "partial" || save.phase === "failed" ? (
              <CircleAlert className="h-3 w-3" />
            ) : (
              <Cloud className="h-3 w-3" />
            )}
            {saveLabel}
          </span>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="hidden items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent hover:text-foreground md:inline-flex"
              aria-label="More editor details"
            >
              <Radio className="h-3 w-3" />
              {synced ? "In sync" : "Syncing…"}
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Editor details</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              {synced ? "Synced with session" : "Syncing changes…"}
            </DropdownMenuItem>
            <DropdownMenuItem disabled>UTF-8 · LF</DropdownMenuItem>
            <DropdownMenuItem disabled>
              Ln {line}, Col {column}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {canEdit ? (
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 font-medium text-emerald-700 dark:text-emerald-300">
            <Unlock className="h-3 w-3" aria-hidden="true" />{" "}
            <span className="whitespace-nowrap">Editing</span>
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 font-medium text-amber-700 dark:text-amber-300">
              <Lock className="h-3 w-3" aria-hidden="true" />{" "}
              <span className="whitespace-nowrap">Read-only</span>
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={requestEdit}
              disabled={requested}
              title={
                requested
                  ? "The host has your request"
                  : "Ask the host for edit access"
              }
              className={cn(
                "h-6 gap-1.5 rounded-full border px-2.5 text-[10px] font-semibold shadow-sm transition-colors [&_svg]:h-3 [&_svg]:w-3 disabled:opacity-100",
                requested
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-500/35 bg-amber-500/15 text-amber-700 hover:border-amber-500/60 hover:bg-amber-500/25 dark:text-amber-200",
              )}
            >
              {requested ? <Check /> : <PencilLine />}
              <span className="hidden lg:inline">
                {requested ? "Request sent" : "Request edit"}
              </span>
            </Button>
          </div>
        )}
      </div>
    </footer>
  );
}
