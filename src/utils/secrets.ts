import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison, so response timing leaks neither the
 * stored secret nor its length: both sides are hashed first. Two missing
 * values are equal; a missing value never equals a present one.
 */
export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return timingSafeEqual(digest(a), digest(b));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
