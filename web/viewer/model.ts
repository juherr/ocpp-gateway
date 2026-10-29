/**
 * The viewer page's logic, free of the DOM: what the gateway streams, how a
 * message is summarised, the bounded buffer of received messages and the
 * connection's state. `app.ts` only renders it.
 */

import type { SseEvent } from "./sse";

// --- What the gateway streams (src/trace/record.ts, dates as ISO strings) ---

export type Direction = "cp-to-csms" | "csms-to-cp";
export type DeliveryStatus = "queued" | "submitted" | "written" | "failed" | "dropped";

export type WireSource =
  | { type: "charge-point"; id: string }
  | { type: "csms"; id: string; role: "primary" | "secondary" };

export interface WireDestination {
  target: string;
  role: "primary" | "secondary" | "charge-point";
}

export interface WireDelivery extends WireDestination {
  status: DeliveryStatus;
  reason?: string;
  updatedAt: string;
}

export interface WireGatewayMeta {
  traceId: string;
  tenantId: string | null;
  sessionId: string;
  seq: number;
  source: WireSource;
  destinations: WireDestination[];
  ignored?: true;
  correlation?: { callTraceId: string; action: string };
  binary?: true;
}

export interface WireTraceRecord {
  schemaVersion: string;
  timestamp: string;
  ocppVersion?: string;
  transport: "json";
  chargePointId: string;
  connectorId?: number;
  direction: Direction;
  messageType: "CALL" | "CALLRESULT" | "CALLERROR";
  messageId: string;
  action?: string;
  payload?: unknown;
  raw: string;
  error?: { code: string; description: string; details?: unknown };
  meta: { gateway: WireGatewayMeta };
}

export interface WireUnparsedFrame {
  timestamp: string;
  ocppVersion?: string;
  chargePointId: string;
  direction: Direction;
  raw: string;
  reason: string;
  meta: { gateway: WireGatewayMeta };
}

interface WireDocumentBase {
  id: string;
  tenantId: string | null;
  sessionId: string;
  chargePointId: string;
  seq: number;
  receivedAt: string;
  deliveries: WireDelivery[];
}

export type WireTraceDocument = WireDocumentBase &
  ({ kind: "trace"; trace: WireTraceRecord } | { kind: "frame"; frame: WireUnparsedFrame });

export interface Hello {
  serverTime: string;
  /** When the gateway instance started: a new value means it restarted. */
  startedAt: string;
  maxBufferedMessages: number;
}

export interface DeliveryUpdate {
  id: string;
  index: number;
  delivery: WireDelivery;
}

export type StreamEvent =
  | { type: "hello"; hello: Hello }
  | { type: "trace"; doc: WireTraceDocument }
  | { type: "delivery"; update: DeliveryUpdate }
  | { type: "gap"; dropped: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One stream event, typed; `null` for an unknown event or malformed data. */
export function decodeEvent(event: SseEvent): StreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  switch (event.event) {
    case "hello":
      return typeof data.startedAt === "string"
        ? { type: "hello", hello: data as unknown as Hello }
        : null;
    case "trace":
      return typeof data.id === "string" &&
        Array.isArray(data.deliveries) &&
        ((data.kind === "trace" && isObject(data.trace)) ||
          (data.kind === "frame" && isObject(data.frame)))
        ? { type: "trace", doc: data as unknown as WireTraceDocument }
        : null;
    case "delivery":
      return typeof data.id === "string" && Number.isInteger(data.index) && isObject(data.delivery)
        ? { type: "delivery", update: data as unknown as DeliveryUpdate }
        : null;
    case "gap":
      return Number.isInteger(data.dropped)
        ? { type: "gap", dropped: data.dropped as number }
        : null;
    default:
      return null;
  }
}

// --- Row summary ---

/** Shown for a value the trace does not have: never invented. */
export const NONE = "—";

/** Statuses only move forward: queued → submitted → a final status. */
export const DELIVERY_STATUS_RANK: Readonly<Record<DeliveryStatus, number>> = {
  queued: 0,
  submitted: 1,
  written: 2,
  failed: 2,
  dropped: 2,
};

/**
 * One status for all of a message's destinations: `failed` if any failed,
 * else `dropped` if any was dropped, else the least advanced one (`queued`,
 * `submitted`, then `written` once every destination is written). A dash for
 * a message routed nowhere (a secondary's, ignored). `written` means written
 * to the socket, never acknowledged by the peer.
 */
