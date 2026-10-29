import { describe, expect, it } from "vitest";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  ConnectionMachine,
  decodeEvent,
  formatClock,
  responseFailure,
  STABLE_CONNECTION_MS,
  summarize,
  syntheticStatus,
  TraceStore,
  type WireDelivery,
  type WireTraceDocument,
} from "../../../web/viewer/model";

const T0 = "2026-10-29T14:32:01.421Z";

function delivery(overrides: Partial<WireDelivery> = {}): WireDelivery {
  return {
    target: "csms-a",
    role: "primary",
    status: "queued",
    updatedAt: T0,
    ...overrides,
  };
}

let nextId = 0;

/** A charger CALL, as streamed by the gateway (dates as ISO strings). */
function callDoc(overrides: Partial<WireTraceDocument> = {}): WireTraceDocument {
  const id = `trace-${++nextId}`;
  return {
    id,
    tenantId: null,
    sessionId: "session-1",
    chargePointId: "CP-001",
    seq: nextId,
    receivedAt: T0,
    deliveries: [delivery()],
    kind: "trace",
    trace: {
      schemaVersion: "1.1",
      timestamp: T0,
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-001",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "msg-42",
      action: "Heartbeat",
      payload: {},
      raw: '[2,"msg-42","Heartbeat",{}]',
      meta: {
        gateway: {
          traceId: id,
          tenantId: null,
          sessionId: "session-1",
          seq: nextId,
          source: { type: "charge-point", id: "CP-001" },
          destinations: [{ target: "csms-a", role: "primary" }],
        },
      },
    },
    ...overrides,
  } as WireTraceDocument;
}

/** A primary CSMS response, correlated to `action` unless `null`. */
function responseDoc(
  messageType: "CALLRESULT" | "CALLERROR",
  action: string | null,
): WireTraceDocument {
  const doc = callDoc();
  if (doc.kind !== "trace") throw new Error("unreachable");
  const { trace } = doc;
  trace.direction = "csms-to-cp";
  trace.messageType = messageType;
  delete trace.action;
  trace.meta.gateway.source = { type: "csms", id: "csms-a", role: "primary" };
  trace.meta.gateway.destinations = [{ target: "CP-001", role: "charge-point" }];
  doc.deliveries = [delivery({ target: "CP-001", role: "charge-point" })];
  if (action !== null) trace.meta.gateway.correlation = { callTraceId: "trace-0", action };
  if (messageType === "CALLERROR") {
    delete trace.payload;
    trace.error = { code: "NotImplemented", description: "Unknown action" };
  }
  return doc;
}

function frameDoc(): WireTraceDocument {
  const doc = callDoc();
  if (doc.kind !== "trace") throw new Error("unreachable");
  const { meta, chargePointId, direction, raw, timestamp } = doc.trace;
  return {
    ...doc,
    kind: "frame",
    trace: undefined,
    frame: {
      timestamp,
      chargePointId,
      direction,
      raw: `${raw}garbage`,
      reason: "invalid-json",
      meta,
    },
  } as unknown as WireTraceDocument;
}

describe("formatClock", () => {
  it("shows hours, minutes, seconds and milliseconds", () => {
    expect(formatClock("2026-10-29T04:02:01.009Z", true)).toBe("04:02:01.009");
  });

  it("shows an unreadable time as a dash", () => {
    expect(formatClock("not a date", true)).toBe("—");
  });
});

