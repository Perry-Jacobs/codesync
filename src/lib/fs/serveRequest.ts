"use client";

import type {
  ClientPayloads,
  ClientType,
  ServerPayloads,
} from "@/lib/ws-protocol";
import type { DirHandleLike } from "./types";
import {
  createEntry,
  removeEntry,
  renameEntry,
  writeTextFile,
  readTextFile,
} from "./hostFs";

type Responder = <K extends ClientType>(
  type: K,
  data: ClientPayloads[K],
) => void;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Filesystem operation failed";
}

/** Executes one gateway filesystem request against the host's real folder. */
export async function serveFsRequest(
  root: DirHandleLike | null,
  request: ServerPayloads["fs_request"],
  send: Responder,
): Promise<void> {
  if (!root) {
    send("fs_ack", {
      requestId: request.requestId,
      ok: false,
      error: "The host folder is not connected",
      fileId: request.fileId,
      path: request.path,
    });
    return;
  }

  const fail = (error: unknown): void => {
    send("fs_ack", {
      requestId: request.requestId,
      ok: false,
      error: messageOf(error),
      fileId: request.fileId,
      path: request.path,
    });
  };

  try {
    switch (request.op) {
      case "read": {
        if (!request.fileId) {
          fail(new Error("Read request is missing the file id"));
          return;
        }
        const content = await readTextFile(root, request.path);
        send("fs_file_content", {
          requestId: request.requestId,
          fileId: request.fileId,
          content,
          mtime: Date.now(),
        });
        return;
      }
      case "write": {
        await writeTextFile(root, request.path, request.content ?? "");
        send("fs_ack", {
          requestId: request.requestId,
          ok: true,
          fileId: request.fileId,
          path: request.path,
        });
        return;
      }
      case "create":
      case "mkdir": {
        await createEntry(
          root,
          request.path,
          request.op === "mkdir" ? "dir" : "file",
        );
        send("fs_ack", {
          requestId: request.requestId,
          ok: true,
          path: request.path,
        });
        return;
      }
      case "delete": {
        await removeEntry(root, request.path);
        send("fs_ack", {
          requestId: request.requestId,
          ok: true,
          path: request.path,
        });
        return;
      }
      case "rename": {
        if (!request.toPath) {
          fail(new Error("Rename request is missing the destination"));
          return;
        }
        await renameEntry(root, request.path, request.toPath);
        send("fs_ack", {
          requestId: request.requestId,
          ok: true,
          path: request.toPath,
        });
        return;
      }
      default:
        fail(new Error("Unsupported filesystem operation"));
    }
  } catch (error) {
    fail(error);
  }
}
