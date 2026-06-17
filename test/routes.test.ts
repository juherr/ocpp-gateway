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
    expect(t.default.primary).toBe(TABLE.default.primary);
    expect(t.chargers["CP-001"].secondaries).toHaveLength(1);
  });

  it("defaults missing secondaries to an empty array", () => {
    const t = parseRouteTable({ default: { primary: "ws://x/y" } });
    expect(t.default.secondaries).toEqual([]);
    expect(t.chargers).toEqual({});
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
    const r = resolveRoute(table, "CP-001");
    expect(r.primary).toBe("wss://primary-csms.example.com/ocpp");
    expect(r.secondaries).toEqual(["wss://csms.example.com/ocpp"]);
  });

  it("falls back to the default route for an unknown id", () => {
    const r = resolveRoute(table, "SIMULATOR-001");
    expect(r.primary).toBe("wss://csms.example.com/ocpp");
    expect(r.secondaries).toEqual([]);
  });

  it("matches charger ids exactly (case-sensitive)", () => {
    expect(resolveRoute(table, "cp-001").primary).toBe(table.default.primary);
  });
});

describe("buildTargetUrl", () => {
  it("appends the chargeBoxId as a path segment", () => {
    expect(buildTargetUrl("wss://csms.example.com/ws", "CP-001")).toBe(
      "wss://csms.example.com/ws/CP-001",
    );
  });

  it("trims trailing slashes on the base url", () => {
    expect(buildTargetUrl("wss://csms.example.com/ws/", "CP-001")).toBe(
      "wss://csms.example.com/ws/CP-001",
    );
    expect(buildTargetUrl("wss://csms.example.com/ws///", "CP-001")).toBe(
      "wss://csms.example.com/ws/CP-001",
    );
  });

  it("url-encodes ids containing reserved characters", () => {
    expect(buildTargetUrl("ws://csms/ocpp", "CP 01/ä")).toBe("ws://csms/ocpp/CP%2001%2F%C3%A4");
  });
});
