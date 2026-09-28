import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import type { RemoteDeviceRequest } from "../middleware/remote-device-auth";
import { AppError } from "../middleware/errorHandler";
import * as remoteDeviceService from "../services/remote-device.service";
import * as remoteDeliveryService from "../services/resume-remote-delivery.service";
import type {
  AckRemoteDeliveryInput,
  CreateRemoteDeviceInput,
  DeliverArchiveInput,
} from "../validators/resume-remote.validator";

export async function createRemoteDeviceHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const body = req.body as CreateRemoteDeviceInput;
    const { device, rawSecret } = await remoteDeviceService.createRemoteDevice(
      userId,
      body.name,
      { setDefault: body.setDefault }
    );

    res.status(201).json({
      device,
      rawSecret,
      warning:
        "Store this device secret now. It will not be shown again. Use it as Authorization: Bearer <rawSecret> on the remote agent.",
    });
  } catch (err) {
    next(err);
  }
}

export async function listRemoteDevicesHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const devices = await remoteDeviceService.listRemoteDevices(userId);
    res.status(200).json({ devices });
  } catch (err) {
    next(err);
  }
}

export async function setDefaultRemoteDeviceHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const deviceId = String(req.params.id ?? "").trim();
    if (!deviceId) throw new AppError(400, "device id is required");

    const device = await remoteDeviceService.setDefaultRemoteDevice(
      userId,
      deviceId
    );
    res.status(200).json({ device });
  } catch (err) {
    next(err);
  }
}

export async function revokeRemoteDeviceHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const deviceId = String(req.params.id ?? "").trim();
    if (!deviceId) throw new AppError(400, "device id is required");

    const device = await remoteDeviceService.revokeRemoteDevice(userId, deviceId);
    res.status(200).json({ device });
  } catch (err) {
    next(err);
  }
}

export async function deliverArchiveHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const archiveId = String(req.params.id ?? "").trim();
    if (!archiveId) throw new AppError(400, "archive id is required");

    const body = req.body as DeliverArchiveInput;
    if (body.mode === "here") {
      const result = await remoteDeliveryService.deliverArchiveHere(
        userId,
        archiveId,
        {
          includePdf: body.includePdf,
          includeDocx: body.includeDocx,
        }
      );
      res.status(200).json(result);
      return;
    }

    const result = await remoteDeliveryService.enqueueRemoteDelivery(
      userId,
      archiveId,
      {
        deviceId: body.deviceId,
        includePdf: body.includePdf,
        includeDocx: body.includeDocx,
      }
    );
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getRemoteDeliveryHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const deliveryId = String(req.params.id ?? "").trim();
    if (!deliveryId) throw new AppError(400, "delivery id is required");

    const delivery = await remoteDeliveryService.getDeliveryForUser(
      userId,
      deliveryId
    );
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.status(200).json({ delivery });
  } catch (err) {
    next(err);
  }
}

export async function listRemoteDeliveriesHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const archiveId =
      typeof req.query.archiveId === "string" && req.query.archiveId.trim()
        ? req.query.archiveId.trim()
        : undefined;
    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? Number(limitRaw)
        : 20;

    const deliveries = await remoteDeliveryService.listDeliveriesForUser(userId, {
      archiveId,
      limit,
    });
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ count: deliveries.length, deliveries });
  } catch (err) {
    next(err);
  }
}

/** SSE: push delivery status until terminal (or timeout). */
export async function streamRemoteDeliveryHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) throw new AppError(401, "Authentication required");

    const deliveryId = String(req.params.id ?? "").trim();
    if (!deliveryId) throw new AppError(400, "delivery id is required");

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let closed = false;
    req.on("close", () => {
      closed = true;
    });

    const send = async () => {
      const delivery = await remoteDeliveryService.getDeliveryForUser(
        userId,
        deliveryId
      );
      res.write(`data: ${JSON.stringify({ delivery })}\n\n`);
      return delivery;
    };

    let delivery = await send();
    if (delivery.isTerminal) {
      res.write(`event: done\ndata: ${JSON.stringify({ delivery })}\n\n`);
      res.end();
      return;
    }

    const started = Date.now();
    const maxMs = 10 * 60 * 1000;
    const timer = setInterval(async () => {
      if (closed) {
        clearInterval(timer);
        return;
      }
      try {
        delivery = await send();
        if (delivery.isTerminal || Date.now() - started > maxMs) {
          res.write(`event: done\ndata: ${JSON.stringify({ delivery })}\n\n`);
          clearInterval(timer);
          res.end();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "stream error";
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        clearInterval(timer);
        res.end();
      }
    }, 2000);

    const heartbeat = setInterval(() => {
      if (closed) {
        clearInterval(heartbeat);
        return;
      }
      res.write(`: ping\n\n`);
    }, 15000);

    req.on("close", () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  } catch (err) {
    next(err);
  }
}

export async function pullRemoteQueueHandler(
  req: RemoteDeviceRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const device = req.remoteDevice;
    if (!device) throw new AppError(401, "Remote device authentication required");

    const limitRaw = req.query.limit;
    const limit =
      typeof limitRaw === "string" && /^\d+$/.test(limitRaw)
        ? Number(limitRaw)
        : 10;

    const items = await remoteDeliveryService.pullRemoteQueueForDevice(
      device.id,
      device.userId,
      limit
    );
    res.status(200).json({
      deviceId: device.id,
      deviceName: device.name,
      count: items.length,
      items,
    });
  } catch (err) {
    next(err);
  }
}

export async function ackRemoteDeliveryHandler(
  req: RemoteDeviceRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const device = req.remoteDevice;
    if (!device) throw new AppError(401, "Remote device authentication required");

    const deliveryId = String(req.params.id ?? "").trim();
    if (!deliveryId) throw new AppError(400, "delivery id is required");

    const body = req.body as AckRemoteDeliveryInput;
    const delivery = await remoteDeliveryService.ackRemoteDelivery(
      device.id,
      deliveryId,
      body
    );
    res.status(200).json({ delivery });
  } catch (err) {
    next(err);
  }
}