describe("summarize", () => {
  it("summarizes a charger CALL", () => {
    const doc = callDoc({ tenantId: "tenant-a" });
    expect(summarize(doc, true)).toEqual({
      time: "14:32:01.421",
      tenant: "tenant-a",
      chargePointId: "CP-001",
      ocppVersion: "1.6",
      direction: "cp-to-csms",
      arrow: "↑",
      source: "charger",
      ignored: false,
      type: "CALL",
      action: "Heartbeat",
      correlated: false,
      messageId: "msg-42",
      sessionId: "session-1",
      delivery: "queued",
    });
  });

  it("shows a global-scope message's tenant as a dash", () => {
    expect(summarize(callDoc(), true).tenant).toBe("—");
  });

  it("names a response's action from its correlation", () => {
    const summary = summarize(responseDoc("CALLRESULT", "Heartbeat"), true);
    expect(summary).toMatchObject({
      arrow: "↓",
      direction: "csms-to-cp",
      source: "primary csms-a",
      type: "CALLRESULT",
      action: "Heartbeat",
      correlated: true,
    });
  });

  it("never invents the action of an uncorrelated response", () => {
    expect(summarize(responseDoc("CALLRESULT", null), true)).toMatchObject({
      action: "—",
      correlated: false,
    });
  });

  it("summarizes a CALLERROR with its correlated action", () => {
    expect(summarize(responseDoc("CALLERROR", "Reset"), true)).toMatchObject({
      type: "CALLERROR",
      action: "Reset",
      correlated: true,
    });
  });

  it("marks a secondary's frame as ignored, with no delivery", () => {
    const doc = responseDoc("CALLRESULT", "Heartbeat");
    if (doc.kind !== "trace") throw new Error("unreachable");
    doc.trace.meta.gateway.source = { type: "csms", id: "mirror", role: "secondary" };
    doc.trace.meta.gateway.destinations = [];
    doc.trace.meta.gateway.ignored = true;
    doc.deliveries = [];
    expect(summarize(doc, true)).toMatchObject({
      source: "secondary mirror",
      ignored: true,
      delivery: "—",
    });
  });

  it("shows absent fields as dashes", () => {
    const doc = callDoc();
    if (doc.kind !== "trace") throw new Error("unreachable");
    delete doc.trace.ocppVersion;
    expect(summarize(doc, true).ocppVersion).toBe("—");
  });

  it("summarizes an unparsed frame with its reason", () => {
    expect(summarize(frameDoc(), true)).toMatchObject({
      type: "unparsed",
      action: "—",
      messageId: "—",
      reason: "invalid-json",
      chargePointId: "CP-001",
      arrow: "↑",
      source: "charger",
    });
  });
});

describe("syntheticStatus", () => {
  const of = (...statuses: WireDelivery["status"][]) =>
    syntheticStatus(statuses.map((status) => delivery({ status })));

  it("is a dash without any destination", () => {
    expect(of()).toBe("—");
  });

  it("reports a failure first, then a drop", () => {
    expect(of("written", "failed", "dropped")).toBe("failed");
    expect(of("written", "dropped", "queued")).toBe("dropped");
  });

  it("otherwise reports the least advanced destination", () => {
    expect(of("written", "submitted", "queued")).toBe("queued");
    expect(of("written", "submitted")).toBe("submitted");
    expect(of("written", "written")).toBe("written");
  });
});

