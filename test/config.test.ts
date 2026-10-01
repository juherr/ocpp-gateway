import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  const environmentVariables = [
    "ROUTES_FILE",
    "LOG_LEVEL",
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
    "PORT",
    "TENANT_BASE_DOMAIN",
    "TENANT_HOST_HEADER",
  ] as const;

  beforeEach(() => {
    for (const envName of environmentVariables) {
      vi.stubEnv(envName, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies defaults", () => {
    const config = loadConfig();

    expect(config.port).toBe(9000);
    expect(config.routesFile).toBe("./routes.json");
    expect(config.loggerConfig.logLevel).toBe("info");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(120);
    expect(config.tenantBaseDomain).toBeUndefined();
    expect(config.tenantHostHeader).toBeUndefined();
  });

  it("normalises TENANT_BASE_DOMAIN", () => {
    vi.stubEnv("TENANT_BASE_DOMAIN", "OCPP.Example.com.");

    expect(loadConfig().tenantBaseDomain).toBe("ocpp.example.com");
  });

  it("normalises TENANT_HOST_HEADER to lowercase", () => {
    vi.stubEnv("TENANT_HOST_HEADER", "X-Forwarded-Host");

    expect(loadConfig().tenantHostHeader).toBe("x-forwarded-host");
  });

  it.each(["TENANT_BASE_DOMAIN", "TENANT_HOST_HEADER"])("treats an empty %s as unset", (name) => {
    vi.stubEnv(name, "  ");

    const config = loadConfig();
    expect(config.tenantBaseDomain).toBeUndefined();
    expect(config.tenantHostHeader).toBeUndefined();
  });

  it("reads ROUTES_FILE", () => {
    vi.stubEnv("ROUTES_FILE", "/etc/ocpp-gateway/routes.json");

    expect(loadConfig().routesFile).toBe("/etc/ocpp-gateway/routes.json");
  });

  it.each([
    { description: "empty", value: "" },
    { description: "whitespace", value: "   " },
  ])("disables debug message truncation when env var is $description", ({ value }) => {
    vi.stubEnv("LOG_DEBUG_MESSAGE_MAX_LENGTH", value);

    expect(loadConfig().loggerConfig.debugMessageMaxLength).toBeUndefined();
  });

  it.each([
    { value: "1", expected: 1 },
    { value: "65535", expected: 65535 },
  ])("accepts port boundary $value", ({ value, expected }) => {
    vi.stubEnv("PORT", value);

    expect(loadConfig().port).toBe(expected);
  });

  it.each([
    {
      envName: "PORT",
      value: "70000",
      expectedCause: 'Value must be an integer between 1 and 65535: "70000"',
    },
    {
      envName: "PORT",
      value: "9000junk",
      expectedCause: 'Invalid integer: "9000junk"',
    },
    {
      envName: "PORT",
      value: "3.14",
      expectedCause: 'Invalid integer: "3.14"',
    },
    {
      envName: "LOG_DEBUG_MESSAGE_MAX_LENGTH",
      value: "0",
      expectedCause: 'Value must be a positive integer: "0"',
    },
    {
      envName: "LOG_DEBUG_MESSAGE_MAX_LENGTH",
      value: "abc",
      expectedCause: 'Invalid integer: "abc"',
    },
    {
      envName: "TENANT_BASE_DOMAIN",
      value: "ocpp.example.com:443",
      expectedCause: 'Invalid hostname: "ocpp.example.com:443"',
    },
    {
      envName: "TENANT_BASE_DOMAIN",
      value: "*.ocpp.example.com",
      expectedCause: 'Invalid hostname: "*.ocpp.example.com"',
    },
    {
      envName: "TENANT_HOST_HEADER",
      value: "X Forwarded Host",
      expectedCause: 'Invalid HTTP header name: "X Forwarded Host"',
    },
    {
      envName: "LOG_LEVEL",
      value: "verbose",
      expectedCause: 'Invalid value: "verbose". Expected one of: debug, info, warn, error.',
    },
  ])("rejects invalid $envName value $value", ({ envName, value, expectedCause }) => {
    vi.stubEnv(envName, value);

    expect(() => loadConfig()).toThrow(
      `Invalid value for environment variable ${envName}: ${expectedCause}`,
    );
  });

  it("parses custom log settings", () => {
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.stubEnv("LOG_DEBUG_MESSAGE_MAX_LENGTH", "77");
    vi.stubEnv("PORT", "9001");

    const config = loadConfig();

    expect(config.loggerConfig.logLevel).toBe("warn");
    expect(config.loggerConfig.debugMessageMaxLength).toBe(77);
    expect(config.port).toBe(9001);
  });
});
