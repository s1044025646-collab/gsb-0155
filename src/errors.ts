export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_DNA"
  | "READ_TOO_SHORT"
  | "GRAPH_TOO_LARGE"
  | "EMPTY_BATCH"
  | "BAD_REQUEST"
  | "INTERNAL";

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "BAD_REQUEST":
    case "INVALID_DNA":
    case "READ_TOO_SHORT":
    case "GRAPH_TOO_LARGE":
    case "EMPTY_BATCH":
      return 422;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}
