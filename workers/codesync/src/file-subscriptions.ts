export function addFileSubscription(files: string[], fileId: string): void {
  if (!files.includes(fileId)) files.push(fileId);
}

export function removeFileSubscription(files: string[], fileId: string): void {
  const index = files.indexOf(fileId);
  if (index >= 0) files.splice(index, 1);
}

export function clearFileSubscriptions(files: string[]): void {
  files.length = 0;
}
