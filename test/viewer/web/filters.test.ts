import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  type Entry,
  type FilterState,
  filterPredicate,
  isFilterActive,
  TraceStore,
  type WireTraceDocument,
} from "../../../web/viewer/model";
import { callDoc, frameDoc, responseDoc, withStatuses } from "./fixtures";

function entriesOf(...docs: WireTraceDocument[]): Entry[] {
  const store = new TraceStore(100);
  for (const doc of docs) store.addTrace(doc);
  return [...store.entries()];
}

function matching(entries: readonly Entry[], filter: Partial<FilterState>): string[] {
  const visible = filterPredicate({ ...EMPTY_FILTER, ...filter });
  return entries.filter(visible).map((e) => (e.kind === "trace" ? e.doc.id : `gap-${e.key}`));
}

const ids = (...docs: WireTraceDocument[]) => docs.map((d) => d.id);

describe("filterPredicate", () => {
  it("shows everything without a filter", () => {
    const docs = [callDoc(), responseDoc("CALLRESULT", "Heartbeat"), frameDoc()];
    expect(matching(entriesOf(...docs), {})).toEqual(ids(...docs));
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("filters by tenant, including messages without one", () => {
    const a = callDoc({ tenantId: "tenant-a" });
    const b = callDoc({ tenantId: "tenant-b" });
    const none = callDoc({ tenantId: null });
    const entries = entriesOf(a, b, none);
    expect(matching(entries, { tenant: "tenant-a" })).toEqual(ids(a));
    expect(matching(entries, { tenant: null })).toEqual(ids(none));
    expect(isFilterActive({ ...EMPTY_FILTER, tenant: null })).toBe(true);
  });

  it("filters by charge point, sessionId and messageId as case-insensitive text", () => {
    const a = callDoc({ chargePointId: "CP-001", sessionId: "0f8fad5b-d9cb", messageId: "boot-1" });
    const b = callDoc({ chargePointId: "CP-002", sessionId: "7c9e6679-7425", messageId: "hb-2" });
    const entries = entriesOf(a, b);
    expect(matching(entries, { chargePointId: "cp-002" })).toEqual(ids(b));
    expect(matching(entries, { chargePointId: " CP-00 " })).toEqual(ids(a, b));
    expect(matching(entries, { sessionId: "0F8FAD5B" })).toEqual(ids(a));
    expect(matching(entries, { messageId: "boot" })).toEqual(ids(a));
  });

  it("filters by direction and message type, unparsed frames included", () => {
    const call = callDoc();
    const result = responseDoc("CALLRESULT", "Heartbeat");
    const error = responseDoc("CALLERROR", "Heartbeat");
    const frame = frameDoc();
    const entries = entriesOf(call, result, error, frame);
    expect(matching(entries, { direction: "csms-to-cp" })).toEqual(ids(result, error));
    expect(matching(entries, { messageType: "CALLERROR" })).toEqual(ids(error));
    expect(matching(entries, { messageType: "unparsed" })).toEqual(ids(frame));
  });

  it("filters by action, a response matching its correlated CALL's action", () => {
    const boot = callDoc({ action: "BootNotification" });
    const answer = responseDoc("CALLRESULT", "BootNotification");
    const uncorrelated = responseDoc("CALLRESULT", null);
    const heartbeat = callDoc({ action: "Heartbeat" });
    const entries = entriesOf(boot, answer, uncorrelated, heartbeat);
    expect(matching(entries, { action: "BootNotification" })).toEqual(ids(boot, answer));
  });

  it("filters by source: the charger, the primary or a secondary", () => {
    const charger = callDoc();
    const primary = responseDoc("CALLRESULT", "Heartbeat");
    const mirror = responseDoc("CALLRESULT", "Heartbeat", {
      source: { type: "csms", id: "mirror-1", role: "secondary" },
      deliveries: [],
    });
    const entries = entriesOf(charger, primary, mirror);
    expect(matching(entries, { source: "charger" })).toEqual(ids(charger));
    expect(matching(entries, { source: "primary csms-a" })).toEqual(ids(primary));
    expect(matching(entries, { source: "secondary mirror-1" })).toEqual(ids(mirror));
  });

  it("filters by delivery status: any destination with it, or routed nowhere", () => {
    const written = withStatuses(callDoc(), "written", "written");
    const mixed = withStatuses(callDoc(), "written", "failed");
    const queued = withStatuses(callDoc(), "queued");
    const nowhere = withStatuses(callDoc());
    const entries = entriesOf(written, mixed, queued, nowhere);
    expect(matching(entries, { delivery: "written" })).toEqual(ids(written, mixed));
    expect(matching(entries, { delivery: "failed" })).toEqual(ids(mixed));
    expect(matching(entries, { delivery: "queued" })).toEqual(ids(queued));
    expect(matching(entries, { delivery: "none" })).toEqual(ids(nowhere));
  });

  it("follows a delivery update", () => {
    const store = new TraceStore(10);
    const doc = withStatuses(callDoc(), "queued");
    store.addTrace(doc);
    const visible = filterPredicate({ ...EMPTY_FILTER, delivery: "written" });
    expect(store.entries().filter(visible)).toHaveLength(0);
    store.applyDelivery({
      id: doc.id,
      index: 0,
      delivery: { ...doc.deliveries[0], status: "written" },
    });
    expect(store.entries().filter(visible)).toHaveLength(1);
  });

  it("searches free text over metadata only", () => {
    const doc = callDoc({
      tenantId: "tenant-a",
      sessionId: "session-xyz",
      chargePointId: "CP-001",
      messageId: "msg-meta",
      action: "Authorize",
      payload: { idTag: "SECRET-TAG-123" },
    });
    const frame = frameDoc({ raw: "SECRET-RAW-456 garbage" });
    const entries = entriesOf(doc, frame);
    for (const text of [
      "tenant-a",
      "SESSION-XYZ",
      "cp-001",
      "msg-meta",
      "authorize",
      "charger",
      doc.id,
    ]) {
      expect(matching(entries, { text }), text).toContain(doc.id);
    }
    expect(matching(entries, { text: "invalid-json" })).toEqual(ids(frame));
    expect(matching(entries, { text: "SECRET-TAG" })).toEqual([]);
    expect(matching(entries, { text: "idTag" })).toEqual([]);
    expect(matching(entries, { text: "SECRET-RAW" })).toEqual([]);
  });

  it("combines filters", () => {
    const a = callDoc({ tenantId: "tenant-a", action: "Heartbeat" });
    const b = callDoc({ tenantId: "tenant-a", action: "Authorize" });
    const c = callDoc({ tenantId: "tenant-b", action: "Heartbeat" });
    const entries = entriesOf(a, b, c);
    expect(matching(entries, { tenant: "tenant-a", action: "Heartbeat" })).toEqual(ids(a));
    expect(matching(entries, { tenant: "tenant-b", action: "Authorize" })).toEqual([]);
  });

  it("shows everything again once reset", () => {
    const docs = [callDoc({ tenantId: "tenant-a" }), callDoc()];
    const entries = entriesOf(...docs);
    expect(matching(entries, { tenant: "tenant-a", text: "nothing" })).toEqual([]);
    expect(matching(entries, EMPTY_FILTER)).toEqual(ids(...docs));
  });

  it("always shows gap markers: they describe the stream, not a message", () => {
    const store = new TraceStore(10);
    store.addTrace(callDoc({ tenantId: "tenant-a" }));
    const { added: gap } = store.addGap({ reason: "disconnected", at: "2026-10-29T14:33:00Z" });
    expect(matching(store.entries(), { tenant: "tenant-b" })).toEqual([`gap-${gap.key}`]);
  });
});

describe("TraceStore.observed", () => {
  it("lists the distinct values of the buffered messages, sorted", () => {
    const store = new TraceStore(3);
    store.addTrace(callDoc({ tenantId: "tenant-b", chargePointId: "CP-002", action: "Heartbeat" }));
    store.addTrace(callDoc({ tenantId: null, chargePointId: "CP-001", action: "Authorize" }));
    store.addTrace(responseDoc("CALLRESULT", "Authorize", { tenantId: "tenant-a" }));
    expect(store.observed()).toEqual({
      tenants: [null, "tenant-a", "tenant-b"],
      chargePointIds: ["CP-001", "CP-002"],
      actions: ["Authorize", "Heartbeat"],
      sources: ["charger", "primary csms-a"],
    });
  });

  it("forgets the values of evicted and cleared messages", () => {
    const store = new TraceStore(1);
    store.addTrace(callDoc({ tenantId: "tenant-a", chargePointId: "CP-001" }));
    const before = store.observedVersion;
    store.addTrace(callDoc({ tenantId: "tenant-b", chargePointId: "CP-002" }));
    expect(store.observedVersion).not.toBe(before);
    expect(store.observed().tenants).toEqual(["tenant-b"]);
    expect(store.observed().chargePointIds).toEqual(["CP-002"]);
    store.clear();
    expect(store.observed()).toEqual({ tenants: [], chargePointIds: [], actions: [], sources: [] });
  });

  it("keeps its version while the set of values does not change", () => {
    const store = new TraceStore(10);
    store.addTrace(callDoc());
    const version = store.observedVersion;
    store.addTrace(callDoc());
    expect(store.observedVersion).toBe(version);
  });
});
