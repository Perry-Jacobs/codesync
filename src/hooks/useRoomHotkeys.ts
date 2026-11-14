"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import type { HostWorkspaceApi } from "@/hooks/useHostWorkspace";
import { useSaveWorkspace } from "@/hooks/useSaveWorkspace";
import { useMediaStore } from "@/stores/media.store";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";

interface HotkeyOptions {
  host: HostWorkspaceApi;
}

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], .monaco-editor',
    ),
  );
}

/** Session-wide keyboard shortcuts (VS Code muscle memory). */
export function useRoomHotkeys({ host }: HotkeyOptions): void {
  const status = useRoomStore((state) => state.status);
  const saveWorkspace = useSaveWorkspace(host);

  useEffect(() => {
    if (status !== "admitted") return;
    let pushToTalk = false;
    let micStateBeforePushToTalk = false;

    const endPushToTalk = (): void => {
      if (!pushToTalk) return;
      pushToTalk = false;
      useMediaStore.getState().setMicEnabled(micStateBeforePushToTalk);
    };

    const followNext = (): void => {
      const { self, participants } = useRoomStore.getState();
      if (!self) return;
      const candidates = participants.filter(
        (entry) => entry.id !== self.id && entry.state === "ADMITTED",
      );
      if (candidates.length === 0) {
        toast.info("Nobody else is here to follow yet");
        return;
      }
      const ui = useUiStore.getState();
      const index = candidates.findIndex(
        (entry) => entry.id === ui.followingId,
      );
      const next = candidates[(index + 1) % candidates.length];
      ui.setFollowing(next.id);
      toast.message(`Following ${next.name}`, { duration: 1600 });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (modifier && key === "s") {
        event.preventDefault();
        saveWorkspace();
        return;
      }

      if (modifier && key === "b") {
        event.preventDefault();
        useUiStore.getState().toggleSidebar();
        return;
      }

      if (event.altKey && key === "f") {
        event.preventDefault();
        followNext();
        return;
      }

      if (event.key === "Escape") {
        if (useUiStore.getState().followingId) {
          useUiStore.getState().setFollowing(null);
        }
        return;
      }

      if (
        event.code === "Space" &&
        !event.repeat &&
        !modifier &&
        !event.altKey &&
        !isTextTarget(event.target)
      ) {
        const self = useRoomStore.getState().self;
        if (!self?.canSpeak) return;
        if (pushToTalk) return;
        pushToTalk = true;
        micStateBeforePushToTalk = useMediaStore.getState().micEnabled;
        event.preventDefault();
        useMediaStore.getState().setMicEnabled(true);
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== "Space" || !pushToTalk) return;
      event.preventDefault();
      endPushToTalk();
    };

    const onBlur = (): void => endPushToTalk();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      endPushToTalk();
    };
  }, [saveWorkspace, status]);
}
