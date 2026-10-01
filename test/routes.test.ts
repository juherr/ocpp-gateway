import { describe, expect, it } from "vitest";
import { buildTargetUrl, parseRouteTable, resolveRoute } from "../src/routes";

const TABLE = {
  default: {
    primary: "wss://csms.example.com/ocpp",
    secondaries: [],
  },
  chargers: {
    "CP-001": {
      primary: "wss://primary-csms.example.com/ocpp",
      secondaries: ["wss://csms.example.com/ocpp"],
    },
  },
};

describe("parseRouteTable", () => {
  it("accepts a well-formed table", () => {
    const t = parseRouteTable(TABLE);
    expect(t.default.primary.url).toBe(TABLE.default.primary);
    expect(t.chargers.get("CP-001")?.secondaries).toHaveLength(1);
  });

  it("normalises string backends to { url, appendChargeBoxId: true }", () => {
    const t = parseRouteTable(TABLE);
    expect(t.chargers.get("CP-001")?.primary).toEqual({
      url: "wss://primary-csms.example.com/ocpp",
      appendChargeBoxId: true,
    });
    expect(t.chargers.get("CP-001")?.secondaries).toEqual([
      { url: "wss://csms.example.com/ocpp", appendChargeBoxId: true },
    ]);
  });

  it("accepts object backends with an explicit appendChargeBoxId", () => {
    const t = parseRouteTable({
      default: {
        primary: { url: "wss://fixed-csms.example.com/XXXXXXXX", appendChargeBoxId: false },
        secondaries: ["wss://a.example.com/ocpp", { url: "wss://b.example.com/ocpp" }],
      },
    });
    expect(t.default.primary).toEqual({
      url: "wss://fixed-csms.example.com/XXXXXXXX",
      appendChargeBoxId: false,
    });
    expect(t.default.secondaries).toEqual([
      { url: "wss://a.example.com/ocpp", appendChargeBoxId: true },
      { url: "wss://b.example.com/ocpp", appendChargeBoxId: true },
    ]);
  });

  it("rejects an object backend without a url", () => {
    expect(() => parseRouteTable({ default: { primary: { appendChargeBoxId: true } } })).toThrow(
      /url/,
    );
  });

  it("rejects a backend url that cannot be parsed", () => {
    expect(() => parseRouteTable({ default: { primary: "not a url" } })).toThrow(/valid URL/);
  });

  it.each(["htps://csms.example.com/ocpp", "mailto:ops@example.com"])(
    "rejects a backend url with a scheme ws cannot dial (%s)",
    (url) => {
      // ws throws synchronously on these at connect time, which would crash the gateway.
      expect(() =>
        parseRouteTable({ default: { primary: "ws://x/y", secondaries: [url] } }),
      ).toThrow(/ws:, wss:, http: or https:/);
    },
  );

  it.each(["ws://x/y", "wss://x/y", "http://x/y", "https://x/y"])(
    "accepts a backend url with a dialable scheme (%s)",
    (url) => {
      expect(parseRouteTable({ default: { primary: url } }).default.primary.url).toBe(url);
    },
  );

  it("rejects a non-boolean appendChargeBoxId", () => {
    expect(() =>
      parseRouteTable({ default: { primary: { url: "ws://x/y", appendChargeBoxId: "no" } } }),
    ).toThrow(/appendChargeBoxId/);
  });

  it("defaults missing secondaries to an empty array", () => {
    const t = parseRouteTable({ default: { primary: "ws://x/y" } });
    expect(t.default.secondaries).toEqual([]);
    expect(t.chargers.size).toBe(0);
  });

  it("rejects a table without a default route", () => {
    expect(() => parseRouteTable({ chargers: {} })).toThrow();
  });

  it("rejects a default route without a primary", () => {
    expect(() => parseRouteTable({ default: { secondaries: [] } })).toThrow();
  });

  it("rejects a charger route without a primary", () => {
    expect(() =>
      parseRouteTable({
        default: { primary: "ws://x/y" },
        chargers: { A: { secondaries: [] } },
      }),
    ).toThrow();
  });

  it("rejects non-string secondaries", () => {
    expect(() =>
      parseRouteTable({ default: { primary: "ws://x/y", secondaries: [42] } }),
    ).toThrow();
  });

  it("rejects a non-object root", () => {
    expect(() => parseRouteTable(null)).toThrow();
    expect(() => parseRouteTable("nope")).toThrow();
  });
});

