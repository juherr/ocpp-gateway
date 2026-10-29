import { describe, expect, it } from "vitest";
import { type Entry, TraceStore } from "../../../web/viewer/model";
import { callDoc, delivery, withStatuses } from "./fixtures";

const keys = (entries: readonly Entry[]) =>
  entries.map((e) => (e.kind === "trace" ? e.doc.id : `gap:${e.reason}`));

describe("TraceStore pause", () => {
  it("holds messages received while paused out of the list, counting them", () => {
    const store = new TraceStore(10);
    const before = callDoc();
    store.addTrace(before);
    store.pause();
    const held = callDoc();
    const { added, evicted } = store.addTrace(held);

    expect(store.paused).toBe(true);
    // Held, not listed: nothing for the page to draw.
    expect(added).toBeUndefined();
    expect(evicted).toEqual([]);
    expect(keys(store.entries())).toEqual([before.id]);
    expect(store.size).toBe(1);
    expect(store.pendingMessages).toBe(1);
    expect(store.received).toBe(2);
    expect(store.get(held.id)?.doc).toBe(held);
  });

  it("lists the held messages on resume, in reception order", () => {
    const store = new TraceStore(10);
    const a = callDoc();
    store.addTrace(a);
    store.pause();
    const b = callDoc();
    const c = callDoc();
    store.addTrace(b);
    store.addTrace(c);

    const { added, evicted } = store.resume();
    expect(store.paused).toBe(false);
    expect(keys(added)).toEqual([b.id, c.id]);
    expect(evicted).toEqual([]);
    expect(keys(store.entries())).toEqual([a.id, b.id, c.id]);
    const listedKeys = store.entries().map((e) => e.key);
    expect(listedKeys).toEqual(listedKeys.toSorted((x, y) => x - y));
    expect(store.pendingMessages).toBe(0);
  });

  it("evicts the oldest listed messages when the resumed ones exceed the capacity", () => {
    const store = new TraceStore(2);
    const a = callDoc();
    const b = callDoc();
    store.addTrace(a);
    store.addTrace(b);
    store.pause();
    const c = callDoc();
    store.addTrace(c);
    const { evicted } = store.resume();
    expect(keys(evicted)).toEqual([a.id]);
    expect(keys(store.entries())).toEqual([b.id, c.id]);
    expect(store.evictedMessages).toBe(1);
  });

  it("bounds the held messages by count, dropping the oldest first, counted apart", () => {
    const store = new TraceStore(2);
    const listed = callDoc();
    store.addTrace(listed);
    store.pause();
    const [a, b, c] = [callDoc(), callDoc(), callDoc()];
    store.addTrace(a);
    store.addTrace(b);
    const { evicted } = store.addTrace(c);

    expect(keys(evicted)).toEqual([a.id]);
    expect(store.pendingMessages).toBe(2);
    expect(store.pendingDropped).toBe(1);
    expect(store.evictedMessages).toBe(0);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.isPending(evicted[0])).toBe(false);
    expect(store.isPending(store.get(b.id) as Entry)).toBe(true);
    expect(store.isPending(store.entries()[0])).toBe(false);
    expect(keys(store.entries())).toEqual([listed.id]);
    expect(keys(store.resume().added)).toEqual([b.id, c.id]);
  });

  it("bounds the held messages by bytes", () => {
    const store = new TraceStore(100, 50);
    store.pause();
    const a = callDoc({ raw: "a".repeat(30) });
    const b = callDoc({ raw: "b".repeat(30) });
    store.addTrace(a);
    store.addTrace(b);
    expect(store.pendingMessages).toBe(1);
    expect(store.pendingDropped).toBe(1);
    expect(keys(store.resume().added)).toEqual([b.id]);
  });

  it("applies delivery updates to listed and held messages alike", () => {
    const store = new TraceStore(10);
    const listed = withStatuses(callDoc(), "queued");
    store.addTrace(listed);
    store.pause();
    const held = withStatuses(callDoc(), "queued");
    store.addTrace(held);

    const written = delivery({ status: "written" });
    expect(
      store.applyDelivery({ id: listed.id, index: 0, delivery: written })?.summary.delivery,
    ).toBe("written");
    expect(
      store.applyDelivery({ id: held.id, index: 0, delivery: written })?.summary.delivery,
    ).toBe("written");
    const [resumed] = store.resume().added;
    expect(resumed.kind === "trace" && resumed.summary.delivery).toBe("written");
  });

  it("ignores delivery updates for dropped held messages", () => {
    const store = new TraceStore(1);
    store.pause();
    const dropped = withStatuses(callDoc(), "queued");
    store.addTrace(dropped);
    store.addTrace(callDoc());
    expect(
      store.applyDelivery({ id: dropped.id, index: 0, delivery: delivery({ status: "written" }) }),
    ).toBeUndefined();
  });

  it("holds gap markers in place: one opened and closed while paused comes after the messages before it", () => {
    const store = new TraceStore(10);
    store.pause();
    const before = callDoc();
    store.addTrace(before);
    const { added } = store.addGap({ reason: "disconnected", at: "2026-10-29T14:33:00Z" });
    expect(added).toBeUndefined();
    const gap = store.closeGap("2026-10-29T14:33:05Z", false)!;
    expect(gap).toMatchObject({ kind: "gap", reason: "disconnected" });
    expect(store.isPending(gap)).toBe(true);
    const after = callDoc();
    store.addTrace(after);
    expect(store.entries()).toEqual([]);

    expect(keys(store.resume().added)).toEqual([before.id, "gap:disconnected", after.id]);
    expect(gap.to).toBe("2026-10-29T14:33:05Z");
    expect(store.isPending(gap)).toBe(false);
  });

  it("merges a missed-events gap only into a held gap while paused", () => {
    const store = new TraceStore(10);
    const { added: listedGap } = store.addGap({
      reason: "missed",
      at: "2026-10-29T14:33:00Z",
      missed: 2,
    });
    store.pause();
    store.addGap({ reason: "missed", at: "2026-10-29T14:33:01Z", missed: 3 });
    store.addGap({ reason: "missed", at: "2026-10-29T14:33:02Z", missed: 1 });
    expect(listedGap!.missed).toBe(2);
    const [held] = store.resume().added;
    expect(held).not.toBe(listedGap);
    expect(held).toMatchObject({ kind: "gap", reason: "missed", missed: 4 });
  });

  it("closes a gap listed before the pause in place", () => {
    const store = new TraceStore(10);
    const { added: gap } = store.addGap({ reason: "disconnected", at: "2026-10-29T14:33:00Z" });
    store.pause();
    expect(store.closeGap("2026-10-29T14:33:05Z", true)).toBe(gap);
    expect(store.isPending(gap)).toBe(false);
    expect(store.pendingMessages).toBe(0);
  });

  it("clears the list and the held messages, still paused, the totals kept", () => {
    const store = new TraceStore(2);
    store.addTrace(callDoc());
    store.pause();
    const held = callDoc();
    store.addTrace(held);
    store.addTrace(callDoc());
    store.addTrace(callDoc());
    store.clear();

    expect(store.entries()).toEqual([]);
    expect(store.pendingMessages).toBe(0);
    expect(store.paused).toBe(true);
    expect(store.sessions).toBe(0);
    expect(store.get(held.id)).toBeUndefined();
    expect(store.received).toBe(4);
    expect(store.pendingDropped).toBe(1);
    expect(store.resume().added).toEqual([]);
  });

  it("trims the held messages to a lower capacity", () => {
    const store = new TraceStore(5);
    store.pause();
    for (let i = 0; i < 4; i++) store.addTrace(callDoc());
    store.setCapacity(2);
    expect(store.pendingMessages).toBe(2);
    expect(store.pendingDropped).toBe(2);
  });

  it("counts the sessions of held messages", () => {
    const store = new TraceStore(5);
    store.pause();
    store.addTrace(callDoc({ sessionId: "s-1" }));
    store.addTrace(callDoc({ sessionId: "s-2" }));
    expect(store.sessions).toBe(2);
  });

  it("ignores pause and resume when already in that state", () => {
    const store = new TraceStore(5);
    expect(store.resume()).toEqual({ added: [], evicted: [] });
    store.pause();
    store.addTrace(callDoc());
    store.pause();
    expect(store.pendingMessages).toBe(1);
  });
});
