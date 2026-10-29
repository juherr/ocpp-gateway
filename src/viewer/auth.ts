import { constantTimeEqual } from "../utils/secrets";

/** HTTP Basic credentials. May carry credentials: never log them. */
export interface BasicCredentials {
  username: string;
  password: string;
}

/** RFC 7617 credentials: strict, padded base64 (token68 restricted to the base64 alphabet). */
const BASIC_AUTHORIZATION = /^basic +([A-Za-z0-9+/]+={0,2})$/i;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => char < " " || char === "\u007f");
}

/**
 * The credentials of an `Authorization: Basic …` header value, or `null` when
 * it is not one: another scheme, base64 that is not strict and padded, bytes
 * that are not UTF-8, no colon, an empty user-id or a control character. The
 * user-id ends at the first colon, so the password may contain colons.
 */
export function parseBasicAuthorization(header: string): BasicCredentials | null {
  const match = BASIC_AUTHORIZATION.exec(header.trim());
  if (!match || match[1].length % 4 !== 0) return null;
  let decoded: string;
  try {
    decoded = utf8.decode(Buffer.from(match[1], "base64"));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0 || hasControlCharacter(decoded)) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * Whether `header` carries exactly the `expected` credentials. Both parts are
 * always compared, in constant time, so timing tells neither which part was
 * wrong nor how much of it matched.
 */
export function verifyBasicAuthorization(
  header: string | null,
  expected: BasicCredentials,
): boolean {
  const credentials = header === null ? null : parseBasicAuthorization(header);
  const sameUsername = constantTimeEqual(credentials?.username ?? "", expected.username);
  const samePassword = constantTimeEqual(credentials?.password ?? "", expected.password);
  return credentials !== null && sameUsername && samePassword;
}

export const DEFAULT_AUTH_MAX_FAILURES = 10;
export const DEFAULT_AUTH_WINDOW_MS = 60_000;
const DEFAULT_AUTH_MAX_KEYS = 1000;

export interface AuthFailureLimiterOptions {
  /** Failures within a window after which a source is blocked until the window ends. */
  maxFailures?: number;
  windowMs?: number;
  /** Sources counted on their own; the others share one bucket. */
  maxKeys?: number;
  /** Injectable clock, in milliseconds. */
  now?: () => number;
}

/** What a failure changed, so a caller can log once per source and window. */
export interface FailureRecord {
  /** The first failure of this window for this source (or the shared bucket). */
  first: boolean;
  /** This failure is the one that blocks the source (or the shared bucket). */
  blocked: boolean;
  /** Counted in the shared bucket, the source having no entry of its own. */
  overflow: boolean;
}

interface Window {
  failures: number;
  /** When the window ends, and with it any block. */
  resetAt: number;
}

/**
 * Fixed-window limit on failed authentications per source. A window opens on a
 * source's first failure; once `maxFailures` are counted in it, the source is
 * blocked until it ends, even with valid credentials, so a brute force cannot
 * go on. A success changes nothing, neither for its source nor for the others.
 *
 * Memory is bounded: past `maxKeys` sources, the others share one bucket, and a
 * source without an entry of its own is blocked while that bucket is. This
 * fails closed: a flood from many addresses can lock new addresses out for a
 * window, but never frees a blocked source by evicting it.
 */
export class AuthFailureLimiter {
  private readonly entries = new Map<string, Window>();
  private overflow: Window | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor({
    maxFailures = DEFAULT_AUTH_MAX_FAILURES,
    windowMs = DEFAULT_AUTH_WINDOW_MS,
    maxKeys = DEFAULT_AUTH_MAX_KEYS,
    now = Date.now,
  }: AuthFailureLimiterOptions = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** Sources counted on their own (for tests). */
  get size(): number {
    return this.entries.size;
  }

  /** How long `source` stays blocked, in milliseconds; `0` when it is not. */
  retryAfterMs(source: string): number {
    const now = this.now();
    const window = this.live(this.entries.get(source), now) ?? this.live(this.overflow, now);
    if (!window || window.failures < this.maxFailures) return 0;
    return window.resetAt - now;
  }

  recordFailure(source: string): FailureRecord {
    const now = this.now();
    this.arm();
    let window = this.live(this.entries.get(source), now);
    let overflow = false;
    if (!window) {
      if (this.entries.size >= this.maxKeys) this.prune(now);
      if (this.entries.size < this.maxKeys) {
        window = { failures: 0, resetAt: now + this.windowMs };
        this.entries.set(source, window);
      } else {
        overflow = true;
        this.overflow = this.live(this.overflow, now) ?? {
          failures: 0,
          resetAt: now + this.windowMs,
        };
        window = this.overflow;
      }
    }
    window.failures += 1;
    return {
      first: window.failures === 1,
      blocked: window.failures === this.maxFailures,
      overflow,
    };
  }

  /** Forget every count and disarm the timer (viewer shutdown). */
  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.entries.clear();
    this.overflow = null;
  }

  private live(window: Window | null | undefined, now: number): Window | undefined {
    return window && window.resetAt > now ? window : undefined;
  }

  private prune(now: number) {
    for (const [source, window] of this.entries) {
      if (window.resetAt <= now) this.entries.delete(source);
    }
    if (this.overflow && this.overflow.resetAt <= now) this.overflow = null;
  }

  /** Armed only while something is counted, so an idle viewer keeps no timer. */
  private arm() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.prune(this.now());
      if (this.entries.size > 0 || this.overflow !== null) this.arm();
    }, this.windowMs);
    this.timer.unref?.();
  }
}
