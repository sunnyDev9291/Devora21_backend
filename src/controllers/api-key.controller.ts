import { Response, NextFunction } from "express";
import * as apiKeyService from "../services/api-key.service";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export async function createApiKeyHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const name = typeof req.body?.name === "string" ? req.body.name : "Default";
    const { apiKey, rawKey } = await apiKeyService.createApiKey(userId, name);

    res.status(201).json({
      apiKey,
      rawKey,
      warning: "Store this key now. It will not be shown again.",
    });
  } catch (err) {
    next(err);
  }
}

export async function listApiKeysHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const apiKeys = await apiKeyService.listApiKeys(userId);
    res.json({ apiKeys });
  } catch (err) {
    next(err);
  }
}

export async function revokeApiKeyHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const keyId = String(req.params.id ?? "");
    if (!keyId) {
      throw new AppError(400, "API key id is required");
    }

    const apiKey = await apiKeyService.revokeApiKey(userId, keyId);
    res.json({ apiKey });
  } catch (err) {
    next(err);
  }
}
