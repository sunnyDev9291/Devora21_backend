import { Response, NextFunction } from "express";
import type { RemoteDevice } from "@prisma/client";
import { AppError } from "./errorHandler";
import { logger } from "../lib/logger";
import {
  findRemoteDeviceBySecret,
  REMOTE_DEVICE_SECRET_PREFIX,
} from "../services/remote-device.service";

export type RemoteDeviceRequest = {
  remoteDevice?: RemoteDevice;
} & import("express").Request;

/**
 * Auth for the Windows remote agent.
 * Authorization: Bearer dvrd_<secret>
 */
export async function requireRemoteDevice(
  req: RemoteDeviceRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      logger.warn("remote.auth", "missing Bearer token on agent request", {
        path: req.originalUrl,
      });
      throw new AppError(401, "Remote device authentication required");
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token.startsWith(REMOTE_DEVICE_SECRET_PREFIX)) {
      logger.warn("remote.auth", "invalid device secret prefix", {
        path: req.originalUrl,
      });
      throw new AppError(401, "Invalid remote device credentials");
    }

    const device = await findRemoteDeviceBySecret(token);
    if (!device) {
      logger.warn("remote.auth", "device secret not found or revoked", {
        path: req.originalUrl,
      });
      throw new AppError(401, "Invalid remote device credentials");
    }

    req.remoteDevice = device;
    next();
  } catch (err) {
    next(err);
  }
}
