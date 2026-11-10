/**
 * Maps a gateway trace document to an Open OCPP Trace viewer entry. Pure and
 * DOM-free.
 *
 * A `kind: "trace"` document becomes a `TraceEntry` whose `record` is the
 * document's record itself, never copied nor changed, so an export writes
 * exactly what the gateway recorded. A `kind: "frame"` document becomes an
 * `UnparsedEntry`: it is never turned into a record. The gateway's context
 * (tenant, session, source, deliveries) goes into `metadata`, beside the
 * record.
 */

import type { TraceEntry, ViewerEntry } from "@open-ocpp-trace/viewer-standalone";
import type { WireDelivery, WireGatewayMeta, WireSource, WireTraceDocument } from "../viewer/model";

type EntryMetadata = NonNullable<TraceEntry["metadata"]>;
/** One delivery of an entry, as the viewer reads it. */
export type EntryDelivery = NonNullable<EntryMetadata["deliveries"]>[number];
type EntrySource = NonNullable<EntryMetadata["source"]>;
type EntryRecord = TraceEntry["record"];

/** Maps one wire delivery to an entry delivery, keeping only the fields the viewer knows. */
export function toEntryDelivery(delivery: WireDelivery): EntryDelivery {
  return {
    target: delivery.target,
    role: delivery.role,
    status: delivery.status,
    ...(delivery.reason !== undefined && { reason: delivery.reason }),
    updatedAt: delivery.updatedAt,
  };
}

function gatewayMeta(doc: WireTraceDocument): WireGatewayMeta {
  return doc.kind === "trace" ? doc.trace.meta.gateway : doc.frame.meta.gateway;
}

/**
 * The peer that sent the frame, as `"<type>:<id>"` so that a charge point
 * and a CSMS with the same name stay apart. The label is display text only.
 */
function entrySource(source: WireSource): EntrySource {
  if (source.type === "charge-point") {
    return { id: `charge-point:${source.id}`, label: `Charge point ${source.id}` };
  }
  return { id: `csms:${source.id}`, label: `CSMS ${source.id} (${source.role})` };
}

/**
 * The gateway fields the viewer has no property for, kept in
 * `metadata.custom`: the per-session sequence number, the correlation the
 * gateway computed, and the `ignored` and `binary` flags.
 */
function custom(doc: WireTraceDocument, meta: WireGatewayMeta): Record<string, unknown> {
  return {
    seq: doc.seq,
    ...(meta.correlation !== undefined && { correlation: meta.correlation }),
    ...(meta.ignored === true && { ignored: true }),
    ...(meta.binary === true && { binary: true }),
  };
}

/** The viewer metadata of a document: its routing context, never inside the record. */
export function gatewayMetadata(doc: WireTraceDocument): EntryMetadata {
  const meta = gatewayMeta(doc);
  return {
    ...(doc.tenantId !== null && { tenant: doc.tenantId }),
    chargePointId: doc.chargePointId,
    sessionId: doc.sessionId,
    // A gateway session is one charge point WebSocket connection: the scope
    // in which OCPP message ids are unique.
    conversationId: doc.sessionId,
    source: entrySource(meta.source),
    deliveries: doc.deliveries.map(toEntryDelivery),
    custom: custom(doc, meta),
  };
}

/** Maps one gateway trace document to a viewer entry. */
export function gatewayEntry(doc: WireTraceDocument): ViewerEntry {
  const metadata = gatewayMetadata(doc);
  if (doc.kind === "trace") {
    return {
      kind: "trace",
      id: doc.id,
      receivedAt: doc.receivedAt,
      // The gateway's record is an Open OCPP Trace record plus its own
      // `meta.gateway`: handed over as is.
      record: doc.trace as unknown as EntryRecord,
      metadata,
    };
  }
  const { frame } = doc;
  return {
    kind: "unparsed",
    id: doc.id,
    receivedAt: doc.receivedAt,
    raw: frame.raw,
    reason: frame.reason,
    timestamp: frame.timestamp,
    direction: frame.direction,
    transport: "json",
    metadata,
  };
}
