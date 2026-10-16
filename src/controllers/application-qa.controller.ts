import { Response, NextFunction, Request } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import {
  getRecentApplicationQaEvents,
  subscribeApplicationQaEvents,
  applicationQaSubscriberCount,
  type ApplicationQaLiveEvent,
} from "../lib/application-qa-events";
import {
  consumeApplicationQaStreamTicket,
  issueApplicationQaStreamTicket,
} from "../lib/application-qa-stream-ticket";
import { isSuperAdminUser } from "../config/env";
import { logger } from "../lib/logger";
import * as authService from "../services/auth.service";
import * as qaService from "../services/application-qa.service";
import type {
  PatchApplicationQaSessionInput,
  SyncApplicationQaInput,
} from "../validators/application-qa.validator";

/**
 * EventSource cannot set Authorization headers. Allow ?access_token= / ?token=
 * (JWT or session cookie still preferred when withCredentials works).
 */
export function acceptQueryAccessToken(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.headers.authorization) {
    const q = req.query.access_token || req.query.token;
    if (typeof q === "string" && q.trim()) {
      req.headers.authorization = `Bearer ${q.trim()}`;
    }
  }
  next();
}

/**
 * Resolve ?ticket= from POST /admin/application-qa/stream-ticket into req.authUser.
 * Must run before requireAuth on the SSE route (or globally before requireAuth).
 */
export async function acceptApplicationQaStreamTicket(
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
    const rec = consumeApplicationQaStreamTicket(raw);
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

/** Named SSE event + default `message` (payload always includes `type`). */
function writeSse(res: Response, eventName: string, data: unknown): void {
  let payload: Record<string, unknown>;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    payload = { ...(data as Record<string, unknown>), type: eventName };
    // Prefer caller's type when present (session.created / session.updated / …).
    const callerType = (data as { type?: string }).type;
    if (callerType) payload.type = callerType;
  } else {
    payload = { type: eventName, data };
  }
  const json = JSON.stringify(payload);
  res.write(`event: ${payload.type}\ndata: ${json}\n\n`);
  // Also emit as default message so `es.onmessage` / fetch parsers work.
  res.write(`data: ${json}\n\n`);
  flushSse(res);
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export async function extensionMeHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) throw new AppError(401, "Authentication required");
    res.json({
      user: {
        id: req.authUser.id,
        email: req.authUser.email,
        isSuperAdmin: req.authUser.isSuperAdmin,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function syncApplicationQaHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) throw new AppError(401, "Authentication required");
    const result = await qaService.syncApplicationQa(
      req.authUser.id,
      req.body as SyncApplicationQaInput
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listOwnSessionsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) throw new AppError(401, "Authentication required");
    const result = await qaService.listOwnSessions(req.authUser.id, {
      page: parsePositiveInt(req.query.page, 1),
      limit: Math.min(100, parsePositiveInt(req.query.limit, 25)),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getOwnSessionHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) throw new AppError(401, "Authentication required");
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Session id is required");
    const result = await qaService.getOwnSession(req.authUser.id, id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function patchOwnSessionHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) throw new AppError(401, "Authentication required");
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Session id is required");
    const result = await qaService.patchOwnSession(
      req.authUser.id,
      id,
      req.body as PatchApplicationQaSessionInput
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteOwnSessionHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) throw new AppError(401, "Authentication required");
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Session id is required");
    const result = await qaService.deleteOwnSession(req.authUser.id, id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminListQaOwnersHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    void req;
    res.json(await qaService.adminListOwners());
  } catch (err) {
    next(err);
  }
}

/**
 * Issue a short-lived ticket for EventSource auth.
 * POST /admin/application-qa/stream-ticket
 */
export async function adminStreamQaTicketHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.isSuperAdmin) {
      throw new AppError(403, "Super Admin access required");
    }
    const issued = issueApplicationQaStreamTicket({
      id: req.authUser.id,
      email: req.authUser.email,
    });
    res.json({
      ok: true,
      ticket: issued.ticket,
      expiresIn: issued.expiresIn,
      streamPath: `/admin/application-qa/stream?ticket=${issued.ticket}`,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Super Admin SSE: live Application Q&A session create/update/delete.
 * GET /admin/application-qa/stream
 *
 * Auth (any one):
 * - Cookie session + credentials
 * - Authorization: Bearer <jwt|apiKey> (works with fetch streaming)
 * - ?access_token= / ?token=
 * - ?ticket= from POST /stream-ticket
 */
export async function adminStreamQaHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.isSuperAdmin) {
      throw new AppError(403, "Super Admin access required");
    }

    // Prevent proxies / Node from timing out a long-lived stream.
    req.socket.setTimeout(0);
    res.setTimeout(0);

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    logger.info("application-qa", "SSE client connected", {
      userId: req.authUser.id,
      subscribers: applicationQaSubscriberCount() + 1,
    });

    writeSse(res, "ready", {
      ok: true,
      at: new Date().toISOString(),
      subscribers: applicationQaSubscriberCount() + 1,
    });

    // Replay recent buffer so a mid-session open still sees latest activity.
    for (const ev of getRecentApplicationQaEvents(25)) {
      writeSse(res, ev.type, ev);
    }

    const onEvent = (ev: ApplicationQaLiveEvent) => {
      try {
        writeSse(res, ev.type, ev);
      } catch {
        // client gone
      }
    };
    const unsubscribe = subscribeApplicationQaEvents(onEvent);

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
      logger.info("application-qa", "SSE client disconnected", {
        userId: req.authUser?.id,
        subscribers: applicationQaSubscriberCount(),
      });
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  } catch (err) {
    next(err);
  }
}

function queryString(
  req: AuthenticatedRequest,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const raw = req.query[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  return undefined;
}

export async function adminListQaSessionsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = queryString(req, "userId", "user_id");
    const q = queryString(req, "q");
    const date = queryString(req, "date", "day");
    const timezone = queryString(req, "timezone", "tz") || "America/New_York";
    const from = queryString(req, "from");
    const to = queryString(req, "to");
    res.json(
      await qaService.adminListSessions({
        userId: userId || undefined,
        q,
        date,
        timezone,
        from,
        to,
        page: parsePositiveInt(req.query.page, 1),
        limit: Math.min(100, parsePositiveInt(req.query.limit, 25)),
      })
    );
  } catch (err) {
    next(err);
  }
}

export async function adminGetQaSessionHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Session id is required");
    res.json(await qaService.adminGetSession(id));
  } catch (err) {
    next(err);
  }
}

export async function adminDeleteQaSessionHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Session id is required");
    res.json(await qaService.adminDeleteSession(id));
  } catch (err) {
    next(err);
  }
}
