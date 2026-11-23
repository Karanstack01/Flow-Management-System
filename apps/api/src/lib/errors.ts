import { ZodError, type ZodTypeAny, type z } from 'zod';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static validation(details: Record<string, string>) {
    return new AppError(422, 'VALIDATION_FAILED', 'Some fields are invalid', details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to do this') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(what = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${what} not found`);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
}

/** Parse untrusted input with a zod schema; throws a 400 with field paths on failure. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  try {
    return schema.parse(value);
  } catch (e) {
    if (e instanceof ZodError) {
      const details = Object.fromEntries(e.issues.map((i) => [i.path.join('.') || '_', i.message]));
      throw new AppError(400, 'BAD_REQUEST', 'Invalid request', details);
    }
    throw e;
  }
}
