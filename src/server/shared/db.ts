import { conflict } from "./errors";

export function requireChanged(result: D1Result, message = "数据已变化，请刷新后重试"): void {
  if ((result.meta.changes ?? 0) < 1) throw conflict(message);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export function boolFromDb(value: number | boolean): boolean {
  return value === true || value === 1;
}
