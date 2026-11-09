import { readRecords } from "@open-ocpp-trace/jsonl/reader";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  exportFilename,
  filterPredicate,
  jsonlLines,
  TraceStore,
} from "../../../web/viewer/model";
import { schemaErrors, rawFidelityErrors, type SpecRecord } from "../../trace/conformance";
import { callDoc, frameDoc, responseDoc, withStatuses } from "./fixtures";

/** The export as one string. */
const toJsonl = (...args: Parameters<typeof jsonlLines>) => jsonlLines(...args).lines.join("");

function storeWith() {
  const store = new TraceStore(100);
  const call = withStatuses(
    callDoc({ tenantId: "tenant-a", action: "Authorize", payload: { idTag: "TAG-1" } }),
    "written",
  );
  const result = responseDoc("CALLRESULT", "Authorize", { tenantId: "tenant-a" });
  const error = responseDoc("CALLERROR", "Heartbeat");
  const frame = frameDoc({ raw: "[2,broken" });
  for (const doc of [call, result, error, frame]) store.addTrace(doc);
  store.addGap({ reason: "missed", at: "2026-10-29T14:33:00Z", missed: 1 });
  return { store, call, result, error, frame };
}

const lines = (jsonl: string) => jsonl.split("\n").slice(0, -1);

describe("toJsonl", () => {
  it("writes one trace record per line, exactly as received, frames and gaps left out", () => {
    const { store, call, result, error } = storeWith();
    const jsonl = toJsonl(store.entries(), "trace");
    expect(jsonl.endsWith("\n")).toBe(true);
    expect(lines(jsonl)).toEqual(
      [call, result, error].map((d) => JSON.stringify(d.kind === "trace" && d.trace)),
    );
  });

  it("writes records that parse line by line and conform to Open OCPP Trace v1.1", () => {
    const { store } = storeWith();
    for (const line of lines(toJsonl(store.entries(), "trace"))) {
      const record = JSON.parse(line) as SpecRecord;
      expect(record.schemaVersion).toBe("1.1");
      expect(schemaErrors(record)).toEqual([]);
      expect(rawFidelityErrors(record)).toEqual([]);
      expect(record.meta).toEqual({
        gateway: expect.objectContaining({ traceId: expect.any(String) }),
      });
      expect(record).not.toHaveProperty("deliveries");
    }
  });

  it("reads back as the same records through the Open OCPP Trace JSONL reader", async () => {
    const { store, call, result, error } = storeWith();
    const read = [];
    for await (const record of readRecords([toJsonl(store.entries(), "trace")])) read.push(record);
    expect(read).toEqual([call, result, error].map((d) => d.kind === "trace" && d.trace));
  });

  it("skips and counts the trace records that are not valid Open OCPP Trace", () => {
    const store = new TraceStore(10);
    const valid = callDoc({ action: "Heartbeat" });
    const invalid = callDoc({ action: "Authorize" });
    if (invalid.kind !== "trace") throw new Error("expected a trace document");
    store.addTrace({ ...invalid, trace: { ...invalid.trace, timestamp: "yesterday" } });
    store.addTrace(valid);
    const { lines: exported, skipped } = jsonlLines(store.entries(), "trace");
    expect(exported).toEqual([`${JSON.stringify(valid.kind === "trace" && valid.trace)}\n`]);
    expect(skipped).toBe(1);
  });

  it("skips nothing when every record is valid, nor in an unparsed-frame export", () => {
    const { store } = storeWith();
    expect(jsonlLines(store.entries(), "frame").skipped).toBe(0);
    expect(jsonlLines(store.entries(), "trace").skipped).toBe(0);
  });

  it("exports the filtered messages only when given them", () => {
    const { store, call, result } = storeWith();
    const visible = filterPredicate({ ...EMPTY_FILTER, tenant: "tenant-a" });
    const exported = lines(toJsonl(store.entries().filter(visible), "trace")).map(
      (line) =>
        (JSON.parse(line) as { meta: { gateway: { traceId: string } } }).meta.gateway.traceId,
    );
    expect(exported).toEqual([call.id, result.id]);
  });

  it("exports unparsed frames on their own", () => {
    const { store, frame } = storeWith();
    expect(lines(toJsonl(store.entries(), "frame"))).toEqual([
      JSON.stringify(frame.kind === "frame" && frame.frame),
    ]);
  });

  it("is empty without a record of that kind", () => {
    expect(toJsonl([], "trace")).toBe("");
    const store = new TraceStore(5);
    store.addTrace(callDoc());
    expect(toJsonl(store.entries(), "frame")).toBe("");
  });

  it("leaves the messages unchanged", () => {
    const { store } = storeWith();
    const before = structuredClone(store.entries().map((e) => (e.kind === "trace" ? e.doc : e)));
    toJsonl(store.entries(), "trace");
    toJsonl(store.entries(), "frame");
    expect(store.entries().map((e) => (e.kind === "trace" ? e.doc : e))).toEqual(before);
  });
});

describe("exportFilename", () => {
  it("names the file after the export time, without colons", () => {
    const at = new Date("2026-10-29T14:32:01.421Z");
    expect(exportFilename("trace", at)).toBe("ocpp-traces-2026-10-29T14-32-01.421Z.jsonl");
    expect(exportFilename("frame", at)).toBe("ocpp-unparsed-frames-2026-10-29T14-32-01.421Z.jsonl");
  });
});