describe("TraceStore", () => {
  it("keeps messages in reception order and counts them", () => {
    const store = new TraceStore(10);
    const a = callDoc();
    const b = callDoc({ sessionId: "session-2" });
    store.addTrace(a);
    store.addTrace(b);
    store.addTrace(callDoc());

    expect(store.entries().map((e) => e.kind === "trace" && e.doc.id)).toEqual([
      a.id,
      b.id,
      expect.any(String),
    ]);
    expect(store.received).toBe(3);
    expect(store.sessions).toBe(2);
  });

  it("evicts the oldest entries past its capacity, and counts them", () => {
    const store = new TraceStore(2);
    const first = callDoc({ sessionId: "gone" });
    store.addTrace(first);
    store.addTrace(callDoc());
    const { evicted } = store.addTrace(callDoc());

    expect(evicted.map((e) => e.key)).toEqual([1]);
    expect(store.entries()).toHaveLength(2);
    expect(store.get(first.id)).toBeUndefined();
    expect(store.evicted).toBe(1);
    expect(store.received).toBe(3);
    expect(store.sessions).toBe(1);
  });

  it("shrinks to a lower capacity", () => {
    const store = new TraceStore(5);
    for (let i = 0; i < 5; i++) store.addTrace(callDoc());
    expect(store.setCapacity(2).map((e) => e.key)).toEqual([1, 2, 3]);
    expect(store.entries()).toHaveLength(2);
  });

  it("merges a delivery update into its message", () => {
    const store = new TraceStore(10);
    const doc = callDoc();
    store.addTrace(doc);

    const entry = store.applyDelivery({
      id: doc.id,
      index: 0,
      delivery: delivery({ status: "written", updatedAt: "2026-10-29T14:32:01.500Z" }),
    });

    expect(entry?.doc.deliveries[0]).toMatchObject({ status: "written" });
    expect(entry?.summary.delivery).toBe("written");
  });

  it("ignores updates for unknown, evicted or out-of-range deliveries", () => {
    const store = new TraceStore(1);
    const doc = callDoc();
    store.addTrace(doc);
    const written = delivery({ status: "written" });

    expect(store.applyDelivery({ id: "unknown", index: 0, delivery: written })).toBeUndefined();
    expect(store.applyDelivery({ id: doc.id, index: 1, delivery: written })).toBeUndefined();
    expect(store.applyDelivery({ id: doc.id, index: -1, delivery: written })).toBeUndefined();
    store.addTrace(callDoc());
    expect(store.applyDelivery({ id: doc.id, index: 0, delivery: written })).toBeUndefined();
  });

  it("never moves a delivery backwards, nor from one final status to another", () => {
    const store = new TraceStore(10);
    const doc = callDoc({ deliveries: [delivery({ status: "submitted" })] });
    store.addTrace(doc);
    const update = (status: WireDelivery["status"]) =>
      store.applyDelivery({ id: doc.id, index: 0, delivery: delivery({ status }) });

    expect(update("queued")).toBeUndefined();
    expect(update("submitted")).toBeUndefined();
    expect(update("failed")?.doc.deliveries[0].status).toBe("failed");
    expect(update("written")).toBeUndefined();
    expect(store.get(doc.id)?.doc.deliveries[0].status).toBe("failed");
  });

  it("ignores a delivery with an unknown status", () => {
    const store = new TraceStore(10);
    const doc = callDoc();
    store.addTrace(doc);
    const bogus = delivery({ status: "acknowledged" as WireDelivery["status"] });
    expect(store.applyDelivery({ id: doc.id, index: 0, delivery: bogus })).toBeUndefined();
  });

  it("marks events the gateway could not send", () => {
    const store = new TraceStore(10);
    store.addTrace(callDoc());
    const { added } = store.addGap({ reason: "missed", at: T0, missed: 3 });

    expect(added).toMatchObject({ kind: "gap", reason: "missed", from: T0, missed: 3 });
  });

  it("marks a disconnection as a possible gap, closed on reconnection", () => {
    const store = new TraceStore(10);
    store.addTrace(callDoc());
    store.addGap({ reason: "disconnected", at: T0 });
    const closed = store.closeGap("2026-10-29T14:33:00.000Z", false);

    expect(closed).toMatchObject({
      kind: "gap",
      reason: "disconnected",
      from: T0,
      to: "2026-10-29T14:33:00.000Z",
      restarted: false,
    });
  });

  it("notes a gateway restart on the gap", () => {
    const store = new TraceStore(10);
    store.addGap({ reason: "disconnected", at: T0 });
    expect(store.closeGap("2026-10-29T14:33:00.000Z", true)?.restarted).toBe(true);
  });

  it("merges back-to-back gaps of the same kind, so reconnect loops stay bounded", () => {
    const store = new TraceStore(10);
    store.addTrace(callDoc());
    for (let i = 0; i < 50; i++) {
      store.addGap({ reason: "disconnected", at: `2026-10-29T14:3${i % 10}:00.000Z` });
    }
    store.addGap({ reason: "missed", at: T0, missed: 2 });
    store.addGap({ reason: "missed", at: T0, missed: 5 });

    expect(store.entries().map((e) => e.kind)).toEqual(["trace", "gap", "gap"]);
    expect(store.entries()[1]).toMatchObject({ from: "2026-10-29T14:30:00.000Z" });
    expect(store.entries()[2]).toMatchObject({ missed: 7 });
  });

  it("counts gaps towards its capacity", () => {
    const store = new TraceStore(2);
    store.addTrace(callDoc());
    store.addGap({ reason: "missed", at: T0, missed: 1 });
    store.addTrace(callDoc());
    expect(store.entries().map((e) => e.kind)).toEqual(["gap", "trace"]);
  });

  it("clears its entries but keeps its totals", () => {
    const store = new TraceStore(10);
    store.addTrace(callDoc());
    const removed = store.clear();
    expect(removed).toHaveLength(1);
    expect(store.entries()).toEqual([]);
    expect(store.received).toBe(1);
    expect(store.sessions).toBe(0);
  });
});

