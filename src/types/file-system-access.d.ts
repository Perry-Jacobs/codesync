export {};

declare global {
  interface Window {
    /** Chrome/Edge only; deliberately not in lib.dom. */
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}
