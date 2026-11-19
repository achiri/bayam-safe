/** Error with a stable code and HTTP status, safe to show to clients. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`, 404);
export const forbidden = (msg = 'Not allowed') => new AppError('FORBIDDEN', msg, 403);
export const conflict = (msg: string) => new AppError('CONFLICT', msg, 409);
export const invalid = (msg: string) => new AppError('INVALID', msg, 400);

/** Thrown by stores when an optimistic-concurrency check fails. */
export class VersionConflictError extends AppError {
  constructor(entity: string) {
    super('VERSION_CONFLICT', `${entity} was modified concurrently, please retry`, 409);
  }
}
