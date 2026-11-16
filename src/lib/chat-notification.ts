import type { ChatMessage } from "./ws-protocol";

export interface ChatNotification {
  title: string;
  description: string;
}

const PREVIEW_LIMIT = 140;
const MAX_REMEMBERED_MESSAGES = 500;

export function chatNotificationFor(
  message: ChatMessage,
  selfId: string | null,
): ChatNotification | null {
  if (message.participantId === selfId) return null;
  const body = message.body.trim().replace(/\s+/g, " ");
  const description =
    body.length > PREVIEW_LIMIT
      ? `${body.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`
      : body;
  return {
    title: message.name || "New message",
    description: description || "Sent a message",
  };
}

export class ChatNotificationGate {
  private scope: string | null = null;
  private readonly seen = new Set<string>();

  reset(scope: string): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.seen.clear();
  }

  notificationFor(
    message: ChatMessage,
    selfId: string | null,
    scope: string,
  ): ChatNotification | null {
    this.reset(scope);
    if (this.seen.has(message.id)) return null;
    this.seen.add(message.id);
    if (this.seen.size > MAX_REMEMBERED_MESSAGES) {
      const oldest = this.seen.values().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    return chatNotificationFor(message, selfId);
  }
}
