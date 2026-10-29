import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../../src/utils/secrets";

describe("constantTimeEqual", () => {
  it("matches equal strings", () => {
    expect(constantTimeEqual("Basic dXNlcjpwYXNz", "Basic dXNlcjpwYXNz")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("rejects different strings, whatever their lengths", () => {
    expect(constantTimeEqual("secret", "secreT")).toBe(false);
    expect(constantTimeEqual("secret", "secret-but-longer")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("compares UTF-8 strings", () => {
    expect(constantTimeEqual("pässwörd", "pässwörd")).toBe(true);
    expect(constantTimeEqual("pässwörd", "passwörd")).toBe(false);
  });

  it("matches two missing values, never a missing one with a present one", () => {
    expect(constantTimeEqual(undefined, undefined)).toBe(true);
    expect(constantTimeEqual(undefined, "")).toBe(false);
    expect(constantTimeEqual("", undefined)).toBe(false);
  });
});
