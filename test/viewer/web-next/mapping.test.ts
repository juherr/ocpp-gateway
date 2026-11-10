import { describe, expect, it } from "vitest";
import { gatewayEntry, toEntryDelivery } from "../../../web/viewer-next/mapping";
import { callDoc, delivery, frameDoc, responseDoc, withStatuses } from "../web/fixtures";

describe("gatewayEntry", () => {
  it("maps a trace document to a trace entry whose record is the document's own", () => {
    const doc = callDoc({ tenantId: "tenant-a", sessionId: "session-7" });
    if (doc.kind !== "trace") throw new Error("unreachable");

    const entry = gatewayEntry(doc);

    expect(entry.kind).toBe("trace");
    expect(entry.id).toBe(doc.id);
    expect(entry.receivedAt).toBe(doc.receivedAt);
    // The very object: never copied nor changed, so an export writes what the gateway recorded.
    expect(entry.kind === "trace" && entry.record).toBe(doc.trace);
    expect(entry.metadata).toEqual({
      tenant: "tenant-a",
      chargePointId: "CP-001",
      sessionId: "session-7",
      conversationId: "session-7",
      source: { id: "charge-point:CP-001", label: "Charge point CP-001" },
      deliveries: [
        {
          target: "csms-a",
          role: "primary",
          status: "queued",
          updatedAt: "2026-10-29T14:32:01.421Z",
        },
      ],
      custom: { seq: doc.seq },
    });
  });

  it("leaves the tenant out when the document has none", () => {
    const entry = gatewayEntry(callDoc({ tenantId: null }));

    expect(entry.metadata).not.toHaveProperty("tenant");
  });

  it("labels a CSMS source with its role and keeps the correlation in custom", () => {
    const doc = responseDoc("CALLRESULT", "Heartbeat");

    const entry = gatewayEntry(doc);

    expect(entry.metadata?.source).toEqual({ id: "csms:csms-a", label: "CSMS csms-a (primary)" });
    expect(entry.metadata?.custom).toEqual({
      seq: doc.seq,
      correlation: { callTraceId: "trace-0", action: "Heartbeat" },
    });
  });

  it("maps a frame document to an unparsed entry, never to a record", () => {
    const doc = frameDoc({ raw: "not json" });

    const entry = gatewayEntry(doc);

    expect(entry).toMatchObject({
      kind: "unparsed",
      id: doc.id,
      raw: "not json",
      reason: "invalid-json",
      direction: "cp-to-csms",
      timestamp: "2026-10-29T14:32:01.421Z",
      transport: "json",
    });
    expect(entry).not.toHaveProperty("record");
    expect(entry.metadata?.deliveries).toHaveLength(1);
  });

  it("maps every delivery of the document, in order", () => {
    const doc = withStatuses(callDoc(), "written", "failed");

    expect(gatewayEntry(doc).metadata?.deliveries?.map((d) => [d.target, d.status])).toEqual([
      ["csms-a", "written"],
      ["mirror-1", "failed"],
    ]);
  });
});

describe("toEntryDelivery", () => {
  it("keeps the reason and drops fields the viewer does not know", () => {
    const wire = { ...delivery({ status: "dropped", reason: "queue-overflow" }), extra: 1 };

    expect(toEntryDelivery(wire)).toEqual({
      target: "csms-a",
      role: "primary",
      status: "dropped",
      reason: "queue-overflow",
      updatedAt: "2026-10-29T14:32:01.421Z",
    });
  });
});
