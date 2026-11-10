import type { EntryUpdate } from "@open-ocpp-trace/viewer-standalone";
import { describe, expect, it } from "vitest";
import type { Hello, WireDelivery, WireTraceDocument } from "../../../web/viewer/model";
import { createGatewayFeed, type GatewayFeed } from "../../../web/viewer-next/feed";
import { callDoc, delivery, frameDoc, withStatuses } from "../web/fixtures";

const NOW = "2026-10-29T15:00:00.000Z";

function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    serverTime: NOW,
    startedAt: "2026-10-29T14:00:00.000Z",
    maxBufferedMessages: 10,
    ...overrides,
  };
}

/** A feed with a recording subscriber, connected once. */
function connectedFeed(first: Hello = hello()): { feed: GatewayFeed; batches: EntryUpdate[][] } {
  const feed = createGatewayFeed({ now: () => NOW });
  const batches: EntryUpdate[][] = [];
  feed.adapter.subscribe((batch) => batches.push([...batch]));
  feed.connected({ reconnected: false, restarted: false }, first);
  return { feed, batches };
}

const trace = (doc: WireTraceDocument) => ({ type: "trace" as const, doc });
const update = (id: string, index: number, d: WireDelivery) => ({
  type: "delivery" as const,
  update: { id, index, delivery: d },
});

