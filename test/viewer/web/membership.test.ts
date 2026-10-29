import { describe, expect, it } from "vitest";
import {
  type DeliveryStatus,
  EMPTY_FILTER,
  filterPredicate,
  listedEntries,
  membershipChanges,
  toJsonl,
  type TraceEntry,
  TraceStore,
  type WireTraceDocument,
} from "../../../web/viewer/model";
import { callDoc, delivery, withStatuses } from "./fixtures";

/**
 * What the page does with a delivery update under a delivery filter: the
 * rows that come or go, and where a new one goes. Statuses only move
 * forward (queued, submitted, written).
 */

/** One message per initial status, listed under a filter on `status`. */
function setUp(statuses: DeliveryStatus[], status: DeliveryStatus, capacity = 100) {
  const store = new TraceStore(capacity);
  const docs = statuses.map((initial) => {
    const doc = withStatuses(callDoc(), initial);
    store.addTrace(doc);
    return doc;
  });
  const visible = filterPredicate({ ...EMPTY_FILTER, delivery: status });
  // The rows the page shows: the listed entries the filter lets through.
  const shown = new Set(
    store
      .entries()
      .filter(visible)
      .map((e) => e.key),
  );
  const isShown = (key: number) => shown.has(key);
  const update = (doc: WireTraceDocument, next: DeliveryStatus) =>
    store.applyDelivery({
      id: doc.id,
      index: 0,
      delivery: delivery({ status: next }),
    }) as TraceEntry;
  const keyOf = (doc: WireTraceDocument) => store.get(doc.id)?.key;
  return { store, docs, visible, isShown, update, keyOf };
}

describe("membershipChanges", () => {
  it("removes a listed message that no longer passes the filter, while live", () => {
    const { store, docs, visible, isShown, update } = setUp(["queued", "queued"], "queued");
    const changed = update(docs[1], "written");
    expect(membershipChanges(store.entries(), isShown, [changed], visible, false)).toEqual({
      insert: [],
      remove: [changed.key],
    });
  });

  it("inserts a listed message that now passes the filter, before the next row", () => {
    const { store, docs, visible, isShown, update, keyOf } = setUp(
      ["written", "queued", "queued", "written"],
      "written",
    );
    const changed = update(docs[1], "written");
    expect(membershipChanges(store.entries(), isShown, [changed], visible, false)).toEqual({
      insert: [{ entry: changed, beforeKey: keyOf(docs[3]) }],
      remove: [],
    });
  });

  it("appends a message after the last row", () => {
    const { store, docs, visible, isShown, update } = setUp(["written", "queued"], "written");
    const changed = update(docs[1], "written");
    expect(membershipChanges(store.entries(), isShown, [changed], visible, false).insert).toEqual([
      { entry: changed, beforeKey: null },
    ]);
  });

  it("changes nothing while paused, then applies the change on resume", () => {
    const { store, docs, visible, isShown, update } = setUp(["queued", "queued"], "queued");
    store.pause();
    const changed = update(docs[1], "written");
    expect(membershipChanges(store.entries(), isShown, [changed], visible, true)).toEqual({
      insert: [],
      remove: [],
    });
    store.resume();
    expect(membershipChanges(store.entries(), isShown, [changed], visible, false)).toEqual({
      insert: [],
      remove: [changed.key],
    });
  });

  it("inserts in reception order whatever the update order", () => {
    const { store, docs, visible, isShown, update, keyOf } = setUp(
      ["written", "queued", "queued", "written"],
      "written",
    );
    const b = update(docs[2], "written");
    const a = update(docs[1], "written");
    expect(membershipChanges(store.entries(), isShown, [b, a], visible, false).insert).toEqual([
      { entry: a, beforeKey: keyOf(docs[3]) },
      { entry: b, beforeKey: keyOf(docs[3]) },
    ]);
  });

  it("never inserts before a row removed by the same change", () => {
    const { store, docs, visible, isShown, update, keyOf } = setUp(
      ["queued", "submitted", "submitted"],
      "submitted",
    );
    const entering = update(docs[0], "submitted");
    const leaving = update(docs[1], "written");
    expect(
      membershipChanges(store.entries(), isShown, [entering, leaving], visible, false),
    ).toEqual({
      insert: [{ entry: entering, beforeKey: keyOf(docs[2]) }],
      remove: [leaving.key],
    });
  });

  it("ignores an evicted message", () => {
    const { store, docs, visible, isShown, update } = setUp(["queued", "queued"], "queued", 2);
    const evicted = update(docs[0], "written");
    store.addTrace(withStatuses(callDoc(), "queued"));
    expect(store.get(docs[0].id)).toBeUndefined();
    expect(membershipChanges(store.entries(), isShown, [evicted], visible, false)).toEqual({
      insert: [],
      remove: [],
    });
  });

  it("ignores a message held while paused: it is not listed yet", () => {
    const { store, visible, isShown, update } = setUp(["written"], "written");
    store.pause();
    const doc = withStatuses(callDoc(), "queued");
    store.addTrace(doc);
    const held = update(doc, "written");
    expect(store.isPending(held)).toBe(true);
    // Even evaluated as live: only listed messages come or go.
    expect(membershipChanges(store.entries(), isShown, [held], visible, false)).toEqual({
      insert: [],
      remove: [],
    });
  });
});

describe("listedEntries", () => {
  it("exports the rows listed while paused, not a new evaluation of the filters", () => {
    const { store, docs, visible, isShown, update, keyOf } = setUp(
      ["queued", "queued", "queued"],
      "queued",
    );
    store.pause();
    const changed = update(docs[1], "written");
    // Paused: the row stays listed.
    expect(membershipChanges(store.entries(), isShown, [changed], visible, true).remove).toEqual(
      [],
    );
    const exported = listedEntries(store.entries(), isShown);
    expect(exported.map((e) => e.key)).toEqual(docs.map(keyOf));
    expect(store.entries().filter(visible)).toHaveLength(2);
    expect(toJsonl(exported, "trace").trimEnd().split("\n")).toHaveLength(3);
  });
});
