import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const DNA_RE = /^[ACGT]+$/;

/**
 * Validate a read assumed to be already oriented and uppercase.
 * Returns a normalized sequence (uppercase) or throws INVALID_DNA.
 */
export function validateDna(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ApiError("INVALID_DNA", "read sequence must be a non-empty string");
  }
  const seq = raw.toUpperCase();
  if (!DNA_RE.test(seq)) {
    const bad = [...new Set([...seq].filter((c) => !"ACGT".includes(c)))].join(",");
    throw new ApiError("INVALID_DNA", `sequence contains characters outside ACGT: ${bad || "(empty)"}`, {
      badCharacters: bad,
    });
  }
  return seq;
}

export function isDna(seq: string): boolean {
  return DNA_RE.test(seq);
}

/** Deterministic, seedable PRNG (mulberry32) so demos/tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function positiveInt(value: unknown, name: string, opts?: { min?: number; max?: number }): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) throw new ApiError("VALIDATION_ERROR", `${name} must be an integer`, { name });
  if (opts?.min !== undefined && n < opts.min)
    throw new ApiError("VALIDATION_ERROR", `${name} must be >= ${opts.min}`, { name });
  if (opts?.max !== undefined && n > opts.max)
    throw new ApiError("VALIDATION_ERROR", `${name} must be <= ${opts.max}`, { name });
  return n;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ApiError("VALIDATION_ERROR", `${name} must be a non-empty string`, { name });
  return value;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