describe("resolveRoute", () => {
  const table = parseRouteTable(TABLE);

  it("returns the charger-specific route when the id matches", () => {
    const r = resolveRoute(table, null, "CP-001");
    expect(r?.primary.url).toBe("wss://primary-csms.example.com/ocpp");
    expect(r?.secondaries.map((b) => b.url)).toEqual(["wss://csms.example.com/ocpp"]);
  });

  it("falls back to the default route for an unknown id", () => {
    const r = resolveRoute(table, null, "SIMULATOR-001");
    expect(r?.primary.url).toBe("wss://csms.example.com/ocpp");
    expect(r?.secondaries).toEqual([]);
  });

  it("matches charger ids exactly (case-sensitive)", () => {
    expect(resolveRoute(table, null, "cp-001")?.primary).toBe(table.default?.primary);
  });

  it("keeps a charger route whose id is an Object.prototype key", () => {
    const t = parseRouteTable(
      JSON.parse(
        '{"default":{"primary":"ws://x/d"},"chargers":{"__proto__":{"primary":"ws://x/p"}}}',
      ),
    );
    expect(resolveRoute(t, null, "__proto__")?.primary.url).toBe("ws://x/p");
  });

  it.each(["constructor", "__proto__", "toString"])(
    "does not resolve inherited object properties as charger ids (%s)",
    (id) => {
      expect(resolveRoute(table, null, id)).toBe(table.default);
    },
  );
});

const TENANT_TABLE = {
  default: { primary: "wss://csms.example.com/ocpp" },
  tenants: {
    "tenant-a": {
      default: { primary: "wss://csms-a.example.com/ocpp" },
      chargers: { "CP-001": { primary: "wss://csms-a.example.com/special" } },
    },
    "tenant-b": {
      hostnames: ["OCPP.Customer-B.example"],
      chargers: { "CP-001": { primary: "wss://csms-b.example.com/ocpp" } },
    },
  },
};

describe("parseRouteTable with tenants", () => {
  it("parses per-tenant routes and normalises their hostnames", () => {
    const t = parseRouteTable(TENANT_TABLE);
    expect(t.tenants.get("tenant-a")?.default?.primary.url).toBe("wss://csms-a.example.com/ocpp");
    expect(t.tenants.get("tenant-b")?.default).toBeUndefined();
    expect([...t.hostnames]).toEqual([["ocpp.customer-b.example", "tenant-b"]]);
  });

  it("defaults to no tenants for a legacy table", () => {
    expect(parseRouteTable(TABLE).tenants.size).toBe(0);
  });

  it("accepts a table with tenants only (no global default route)", () => {
    const t = parseRouteTable({ tenants: TENANT_TABLE.tenants });
    expect(t.default).toBeUndefined();
  });

  it("rejects a table with neither a default route nor a tenant", () => {
    expect(() => parseRouteTable({ tenants: {} })).toThrow(/"default" route or at least one/);
  });

  it.each(["Tenant-A", "tenant_a", "-a", "a.b", ""])("rejects tenant id %j", (id) => {
    expect(() =>
      parseRouteTable({ tenants: { [id]: { default: { primary: "ws://x/y" } } } }),
    ).toThrow(/tenant id/);
  });

  it("rejects a tenant without any route", () => {
    expect(() => parseRouteTable({ tenants: { acme: { hostnames: [] } } })).toThrow(
      /tenant "acme" must define a "default" route or at least one charger/,
    );
  });

  it.each([
    ["a non-array", "ocpp.acme.example"],
    ["a malformed hostname", ["ac_me.example"]],
    ["a hostname with a port", ["ocpp.acme.example:443"]],
  ])("rejects %s for hostnames", (_description, hostnames) => {
    expect(() =>
      parseRouteTable({ tenants: { acme: { hostnames, default: { primary: "ws://x/y" } } } }),
    ).toThrow(/hostnames/);
  });

  it("rejects a hostname claimed by two tenants", () => {
    expect(() =>
      parseRouteTable({
        tenants: {
          acme: { hostnames: ["ocpp.shared.example"], default: { primary: "ws://x/y" } },
          globex: { hostnames: ["OCPP.shared.example"], default: { primary: "ws://x/y" } },
        },
      }),
    ).toThrow(/"ocpp.shared.example" is claimed by tenants "acme" and "globex"/);
  });
});

