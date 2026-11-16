export function hasDifferentLiveSocket(
  currentSocketId: string | null,
  closingSocketId: string,
): boolean {
  return currentSocketId !== null && currentSocketId !== closingSocketId;
}
