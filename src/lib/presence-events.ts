import type { CodeRange, ServerMessage } from "./ws-protocol";

export type PresenceEvent =
  | {
      kind: "cursor";
      participantId: string;
      fileId: string;
      line: number;
      column: number;
      topLine?: number;
    }
  | {
      kind: "selection";
      participantId: string;
      fileId: string;
      ranges: CodeRange[];
    }
  | { kind: "viewport"; participantId: string; fileId: string; topLine: number }
  | { kind: "clear-participant"; participantId: string }
  | { kind: "clear-all" };

export type PresenceMessage = Extract<
  ServerMessage,
  { type: "cursor" | "selection" | "viewport" }
>;

/** Translates the wire presence messages into the editor's cursor bus shape. */
export function toPresenceEvent(message: PresenceMessage): PresenceEvent {
  if (message.type === "cursor") {
    return {
      kind: "cursor",
      participantId: message.data.participantId,
      fileId: message.data.fileId,
      line: message.data.line,
      column: message.data.column,
      topLine: message.data.topLine,
    };
  }
  if (message.type === "selection") {
    return {
      kind: "selection",
      participantId: message.data.participantId,
      fileId: message.data.fileId,
      ranges: message.data.ranges,
    };
  }
  return {
    kind: "viewport",
    participantId: message.data.participantId,
    fileId: message.data.fileId,
    topLine: message.data.topLine,
  };
}
