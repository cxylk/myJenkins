export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class CancelledError extends Error {
  constructor(message = '操作已被取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, 'BAD_REQUEST', message, details);
}

export function unauthorized(message = '请先登录'): AppError {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = '没有权限执行此操作'): AppError {
  return new AppError(403, 'FORBIDDEN', message);
}

export function notFound(message = '资源不存在'): AppError {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(message: string): AppError {
  return new AppError(409, 'CONFLICT', message);
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}
