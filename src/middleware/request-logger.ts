import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";
import type { AuthenticatedRequest } from "./auth";

/**
 * Log every request with status + duration. Attaches to res.finish.
 */
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const started = Date.now();
  const path = req.originalUrl || req.url;

  // Skip noisy health pings from filling the stream unless they fail.
  const isHealth = path === "/health" || path.startsWith("/health?");

  res.on("finish", () => {
    if (isHealth && res.statusCode < 400) return;

    // Agent polls every few seconds — only log failures / non-empty claims in service layer.
    const isRemoteQueuePoll =
      req.method === "GET" &&
      (path === "/resume/remote-queue" || path.startsWith("/resume/remote-queue?"));
    if (isRemoteQueuePoll && res.statusCode < 400) return;

    const isDeliveryStatusPoll =
      req.method === "GET" &&
      /^\/resume\/remote-deliveries\/[^/?]+(?:\?|$)/.test(path);
    if (isDeliveryStatusPoll && res.statusCode < 400) return;

    const authReq = req as AuthenticatedRequest;
    const userId = authReq.authUser?.id;
    const remoteDevice = (req as { remoteDevice?: { id?: string; name?: string } })
      .remoteDevice;

    logger.info("http", `${req.method} ${path} → ${res.statusCode}`, {
      ms: Date.now() - started,
      status: res.statusCode,
      ...(userId ? { userId } : {}),
      ...(remoteDevice?.id
        ? { deviceId: remoteDevice.id, deviceName: remoteDevice.name }
        : {}),
    });
  });

  next();
}
