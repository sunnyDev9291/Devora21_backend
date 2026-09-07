import { Request, Response, NextFunction } from "express";
import { ZodTypeAny } from "zod";

export function validateBody(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        message: "Validation failed",
        details: result.error.flatten().fieldErrors,
        errors: result.error.flatten().fieldErrors,
      });
      return;
    }

    req.body = result.data;
    next();
  };
}

export function validateBody422(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      const errors = result.error.flatten().fieldErrors as Record<string, string[]>;
      res.status(422).json({
        error: "Validation failed",
        message: "Validation failed",
        errors,
      });
      return;
    }

    req.body = result.data;
    next();
  };
}
