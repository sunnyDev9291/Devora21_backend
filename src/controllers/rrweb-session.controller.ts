import { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { isSuperAdminUser } from "../config/env";
import { logger } from "../lib/logger";
import {
  getRecentRrwebSessionEvents,
  subscribeRrwebSessionEvents,
  rrwebSessionSubscriberCount,
  type RrwebLiveEvent,
} from "../lib/rrweb-session-events";
import {
  consumeRrwebSessionStreamTicket,
  issueRrwebSessionStreamTicket,
} from "../lib/rrweb-session-stream-ticket";
import * as authService from "../services/auth.service";
import * as rrwebService from "../services/rrweb-session.service";
import type {
  AppendRrwebEventsInput,
  CompleteRrwebSessionInput,
  StartRrwebSessionInput,
} from "../validators/rrweb-session.validator";

/**
 * Resolve ?ticket= from POST /admin/rrweb-sessions/stream-ticket.
 * Must run before requireAuth on the admin router.
 */
export async function acceptRrwebSessionStreamTicket(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (req.authUser?.id) {
      next();
      return;
    }
    const raw = req.query.ticket;
    if (typeof raw !== "string" || !raw.trim()) {
      next();
      return;
    }
    const rec = consumeRrwebSessionStreamTicket(raw);
    if (!rec) {
      next();
      return;
    }
    const user = await authService.findUserById(rec.userId);
    if (!user) {
      next();
      return;
    }
    req.authMethod = "session";
    req.authUser = {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      resumeBuilderEnabled: user.resumeBuilderEnabled,
      isSuperAdmin: isSuperAdminUser(user),
    };
    next();
  } catch {
    next();
  }
}

function flushSse(res: Response): void {
  const anyRes = res as Response & { flush?: () => void };
  if (typeof anyRes.flush === "function") {
    anyRes.flush();
  }
}

function writeSse(res: Response, eventName: string, data: unknown): void {
  let payload: Record<string, unknown>;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    payload = { ...(data as Record<string, unknown>), type: eventName };
    const callerType = (data as { type?: string }).type;
    if (callerType) payload.type = callerType;
  } else {
    payload = { type: eventName, data };
  }
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushSse(res);
}

function queryString(req: AuthenticatedRequest, ...keys: string[]): string {
  for (const k of keys) {
    const v = req.query[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export async function startRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.startRrwebSession(
      req.authUser!.id,
      req.body as StartRrwebSessionInput
    );
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function appendRrwebEventsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.appendRrwebEvents(
      req.authUser!.id,
      String(req.params.id),
      req.body as AppendRrwebEventsInput
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function completeRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.completeRrwebSession(
      req.authUser!.id,
      String(req.params.id),
      req.body as CompleteRrwebSessionInput
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function listOwnRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.listOwnRrwebSessions(req.authUser!.id, {
      page: parsePositiveInt(req.query.page, 1),
      limit: Math.min(100, parsePositiveInt(req.query.limit, 20)),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getOwnRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const includeEvents =
      req.query.includeEvents === "1" || req.query.includeEvents === "true";
    const result = await rrwebService.getOwnRrwebSession(
      req.authUser!.id,
      String(req.params.id),
      { includeEvents }
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteOwnRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.deleteOwnRrwebSession(
      req.authUser!.id,
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminListRrwebOwnersHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    void req;
    res.json(await rrwebService.adminListRrwebOwners());
  } catch (err) {
    next(err);
  }
}

export async function adminListRrwebSessionsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.adminListRrwebSessions({
      userId: queryString(req, "userId", "user_id") || undefined,
      q: queryString(req, "q") || undefined,
      date: queryString(req, "date", "day") || undefined,
      timezone: queryString(req, "timezone", "tz") || undefined,
      page: parsePositiveInt(req.query.page, 1),
      limit: Math.min(100, parsePositiveInt(req.query.limit, 25)),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminStreamRrwebTicketHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.isSuperAdmin) {
      throw new AppError(403, "Super Admin access required");
    }
    const issued = issueRrwebSessionStreamTicket({
      id: req.authUser.id,
      email: req.authUser.email,
    });
    res.json({
      ok: true,
      ticket: issued.ticket,
      expiresIn: issued.expiresIn,
      streamPath: `/admin/rrweb-sessions/stream?ticket=${issued.ticket}`,
    });
  } catch (err) {
    next(err);
  }
}

export async function adminStreamRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.isSuperAdmin) {
      throw new AppError(403, "Super Admin access required");
    }

    req.socket.setTimeout(0);
    res.setTimeout(0);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    logger.info("rrweb-sessions", "SSE client connected", {
      userId: req.authUser.id,
      subscribers: rrwebSessionSubscriberCount() + 1,
    });

    writeSse(res, "ready", {
      ok: true,
      at: new Date().toISOString(),
      subscribers: rrwebSessionSubscriberCount() + 1,
    });

    for (const ev of getRecentRrwebSessionEvents(25)) {
      writeSse(res, ev.type, ev);
    }

    const onEvent = (ev: RrwebLiveEvent) => {
      try {
        writeSse(res, ev.type, ev);
      } catch {
        // client gone
      }
    };
    const unsubscribe = subscribeRrwebSessionEvents(onEvent);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${new Date().toISOString()}\n\n`);
        flushSse(res);
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      logger.info("rrweb-sessions", "SSE client disconnected", {
        userId: req.authUser?.id,
        subscribers: rrwebSessionSubscriberCount(),
      });
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  } catch (err) {
    next(err);
  }
}

export async function adminGetRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const includeEvents =
      req.query.includeEvents === "1" || req.query.includeEvents === "true";
    const result = await rrwebService.adminGetRrwebSession(
      String(req.params.id),
      { includeEvents }
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /admin/rrweb-sessions/:id/events
 * Proxies B2 payload (avoids browser CORS → "Failed to fetch").
 * Streams bytes through — does not wait to buffer the whole object first.
 */
export async function adminGetRrwebEventsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { stream, contentLength, encoding, filename } =
      await rrwebService.adminOpenRrwebEventsStream(String(req.params.id));

    res.setHeader(
      "Content-Type",
      encoding === "gzip" ? "application/gzip" : "application/json; charset=utf-8"
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${filename}"`
    );
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Events-Encoding", encoding);
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Events-Encoding, Content-Type, Content-Length"
    );
    if (typeof contentLength === "number" && contentLength > 0) {
      res.setHeader("Content-Length", String(contentLength));
    }
    res.status(200);

    stream.on("error", (err) => {
      logger.error(
        "rrweb-events",
        `stream failed: ${err instanceof Error ? err.message : err}`
      );
      if (!res.headersSent) {
        next(err);
        return;
      }
      res.destroy(err instanceof Error ? err : undefined);
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

export async function adminDeleteRrwebHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.adminDeleteRrwebSession(
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminMarkRrwebReviewedHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await rrwebService.adminMarkRrwebSessionReviewed(
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}
