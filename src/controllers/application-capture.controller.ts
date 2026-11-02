import { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { isSuperAdminUser } from "../config/env";
import { logger } from "../lib/logger";
import {
  getRecentApplicationCaptureEvents,
  subscribeApplicationCaptureEvents,
  applicationCaptureSubscriberCount,
  type ApplicationCaptureLiveEvent,
} from "../lib/application-capture-events";
import {
  consumeApplicationCaptureStreamTicket,
  issueApplicationCaptureStreamTicket,
} from "../lib/application-capture-stream-ticket";
import * as authService from "../services/auth.service";
import * as captureService from "../services/application-capture.service";
import type { CreateApplicationCaptureInput } from "../validators/application-capture.validator";

/**
 * Resolve ?ticket= from POST /admin/application-captures/stream-ticket.
 * Must run before requireAuth on the admin router.
 */
export async function acceptApplicationCaptureStreamTicket(
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
    const rec = consumeApplicationCaptureStreamTicket(raw);
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
  // Also emit as default message for clients that only listen to onmessage.
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  flushSse(res);
}

export async function createCaptureHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.authUser!.id;
    const result = await captureService.createApplicationCapture(
      userId,
      req.body as CreateApplicationCaptureInput
    );
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function listCapturesHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.authUser!.id;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await captureService.listApplicationCaptures(userId, {
      page,
      limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getCaptureHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.authUser!.id;
    const result = await captureService.getApplicationCapture(
      userId,
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteCaptureHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.authUser!.id;
    const result = await captureService.deleteApplicationCapture(
      userId,
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

function queryString(
  req: AuthenticatedRequest,
  ...keys: string[]
): string {
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

/** GET /admin/application-captures/owners */
export async function adminListCaptureOwnersHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    void req;
    res.json(await captureService.adminListCaptureOwners());
  } catch (err) {
    next(err);
  }
}

/** GET /admin/application-captures?userId=&q=&date=&timezone=&page=&limit= */
export async function adminListCapturesHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await captureService.adminListApplicationCaptures({
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

/**
 * POST /admin/application-captures/stream-ticket
 */
export async function adminStreamCaptureTicketHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.isSuperAdmin) {
      throw new AppError(403, "Super Admin access required");
    }
    const issued = issueApplicationCaptureStreamTicket({
      id: req.authUser.id,
      email: req.authUser.email,
    });
    res.json({
      ok: true,
      ticket: issued.ticket,
      expiresIn: issued.expiresIn,
      streamPath: `/admin/application-captures/stream?ticket=${issued.ticket}`,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Super Admin SSE: live Application Capture session create/update/delete.
 * GET /admin/application-captures/stream
 */
export async function adminStreamCaptureHandler(
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

    logger.info("application-captures", "SSE client connected", {
      userId: req.authUser.id,
      subscribers: applicationCaptureSubscriberCount() + 1,
    });

    writeSse(res, "ready", {
      ok: true,
      at: new Date().toISOString(),
      subscribers: applicationCaptureSubscriberCount() + 1,
    });

    for (const ev of getRecentApplicationCaptureEvents(25)) {
      writeSse(res, ev.type, ev);
    }

    const onEvent = (ev: ApplicationCaptureLiveEvent) => {
      try {
        writeSse(res, ev.type, ev);
      } catch {
        // client gone
      }
    };
    const unsubscribe = subscribeApplicationCaptureEvents(onEvent);

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
      logger.info("application-captures", "SSE client disconnected", {
        userId: req.authUser?.id,
        subscribers: applicationCaptureSubscriberCount(),
      });
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  } catch (err) {
    next(err);
  }
}

/** GET /admin/application-captures/:id */
export async function adminGetCaptureHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await captureService.adminGetApplicationCapture(
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/** DELETE /admin/application-captures/:id — delete URL session */
export async function adminDeleteCaptureHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await captureService.adminDeleteApplicationCapture(
      String(req.params.id)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/** DELETE /admin/application-captures/:id/images/:imageId — delete one screenshot */
export async function adminDeleteCaptureImageHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await captureService.adminDeleteApplicationCaptureImage(
      String(req.params.id),
      String(req.params.imageId)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /admin/application-captures/:id/images/:imageId/review
 * Mark screenshot checked when Super Admin opens/expands it.
 */
export async function adminMarkCaptureImageReviewedHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await captureService.adminMarkCaptureImageReviewed(
      String(req.params.id),
      String(req.params.imageId)
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}
