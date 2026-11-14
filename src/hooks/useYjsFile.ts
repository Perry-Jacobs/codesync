'use client';

import { useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { useSession } from '@/components/providers/session-provider';
import { yjsBus } from '@/lib/buses';
import {
  acquireClientDoc,
  applyRemoteUpdate,
  encodeFullState,
  encodeStateVector,
  releaseClientDoc,
} from '@/lib/yjs/client';
import { useRoomStore } from '@/stores/room.store';

export interface YjsFileHandle {
  doc: Y.Doc | null;
  text: Y.Text | null;
  synced: boolean;
}

interface DocState {
  fileId: string;
  doc: Y.Doc;
}

/**
 * Owns the client-side Y.Doc for the active file:
 *  - restores cached state after tab switches
 *  - streams local edits to the gateway
 *  - asks for a state diff on every (re)connect so nothing is lost
 *  - applies remote updates off the shared bus
 */
export function useYjsFile(fileId: string | null): YjsFileHandle {
  const { send } = useSession();
  const status = useRoomStore((state) => state.status);
  const connection = useRoomStore((state) => state.connection);
  const [state, setState] = useState<DocState | null>(null);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!fileId) return;
    const doc = acquireClientDoc(fileId);
    setState({ fileId, doc });
    setSynced(false);
    return () => {
      releaseClientDoc(fileId);
    };
  }, [fileId]);

  const doc = state && state.fileId === fileId ? state.doc : null;
  const text = useMemo(() => doc?.getText('content') ?? null, [doc]);

  // Local edits -> gateway.
  useEffect(() => {
    if (!doc || !fileId) return;
    const onUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === 'remote') return;
      if (update.length <= 2) return;
      send('yjs_update', { fileId, update: toBase64(update) });
    };
    doc.on('update', onUpdate);
    return () => doc.off('update', onUpdate);
  }, [doc, fileId, send]);

  // Remote edits <- gateway.
  useEffect(() => {
    if (!doc || !fileId) return;
    return yjsBus.on((event) => {
      if (event.fileId !== fileId) return;
      applyRemoteUpdate(doc, event.update);
      setSynced(true);
    });
  }, [doc, fileId]);

  // Full state + diff request on first open and after every reconnect.
  useEffect(() => {
    if (!doc || !fileId) return;
    if (status !== 'admitted' || connection !== 'open') return;
    const full = encodeFullState(doc);
    if (full.length > 8) {
      send('yjs_update', { fileId, update: full });
    }
    send('yjs_sync_request', { fileId, stateVector: encodeStateVector(doc) });
  }, [doc, fileId, status, connection, send]);

  return { doc, text, synced };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
