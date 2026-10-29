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
 * OCPP traffic is). The parsed payload and the DOM cost a few times more, so
 * this keeps a tab with large frames well under a gigabyte.
 */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

/** What an entry weighs against the byte bound: its raw frame's length. */
function weight(entry: Entry): number {
  if (entry.kind !== "trace") return 0;
  const { raw } = capturedOf(entry.doc);
  return typeof raw === "string" ? raw.length : 0;
}

/**
 * The last `capacity` entries (messages and gap markers), in reception order,
 * holding at most `maxBytes` of raw frames — except for a single message
 * larger than that, kept alone. The oldest are evicted first, and counted.
 */
export class TraceStore {
  private items: Entry[] = [];
  private head = 0;
  private readonly byId = new Map<string, TraceEntry>();
  private readonly sessionCounts = new Map<string, number>();
  private nextKey = 1;
  /** Messages received since the page loaded. */
  received = 0;
  /** Messages pushed out by the bounds: what the page reports as removed. */
  evictedMessages = 0;
  /** Gap markers pushed out by the bounds. */
  evictedGaps = 0;
  /** The buffered messages' weight against `maxBytes`. */
  bytes = 0;

  constructor(
    private capacity: number,
    private readonly maxBytes = MAX_BUFFERED_BYTES,
  ) {}

  /** Distinct sessions among the buffered messages. */
  get sessions(): number {
    return this.sessionCounts.size;
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

  /** Changes the capacity (at least 1; ignored unless finite); returns the entries evicted. */
  setCapacity(capacity: number): Entry[] {
    if (typeof capacity !== "number" || !Number.isFinite(capacity)) return [];
    this.capacity = Math.max(1, Math.floor(capacity));
    return this.trim();
  }

  addTrace(doc: WireTraceDocument): AddResult<TraceEntry> {
    const entry: TraceEntry = { kind: "trace", key: this.nextKey++, doc, summary: summarize(doc) };
    this.received++;
    this.byId.set(doc.id, entry);
    this.sessionCounts.set(doc.sessionId, (this.sessionCounts.get(doc.sessionId) ?? 0) + 1);
    this.bytes += weight(entry);
    this.items.push(entry);
    return { added: entry, evicted: this.trim() };
  }

  /**
   * Adds a gap marker, or extends the last entry when it is a gap of the same
   * kind: a connection that keeps failing never floods the buffer.
   */
  addGap(gap: NewGap): AddResult<GapEntry> {
    const last = this.size > 0 ? this.items[this.items.length - 1] : undefined;
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
    this.items.push(entry);
    return { added: entry, evicted: this.trim() };
  }

  /** Ends the open disconnection gap, if any; returns it. */
  closeGap(at: string, restarted: boolean): GapEntry | undefined {
    for (let i = this.items.length - 1; i >= this.head; i--) {
      const entry = this.items[i];
      if (entry.kind === "gap" && entry.reason === "disconnected" && entry.to === undefined) {
        entry.to = at;
        entry.restarted = (entry.restarted ?? false) || restarted;
        return entry;
      }
    }
    return undefined;
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

  /** Empties the buffer, keeping the totals; returns the entries removed. */
  clear(): Entry[] {
    const removed = this.items.slice(this.head);
    this.items = [];
    this.head = 0;
    this.byId.clear();
    this.sessionCounts.clear();
    this.bytes = 0;
    return removed;
  }

  private trim(): Entry[] {
    const evicted: Entry[] = [];
    while (this.size > this.capacity || (this.bytes > this.maxBytes && this.size > 1)) {
      const entry = this.items[this.head++];
      evicted.push(entry);
      this.forget(entry);
      if (entry.kind === "trace") this.evictedMessages++;
      else this.evictedGaps++;
    }
    if (this.head > 1024 && this.head * 2 > this.items.length) this.compact();
    return evicted;
  }

  private forget(entry: Entry): void {
    if (entry.kind !== "trace") return;
    this.bytes -= weight(entry);
    this.byId.delete(entry.doc.id);
    const count = (this.sessionCounts.get(entry.doc.sessionId) ?? 1) - 1;
    if (count > 0) this.sessionCounts.set(entry.doc.sessionId, count);
    else this.sessionCounts.delete(entry.doc.sessionId);
  }

  private compact(): void {
    if (this.head === 0) return;
    this.items = this.items.slice(this.head);
    this.head = 0;
  }
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
