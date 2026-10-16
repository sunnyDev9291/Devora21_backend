import { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import * as gatewayService from "../services/admin-gateway.service";
import type {
  PutGatewayCredentialsInput,
  VerifyGatewayCredentialsInput,
} from "../validators/admin-gateway.validator";

export async function getGatewayCredentialsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }
    const status = await gatewayService.getGatewayCredentialsStatus(userId);
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

export async function putGatewayCredentialsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }
    const status = await gatewayService.putGatewayCredentials(
      userId,
      req.body as PutGatewayCredentialsInput
    );
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

export async function verifyGatewayCredentialsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }
    const result = await gatewayService.verifyGatewayCredentials(
      userId,
      req.body as VerifyGatewayCredentialsInput
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
