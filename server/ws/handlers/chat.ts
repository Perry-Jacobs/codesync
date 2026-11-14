import { nanoid } from "nanoid";
import type { ClientPayloads, ChatMessage } from "@/lib/ws-protocol";
import { canScreenShare, hasCapability } from "@/lib/acl";
import { appendChat, updateParticipant } from "../../rooms/repository";
import { emit, refreshSocketParticipant } from "../broadcast";
import type { SocketContext } from "../connection";
import { requireRoom } from "./code";
import { WsError } from "../../errors";
import { toWireParticipant } from "../../rooms/types";

export async function handleChatSend(
  ctx: SocketContext,
  data: ClientPayloads["chat_send"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  if (!hasCapability(participant, "chat")) {
    throw new WsError("FORBIDDEN", "You cannot send messages in this room");
  }
  const message: ChatMessage = {
    id: `c_${nanoid(12)}`,
    participantId: participant.id,
    name: participant.name,
    body: data.body,
    at: Date.now(),
    clientMsgId: data.clientMsgId,
  };
  await appendChat(room.id, message);
  emit(room.id, "chat_message", { message }, {});
}

export async function handleRaiseHand(
  ctx: SocketContext,
  data: ClientPayloads["raise_hand"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  const next = await updateParticipant(
    room.id,
    participant.id,
    { handRaised: data.raised },
    { requireSocketId: ctx.id },
  );
  if (!next) throw new WsError("CONFLICT", "Participant no longer exists");
  ctx.participant = next;
  emit(
    room.id,
    "participant_updated",
    { participant: toWireParticipant(next) },
    {},
  );
}

export async function handleReaction(
  ctx: SocketContext,
  data: ClientPayloads["reaction"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);
  emit(
    room.id,
    "reaction",
    { participantId: participant.id, emoji: data.emoji },
    {},
  );
}

export async function handleMediaState(
  ctx: SocketContext,
  data: ClientPayloads["media_state"],
): Promise<void> {
  const { room, participant } = await requireRoom(ctx);

  const speakAllowed = hasCapability(participant, "speak");
  const screenAllowed = canScreenShare(participant, room.allowGuestScreenShare);

  if (data.mic && !speakAllowed) {
    ctx.send("error", {
      code: "FORBIDDEN",
      message: "The host has not granted you speak permission",
    });
  }
  if (data.screen && !screenAllowed) {
    ctx.send("error", {
      code: "FORBIDDEN",
      message: "Screen sharing is limited to the host and co-hosts",
    });
  }

  const next = await updateParticipant(
    room.id,
    participant.id,
    {
      mic: data.mic && speakAllowed,
      cam: data.cam,
      screen: data.screen && screenAllowed,
    },
    { requireSocketId: ctx.id },
  );
  if (!next) throw new WsError("CONFLICT", "Participant no longer exists");
  ctx.participant = next;
  refreshSocketParticipant(room.id, next);
  emit(
    room.id,
    "participant_updated",
    { participant: toWireParticipant(next) },
    {},
  );
}
