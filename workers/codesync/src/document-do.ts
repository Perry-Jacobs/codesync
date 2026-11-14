import * as Y from "yjs";
import { base64ToBytes, bytesToBase64 } from "./crypto";

const SNAPSHOT_KEY = "yjs-snapshot";

interface ApplyBody {
  update?: string;
}

interface SeedBody {
  content?: string;
}

export class DocumentDurableObject {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/apply") {
        const body = (await request.json()) as ApplyBody;
        if (typeof body.update !== "string" || body.update.length === 0) {
          return jsonError(400, "INVALID_MESSAGE", "Missing Yjs update");
        }
        const update = body.update;
        return this.enqueue(async () => {
          const doc = await this.load();
          Y.applyUpdate(doc, base64ToBytes(update), "codesync");
          await this.persist(doc);
          return json({ ok: true });
        });
      }

      if (request.method === "POST" && url.pathname === "/seed") {
        const body = (await request.json()) as SeedBody;
        if (typeof body.content !== "string") {
          return jsonError(400, "INVALID_MESSAGE", "Missing document content");
        }
        const content = body.content;
        return this.enqueue(async () => {
          const doc = await this.load();
          const text = doc.getText("content");
          if (text.length === 0 && content.length > 0) {
            doc.transact(() => text.insert(0, content), "seed");
            await this.persist(doc);
          }
          return json({ ok: true, seeded: text.length > 0 });
        });
      }

      if (request.method === "GET" && url.pathname === "/snapshot") {
        return this.enqueue(async () => {
          const doc = await this.load();
          return json({ update: bytesToBase64(Y.encodeStateAsUpdate(doc)) });
        });
      }

      if (request.method === "GET" && url.pathname === "/diff") {
        const encodedVector = url.searchParams.get("stateVector");
        const vector = encodedVector ? base64ToBytes(encodedVector) : undefined;
        return this.enqueue(async () => {
          const doc = await this.load();
          const update = Y.encodeStateAsUpdate(
            doc,
            vector?.length ? vector : undefined,
          );
          return json({
            update: bytesToBase64(update),
            kind: vector?.length ? "diff" : "snapshot",
          });
        });
      }

      if (request.method === "GET" && url.pathname === "/text") {
        return this.enqueue(async () => {
          const doc = await this.load();
          return json({ content: doc.getText("content").toString() });
        });
      }

      if (request.method === "DELETE") {
        return this.enqueue(async () => {
          await this.state.storage.delete(SNAPSHOT_KEY);
          return json({ ok: true });
        });
      }

      return jsonError(404, "NOT_FOUND", "Document endpoint not found");
    } catch {
      return jsonError(500, "INTERNAL", "Document operation failed");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async load(): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const stored = await this.state.storage.get<ArrayBuffer>(SNAPSHOT_KEY);
    if (stored) Y.applyUpdate(doc, new Uint8Array(stored));
    return doc;
  }

  private async persist(doc: Y.Doc): Promise<void> {
    const snapshot = Y.encodeStateAsUpdate(doc);
    await this.state.storage.put(
      SNAPSHOT_KEY,
      snapshot.buffer.slice(
        snapshot.byteOffset,
        snapshot.byteOffset + snapshot.byteLength,
      ),
    );
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(status: number, code: string, message: string): Response {
  return json({ error: message, code }, status);
}
