import { EventEmitter } from "events";

/**
 * In-process pub/sub for Super Admin Application Captures live updates (SSE).
 * One Node process = one hub (fine for single-instance deploy).
 */

export type ApplicationCaptureLiveEventType =
  | "session.created"
  | "session.updated"
  | "session.deleted"
  | "image.deleted"
  | "image.reviewed";

export type ApplicationCaptureLiveEvent =
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
    }
  | {
      type: "image.deleted";
      at: string;
      sessionId: string;
      imageId: string;
      userId?: string;
      /** Remaining session after delete; null if session was removed too. */
      session: Record<string, unknown> | null;
    }
  | {
      type: "image.reviewed";
      at: string;
      sessionId: string;
      imageId: string;
      userId?: string;
      session: Record<string, unknown>;
    };

const hub = new EventEmitter();
hub.setMaxListeners(100);

const RECENT_MAX = 40;
const recent: ApplicationCaptureLiveEvent[] = [];

export function publishApplicationCaptureEvent(
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
    | {
        type: "image.deleted";
        sessionId: string;
        imageId: string;
        userId?: string;
        session: Record<string, unknown> | null;
        at?: string;
      }
    | {
        type: "image.reviewed";
        sessionId: string;
        imageId: string;
        userId?: string;
        session: Record<string, unknown>;
        at?: string;
      }
): void {
  const at = event.at ?? new Date().toISOString();
  const full: ApplicationCaptureLiveEvent =
    event.type === "session.deleted"
      ? {
          type: "session.deleted",
          at,
          sessionId: event.sessionId,
          ...(event.userId ? { userId: event.userId } : {}),
        }
      : event.type === "image.deleted"
        ? {
            type: "image.deleted",
            at,
            sessionId: event.sessionId,
            imageId: event.imageId,
            session: event.session,
            ...(event.userId ? { userId: event.userId } : {}),
          }
        : event.type === "image.reviewed"
          ? {
              type: "image.reviewed",
              at,
              sessionId: event.sessionId,
              imageId: event.imageId,
              session: event.session,
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
      "[application-captures] live event published with 0 SSE subscribers:",
      full.type
    );
  }
}

export function getRecentApplicationCaptureEvents(
  limit = 20
): ApplicationCaptureLiveEvent[] {
  const n = Math.max(1, Math.min(RECENT_MAX, limit));
  return recent.slice(-n);
}

export function subscribeApplicationCaptureEvents(
  listener: (event: ApplicationCaptureLiveEvent) => void
): () => void {
  hub.on("event", listener);
  return () => {
    hub.off("event", listener);
  };
}

export function applicationCaptureSubscriberCount(): number {
  return hub.listenerCount("event");
}
