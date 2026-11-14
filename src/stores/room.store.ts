"use client";

import { create } from "zustand";
import type { ChatMessage, Participant, RoomSnapshot } from "@/lib/ws-protocol";
import type { ConnectionStatus } from "@/lib/socket/roomSocketClient";

export type RoomUiStatus =
  | "idle"
  | "joining"
  | "waiting"
  | "admitted"
  | "denied"
  | "kicked"
  | "ended"
  | "error";

interface RoomState {
  room: RoomSnapshot | null;
  self: Participant | null;
  participants: Participant[];
  waiting: Participant[];
  chat: ChatMessage[];
  status: RoomUiStatus;
  connection: ConnectionStatus;
  error: string | null;
  reconnectToken: string | null;
  /** Incremented whenever a session scope changes, so room-scoped consumers can re-isolate. */
  sessionEpoch: number;
  applyRoomState(payload: {
    room: RoomSnapshot;
    self: Participant;
    participants: Participant[];
    waiting: Participant[];
    chat: ChatMessage[];
  }): void;
  upsertParticipant(participant: Participant): void;
  removeParticipant(participantId: string): void;
  setWaiting(waiting: Participant[]): void;
  addChatMessage(message: ChatMessage): void;
  setRoomPatch(patch: Partial<RoomSnapshot>): void;
  applyPermission(payload: {
    participantId: string;
    role: Participant["role"];
    canEdit: boolean;
    canSpeak: boolean;
  }): void;
  setStatus(status: RoomUiStatus): void;
  setConnection(connection: ConnectionStatus): void;
  setError(error: string | null): void;
  setReconnectToken(token: string | null): void;
  reset(): void;
}

const initial = {
  room: null,
  self: null,
  participants: [],
  waiting: [],
  chat: [],
  status: "idle" as RoomUiStatus,
  connection: "idle" as ConnectionStatus,
  error: null,
  reconnectToken: null,
  sessionEpoch: 0,
};

export const useRoomStore = create<RoomState>((set) => ({
  ...initial,

  applyRoomState: (payload) =>
    set({
      room: payload.room,
      self: payload.self,
      participants: payload.participants,
      waiting: payload.waiting,
      chat: payload.chat,
      error: null,
      // `room_state` describes the room before the server has finished the
      // join handshake. Only the authoritative `admitted` message may expose
      // the room as admitted; otherwise startup effects can send while the
      // socket client is still waiting for admission.
      status: payload.self.state === "WAITING" ? "waiting" : "joining",
    }),

  upsertParticipant: (participant) =>
    set((state) => {
      const exists = state.participants.some(
        (entry) => entry.id === participant.id,
      );
      const participants = exists
        ? state.participants.map((entry) =>
            entry.id === participant.id ? participant : entry,
          )
        : [...state.participants, participant];
      const self = state.self?.id === participant.id ? participant : state.self;
      return { participants, self };
    }),

  removeParticipant: (participantId) =>
    set((state) => ({
      participants: state.participants.filter(
        (entry) => entry.id !== participantId,
      ),
      waiting: state.waiting.filter((entry) => entry.id !== participantId),
    })),

  setWaiting: (waiting) => set({ waiting }),

  addChatMessage: (message) =>
    set((state) => {
      if (state.chat.some((entry) => entry.id === message.id)) return state;
      return { chat: [...state.chat, message].slice(-300) };
    }),

  setRoomPatch: (patch) =>
    set((state) =>
      state.room ? { room: { ...state.room, ...patch } } : state,
    ),

  applyPermission: ({ participantId, role, canEdit, canSpeak }) =>
    set((state) => {
      const apply = (entry: Participant): Participant =>
        entry.id === participantId
          ? { ...entry, role, canEdit, canSpeak }
          : entry;
      return {
        participants: state.participants.map(apply),
        self: state.self ? apply(state.self) : null,
      };
    }),

  setStatus: (status) => set({ status }),
  setConnection: (connection) => set({ connection }),
  // Terminal status is owned by the server message handlers; an error string
  // must never overwrite "denied"/"kicked"/"ended".
  setError: (error) => set({ error }),
  setReconnectToken: (reconnectToken) => set({ reconnectToken }),

  reset: () =>
    set((state) => ({
      ...initial,
      sessionEpoch: state.sessionEpoch + 1,
    })),
}));
