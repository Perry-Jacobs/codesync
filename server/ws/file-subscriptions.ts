export type RoomFileSubscriptions = Map<string, Map<string, Set<string>>>;

export function addFileSubscription(
  subscriptions: RoomFileSubscriptions,
  roomId: string,
  fileId: string,
  socketId: string,
): boolean {
  let files = subscriptions.get(roomId);
  if (!files) {
    files = new Map();
    subscriptions.set(roomId, files);
  }
  let subscribers = files.get(fileId);
  if (!subscribers) {
    subscribers = new Set();
    files.set(fileId, subscribers);
  }
  const added = !subscribers.has(socketId);
  subscribers.add(socketId);
  return added;
}

export function removeFileSubscription(
  subscriptions: RoomFileSubscriptions,
  roomId: string,
  fileId: string,
  socketId: string,
): boolean {
  const files = subscriptions.get(roomId);
  const subscribers = files?.get(fileId);
  if (!files || !subscribers || !subscribers.delete(socketId)) return false;
  if (subscribers.size === 0) files.delete(fileId);
  if (files.size === 0) subscriptions.delete(roomId);
  return true;
}

export function clearFileSubscriptions(
  subscriptions: RoomFileSubscriptions,
  roomId: string,
  fileId: string,
): string[] {
  const files = subscriptions.get(roomId);
  const subscribers = files?.get(fileId);
  if (!files || !subscribers) return [];
  files.delete(fileId);
  if (files.size === 0) subscriptions.delete(roomId);
  return [...subscribers];
}

export function removeSocketSubscriptions(
  subscriptions: RoomFileSubscriptions,
  roomId: string,
  socketId: string,
): string[] {
  const files = subscriptions.get(roomId);
  if (!files) return [];
  const removed: string[] = [];
  for (const [fileId, subscribers] of files) {
    if (!subscribers.delete(socketId)) continue;
    removed.push(fileId);
    if (subscribers.size === 0) files.delete(fileId);
  }
  if (files.size === 0) subscriptions.delete(roomId);
  return removed;
}