describe("ConnectionMachine", () => {
  const machine = (random = () => 1) => new ConnectionMachine({ random });

  it("starts connecting and is connected on hello", () => {
    const connection = machine();
    expect(connection.state).toBe("connecting");
    connection.connected({ startedAt: T0 }, 0);
    expect(connection.state).toBe("connected");
  });

  it("backs off progressively up to its maximum", () => {
    const connection = machine();
    const delays = Array.from({ length: 8 }, (_, i) => {
      const { retryInMs } = connection.failed({ kind: "network" }, i);
      connection.retrying();
      expect(connection.state).toBe("reconnecting");
      return retryInMs;
    });
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(BACKOFF_BASE_MS).toBe(1000);
    expect(BACKOFF_MAX_MS).toBe(30000);
  });

  it("jitters each delay between half and all of it", () => {
    expect(machine(() => 0).failed({ kind: "network" }, 0).retryInMs).toBe(500);
    expect(machine(() => 0.5).failed({ kind: "network" }, 0).retryInMs).toBe(750);
  });

  it("is disconnected while it waits to retry", () => {
    const connection = machine();
    connection.connected({ startedAt: T0 }, 0);
    connection.failed({ kind: "ended" }, 1);
    expect(connection.state).toBe("disconnected");
  });

  it("starts over from the base delay after a stable connection only", () => {
    const connection = machine();
    connection.failed({ kind: "network" }, 0);
    connection.failed({ kind: "network" }, 0);
    // Ended right after hello: still backing off.
    connection.connected({ startedAt: T0 }, 1000);
    expect(connection.failed({ kind: "ended" }, 1500).retryInMs).toBe(4000);
    connection.connected({ startedAt: T0 }, 10_000);
    expect(connection.failed({ kind: "ended" }, 10_000 + STABLE_CONNECTION_MS).retryInMs).toBe(
      1000,
    );
  });

  it("waits at least as long as the server's Retry-After", () => {
    expect(machine().failed({ kind: "http", status: 429, retryAfterMs: 60_000 }, 0)).toEqual({
      retryInMs: 60_000,
    });
  });

  it("stops retrying once authentication fails", () => {
    const connection = machine();
    expect(connection.failed({ kind: "auth" }, 0)).toEqual({ retryInMs: null });
    expect(connection.state).toBe("auth-failed");
    expect(connection.failed({ kind: "network" }, 1)).toEqual({ retryInMs: null });
    connection.retrying();
    expect(connection.state).toBe("auth-failed");
  });

  it("opens a gap on losing a connection, never before the first one", () => {
    const connection = machine();
    expect(connection.failed({ kind: "network" }, 0).lostAt).toBeUndefined();
    connection.connected({ startedAt: T0 }, 1);
    expect(connection.failed({ kind: "ended" }, 2).lostAt).toBe(2);
    // Retries failing while disconnected do not open another one.
    expect(connection.failed({ kind: "network" }, 3).lostAt).toBeUndefined();
  });

  it("tells whether a reconnection reached a restarted gateway", () => {
    const connection = machine();
    expect(connection.connected({ startedAt: T0 }, 0)).toEqual({
      reconnected: false,
      restarted: false,
    });
    connection.failed({ kind: "ended" }, 1);
    expect(connection.connected({ startedAt: T0 }, 2)).toEqual({
      reconnected: true,
      restarted: false,
    });
    connection.failed({ kind: "ended" }, 3);
    expect(connection.connected({ startedAt: "2026-10-29T15:00:00.000Z" }, 4)).toEqual({
      reconnected: true,
      restarted: true,
    });
  });
});

describe("responseFailure", () => {
  it("reads a 401 as an authentication failure", () => {
    expect(responseFailure(401, null)).toEqual({ kind: "auth" });
  });

  it("reads Retry-After in seconds, and ignores an unreadable one", () => {
    expect(responseFailure(429, "12")).toEqual({ kind: "http", status: 429, retryAfterMs: 12_000 });
    expect(responseFailure(503, "soon")).toEqual({ kind: "http", status: 503 });
    expect(responseFailure(503, null)).toEqual({ kind: "http", status: 503 });
  });
});

describe("decodeEvent", () => {
  it("decodes the stream's events", () => {
    expect(
      decodeEvent({
        event: "hello",
        data: `{"startedAt":"${T0}","serverTime":"${T0}","maxBufferedMessages":5}`,
      }),
    ).toEqual({
      type: "hello",
      hello: { startedAt: T0, serverTime: T0, maxBufferedMessages: 5 },
    });
    const doc = callDoc();
    expect(decodeEvent({ event: "trace", data: JSON.stringify(doc), id: "1" })).toEqual({
      type: "trace",
      doc,
    });
    expect(decodeEvent({ event: "delivery", data: `{"id":"x","index":0,"delivery":{}}` })).toEqual({
      type: "delivery",
      update: { id: "x", index: 0, delivery: {} },
    });
    expect(decodeEvent({ event: "gap", data: `{"dropped":4}` })).toEqual({
      type: "gap",
      dropped: 4,
    });
  });

  it("ignores unknown events and malformed data", () => {
    expect(decodeEvent({ event: "message", data: "{}" })).toBeNull();
    expect(decodeEvent({ event: "trace", data: "{" })).toBeNull();
    expect(decodeEvent({ event: "trace", data: "[]" })).toBeNull();
    expect(decodeEvent({ event: "trace", data: `{"id":"x","kind":"other"}` })).toBeNull();
    expect(decodeEvent({ event: "gap", data: `{"dropped":"many"}` })).toBeNull();
    expect(decodeEvent({ event: "delivery", data: `{"id":"x","index":"0"}` })).toBeNull();
  });
});
