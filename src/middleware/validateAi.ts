import { Request, Response, NextFunction } from "express";
import { ZodTypeAny, ZodError } from "zod";

function formatValidationError(error: ZodError): string {
  const fieldErrors = error.flatten().fieldErrors;
  const firstField = Object.keys(fieldErrors)[0];
  const firstMessage = firstField ? fieldErrors[firstField]?.[0] : undefined;
  return firstMessage ?? "Invalid request body";
}

export function validateAiBody(schema: ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({ error: formatValidationError(result.error) });
      return;
    }

    req.body = result.data;
    next();
  };
}
