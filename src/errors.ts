export type ErrorCode =
  | "E_SYNTAX"
  | "E_SEMANTIC"
  | "E_VALIDATION"
  | "E_SQL"
  | "E_RUNTIME";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly line?: number;
  public readonly column?: number;

  constructor(code: ErrorCode, message: string, line?: number, column?: number) {
    super(message);
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

export const asAppError = (err: unknown): AppError => {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof Error) {
    return new AppError("E_RUNTIME", err.message);
  }

  return new AppError("E_RUNTIME", "Unknown error");
};
