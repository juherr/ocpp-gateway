import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthFailureLimiter,
  parseBasicAuthorization,
  verifyBasicAuthorization,
} from "../../src/viewer/auth";

const basic = (userPass: string) => `Basic ${Buffer.from(userPass, "utf8").toString("base64")}`;
const EXPECTED = { username: "operator", password: "s3cret:pass" };

describe("parseBasicAuthorization", () => {
  it("decodes the user-id and the password", () => {
    expect(parseBasicAuthorization(basic("operator:pw"))).toEqual({
      username: "operator",
      password: "pw",
    });
  });

  it("splits at the first colon, so a password may contain colons", () => {
    expect(parseBasicAuthorization(basic("operator:a:b:c"))).toEqual({
      username: "operator",
      password: "a:b:c",
    });
  });

  it("accepts an empty password and any case for the scheme", () => {
    expect(parseBasicAuthorization(basic("operator:"))).toEqual({
      username: "operator",
      password: "",
    });
    expect(parseBasicAuthorization(basic("operator:pw").replace("Basic", "bAsIc"))).toEqual({
      username: "operator",
      password: "pw",
    });
  });

  it("decodes UTF-8", () => {
    expect(parseBasicAuthorization(basic("opérateur:pässwörd"))).toEqual({
      username: "opérateur",
      password: "pässwörd",
    });
  });

  it.each([
    ["an empty header", ""],
    ["no scheme", Buffer.from("operator:pw").toString("base64")],
    ["another scheme", `Bearer ${Buffer.from("operator:pw").toString("base64")}`],
    ["no credentials", "Basic"],
    ["blank credentials", "Basic   "],
    ["bad base64 characters", "Basic b3Blcm F0b3I6cHc="],
    ["base64 with a stray character", "Basic b3BlcmF0b3I6cHc=!"],
    ["unpadded base64", "Basic b3BlcmF0b3I6cHc"],
    ["padding in the middle", "Basic b3Bl=mF0b3I6cHc="],
    ["no colon", basic("operator")],
    ["an empty user-id", basic(":pw")],
    ["a control character", basic("operator:p\nw")],
    ["invalid UTF-8", `Basic ${Buffer.from([0x6f, 0x70, 0x3a, 0xff, 0xfe]).toString("base64")}`],
  ])("rejects %s", (_, header) => {
    expect(parseBasicAuthorization(header)).toBeNull();
  });
});

describe("verifyBasicAuthorization", () => {
  it("accepts the configured username and password", () => {
    expect(verifyBasicAuthorization(basic("operator:s3cret:pass"), EXPECTED)).toBe(true);
  });

  it.each([
    ["a missing header", null],
    ["a malformed header", "Basic !!"],
    ["a wrong password", basic("operator:s3cret:pasS")],
    ["a wrong username", basic("Operator:s3cret:pass")],
    ["both wrong", basic("someone:else")],
    ["a password prefix", basic("operator:s3cret")],
  ])("rejects %s", (_, header) => {
    expect(verifyBasicAuthorization(header, EXPECTED)).toBe(false);
  });
});

describe("AuthFailureLimiter", () => {
  let limiter: AuthFailureLimiter | undefined;
  afterEach(() => {
    limiter?.stop();
    limiter = undefined;
    vi.useRealTimers();
  });

  function make(options: { maxFailures?: number; windowMs?: number; maxKeys?: number } = {}) {
    let now = 1_000_000;
    limiter = new AuthFailureLimiter({
      maxFailures: 3,
      windowMs: 60_000,
      ...options,
      now: () => now,
    });
    return { limiter, advance: (ms: number) => (now += ms) };
  }

  it("blocks a source after maxFailures within the window, until the window ends", () => {
    const { limiter, advance } = make();

    expect(limiter.recordFailure("192.0.2.1")).toEqual({
      first: true,
      blocked: false,
      overflow: false,
    });
    advance(10_000);
    expect(limiter.recordFailure("192.0.2.1")).toEqual({
      first: false,
      blocked: false,
      overflow: false,
    });
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(0);
    advance(10_000);
    expect(limiter.recordFailure("192.0.2.1")).toEqual({
      first: false,
      blocked: true,
      overflow: false,
    });

    // The window opened at the first failure: 40 s are left.
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(40_000);
    advance(39_999);
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(1);
    advance(1);
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(0);
  });

  it("starts a fresh window once the previous one is over", () => {
    const { limiter, advance } = make();
    limiter.recordFailure("192.0.2.1");
    limiter.recordFailure("192.0.2.1");
    advance(60_000);

    expect(limiter.recordFailure("192.0.2.1").first).toBe(true);
    limiter.recordFailure("192.0.2.1");
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(0);
  });

  it("counts each source on its own", () => {
    const { limiter } = make();
    for (let i = 0; i < 3; i++) limiter.recordFailure("192.0.2.1");

    expect(limiter.retryAfterMs("192.0.2.1")).toBeGreaterThan(0);
    expect(limiter.retryAfterMs("192.0.2.2")).toBe(0);
    expect(limiter.recordFailure("192.0.2.2").first).toBe(true);
  });

  it("puts sources past maxKeys in one shared bucket, which fails closed", () => {
    const { limiter } = make({ maxKeys: 2 });
    limiter.recordFailure("192.0.2.1");
    limiter.recordFailure("192.0.2.2");

    expect(limiter.recordFailure("192.0.2.3")).toEqual({
      first: true,
      blocked: false,
      overflow: true,
    });
    expect(limiter.recordFailure("192.0.2.4")).toEqual({
      first: false,
      blocked: false,
      overflow: true,
    });
    expect(limiter.recordFailure("192.0.2.5")).toEqual({
      first: false,
      blocked: true,
      overflow: true,
    });

    // Every source without an entry of its own is now blocked, even a new one,
    // while the sources that have one keep their own count.
    expect(limiter.retryAfterMs("192.0.2.3")).toBeGreaterThan(0);
    expect(limiter.retryAfterMs("198.51.100.7")).toBeGreaterThan(0);
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(0);
  });

  it("never evicts a blocked source to make room", () => {
    const { limiter } = make({ maxKeys: 1 });
    for (let i = 0; i < 3; i++) limiter.recordFailure("192.0.2.1");
    for (let i = 0; i < 10; i++) limiter.recordFailure(`198.51.100.${i}`);

    expect(limiter.retryAfterMs("192.0.2.1")).toBeGreaterThan(0);
  });

  it("reuses the room of expired entries", () => {
    const { limiter, advance } = make({ maxKeys: 1 });
    limiter.recordFailure("192.0.2.1");
    advance(60_000);

    expect(limiter.recordFailure("192.0.2.2").overflow).toBe(false);
  });

  it("forgets expired entries on a timer that does not keep the process alive", () => {
    vi.useFakeTimers();
    const realNow = { value: 0 };
    limiter = new AuthFailureLimiter({
      maxFailures: 3,
      windowMs: 60_000,
      maxKeys: 1,
      now: () => realNow.value,
    });
    limiter.recordFailure("192.0.2.1");
    expect(limiter.size).toBe(1);

    realNow.value = 60_000;
    vi.advanceTimersByTime(60_000);
    expect(limiter.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() forgets everything and disarms the timer", () => {
    vi.useFakeTimers();
    limiter = new AuthFailureLimiter({ maxFailures: 1 });
    limiter.recordFailure("192.0.2.1");
    expect(vi.getTimerCount()).toBe(1);

    limiter.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(limiter.size).toBe(0);
    expect(limiter.retryAfterMs("192.0.2.1")).toBe(0);
  });
});
