import type {
  DeliveryStatus,
  WireDelivery,
  WireSource,
  WireTraceDocument,
} from "../../../web/viewer/model";

/** Wire documents as the gateway streams them, for the page's model tests. */

export const T0 = "2026-10-29T14:32:01.421Z";

export function delivery(overrides: Partial<WireDelivery> = {}): WireDelivery {
  return { target: "csms-a", role: "primary", status: "queued", updatedAt: T0, ...overrides };
}

let nextId = 0;

export interface DocOptions {
  tenantId?: string | null;
  sessionId?: string;
  chargePointId?: string;
  messageId?: string;
  action?: string;
  payload?: unknown;
  raw?: string;
  deliveries?: WireDelivery[];
  source?: WireSource;
}

/** A CALL from the charger, unless `source` says otherwise. */
export function callDoc(options: DocOptions = {}): WireTraceDocument {
  const id = `trace-${++nextId}`;
  const tenantId = options.tenantId ?? null;
  const sessionId = options.sessionId ?? "session-1";
  const chargePointId = options.chargePointId ?? "CP-001";
  const messageId = options.messageId ?? `msg-${nextId}`;
  const action = options.action ?? "Heartbeat";
  const payload = options.payload ?? {};
  const source = options.source ?? { type: "charge-point", id: chargePointId };
  return {
    id,
    tenantId,
    sessionId,
    chargePointId,
    seq: nextId,
    receivedAt: T0,
    deliveries: options.deliveries ?? [delivery()],
    kind: "trace",
    trace: {
      schemaVersion: "1.1",
      timestamp: T0,
      ocppVersion: "1.6",
      transport: "json",
      chargePointId,
      direction: source.type === "charge-point" ? "cp-to-csms" : "csms-to-cp",
      messageType: "CALL",
      messageId,
      action,
      payload,
      raw: options.raw ?? JSON.stringify([2, messageId, action, payload]),
      meta: {
        gateway: {
          traceId: id,
          tenantId,
          sessionId,
          seq: nextId,
          source,
          destinations: [{ target: "csms-a", role: "primary" }],
        },
      },
    },
  };
}

/** A CSMS response to the charger, correlated to `action` unless `null`. */
export function responseDoc(
  messageType: "CALLRESULT" | "CALLERROR",
  action: string | null,
  options: DocOptions = {},
): WireTraceDocument {
  const doc = callDoc({
    source: { type: "csms", id: "csms-a", role: "primary" },
    deliveries: [delivery({ target: "CP-001", role: "charge-point" })],
    ...options,
  });
  if (doc.kind !== "trace") throw new Error("unreachable");
  const { trace } = doc;
  trace.messageType = messageType;
  delete trace.action;
  trace.meta.gateway.destinations = [{ target: "CP-001", role: "charge-point" }];
  if (action !== null) trace.meta.gateway.correlation = { callTraceId: "trace-0", action };
  if (messageType === "CALLERROR") {
    delete trace.payload;
    trace.error = { code: "NotImplemented", description: "Unknown action" };
    trace.raw = JSON.stringify([4, trace.messageId, "NotImplemented", "Unknown action", {}]);
  } else {
    trace.raw = JSON.stringify([3, trace.messageId, trace.payload]);
  }
  return doc;
}

/** A frame that could not be read as a trace record. */
export function frameDoc(options: DocOptions = {}): WireTraceDocument {
  const doc = callDoc(options);
  if (doc.kind !== "trace") throw new Error("unreachable");
  const { meta, chargePointId, direction, timestamp } = doc.trace;
  return {
    id: doc.id,
    tenantId: doc.tenantId,
    sessionId: doc.sessionId,
    chargePointId: doc.chargePointId,
    seq: doc.seq,
    receivedAt: doc.receivedAt,
    deliveries: doc.deliveries,
    kind: "frame",
    frame: {
      timestamp,
      chargePointId,
      direction,
      raw: options.raw ?? "not json",
      reason: "invalid-json",
      meta,
    },
  };
}

export function withStatuses(doc: WireTraceDocument, ...statuses: DeliveryStatus[]) {
  doc.deliveries = statuses.map((status, i) =>
    delivery({
      target: i === 0 ? "csms-a" : `mirror-${i}`,
      role: i === 0 ? "primary" : "secondary",
      status,
    }),
  );
  return doc;
}
