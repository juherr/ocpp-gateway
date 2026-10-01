import { describe, expect, it } from "vitest";
import {
  HostnameTenantResolver,
  normalizeHostname,
  parseHostname,
  readSingleHeader,
} from "../src/tenants";

describe("normalizeHostname", () => {
  it.each([
    ["acme.ocpp.example.com", "acme.ocpp.example.com"],
    ["ACME.Ocpp.Example.COM", "acme.ocpp.example.com"],
    ["acme.ocpp.example.com:443", "acme.ocpp.example.com"],
    ["acme.ocpp.example.com.", "acme.ocpp.example.com"],
    ["acme.ocpp.example.com.:9000", "acme.ocpp.example.com"],
    ["127.0.0.1:9000", "127.0.0.1"],
    ["localhost", "localhost"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(normalizeHostname(raw)).toBe(expected);
  });

  it.each([
    ["an empty value", ""],
    ["an IPv6 literal", "[::1]:9000"],
    ["an empty port", "acme.ocpp.example.com:"],
    ["a non-numeric port", "acme.ocpp.example.com:https"],
    ["userinfo", "user@acme.ocpp.example.com"],
    ["an empty label", "acme..ocpp.example.com"],
    ["a leading dot", ".ocpp.example.com"],
    ["an underscore", "ac_me.ocpp.example.com"],
    ["a label starting with a hyphen", "-acme.ocpp.example.com"],
    ["a label ending with a hyphen", "acme-.ocpp.example.com"],
    ["a percent-encoded label", "%61cme.ocpp.example.com"],
    ["whitespace", "acme .ocpp.example.com"],
    ["a non-ASCII label", "café.ocpp.example.com"],
    ["a label longer than 63 characters", `${"a".repeat(64)}.ocpp.example.com`],
  ])("rejects %s", (_description, raw) => {
    expect(normalizeHostname(raw)).toBeNull();
  });
});

describe("parseHostname", () => {
  it("lowercases a bare hostname and drops one trailing dot", () => {
    expect(parseHostname("OCPP.Customer.example.")).toBe("ocpp.customer.example");
  });

  it.each(["ocpp.customer.example:443", "[::1]", "*.ocpp.example.com", ""])(
    "rejects %j (not a bare hostname)",
    (value) => {
      expect(parseHostname(value)).toBeNull();
    },
  );
});

describe("readSingleHeader", () => {
  it("returns the value of a header sent once, matching its name case-insensitively", () => {
    expect(
      readSingleHeader(["Host", "acme.ocpp.example.com", "Upgrade", "websocket"], "host"),
    ).toBe("acme.ocpp.example.com");
  });

  it("returns null when the header is missing", () => {
    expect(readSingleHeader(["Upgrade", "websocket"], "host")).toBeNull();
  });

  it("returns null when the header is sent more than once", () => {
    expect(
      readSingleHeader(["Host", "acme.ocpp.example.com", "host", "other.ocpp.example.com"], "host"),
    ).toBeNull();
  });
});

describe("HostnameTenantResolver", () => {
  const resolver = new HostnameTenantResolver({ baseDomain: "ocpp.example.com" });

  it("resolves the first label under the base domain", () => {
    expect(resolver.resolve("acme.ocpp.example.com")).toBe("acme");
    expect(resolver.resolve("tenant-b.ocpp.example.com")).toBe("tenant-b");
  });

  it("ignores case, the port and a trailing dot", () => {
    expect(resolver.resolve("ACME.OCPP.Example.com:443")).toBe("acme");
    expect(resolver.resolve("acme.ocpp.example.com.")).toBe("acme");
  });

  it.each([
    ["the base domain itself", "ocpp.example.com"],
    ["a nested subdomain", "a.b.ocpp.example.com"],
    ["a suffix look-alike", "evilocpp.example.com"],
    ["a prefix look-alike", "acme-ocpp.example.com"],
    ["the base domain as a prefix", "acme.ocpp.example.com.evil.net"],
    ["an unrelated host", "csms.example.org"],
    ["an IPv4 address", "127.0.0.1:9000"],
    ["an IPv6 literal", "[::1]:9000"],
    ["a malformed host", "ac_me.ocpp.example.com"],
    ["an empty host", ""],
  ])("resolves no tenant for %s", (_description, host) => {
    expect(resolver.resolve(host)).toBeNull();
  });

  it("resolves no tenant without a base domain or explicit hostnames", () => {
    expect(new HostnameTenantResolver({}).resolve("acme.ocpp.example.com")).toBeNull();
  });

  it("resolves explicit hostnames (custom domains) before the base domain", () => {
    const hostnames = new Map([
      ["ocpp.customer.example", "acme"],
      ["globex.ocpp.example.com", "acme"],
    ]);
    const withHostnames = new HostnameTenantResolver({
      baseDomain: "ocpp.example.com",
      lookupHostname: (hostname) => hostnames.get(hostname) ?? null,
    });

    expect(withHostnames.resolve("OCPP.Customer.example:443")).toBe("acme");
    expect(withHostnames.resolve("globex.ocpp.example.com")).toBe("acme");
    expect(withHostnames.resolve("initech.ocpp.example.com")).toBe("initech");
    expect(withHostnames.resolve("unknown.customer.example")).toBeNull();
  });
});
