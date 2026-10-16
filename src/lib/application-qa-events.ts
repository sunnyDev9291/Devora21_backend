import { EventEmitter } from "events";

/**
 * In-process pub/sub for Super Admin Application Q&A live updates (SSE).
 * One Node process = one hub (fine for single-instance deploy).
 */

export type ApplicationQaLiveEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted";

export type ApplicationQaLiveEvent =
  | {
      type: "session.created" | "session.updated";
      at: string;
      session: Record<string, unknown>;
    }
  | {
      type: "session.deleted";
      at: string;
      sessionId: string;
      userId?: string;
    };

const hub = new EventEmitter();
hub.setMaxListeners(100);

const RECENT_MAX = 40;
const recent: ApplicationQaLiveEvent[] = [];

export function publishApplicationQaEvent(
  event:
    | {
        type: "session.created" | "session.updated";
        session: Record<string, unknown>;
        at?: string;
      }
    | {
        type: "session.deleted";
        sessionId: string;
        userId?: string;
        at?: string;
      }
): void {
  const at = event.at ?? new Date().toISOString();
  const full: ApplicationQaLiveEvent =
    event.type === "session.deleted"
      ? {
          type: "session.deleted",
          at,
          sessionId: event.sessionId,
          ...(event.userId ? { userId: event.userId } : {}),
        }
      : {
          type: event.type,
          at,
          session: event.session,
        };

  recent.push(full);
  if (recent.length > RECENT_MAX) recent.shift();

  hub.emit("event", full);

  // Help diagnose “sync works but dashboard not live” (0 subscribers = FE not connected).
  if (hub.listenerCount("event") === 0) {
    // Avoid import cycle with logger — stderr is enough for ops.
    console.info(
      "[application-qa] live event published with 0 SSE subscribers:",
      full.type
    );
  }
}

export function getRecentApplicationQaEvents(
  limit = 20
): ApplicationQaLiveEvent[] {
  const n = Math.max(1, Math.min(RECENT_MAX, limit));
  return recent.slice(-n);
}

export function subscribeApplicationQaEvents(
  listener: (event: ApplicationQaLiveEvent) => void
): () => void {
  hub.on("event", listener);
  return () => {
    hub.off("event", listener);
  };
}

export function applicationQaSubscriberCount(): number {
  return hub.listenerCount("event");
}
