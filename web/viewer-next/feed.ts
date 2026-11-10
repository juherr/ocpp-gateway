/**
 * The adapter between the gateway's live stream and one Open OCPP Trace
 * viewer: maps documents to entries, applies delivery updates and reports
 * gaps, as batches of `EntryUpdate`s. DOM-free and transport-free: the page
 * feeds it what `startLiveStream` (../viewer/stream.ts) reads and decodes.
 */

import type { EntryUpdate, GapEntry, ViewerAdapter } from "@open-ocpp-trace/viewer-standalone";
import { DELIVERY_STATUS_RANK } from "../../src/trace/record";
import type { DeliveryUpdate, Hello, StreamEvent, WireTraceDocument } from "../viewer/model";
import { type EntryDelivery, gatewayEntry, toEntryDelivery } from "./mapping";

/** The gateway's default `VIEWER_MAX_BUFFERED_MESSAGES`, used until the first hello. */
export const DEFAULT_MAX_BUFFERED_MESSAGES = 1000;

/** Counters of a feed, cumulative. */
export interface GatewayFeedCounters {
  /** Trace documents received, records and frames. */
  readonly received: number;
  /** Delivery updates applied. */
  readonly deliveryUpdates: number;
  /** Delivery updates ignored: unknown id, index out of range, unknown or not higher rank. */
  readonly ignoredUpdates: number;
  /** Events the gateway dropped for this client, from its `gap` events. */
  readonly droppedByServer: number;
  /** Per-entry delivery states evicted by the bound. */
  readonly evicted: number;
}

export interface GatewayFeedOptions {
  /** The current time, as RFC 3339. Defaults to the system clock. */
  readonly now?: () => string;
}

export interface GatewayFeed {
  /** The adapter a viewer connects to; its snapshot is empty (no history). */
  readonly adapter: ViewerAdapter;
  /** A decoded stream event. `hello` is ignored: `connected` reports it. */
  event(event: StreamEvent): void;
  /** An established stream was lost at `at` (ms since the epoch), as `onLost` says. */
  lost(at: number): void;
  /** A stream said hello, as `onConnected` says: after a loss, a gap is listed. */
  connected(result: { reconnected: boolean; restarted: boolean }, hello: Hello): void;
  /**
   * How many entries' delivery states the feed keeps: twice the first
   * hello's `maxBufferedMessages`, as a paused viewer holds its listed
   * entries plus as many pending ones. The oldest state is evicted first.
   */
  readonly capacity: number;
  /** The ids whose delivery state is kept, oldest first. */
  trackedIds(): string[];
  counters(): GatewayFeedCounters;
}

type Counters = { -readonly [K in keyof GatewayFeedCounters]: number };

function rankOf(status: string): number | undefined {
  return Object.hasOwn(DELIVERY_STATUS_RANK, status)
    ? DELIVERY_STATUS_RANK[status as keyof typeof DELIVERY_STATUS_RANK]
    : undefined;
}

/** Creates the state of one gateway stream feeding one viewer. */
export function createGatewayFeed(options: GatewayFeedOptions = {}): GatewayFeed {
  const now = options.now ?? ((): string => new Date().toISOString());
  const listeners = new Set<(batch: readonly EntryUpdate[]) => void>();
  /** Deliveries per entry id, in insertion order: a FIFO. */
  const deliveries = new Map<string, EntryDelivery[]>();
  const counters: Counters = {
    received: 0,
    deliveryUpdates: 0,
    ignoredUpdates: 0,
    droppedByServer: 0,
    evicted: 0,
  };
  let capacity = 2 * DEFAULT_MAX_BUFFERED_MESSAGES;
  let hadHello = false;
  let lostAt: string | undefined;
  let gapCount = 0;

  const emit = (batch: readonly EntryUpdate[]): void => {
    for (const listener of listeners) listener(batch);
  };

  const gap = (fields: Omit<GapEntry, "kind" | "id">): void => {
    gapCount += 1;
    emit([{ type: "add", entry: { kind: "gap", id: `gateway-gap-${gapCount}`, ...fields } }]);
  };

  const onTrace = (doc: WireTraceDocument): void => {
    counters.received += 1;
    if (!deliveries.has(doc.id)) {
      deliveries.set(doc.id, doc.deliveries.map(toEntryDelivery));
      for (const id of deliveries.keys()) {
        if (deliveries.size <= capacity) break;
        deliveries.delete(id);
        counters.evicted += 1;
      }
    }
    emit([{ type: "add", entry: gatewayEntry(doc) }]);
  };

  const onDelivery = ({ id, index, delivery }: DeliveryUpdate): void => {
    const list = deliveries.get(id);
    const current = list !== undefined && Number.isInteger(index) ? list[index] : undefined;
    const rank = rankOf(delivery.status);
    if (
      list === undefined ||
      current === undefined ||
      rank === undefined ||
      rank <= (rankOf(current.status) ?? -1)
    ) {
      counters.ignoredUpdates += 1;
      return;
    }
    // The index names the destination: the target and role stay the ones
    // the document announced.
    list[index] = { ...toEntryDelivery(delivery), target: current.target, role: current.role };
    counters.deliveryUpdates += 1;
    emit([{ type: "update", id, metadata: { deliveries: [...list] } }]);
  };

  return {
    adapter: {
      snapshot: () => [],
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    event(event) {
      switch (event.type) {
        case "trace":
          return onTrace(event.doc);
        case "delivery":
          return onDelivery(event.update);
        case "gap":
          counters.droppedByServer += event.dropped;
          return gap({ reason: "dropped", missedCount: event.dropped, timestamp: now() });
        case "hello":
          return;
      }
    },
    lost(at) {
      if (hadHello && lostAt === undefined) lostAt = new Date(at).toISOString();
    },
    connected({ reconnected, restarted }, hello) {
      if (!hadHello) {
        hadHello = true;
        // Fixed on the first hello: the viewer's store bounds are fixed when
        // it is mounted, on that same hello.
        capacity = 2 * hello.maxBufferedMessages;
      } else if (reconnected || restarted) {
        const timestamp = lostAt ?? now();
        if (restarted) {
          gap({
            reason: "restarted",
            timestamp,
            metadata: { custom: { startedAt: hello.startedAt } },
          });
        } else {
          gap({ reason: "disconnected", timestamp });
        }
      }
      lostAt = undefined;
    },
    get capacity() {
      return capacity;
    },
    trackedIds: () => [...deliveries.keys()],
    counters: () => ({ ...counters }),
  };
}
