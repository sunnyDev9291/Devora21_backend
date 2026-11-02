import { EventEmitter } from "events";

/**
 * In-process pub/sub for Super Admin rrweb session live updates (SSE).
 */

export type RrwebLiveEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "session.reviewed";

export type RrwebLiveEvent =
  | {
      type: "session.created" | "session.updated" | "session.reviewed";
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
const recent: RrwebLiveEvent[] = [];

export function publishRrwebSessionEvent(
  event:
    | {
        type: "session.created" | "session.updated" | "session.reviewed";
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
  const full: RrwebLiveEvent =
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

  if (hub.listenerCount("event") === 0) {
    console.info(
      "[rrweb-sessions] live event published with 0 SSE subscribers:",
      full.type
    );
  }
}

export function getRecentRrwebSessionEvents(limit = 20): RrwebLiveEvent[] {
  const n = Math.max(1, Math.min(RECENT_MAX, limit));
  return recent.slice(-n);
}

export function subscribeRrwebSessionEvents(
  listener: (event: RrwebLiveEvent) => void
): () => void {
  hub.on("event", listener);
  return () => {
    hub.off("event", listener);
  };
}

export function rrwebSessionSubscriberCount(): number {
  return hub.listenerCount("event");
}