describe("createGatewayFeed", () => {
  it("has an empty snapshot and emits one add per trace or frame document", () => {
    const { feed, batches } = connectedFeed();
    const call = callDoc();
    const frame = frameDoc();

    feed.event(trace(call));
    feed.event(trace(frame));

    expect(feed.adapter.snapshot()).toEqual([]);
    expect(
      batches.map((b) => b.map((u) => u.type === "add" && [u.entry.kind, u.entry.id])),
    ).toEqual([[["trace", call.id]], [["unparsed", frame.id]]]);
    expect(feed.counters().received).toBe(2);
  });

  it("ignores the hello event: the connection is reported through connected()", () => {
    const { feed, batches } = connectedFeed();

    feed.event({ type: "hello", hello: hello() });

    expect(batches).toEqual([]);
  });

  describe("delivery updates", () => {
    it("update the existing entry's deliveries, never add a second entry", () => {
      const { feed, batches } = connectedFeed();
      const doc = withStatuses(callDoc(), "queued", "queued");
      feed.event(trace(doc));

      feed.event(
        update(doc.id, 1, delivery({ target: "ignored", role: "primary", status: "written" })),
      );

      expect(batches).toHaveLength(2);
      expect(batches[1]).toEqual([
        {
          type: "update",
          id: doc.id,
          metadata: {
            deliveries: [
              {
                target: "csms-a",
                role: "primary",
                status: "queued",
                updatedAt: "2026-10-29T14:32:01.421Z",
              },
              // The index names the destination: target and role stay the document's.
              {
                target: "mirror-1",
                role: "secondary",
                status: "written",
                updatedAt: "2026-10-29T14:32:01.421Z",
              },
            ],
          },
        },
      ]);
      expect(feed.counters()).toMatchObject({ deliveryUpdates: 1, ignoredUpdates: 0 });
    });

    it("move forward only: an update of equal or lower rank is ignored", () => {
      const { feed, batches } = connectedFeed();
      const doc = callDoc();
      feed.event(trace(doc));
      feed.event(update(doc.id, 0, delivery({ status: "submitted" })));

      feed.event(update(doc.id, 0, delivery({ status: "submitted" })));
      feed.event(update(doc.id, 0, delivery({ status: "queued" })));
      feed.event(update(doc.id, 0, delivery({ status: "failed", reason: "boom" })));
      feed.event(update(doc.id, 0, delivery({ status: "written" })));

      const statuses = batches
        .slice(1)
        .map((b) => b[0]?.type === "update" && b[0].metadata.deliveries?.[0]?.status);
      expect(statuses).toEqual(["submitted", "failed"]);
      expect(feed.counters()).toMatchObject({ deliveryUpdates: 2, ignoredUpdates: 3 });
    });

    it.each([
      ["an unknown id", "trace-unknown", 0],
      ["an index out of range", undefined, 1],
      ["a negative index", undefined, -1],
    ])("ignore %s", (_label, id, index) => {
      const { feed, batches } = connectedFeed();
      const doc = callDoc();
      feed.event(trace(doc));

      feed.event(update(id ?? doc.id, index, delivery({ status: "written" })));

      expect(batches).toHaveLength(1);
      expect(feed.counters().ignoredUpdates).toBe(1);
    });

    it("ignore an unknown status", () => {
      const { feed, batches } = connectedFeed();
      const doc = callDoc();
      feed.event(trace(doc));

      feed.event(
        update(doc.id, 0, { ...delivery(), status: "teleported" } as unknown as WireDelivery),
      );

      expect(batches).toHaveLength(1);
      expect(feed.counters().ignoredUpdates).toBe(1);
    });

    it("never change the delivery list the document carried", () => {
      const { feed } = connectedFeed();
      const doc = callDoc();
      feed.event(trace(doc));

      feed.event(update(doc.id, 0, delivery({ status: "written" })));

      expect(doc.deliveries[0]?.status).toBe("queued");
    });
  });

  describe("bounded state", () => {
    it("keeps the delivery state of twice the first hello's buffer, evicting the oldest", () => {
      const { feed } = connectedFeed(hello({ maxBufferedMessages: 2 }));
      const docs = [callDoc(), callDoc(), callDoc(), callDoc(), callDoc()];
      for (const doc of docs) feed.event(trace(doc));

      expect(feed.capacity).toBe(4);
      expect(feed.trackedIds()).toEqual(docs.slice(1).map((d) => d.id));
      expect(feed.counters().evicted).toBe(1);

      // The evicted entry's update is ignored, a tracked one still applies.
      feed.event(update(docs[0]!.id, 0, delivery({ status: "written" })));
      feed.event(update(docs[1]!.id, 0, delivery({ status: "written" })));
      expect(feed.counters()).toMatchObject({ deliveryUpdates: 1, ignoredUpdates: 1 });
    });

    it("keeps the capacity of the first hello after a restart", () => {
      const { feed } = connectedFeed(hello({ maxBufferedMessages: 2 }));
      feed.lost(Date.parse(NOW));

      feed.connected(
        { reconnected: true, restarted: true },
        hello({ startedAt: "2026-10-29T16:00:00.000Z", maxBufferedMessages: 50 }),
      );

      expect(feed.capacity).toBe(4);
    });

    it("tracks a repeated id once", () => {
      const { feed } = connectedFeed();
      const doc = callDoc();

      feed.event(trace(doc));
      feed.event(trace(doc));

      expect(feed.trackedIds()).toEqual([doc.id]);
    });
  });

  describe("gaps", () => {
    it("reports a gap event as a dropped gap with the missed count", () => {
      const { feed, batches } = connectedFeed();

      feed.event({ type: "gap", dropped: 3 });

      expect(batches).toEqual([
        [
          {
            type: "add",
            entry: {
              kind: "gap",
              id: "gateway-gap-1",
              reason: "dropped",
              missedCount: 3,
              timestamp: NOW,
            },
          },
        ],
      ]);
      expect(feed.counters().droppedByServer).toBe(3);
    });

    it("reports a reconnection as a disconnected gap dated at the loss", () => {
      const { feed, batches } = connectedFeed();
      const lostAt = Date.parse("2026-10-29T14:59:00.000Z");

      feed.lost(lostAt);
      feed.connected({ reconnected: true, restarted: false }, hello());

      expect(batches).toEqual([
        [
          {
            type: "add",
            entry: {
              kind: "gap",
              id: "gateway-gap-1",
              reason: "disconnected",
              timestamp: "2026-10-29T14:59:00.000Z",
            },
          },
        ],
      ]);
    });

    it("reports a restarted gateway as a restarted gap", () => {
      const { feed, batches } = connectedFeed();
      feed.lost(Date.parse("2026-10-29T14:59:00.000Z"));

      feed.connected(
        { reconnected: true, restarted: true },
        hello({ startedAt: "2026-10-29T14:59:30.000Z" }),
      );

      expect(batches[0]?.[0]).toMatchObject({
        type: "add",
        entry: {
          kind: "gap",
          reason: "restarted",
          timestamp: "2026-10-29T14:59:00.000Z",
          metadata: { custom: { startedAt: "2026-10-29T14:59:30.000Z" } },
        },
      });
    });

    it("dates the gap at the first loss since the last hello, and numbers gaps apart", () => {
      const { feed, batches } = connectedFeed();
      feed.lost(Date.parse("2026-10-29T14:59:00.000Z"));
      feed.lost(Date.parse("2026-10-29T14:59:20.000Z"));
      feed.connected({ reconnected: true, restarted: false }, hello());
      feed.event({ type: "gap", dropped: 1 });

      const gaps = batches.map((b) => b[0]?.type === "add" && b[0].entry);
      expect(gaps).toMatchObject([
        { id: "gateway-gap-1", timestamp: "2026-10-29T14:59:00.000Z" },
        { id: "gateway-gap-2" },
      ]);
    });

    it("emits no gap on the first connection", () => {
      const { batches } = connectedFeed();

      expect(batches).toEqual([]);
    });
  });

  it("stops notifying an unsubscribed listener", () => {
    const feed = createGatewayFeed({ now: () => NOW });
    const seen: unknown[] = [];
    const unsubscribe = feed.adapter.subscribe((batch) => seen.push(batch));
    feed.connected({ reconnected: false, restarted: false }, hello());

    unsubscribe();
    feed.event(trace(callDoc()));

    expect(seen).toEqual([]);
  });
});
