import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_MESSAGE_BYTES } from "../../../src/config";
import { LiveTraceHub } from "../../../src/viewer/hub";
import { startViewer } from "../../../src/viewer/server";
import {
  type ConnectionState,
  EMPTY_FILTER,
  filterPredicate,
  toJsonl,
  TraceStore,
} from "../../../web/viewer/model";
import { SseParser } from "../../../web/viewer/sse";
import { startLiveStream } from "../../../web/viewer/stream";
import { boot, connectWhenOpen, makeCsms, startGateway, waitFor } from "../../helpers";
import { rawFidelityErrors, schemaErrors, type SpecRecord } from "../../trace/conformance";

/**
 * The page's export against a real gateway and viewer: every exported line is
 * the trace record the gateway streamed, unchanged, and conforms to Open OCPP
 * Trace v1.1; unparsed frames are only in their own export.
 */

const USERNAME = "viewer-user-5e1a";
const PASSWORD = "viewer-pw-03c7";
const AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Answers a CALL with a CALLRESULT, `DataTransfer` with a CALLERROR; ignores anything else. */
const reply = (tag: string) => (message: string) => {
  try {
    const [type, id, action] = JSON.parse(message) as [number, string, string];
    if (type !== 2) return undefined;
    return action === "DataTransfer"
      ? JSON.stringify([4, id, "NotImplemented", "No vendor extension", {}])
      : JSON.stringify([3, id, { currentTime: "2026-10-29T00:00:00Z", from: tag }]);
  } catch {
    return undefined;
  }
};

async function startStack() {
  const primary = makeCsms("primary", 0, { reply: reply("primary") });
  const mirror = makeCsms("mirror", 0, { reply: reply("mirror") });
  for (const csms of [primary, mirror]) cleanups.push(() => csms.close());
  await Promise.all([once(primary.wss, "listening"), once(mirror.wss, "listening")]);
  const hub = new LiveTraceHub({
    maxClients: 5,
    maxBufferedMessages: 100,
    maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  });
  cleanups.push(() => hub.close());
  const gateway = await startGateway(
    {
      default: {
        primary: { id: "csms-main", url: primary.url() },
        secondaries: [{ id: "mirror-1", url: mirror.url() }],
      },
    },
    {},
    { liveSink: hub },
  );
  cleanups.push(() => gateway.close());
  const viewer = startViewer(
    {
      username: USERNAME,
      password: PASSWORD,
      host: "127.0.0.1",
      port: 0,
      maxBufferedMessages: 100,
      maxClients: 5,
    },
    { assets: { html: "", js: "", css: "" }, events: hub.handle },
  );
  cleanups.push(() => viewer.close());
  await once(viewer.server, "listening");
  return {
    gatewayPort: gateway.port,
    viewerPort: (viewer.server.address() as AddressInfo).port,
    mirror,
  };
}

/** The page's model fed by its own stream code. */
function follow(viewerPort: number) {
  const store = new TraceStore(100);
  const states: ConnectionState[] = [];
  const stream = startLiveStream(
    {
      onState: (state) => states.push(state),
      onLost: () => {},
      onConnected: () => {},
      onEvent: (event) => {
        if (event.type === "trace") store.addTrace(event.doc);
        else if (event.type === "delivery") store.applyDelivery(event.update);
      },
    },
    { url: `http://127.0.0.1:${viewerPort}/events`, headers: { authorization: AUTH } },
  );
  cleanups.push(() => stream.stop());
  return { store, states };
}

/** The streamed trace events' data, as sent, by document id. */
async function recordWire(viewerPort: number) {
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const response = await fetch(`http://127.0.0.1:${viewerPort}/events`, {
    headers: { authorization: AUTH },
    signal: controller.signal,
  });
  const data = new Map<string, string>();
  const parser = new SseParser((event) => {
    if (event.event === "trace")
      data.set((JSON.parse(event.data) as { id: string }).id, event.data);
  });
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        parser.push(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // Aborted at cleanup.
    }
  })();
  return data;
}

const lines = (jsonl: string) => jsonl.split("\n").slice(0, -1);

describe("the viewer page's export against a live gateway", () => {
  it("exports conforming v1.1 records exactly as streamed, frames apart", async () => {
    const { gatewayPort, viewerPort, mirror } = await startStack();
    const wire = await recordWire(viewerPort);
    const { store, states } = follow(viewerPort);
    await waitFor(() => states.includes("connected"));

    const ws = await connectWhenOpen(`ws://127.0.0.1:${gatewayPort}/CP-001`, "ocpp1.6");
    cleanups.push(() => ws.terminate());
    ws.send(boot("boot-1"));
    await waitFor(() => mirror.received().length === 1);
    ws.send(JSON.stringify([2, "dt-1", "DataTransfer", { vendorId: "X" }]));
    ws.send("{oops");

    // Charger: 2 CALLs + 1 frame; primary: CALLRESULT + CALLERROR; mirror: the same.
    await waitFor(() => store.size === 7 && wire.size === 7);
    await waitFor(() =>
      store.entries().every((e) => e.kind === "trace" && e.summary.delivery !== "queued"),
    );

    const exported = lines(toJsonl(store.entries(), "trace"));
    expect(exported).toHaveLength(6);
    const types = new Set<string>();
    const sources = new Set<string>();
    for (const line of exported) {
      const record = JSON.parse(line) as SpecRecord & {
        meta: { gateway: { traceId: string; source: { type: string; role?: string } } };
      };
      expect(schemaErrors(record)).toEqual([]);
      expect(rawFidelityErrors(record)).toEqual([]);
      expect(record.schemaVersion).toBe("1.1");
      const streamed = JSON.parse(wire.get(record.meta.gateway.traceId) as string) as {
        trace: unknown;
      };
      expect(line).toBe(JSON.stringify(streamed.trace));
      types.add(record.messageType);
      sources.add(record.meta.gateway.source.role ?? record.meta.gateway.source.type);
    }
    expect(types).toEqual(new Set(["CALL", "CALLRESULT", "CALLERROR"]));
    expect(sources).toEqual(new Set(["charge-point", "primary", "secondary"]));

    const frames = lines(toJsonl(store.entries(), "frame"));
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0])).toMatchObject({ raw: "{oops", reason: "invalid-json" });
    expect(exported.some((line) => line.includes("{oops"))).toBe(false);

    const errorsOnly = filterPredicate({ ...EMPTY_FILTER, messageType: "CALLERROR" });
    const filtered = lines(toJsonl(store.entries().filter(errorsOnly), "trace"));
    expect(filtered).toHaveLength(2);
    expect(
      filtered.every((line) => (JSON.parse(line) as SpecRecord).messageType === "CALLERROR"),
    ).toBe(true);
  });
});