export function syntheticStatus(deliveries: readonly WireDelivery[]): DeliveryStatus | typeof NONE {
  if (deliveries.length === 0) return NONE;
  const has = (status: DeliveryStatus) => deliveries.some((d) => d.status === status);
  if (has("failed")) return "failed";
  if (has("dropped")) return "dropped";
  if (has("queued")) return "queued";
  if (has("submitted")) return "submitted";
  return "written";
}

export interface RowSummary {
  /** `HH:MM:SS.mmm` of the gateway's reception. */
  time: string;
  tenant: string;
  chargePointId: string;
  ocppVersion: string;
  direction: Direction;
  /** ↑ charger to CSMS, ↓ CSMS to charger. */
  arrow: "↑" | "↓";
  /** `charger`, `primary <id>` or `secondary <id>`. */
  source: string;
  /** A secondary's frame: shown, never forwarded. */
  ignored: boolean;
  type: "CALL" | "CALLRESULT" | "CALLERROR" | "unparsed";
  /** The CALL's action, or for a response the correlated CALL's. */
  action: string;
  /** `action` comes from the correlated CALL. */
  correlated: boolean;
  messageId: string;
  sessionId: string;
  delivery: DeliveryStatus | typeof NONE;
  /** Why an unparsed frame could not be read as a trace record. */
  reason?: string;
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** `HH:MM:SS.mmm`, local time unless `utc`; a dash for an unreadable date. */
export function formatClock(iso: string, utc = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NONE;
  const [h, m, s, ms] = utc
    ? [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
    : [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** A session id short enough for a row: its first 8 characters (a UUID's first group). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function sourceLabel(source: WireSource): string {
  return source.type === "charge-point" ? "charger" : `${source.role} ${source.id}`;
}

/** The record or frame the gateway captured. */
export function capturedOf(doc: WireTraceDocument): WireTraceRecord | WireUnparsedFrame {
  return doc.kind === "trace" ? doc.trace : doc.frame;
}

export function summarize(doc: WireTraceDocument, utc = false): RowSummary {
  const captured = capturedOf(doc);
  const { gateway } = captured.meta;
  const common = {
    time: formatClock(captured.timestamp, utc),
    tenant: doc.tenantId ?? NONE,
    chargePointId: doc.chargePointId,
    ocppVersion: captured.ocppVersion ?? NONE,
    direction: captured.direction,
    arrow: captured.direction === "cp-to-csms" ? ("↑" as const) : ("↓" as const),
    source: sourceLabel(gateway.source),
    ignored: gateway.ignored === true,
    sessionId: doc.sessionId,
    delivery: syntheticStatus(doc.deliveries),
  };
  if (doc.kind === "frame") {
    return {
      ...common,
      type: "unparsed",
      action: NONE,
      correlated: false,
      messageId: NONE,
      reason: doc.frame.reason,
    };
  }
  const { trace } = doc;
  const correlated = trace.action === undefined && gateway.correlation !== undefined;
  return {
    ...common,
    type: trace.messageType,
    action: trace.action ?? gateway.correlation?.action ?? NONE,
    correlated,
    messageId: trace.messageId,
  };
}

// --- The buffer of received messages ---

export interface TraceEntry {
  kind: "trace";
  /** Unique per page load, in reception order. */
  key: number;
  /** As streamed, deliveries merged in; the source of the detail and exports. */
  doc: WireTraceDocument;
  summary: RowSummary;
}

/**
 * A stretch where messages may be missing. `missed`: the gateway dropped
 * events for this page (it fell behind). `disconnected`: the stream was down
 * between `from` and `to` (open while it still is); nothing streamed meanwhile
 * is ever recovered.
 */
export interface GapEntry {
  kind: "gap";
  key: number;
  reason: "missed" | "disconnected";
  from: string;
  to?: string;
  missed?: number;
  /** The reconnection reached a restarted gateway instance. */
  restarted?: boolean;
}

export type Entry = TraceEntry | GapEntry;

export interface AddResult<T extends Entry> {
  /** The entry added, or the gap an addition was merged into. */
  added: T;
  /** Entries pushed out by the capacity, oldest first. */
  evicted: Entry[];
}

export type NewGap =
  | { reason: "missed"; at: string; missed: number }
  | { reason: "disconnected"; at: string };

/**
 * The page's memory bound besides the message count: the sum of the buffered
 * frames' `raw` lengths (UTF-16 code units, one byte each for the ASCII most
 * OCPP traffic is). It applies to the list, and again to the messages held
 * while paused: up to twice this in memory until the resume. The parsed
 * payload and the DOM cost a few times more, so this keeps a tab with large
 * frames under a gigabyte.
 */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

/** What an entry weighs against the byte bound: its raw frame's length. */
function weight(entry: Entry): number {
  if (entry.kind !== "trace") return 0;
  const { raw } = capturedOf(entry.doc);
  return typeof raw === "string" ? raw.length : 0;
}

/** How many buffered messages hold each value; `version` moves when the set of values does. */
class ValueCounts<K> {
  private readonly counts = new Map<K, number>();

  constructor(private readonly changed: () => void) {}

  get size(): number {
    return this.counts.size;
  }

  add(value: K): void {
    const count = this.counts.get(value) ?? 0;
    this.counts.set(value, count + 1);
    if (count === 0) this.changed();
  }

  remove(value: K): void {
    const count = (this.counts.get(value) ?? 1) - 1;
    if (count > 0) {
      this.counts.set(value, count);
    } else if (this.counts.delete(value)) {
      this.changed();
    }
  }

  clear(): void {
    if (this.counts.size > 0) this.changed();
    this.counts.clear();
  }

  values(): K[] {
    return [...this.counts.keys()];
  }
}

/** The distinct values of the buffered messages, for the filters' option lists. */
export interface ObservedValues {
  /** `null`: messages without a tenant (the global scope). */
  tenants: (string | null)[];
  chargePointIds: string[];
  /** Actions as listed, a response's from its correlated CALL. */
  actions: string[];
  /** Source labels (`sourceLabel`). */
  sources: string[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A messages' buffer bounded by count and bytes, oldest first. */
class EntryQueue {
  private items: Entry[] = [];
  private head = 0;
  /** The buffered messages' weight. */
  bytes = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  last(): Entry | undefined {
    return this.size > 0 ? this.items[this.items.length - 1] : undefined;
  }

  push(entry: Entry): void {
    this.items.push(entry);
    this.bytes += weight(entry);
  }

  shift(): Entry {
    const entry = this.items[this.head++];
    this.bytes -= weight(entry);
    if (this.head > 1024 && this.head * 2 > this.items.length) this.compact();
    return entry;
  }

  /** The newest entry matching `predicate`. */
  findLast(predicate: (entry: Entry) => boolean): Entry | undefined {
    for (let i = this.items.length - 1; i >= this.head; i--) {
      if (predicate(this.items[i])) return this.items[i];
    }
    return undefined;
  }

  has(entry: Entry): boolean {
    return this.items.indexOf(entry, this.head) !== -1;
  }

  /** Empties the queue; returns what it held. */
  drain(): Entry[] {
    const drained = this.items.slice(this.head);
    this.items = [];
    this.head = 0;
    this.bytes = 0;
    return drained;
  }

  private compact(): void {
    if (this.head === 0) return;
    this.items = this.items.slice(this.head);
    this.head = 0;
  }
}

/**
 * The last `capacity` entries (messages and gap markers), in reception order,
 * holding at most `maxBytes` of raw frames — except for a single message
 * larger than that, kept alone. The oldest are evicted first, and counted.
 *
 * Paused, it lists nothing new: what arrives meanwhile is held apart, within
 * the same bounds (so up to twice them in all), the oldest dropped first and
 * counted, and listed on resume. Delivery updates still apply to every
 * message, listed or held.
 */
export class TraceStore {
  private items: Entry[] = [];
  private head = 0;
  private readonly held = new EntryQueue();
  private heldMessages = 0;
  private isPaused = false;
  /** Every entry created since the pause is held. */
  private heldFromKey = Infinity;
  private readonly byId = new Map<string, TraceEntry>();
  private readonly sessionCounts = new Map<string, number>();
  private readonly tenantCounts = new ValueCounts<string | null>(() => this.observedVersion++);
  private readonly chargePointCounts = new ValueCounts<string>(() => this.observedVersion++);
  private readonly actionCounts = new ValueCounts<string>(() => this.observedVersion++);
  private readonly sourceCounts = new ValueCounts<string>(() => this.observedVersion++);
  private nextKey = 1;
  /** Messages received since the page loaded. */
  received = 0;
  /** Messages pushed out by the bounds: what the page reports as removed. */
  evictedMessages = 0;
  /** Gap markers pushed out by the bounds. */
  evictedGaps = 0;
  /** Messages held while paused, then dropped by the bounds before the resume. */
  pendingDropped = 0;
  /** The buffered messages' weight against `maxBytes`. */
  bytes = 0;
  /** Changes whenever `observed()` would return another set of values. */
  observedVersion = 0;

  constructor(
    private capacity: number,
    private readonly maxBytes = MAX_BUFFERED_BYTES,
  ) {}

  /** Distinct sessions among the buffered messages, held ones included. */
  get sessions(): number {
    return this.sessionCounts.size;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** Messages held while paused, waiting for the resume. */
  get pendingMessages(): number {
    return this.heldMessages;
  }

  /** The entry is held while paused, not listed yet. */
  isPending(entry: Entry): boolean {
    if (!this.isPaused || entry.key < this.heldFromKey) return false;
    return entry.kind === "trace" ? this.byId.get(entry.doc.id) === entry : this.held.has(entry);
  }

  /** Stops listing what arrives; ignored when already paused. */
  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.heldFromKey = this.nextKey;
  }

  /**
   * Lists the held entries after the others, in reception order; returns them
   * and the entries their addition evicted. Ignored when not paused.
   */
  resume(): { added: Entry[]; evicted: Entry[] } {
    if (!this.isPaused) return { added: [], evicted: [] };
    this.isPaused = false;
    const added = this.held.drain();
    this.heldMessages = 0;
    for (const entry of added) {
      this.items.push(entry);
      this.bytes += weight(entry);
    }
    return { added, evicted: this.trim() };
  }

  /** The distinct values of the buffered messages (held ones included), sorted. */
  observed(): ObservedValues {
    const tenants = this.tenantCounts.values();
    const named = tenants.filter((t): t is string => t !== null).sort(byText);
    return {
      tenants: tenants.includes(null) ? [null, ...named] : named,
      chargePointIds: this.chargePointCounts.values().sort(byText),
      actions: this.actionCounts.values().sort(byText),
      sources: this.sourceCounts.values().sort(byText),
    };
  }

  get size(): number {
    return this.items.length - this.head;
  }

  entries(): readonly Entry[] {
    this.compact();
    return this.items;
  }

  get(id: string): TraceEntry | undefined {
    return this.byId.get(id);
  }

  /**
   * Changes the capacity (at least 1; ignored unless finite); returns the
   * entries evicted, held ones included.
   */
  setCapacity(capacity: number): Entry[] {
    if (typeof capacity !== "number" || !Number.isFinite(capacity)) return [];
    this.capacity = Math.max(1, Math.floor(capacity));
    return [...this.trim(), ...this.trimHeld()];
  }

  /**
   * Lists a received message, or holds it while paused. `evicted`: the
   * entries it pushed out, listed or held.
   */
  addTrace(doc: WireTraceDocument): AddResult<TraceEntry> {
    const entry: TraceEntry = { kind: "trace", key: this.nextKey++, doc, summary: summarize(doc) };
    this.received++;
    this.byId.set(doc.id, entry);
    this.sessionCounts.set(doc.sessionId, (this.sessionCounts.get(doc.sessionId) ?? 0) + 1);
    this.observe(entry, true);
    if (this.isPaused) {
      this.held.push(entry);
      this.heldMessages++;
      return { added: entry, evicted: this.trimHeld() };
    }
    this.bytes += weight(entry);
    this.items.push(entry);
    return { added: entry, evicted: this.trim() };
  }

  /**
   * Adds a gap marker, or extends the last entry when it is a gap of the same
   * kind: a connection that keeps failing never floods the buffer. Paused,
   * the marker is held in its place among the held messages, and only a held
   * gap is extended.
   */
  addGap(gap: NewGap): AddResult<GapEntry> {
    const last = this.isPaused
      ? this.held.last()
      : this.size > 0
        ? this.items[this.items.length - 1]
        : undefined;
    if (last?.kind === "gap" && last.reason === gap.reason) {
      if (gap.reason === "missed") {
        last.missed = (last.missed ?? 0) + gap.missed;
        last.to = gap.at;
      } else {
        delete last.to;
      }
      return { added: last, evicted: [] };
    }
    const entry: GapEntry = {
      kind: "gap",
      key: this.nextKey++,
      reason: gap.reason,
      from: gap.at,
      ...(gap.reason === "missed" && { missed: gap.missed }),
    };
    if (this.isPaused) {
      this.held.push(entry);
      return { added: entry, evicted: this.trimHeld() };
    }
    this.items.push(entry);
    return { added: entry, evicted: this.trim() };
  }

  /** Ends the open disconnection gap, held or listed, if any; returns it. */
  closeGap(at: string, restarted: boolean): GapEntry | undefined {
    const open = (entry: Entry): entry is GapEntry =>
      entry.kind === "gap" && entry.reason === "disconnected" && entry.to === undefined;
    let found: Entry | undefined = this.held.findLast(open);
    for (let i = this.items.length - 1; found === undefined && i >= this.head; i--) {
      if (open(this.items[i])) found = this.items[i];
    }
    if (found?.kind !== "gap") return undefined;
    found.to = at;
    found.restarted = (found.restarted ?? false) || restarted;
    return found;
  }

  /**
   * Merges a delivery outcome into its message; returns the message when it
   * changed. Ignored: unknown or evicted ids, indexes out of range, unknown
   * statuses, and anything that would not move the status forward (one final
   * status never replaces another).
   */
  applyDelivery({ id, index, delivery }: DeliveryUpdate): TraceEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    const { deliveries } = entry.doc;
    if (!Number.isInteger(index) || index < 0 || index >= deliveries.length) return undefined;
    const rank = DELIVERY_STATUS_RANK[delivery.status];
    if (rank === undefined || !Object.hasOwn(DELIVERY_STATUS_RANK, delivery.status)) {
      return undefined;
    }
    if (rank <= DELIVERY_STATUS_RANK[deliveries[index].status]) return undefined;
    deliveries[index] = delivery;
    entry.summary = { ...entry.summary, delivery: syntheticStatus(deliveries) };
    return entry;
  }

  /**
   * Empties the buffer, held entries included, keeping the totals and the
   * pause; returns the listed entries removed.
   */
  clear(): Entry[] {
    const removed = this.items.slice(this.head);
    this.items = [];
    this.head = 0;
    this.held.drain();
    this.heldMessages = 0;
    this.byId.clear();
    this.sessionCounts.clear();
    this.tenantCounts.clear();
    this.chargePointCounts.clear();
    this.actionCounts.clear();
    this.sourceCounts.clear();
    this.bytes = 0;
    return removed;
  }

  private trim(): Entry[] {
    const evicted: Entry[] = [];
    while (this.size > this.capacity || (this.bytes > this.maxBytes && this.size > 1)) {
      const entry = this.items[this.head++];
      evicted.push(entry);
      this.bytes -= weight(entry);
      this.forget(entry);
      if (entry.kind === "trace") this.evictedMessages++;
      else this.evictedGaps++;
    }
    if (this.head > 1024 && this.head * 2 > this.items.length) this.compact();
    return evicted;
  }

  /** The held entries within the same bounds; a dropped message counts in `pendingDropped`. */
  private trimHeld(): Entry[] {
    const dropped: Entry[] = [];
    while (
      this.held.size > this.capacity ||
      (this.held.bytes > this.maxBytes && this.held.size > 1)
    ) {
      const entry = this.held.shift();
      dropped.push(entry);
      this.forget(entry);
      if (entry.kind === "trace") {
        this.heldMessages--;
        this.pendingDropped++;
      } else {
        this.evictedGaps++;
      }
    }
    return dropped;
  }

  private forget(entry: Entry): void {
    if (entry.kind !== "trace") return;
    this.byId.delete(entry.doc.id);
    const count = (this.sessionCounts.get(entry.doc.sessionId) ?? 1) - 1;
    if (count > 0) this.sessionCounts.set(entry.doc.sessionId, count);
    else this.sessionCounts.delete(entry.doc.sessionId);
    this.observe(entry, false);
  }

  private observe(entry: TraceEntry, add: boolean): void {
    const { summary, doc } = entry;
    const op = add ? "add" : "remove";
    this.tenantCounts[op](doc.tenantId);
    this.chargePointCounts[op](summary.chargePointId);
    this.sourceCounts[op](summary.source);
    if (summary.action !== NONE) this.actionCounts[op](summary.action);
  }

  private compact(): void {
    if (this.head === 0) return;
    this.items = this.items.slice(this.head);
    this.head = 0;
  }
}

// --- Filters ---

/** Which messages the list shows; every condition set must hold. */
export interface FilterState {
  /** `""`: any tenant; `null`: messages without a tenant (the global scope). */
  tenant: string | null;
  /** Case-insensitive part of the charge point id; `""`: any. */
  chargePointId: string;
  /** Case-insensitive part of the session id; `""`: any. */
  sessionId: string;
  direction: Direction | "";
  messageType: RowSummary["type"] | "";
  /** The exact action, a response's from its correlated CALL; `""`: any. */
  action: string;
  /** The exact source label (`charger`, `primary <id>`, `secondary <id>`); `""`: any. */
  source: string;
  /** Case-insensitive part of the OCPP message id; `""`: any. */
  messageId: string;
  /**
   * A status at least one destination has (whatever the row's synthetic
   * status), or `none` for a message routed nowhere; `""`: any.
   */
  delivery: DeliveryStatus | "none" | "";
  /**
   * Case-insensitive text found in a message's metadata: trace id, tenant,
   * session id, charge point id, message type, action, source, message id or
   * an unparsed frame's reason. Never in the payload, the error or the raw
   * frame, which may hold secrets.
   */
  text: string;
}

export const EMPTY_FILTER: Readonly<FilterState> = Object.freeze({
  tenant: "",
  chargePointId: "",
  sessionId: "",
  direction: "",
  messageType: "",
  action: "",
  source: "",
  messageId: "",
  delivery: "",
  text: "",
});

export function isFilterActive(filter: FilterState): boolean {
  return (Object.keys(EMPTY_FILTER) as (keyof FilterState)[]).some((key) =>
    typeof filter[key] === "string" ? filter[key].trim() !== "" : filter[key] !== EMPTY_FILTER[key],
  );
}

const contains = (value: string, part: string) => value.toLowerCase().includes(part);

/**
 * The filter as a predicate over the list's entries. Gap markers always pass:
 * they describe the stream, not a message, and a filtered list still has to
 * show where messages may be missing.
 */
export function filterPredicate(filter: FilterState): (entry: Entry) => boolean {
  const part = (value: string) => value.trim().toLowerCase();
  const chargePointId = part(filter.chargePointId);
  const sessionId = part(filter.sessionId);
  const messageId = part(filter.messageId);
  const text = part(filter.text);
  return (entry) => {
    if (entry.kind === "gap") return true;
    const { summary: s, doc } = entry;
    if (filter.tenant !== "" && doc.tenantId !== filter.tenant) return false;
    if (chargePointId && !contains(s.chargePointId, chargePointId)) return false;
    if (sessionId && !contains(s.sessionId, sessionId)) return false;
    if (filter.direction && s.direction !== filter.direction) return false;
    if (filter.messageType && s.type !== filter.messageType) return false;
    if (filter.action && s.action !== filter.action) return false;
    if (filter.source && s.source !== filter.source) return false;
    if (messageId && (s.messageId === NONE || !contains(s.messageId, messageId))) return false;
    if (filter.delivery === "none" && doc.deliveries.length > 0) return false;
    if (
      filter.delivery &&
      filter.delivery !== "none" &&
      !doc.deliveries.some((d) => d.status === filter.delivery)
    ) {
      return false;
    }
    if (text) {
      const metadata = [doc.id, doc.tenantId ?? "", s.sessionId, s.chargePointId, s.type, s.source];
      if (s.action !== NONE) metadata.push(s.action);
      if (s.messageId !== NONE) metadata.push(s.messageId);
      if (s.reason !== undefined) metadata.push(s.reason);
      if (!metadata.some((value) => contains(value, text))) return false;
    }
    return true;
  };
}

// --- Membership changes of listed messages ---

/** A message to list, before the row of `beforeKey` (`null`: at the end). */
export interface RowInsert {
  entry: TraceEntry;
  beforeKey: number | null;
}

export interface MembershipChanges {
  /** In reception order: inserting them one after the other keeps the list in order. */
  insert: RowInsert[];
  /** Keys of the rows to remove. */
  remove: number[];
}

/**
 * Which rows come or go when messages already listed changed (a delivery
 * update under a delivery filter). Paused, nothing does: the list stays
 * frozen until the resume.
 */
export function membershipChanges(
  listed: readonly Entry[],
  isShown: (key: number) => boolean,
  changed: Iterable<TraceEntry>,
  visible: (entry: Entry) => boolean,
  paused: boolean,
): MembershipChanges {
  const changes: MembershipChanges = { insert: [], remove: [] };
  if (paused) return changes;
  const entering: TraceEntry[] = [];
  const leaving = new Set<number>();
  for (const entry of changed) {
    // Evicted or held while paused: not in the list, it has no row to come or go.
    if (listed[indexAfter(listed, entry.key) - 1] !== entry) continue;
    const shown = isShown(entry.key);
    if (visible(entry) === shown) continue;
    if (shown) leaving.add(entry.key);
    else entering.push(entry);
  }
  changes.remove = [...leaving];
  entering.sort((a, b) => a.key - b.key);
  for (const entry of entering) {
    // The next row once the removals are done; the earlier insertions go before it too.
    let beforeKey: number | null = null;
    for (let i = indexAfter(listed, entry.key); i < listed.length; i++) {
      const { key } = listed[i];
      if (isShown(key) && !leaving.has(key)) {
        beforeKey = key;
        break;
      }
    }
    changes.insert.push({ entry, beforeKey });
  }
  return changes;
}

/** The index of the first entry whose key is greater than `key` (entries in key order). */
function indexAfter(entries: readonly Entry[], key: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid].key <= key) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The entries that have a row, in list order: what "export filtered" writes. */
export function listedEntries(
  entries: readonly Entry[],
  isShown: (key: number) => boolean,
): Entry[] {
  return entries.filter((entry) => isShown(entry.key));
}

// --- Export ---

/**
 * JSON Lines of the given entries' trace records (`trace`: Open OCPP Trace
 * v1.1, exactly as streamed, gateway metadata included, delivery outcomes
 * not: they are not part of the record) or unparsed frames (`frame`), one per
 * line in list order. Gap markers and the other kind are left out; nothing is
 * modified.
 */
export function toJsonl(entries: readonly Entry[], kind: "trace" | "frame"): string {
  let out = "";
  for (const entry of entries) {
    if (entry.kind !== "trace") continue;
    const { doc } = entry;
    if (kind === "trace" && doc.kind === "trace") out += `${JSON.stringify(doc.trace)}\n`;
    else if (kind === "frame" && doc.kind === "frame") out += `${JSON.stringify(doc.frame)}\n`;
  }
  return out;
}

/** `ocpp-traces-<ISO time>.jsonl` (or `ocpp-unparsed-frames-…`), colons replaced for every OS. */
export function exportFilename(kind: "trace" | "frame", at: Date): string {
  const prefix = kind === "trace" ? "ocpp-traces" : "ocpp-unparsed-frames";
  return `${prefix}-${at.toISOString().replace(/:/g, "-")}.jsonl`;
}

// --- What the next render must do ---

export interface RenderBatch {
  /** Entries without a row yet, in reception order. */
  added: Entry[];
  /** Rendered entries whose row must be refreshed. */
  changed: Entry[];
  /** Keys of rendered rows to remove. */
  removed: number[];
}

/**
 * The DOM changes waiting for the next animation frame. Browsers pause
 * animation frames in background tabs, so it stays bounded by the store's
 * capacity however long that lasts: an entry evicted before being rendered is
 * forgotten, and only rendered rows are queued for removal.
 */
export class RenderQueue {
  private added = new Map<number, Entry>();
  private changed = new Map<number, Entry>();
  private removed = new Set<number>();

  /** `rendered(key)`: the entry has a row on the page. */
  constructor(private readonly rendered: (key: number) => boolean) {}

  add(entry: Entry): void {
    this.added.set(entry.key, entry);
  }

  /** An entry changed; one not rendered yet will be drawn in its latest state anyway. */
  change(entry: Entry): void {
    if (this.rendered(entry.key)) this.changed.set(entry.key, entry);
  }

  /** A gap marker that may have been merged into one already shown. */
  upsert(entry: Entry): void {
    if (this.rendered(entry.key)) this.changed.set(entry.key, entry);
    else this.added.set(entry.key, entry);
  }

  evict(entries: readonly Entry[]): void {
    for (const { key } of entries) {
      this.added.delete(key);
      this.changed.delete(key);
      if (this.rendered(key)) this.removed.add(key);
    }
  }

  get empty(): boolean {
    return this.added.size === 0 && this.changed.size === 0 && this.removed.size === 0;
  }

  take(): RenderBatch {
    const batch = {
      added: [...this.added.values()],
      changed: [...this.changed.values()],
      removed: [...this.removed],
    };
    this.added = new Map();
    this.changed = new Map();
    this.removed = new Set();
    return batch;
  }
}

// --- Connection state ---

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "auth-failed";

/** Why a stream attempt ended. */
export type Failure =
  | { kind: "auth" }
  | { kind: "http"; status: number; retryAfterMs?: number }
  | { kind: "network" }
  | { kind: "ended" };

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** A connection up this long resets the backoff. */
export const STABLE_CONNECTION_MS = 10_000;

/** What a failed response means: 401 stops, anything else is retried. */
export function responseFailure(status: number, retryAfter: string | null): Failure {
  if (status === 401) return { kind: "auth" };
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds)
    ? { kind: "http", status, retryAfterMs: seconds * 1000 }
    : { kind: "http", status };
}

export interface FailureDecision {
  /** When to try again; `null`: never (authentication failed). */
  retryInMs: number | null;
  /** Set when this failure lost an established connection: a gap opens then. */
  lostAt?: number;
}

export interface ConnectionMachineOptions {
  /** In [0, 1); jitters each delay. */
  random?: () => number;
  baseMs?: number;
  maxMs?: number;
  stableMs?: number;
}

/**
 * The live stream's state. `connecting` (first attempt) → `connected` on the
 * stream's `hello`; a failure → `disconnected` while waiting for the backoff,
 * → `reconnecting` during the next attempt. `auth-failed` is final: the page
 * must be reloaded to enter credentials again. Delays double from
 * `baseMs` up to `maxMs`, each jittered between half and all of it, and start
 * over only after a connection that lasted `stableMs`.
 */
export class ConnectionMachine {
  state: ConnectionState = "connecting";
  private failures = 0;
  private connectedAt: number | undefined;
  /** An established connection was lost and not yet re-established. */
  private lost = false;
  private startedAt: string | undefined;
  private readonly random: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly stableMs: number;

  constructor(options: ConnectionMachineOptions = {}) {
    this.random = options.random ?? Math.random;
    this.baseMs = options.baseMs ?? BACKOFF_BASE_MS;
    this.maxMs = options.maxMs ?? BACKOFF_MAX_MS;
    this.stableMs = options.stableMs ?? STABLE_CONNECTION_MS;
  }

  /** The stream said hello. */
  connected(
    hello: Pick<Hello, "startedAt">,
    now: number,
  ): { reconnected: boolean; restarted: boolean } {
    const reconnected = this.lost;
    const restarted = this.startedAt !== undefined && this.startedAt !== hello.startedAt;
    this.startedAt = hello.startedAt;
    this.lost = false;
    this.connectedAt = now;
    this.state = "connected";
    return { reconnected, restarted };
  }

  failed(failure: Failure, now: number): FailureDecision {
    if (this.state === "auth-failed") return { retryInMs: null };
    if (failure.kind === "auth") {
      this.state = "auth-failed";
      return { retryInMs: null };
    }
    const decision: FailureDecision = { retryInMs: 0 };
    if (this.connectedAt !== undefined) {
      if (now - this.connectedAt >= this.stableMs) this.failures = 0;
      this.connectedAt = undefined;
      this.lost = true;
      decision.lostAt = now;
    }
    const cap = Math.min(this.maxMs, this.baseMs * 2 ** this.failures);
    this.failures++;
    let delay = Math.round(cap * (0.5 + 0.5 * Math.min(1, Math.max(0, this.random()))));
    if (failure.kind === "http" && failure.retryAfterMs !== undefined) {
      delay = Math.max(delay, failure.retryAfterMs);
    }
    decision.retryInMs = delay;
    this.state = "disconnected";
    return decision;
  }

  /** The backoff elapsed: a new attempt starts. */
  retrying(): void {
    if (this.state !== "auth-failed") this.state = "reconnecting";
  }
}