describe("resolveRoute with tenants", () => {
  const table = parseRouteTable(TENANT_TABLE);

  it("routes the same chargeBoxId to a different CSMS per tenant", () => {
    expect(resolveRoute(table, "tenant-a", "CP-001")?.primary.url).toBe(
      "wss://csms-a.example.com/special",
    );
    expect(resolveRoute(table, "tenant-b", "CP-001")?.primary.url).toBe(
      "wss://csms-b.example.com/ocpp",
    );
  });

  it("falls back to the tenant's own default route", () => {
    expect(resolveRoute(table, "tenant-a", "CP-999")?.primary.url).toBe(
      "wss://csms-a.example.com/ocpp",
    );
  });

  it("never falls back to the global routes for a tenant", () => {
    expect(resolveRoute(table, "tenant-b", "CP-999")).toBeNull();
  });

  it("resolves nothing for an unknown tenant", () => {
    expect(resolveRoute(table, "tenant-c", "CP-001")).toBeNull();
    expect(resolveRoute(table, "constructor", "CP-001")).toBeNull();
  });

  it("uses the global routes when no tenant was resolved", () => {
    expect(resolveRoute(table, null, "CP-001")?.primary.url).toBe("wss://csms.example.com/ocpp");
  });

  it("resolves nothing without a tenant when there is no global default", () => {
    const tenantsOnly = parseRouteTable({ tenants: TENANT_TABLE.tenants });
    expect(resolveRoute(tenantsOnly, null, "CP-001")).toBeNull();
  });
});

describe("buildTargetUrl", () => {
  const backend = (url: string, appendChargeBoxId = true) => ({ url, appendChargeBoxId });

  it.each([
    {
      description: "appends the chargeBoxId as a path segment",
      url: "wss://csms.example.com/ws",
      expected: "wss://csms.example.com/ws/CP-001",
    },
    {
      description: "trims a single trailing slash on the base url",
      url: "wss://csms.example.com/ws/",
      expected: "wss://csms.example.com/ws/CP-001",
    },
    {
      description: "trims repeated trailing slashes on the base url",
      url: "wss://csms.example.com/ws///",
      expected: "wss://csms.example.com/ws/CP-001",
    },
    {
      description: "preserves query parameters",
      url: "wss://csms.example.com/endpoint?tenant=emea",
      expected: "wss://csms.example.com/endpoint/CP-001?tenant=emea",
    },
    {
      description: "appends to a bare host",
      url: "wss://csms.example.com",
      expected: "wss://csms.example.com/CP-001",
    },
  ])("$description", ({ url, expected }) => {
    expect(buildTargetUrl(backend(url), "CP-001")).toBe(expected);
  });

  it("url-encodes ids containing reserved characters", () => {
    expect(buildTargetUrl(backend("ws://csms/ocpp"), "CP 01/ä")).toBe(
      "ws://csms/ocpp/CP%2001%2F%C3%A4",
    );
  });

  it("returns the url unchanged when appendChargeBoxId is false", () => {
    expect(
      buildTargetUrl(backend("wss://fixed-csms.example.com/XXXXXXXX?tenant=emea", false), "CP-001"),
    ).toBe("wss://fixed-csms.example.com/XXXXXXXX?tenant=emea");
  });
});
