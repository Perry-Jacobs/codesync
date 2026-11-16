"use client";

import { useEffect, useRef, useState } from "react";
import { Hand, SendHorizontal, Smile } from "lucide-react";
import { nanoid } from "nanoid";
import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { hasCapability } from "@/lib/acl";
import { cn, initials } from "@/lib/utils";
import { REACTION_EMOJIS } from "@/lib/ws-protocol";
import { safeParticipantColor } from "@/utils/color";
import { useRoomStore } from "@/stores/room.store";
import { useUiStore } from "@/stores/ui.store";

interface ChatPanelProps {
  variant?: "desktop" | "drawer";
}

export function ChatPanel({ variant = "desktop" }: ChatPanelProps) {
  const { send } = useSession();
  const chat = useRoomStore((state) => state.chat);
  const self = useRoomStore((state) => state.self);
  const clearUnread = useUiStore((state) => state.clearUnread);
  const chatVisible = useUiStore(
    (state) => state.sidePanelTab === "chat" && state.railVisible,
  );
  const [body, setBody] = useState("");
  const [showReactions, setShowReactions] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const pendingChat = useRef<{ clientMsgId: string; body: string } | null>(
    null,
  );
  const canChat = hasCapability(self, "chat");
  // ChatPanel can stay mounted behind a closed compact drawer. Reopening the
  // rail must not erase the badge for messages that arrived while it was
  // hidden, so only clear when the message list grows while chat is on screen.
  const knownLength = useRef(chat.length);

  useEffect(() => {
    const grew = chat.length > knownLength.current;
    knownLength.current = chat.length;
    if (grew && chatVisible && nearBottom) clearUnread();
  }, [chat.length, chatVisible, clearUnread, nearBottom]);

  useEffect(() => {
    const pending = pendingChat.current;
    if (!pending) return;
    const acknowledged = chat.some(
      (message) => message.clientMsgId === pending.clientMsgId,
    );
    if (!acknowledged) return;
    pendingChat.current = null;
    setBody((current) => (current === pending.body ? "" : current));
  }, [chat]);

  useEffect(() => {
    if (nearBottom) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      setUnseenMessages((count) => count + 1);
    }
  }, [chat.length, nearBottom]);

  const scrollToLatest = (): void => {
    setNearBottom(true);
    setUnseenMessages(0);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const submit = (): void => {
    const trimmed = body.trim();
    if (!trimmed || !canChat) return;
    const clientMsgId = nanoid(10);
    pendingChat.current = { clientMsgId, body: trimmed };
    send("chat_send", { body: trimmed, clientMsgId });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-border">
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 px-3",
          variant === "drawer" ? "h-12" : "h-9",
        )}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Session chat
        </span>
        <div className="ml-auto flex items-center gap-1">
          {self && !self.canSpeak ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-pressed={self.handRaised}
              className={cn(
                variant === "drawer" ? "h-8 w-8" : "h-6 w-6",
                self.handRaised &&
                  "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 hover:text-amber-500 dark:text-amber-300 dark:hover:text-amber-200",
              )}
              onClick={() => send("raise_hand", { raised: !self.handRaised })}
              title={self.handRaised ? "Lower hand" : "Raise hand"}
              aria-label={self.handRaised ? "Lower hand" : "Raise hand"}
            >
              <Hand className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            className={variant === "drawer" ? "h-8 w-8" : "h-6 w-6"}
            onClick={() => setShowReactions((value) => !value)}
            title="Reactions"
          >
            <Smile className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {unseenMessages > 0 ? (
          <Button
            size="sm"
            variant="secondary"
            className="absolute bottom-2 left-1/2 z-10 h-7 -translate-x-1/2 rounded-full text-[10px] shadow-lg"
            onClick={scrollToLatest}
          >
            {unseenMessages} new {unseenMessages === 1 ? "message" : "messages"}
          </Button>
        ) : null}
        <div
          ref={scrollRef}
          className={cn(
            "scrollbar-thin h-full overflow-y-auto",
            variant === "drawer"
              ? "space-y-4 px-4 pb-3"
              : "space-y-3 px-3 pb-2",
          )}
          onScroll={(event) => {
            const element = event.currentTarget;
            const atBottom =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              48;
            setNearBottom(atBottom);
            if (atBottom) setUnseenMessages(0);
          }}
        >
          {chat.length === 0 ? (
            <p className="py-8 text-center text-[11px] leading-relaxed text-muted-foreground">
              No messages yet.
              <br />
              Say hi — or paste a snippet.
            </p>
          ) : (
            chat.map((message) => {
              const author = useRoomStore
                .getState()
                .participants.find(
                  (entry) => entry.id === message.participantId,
                );
              const mine = message.participantId === self?.id;
              return (
                <div
                  key={message.id}
                  className={cn("flex gap-2", mine && "flex-row-reverse")}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex shrink-0 items-center justify-center rounded-full font-semibold",
                      variant === "drawer"
                        ? "h-8 w-8 text-[11px]"
                        : "h-6 w-6 text-[9px]",
                    )}
                    style={{
                      backgroundColor: `${safeParticipantColor(author?.color)}26`,
                      color: safeParticipantColor(author?.color),
                    }}
                  >
                    {initials(message.name)}
                  </span>
                  <div className={cn("min-w-0 flex-1", mine && "text-right")}>
                    <div
                      className={cn(
                        "flex items-baseline gap-2",
                        mine && "justify-end",
                      )}
                    >
                      <span
                        className={cn(
                          "truncate font-medium text-foreground",
                          variant === "drawer" ? "text-sm" : "text-[11px]",
                        )}
                      >
                        {mine ? "You" : message.name}
                      </span>
                      <span
                        className={cn(
                          "text-muted-foreground",
                          variant === "drawer" ? "text-[10px]" : "text-[9px]",
                        )}
                      >
                        {new Date(message.at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <p
                      className={cn(
                        "mt-1 inline-block max-w-full whitespace-pre-wrap break-words rounded-lg text-left leading-relaxed",
                        variant === "drawer"
                          ? "px-3 py-2 text-sm"
                          : "px-2.5 py-1.5 text-xs",
                        mine
                          ? "bg-primary/15 text-foreground"
                          : "bg-white/5 text-foreground/90",
                      )}
                    >
                      {message.body}
                    </p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={endRef} />
        </div>
      </div>

      {showReactions ? (
        <div className="flex items-center gap-1 px-3 pb-1">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="rounded-md px-1.5 py-0.5 text-sm transition-transform hover:scale-125"
              onClick={() => {
                send("reaction", { emoji });
                setShowReactions(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          "border-t border-border",
          variant === "drawer" ? "p-3" : "p-2",
        )}
      >
        <div
          className={cn(
            "flex items-end gap-1.5 rounded-lg border border-border bg-card focus-within:ring-1 focus-within:ring-primary/40",
            variant === "drawer" ? "px-3 py-2" : "px-2 py-1.5",
          )}
        >
          <textarea
            value={body}
            rows={1}
            maxLength={2000}
            disabled={!canChat}
            placeholder={
              canChat ? "Message the session…" : "Chat is disabled for guests"
            }
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className={cn(
              "scrollbar-thin flex-1 resize-none bg-transparent text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
              variant === "drawer"
                ? "max-h-32 min-h-[28px] text-sm"
                : "max-h-28 min-h-[20px] text-xs",
            )}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            className={
              variant === "drawer" ? "h-8 w-8 shrink-0" : "h-6 w-6 shrink-0"
            }
            onClick={submit}
            disabled={!canChat || body.trim().length === 0}
            aria-label="Send message"
          >
            <SendHorizontal className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p
          className={cn(
            "mt-1 px-1 text-muted-foreground",
            variant === "drawer" ? "text-[10px]" : "text-[9px]",
          )}
        >
          Enter sends · Shift+Enter adds a line · hold Space to talk
        </p>
      </div>
    </section>
  );
}
