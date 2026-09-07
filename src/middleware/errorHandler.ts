import { Request, Response, NextFunction } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public errors?: Record<string, string[]>,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    const body: {
      error: string;
      message: string;
      code?: string;
      errors?: Record<string, string[]>;
    } & Record<string, unknown> = {
      error: err.message,
      message: err.message,
    };
    if (err.code) {
      body.code = err.code;
    }
    if (err.errors) {
      body.errors = err.errors;
    }
    if (err.details) {
      Object.assign(body, err.details);
    }
    res.status(err.statusCode).json(body);
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error", message: "Internal server error" });
}
