import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLogger } from "../../src/logger";
import type { Delivery, TraceDocument } from "../../src/trace/record";
import { LiveTraceHub, type LiveTraceHubOptions, type StreamClient } from "../../src/viewer/hub";
import { captureReports } from "../memory-reporter";

/** A stream whose bytes stay buffered while `held`, like a socket nobody reads. */
class FakeClient implements StreamClient {
  readonly chunks: string[] = [];
  writableLength = 0;
  held = false;
  ended = false;
  destroyed = false;
  throwOnWrite = false;

  write(chunk: Buffer | string): boolean {
    if (this.throwOnWrite) throw new Error("socket gone");
    this.chunks.push(chunk.toString());
    if (this.held) this.writableLength += Buffer.byteLength(chunk);
    return !this.held;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Let the peer read everything buffered so far. */
  drain(): void {
    this.held = false;
    this.writableLength = 0;
  }

  text(): string {
    return this.chunks.join("");
  }

  /** The SSE events received, comments (pings) left out. */
  events(): { event?: string; id?: string; data?: unknown }[] {
    return this.text()
      .split("\n\n")
      .filter((block) => block !== "" && !block.startsWith(":"))
      .map((block) => {
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          const colon = line.indexOf(":");
          fields[line.slice(0, colon)] = line.slice(colon + 2);
        }
        return {
          event: fields.event,
          id: fields.id,
          data: fields.data === undefined ? undefined : JSON.parse(fields.data),
        };
      });
  }

  named(name: string) {
    return this.events().filter((e) => e.event === name);
  }
}

const RECEIVED_AT = new Date("2026-10-29T10:00:00.000Z");

function doc(id: string, raw = `[2,"${id}","Heartbeat",{}]`): TraceDocument {
  return {
    id,
    kind: "frame",
    tenantId: null,
    sessionId: "session-1",
    chargePointId: "CP-001",
    seq: 1,
    receivedAt: RECEIVED_AT,
    deliveries: [
      { target: "csms-main", role: "primary", status: "queued", updatedAt: RECEIVED_AT },
    ],
    frame: {
      timestamp: RECEIVED_AT.toISOString(),
      chargePointId: "CP-001",
      direction: "cp-to-csms",
      raw,
      reason: "invalid-json",
      meta: {
        gateway: {
          traceId: id,
          tenantId: null,
          sessionId: "session-1",
          seq: 1,
          source: { type: "charge-point", id: "CP-001" },
          destinations: [{ target: "csms-main", role: "primary" }],
        },
      },
    },
  } as unknown as TraceDocument;
}

const written = (): Delivery => ({
  target: "csms-main",
  role: "primary",
  status: "written",
  updatedAt: new Date("2026-10-29T10:00:01.000Z"),
});

const hubs: LiveTraceHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeHub(options: Partial<LiveTraceHubOptions> = {}) {
  const hub = new LiveTraceHub({
    maxClients: 5,
    maxBufferedMessages: 1000,
    maxMessageBytes: 1024 * 1024,
    ...options,
  });
  hubs.push(hub);
  return hub;
}

function connected(hub: LiveTraceHub) {
  const client = new FakeClient();
  const detach = hub.attach(client);
  return { client, detach };
}

describe("LiveTraceHub", () => {
  it("is inactive without a client, and refuses documents then", () => {
    const hub = makeHub();
    expect(hub.active()).toBe(false);
    expect(hub.insert(doc("t1"))).toBe(false);
    expect(() => hub.updateDelivery("t1", 0, written())).not.toThrow();
    expect(hub.stats()).toMatchObject({ clients: 0, sent: 0, dropped: 0 });
  });

  it("is active while a client is attached", () => {
    const hub = makeHub();
    const { detach } = connected(hub);
    expect(hub.active()).toBe(true);
    detach();
    expect(hub.active()).toBe(false);
    detach(); // idempotent
    expect(hub.stats().clients).toBe(0);
  });

  it("greets a client with a hello event", () => {
    vi.useFakeTimers({ now: new Date("2026-10-29T09:00:00.000Z") });
    const hub = makeHub({ maxBufferedMessages: 321 });
    vi.setSystemTime(new Date("2026-10-29T09:30:00.000Z"));
    const { client } = connected(hub);

    expect(client.events()).toEqual([
      {
        event: "hello",
        id: undefined,
        data: {
          serverTime: "2026-10-29T09:30:00.000Z",
          startedAt: "2026-10-29T09:00:00.000Z",
          maxBufferedMessages: 321,
        },
      },
    ]);
  });

  it("streams an accepted document as a trace event, dates as ISO strings", () => {
    const hub = makeHub();
    const { client } = connected(hub);
    const original = doc("t1");

    expect(hub.insert(original)).toBe(true);

    const [trace] = client.named("trace");
    expect(trace.id).toBeUndefined();
    expect(trace.data).toEqual(JSON.parse(JSON.stringify(original)));
    expect((trace.data as { receivedAt: string }).receivedAt).toBe("2026-10-29T10:00:00.000Z");
    // One `data:` line: the frame's text holds no raw newline.
    expect(client.text()).toMatch(/\nevent: trace\ndata: \{[^\n]*\}\n\n$/);
  });

  it("keeps a frame's newlines escaped, on a single data line", () => {
    const hub = makeHub();
    const { client } = connected(hub);
    hub.insert(doc("t1", 'line one\nline two\r\n"quoted"'));

    const block = client.text().split("\n\n")[1];
    expect(block.split("\n")).toEqual(["event: trace", expect.stringMatching(/^data: \{.*\}$/)]);
    const [trace] = client.named("trace");
    expect((trace.data as { frame: { raw: string } }).frame.raw).toBe(
      'line one\nline two\r\n"quoted"',
    );
  });

  it("serialises a document once, whatever the number of clients", () => {
    const hub = makeHub();
    const clients = [connected(hub), connected(hub), connected(hub)].map((c) => c.client);
    const original = doc("t1");
    const toJSON = vi.fn(() => ({ id: "t1" }));
    (original as unknown as { toJSON: () => unknown }).toJSON = toJSON;

    hub.insert(original);

    expect(toJSON).toHaveBeenCalledTimes(1);
    for (const client of clients) expect(client.named("trace")).toHaveLength(1);
  });

  it("never retains the document: a later mutation is not streamed", () => {
    const hub = makeHub();
    const { client } = connected(hub);
    const original = doc("t1");
    hub.insert(original);
    original.deliveries[0].status = "dropped";
    hub.insert(doc("t2"));

    const [first] = client.named("trace");
    expect((first.data as TraceDocument).deliveries[0].status).toBe("queued");
  });

  it("sends no event id: there is no history to resume from", () => {
    const hub = makeHub();
    const { client: early } = connected(hub);
    hub.insert(doc("t1"));
    const { client: late } = connected(hub);
    hub.insert(doc("t2"));
    hub.updateDelivery("t2", 0, written());

    const traceIds = (client: typeof early) =>
      client.named("trace").map((e) => (e.data as TraceDocument).id);
    expect(traceIds(early)).toEqual(["t1", "t2"]);
    expect(traceIds(late)).toEqual(["t2"]);
    for (const client of [early, late]) expect(client.text()).not.toMatch(/^id:/m);
  });

  it("streams delivery updates", () => {
    const hub = makeHub();
    const { client } = connected(hub);
    hub.insert(doc("t1"));
    hub.updateDelivery("t1", 0, written());

    expect(client.named("delivery")).toEqual([
      {
        event: "delivery",
        id: undefined,
        data: {
          id: "t1",
          index: 0,
          delivery: {
            target: "csms-main",
            role: "primary",
            status: "written",
            updatedAt: "2026-10-29T10:00:01.000Z",
          },
        },
      },
    ]);
    hub.insert(doc("t2"));
    expect(client.named("trace").map((e) => (e.data as TraceDocument).id)).toEqual(["t1", "t2"]);
  });

  it("stops streaming to a detached client", () => {
    const hub = makeHub();
    const { client, detach } = connected(hub);
    detach();
    hub.insert(doc("t1"));
    expect(client.named("trace")).toEqual([]);
  });

  describe("slow clients", () => {
    const SOFT = 1000;

    it("drops events while a client is over the soft bound, then reports the gap", () => {
      const hub = makeHub({ softLimitBytes: SOFT, hardLimitBytes: 100_000 });
      const { client: slow } = connected(hub);
      const { client: fast } = connected(hub);
      slow.held = true;
      slow.writableLength = SOFT; // already over the bound

      hub.insert(doc("t1"));
      hub.updateDelivery("t1", 0, written());
      hub.insert(doc("t2"));
      expect(slow.named("trace")).toEqual([]);
      expect(fast.named("trace")).toHaveLength(2);

      slow.drain();
      hub.insert(doc("t3"));

      const tail = slow.events().slice(1); // after hello
      expect(tail).toEqual([
        { event: "gap", id: undefined, data: { dropped: 3 } },
        expect.objectContaining({ event: "trace", data: expect.objectContaining({ id: "t3" }) }),
      ]);
      expect(hub.stats()).toMatchObject({ dropped: 3, endedSlow: 0 });
      expect(fast.named("gap")).toEqual([]);
    });

    it("still writes one large event to a client under the soft bound", () => {
      const hub = makeHub({ softLimitBytes: SOFT, hardLimitBytes: 100_000 });
      const { client } = connected(hub);
      client.held = true;
      hub.insert(doc("t1", "x".repeat(50 * SOFT)));
      expect(client.named("trace")).toHaveLength(1);
      expect(client.destroyed).toBe(false);
    });

    it("drops, without ending the client, an event that would take its buffer over the hard bound", () => {
      const HARD = 4 * SOFT;
      const hub = makeHub({ softLimitBytes: SOFT, hardLimitBytes: HARD });
      const { client } = connected(hub);
      client.held = true;
      client.writableLength = SOFT - 1; // lagging, still under the soft bound
      const big = doc("t1", "x".repeat(HARD - SOFT + 1)); // larger than hard − soft

      expect(hub.insert(big)).toBe(true);

      expect(client.named("trace")).toEqual([]);
      expect(client.writableLength).toBeLessThanOrEqual(HARD);
      expect(client.destroyed).toBe(false);
      expect(hub.stats()).toMatchObject({ clients: 1, dropped: 1, endedSlow: 0 });

      client.drain();
      hub.insert(doc("t2"));
      expect(client.events().slice(1)).toEqual([
        { event: "gap", id: undefined, data: { dropped: 1 } },
        expect.objectContaining({ event: "trace", data: expect.objectContaining({ id: "t2" }) }),
      ]);
    });

    it("by default, still delivers a frame of control characters to a client just under the soft bound", () => {
      const maxMessageBytes = 1024;
      const hub = makeHub({ maxMessageBytes });
      const { client } = connected(hub);
      client.held = true;
      client.writableLength = 4 * maxMessageBytes - 1;

      hub.insert(doc("t1", "\u0001".repeat(maxMessageBytes))); // ~6× once escaped

      expect(client.named("trace")).toHaveLength(1);
      expect(hub.stats().dropped).toBe(0);
    });

    it("never takes a buffer over the hard bound, small events, gaps and pings included", () => {
      vi.useFakeTimers();
      const HARD = 2 * SOFT;
      const hub = makeHub({ softLimitBytes: SOFT, hardLimitBytes: HARD, heartbeatMs: 1000 });
      const { client } = connected(hub);
      client.held = true;
      for (let i = 0; i < 50; i++) {
        hub.insert(doc(`t${i}`, "x".repeat(i * 7)));
        vi.advanceTimersByTime(250);
        expect(client.writableLength).toBeLessThanOrEqual(HARD);
      }
      expect(hub.stats().peakBufferedBytes).toBeLessThanOrEqual(HARD);
    });

    it("ends a client at the maxDroppedEvents-th event dropped in a row", () => {
      const hub = makeHub({ softLimitBytes: SOFT, hardLimitBytes: 100_000, maxDroppedEvents: 5 });
      const { client } = connected(hub);
      const { client: healthy } = connected(hub);
      client.held = true;
      client.writableLength = SOFT;

      for (let i = 0; i < 4; i++) hub.insert(doc(`t${i}`));
      expect(client.destroyed).toBe(false);
      hub.insert(doc("t4"));

      expect(client.destroyed).toBe(true);
      expect(healthy.destroyed).toBe(false);
      expect(hub.stats()).toMatchObject({ clients: 1, dropped: 5, endedSlow: 1 });
    });

    it("ends a client dropping for longer than maxDroppingMs on its next drop, before any heartbeat", () => {
      vi.useFakeTimers();
      const hub = makeHub({
        softLimitBytes: SOFT,
        hardLimitBytes: 100_000,
        maxDroppingMs: 30_000,
        heartbeatMs: 3_600_000,
      });
      const { client } = connected(hub);
      client.held = true;
      client.writableLength = SOFT;
      hub.insert(doc("t1"));
      vi.advanceTimersByTime(30_000);
      hub.insert(doc("t2"));
      expect(client.destroyed).toBe(false);

      vi.advanceTimersByTime(1);
      hub.insert(doc("t3"));
      expect(client.destroyed).toBe(true);
      expect(hub.stats().endedSlow).toBe(1);
    });

    it("ends a client that keeps dropping for too long, checked on the heartbeat", () => {
      vi.useFakeTimers();
      const hub = makeHub({
        softLimitBytes: SOFT,
        hardLimitBytes: 100_000,
        maxDroppingMs: 20_000,
        heartbeatMs: 15_000,
      });
      const { client } = connected(hub);
      client.held = true;
      client.writableLength = SOFT;
      hub.insert(doc("t1"));

      vi.advanceTimersByTime(15_000);
      expect(client.destroyed).toBe(false);
      vi.advanceTimersByTime(15_000);
      expect(client.destroyed).toBe(true);
      expect(hub.stats().endedSlow).toBe(1);
    });

    it("reports a gap on the heartbeat once the client drained, without waiting for traffic", () => {
      vi.useFakeTimers();
      const hub = makeHub({ softLimitBytes: SOFT, hardLimitBytes: 100_000, heartbeatMs: 15_000 });
      const { client } = connected(hub);
      client.held = true;
      client.writableLength = SOFT;
      hub.insert(doc("t1"));
      client.drain();

      vi.advanceTimersByTime(15_000);
      expect(client.named("gap")).toEqual([{ event: "gap", id: undefined, data: { dropped: 1 } }]);
    });
  });

  it("removes a client whose write throws, without affecting the others", () => {
    const hub = makeHub();
    const { client: broken } = connected(hub);
    const { client: healthy } = connected(hub);
    broken.throwOnWrite = true;

    expect(hub.insert(doc("t1"))).toBe(true);
    expect(() => hub.updateDelivery("t1", 0, written())).not.toThrow();

    expect(broken.destroyed).toBe(true);
    expect(healthy.named("trace")).toHaveLength(1);
    expect(healthy.named("delivery")).toHaveLength(1);
    expect(hub.stats().clients).toBe(1);
  });

  it("never throws from insert: a document that cannot be serialised is refused and reported once", () => {
    const reports = captureReports();
    const hub = makeHub();
    const { client } = connected(hub);
    const broken = doc("t1") as unknown as Record<string, unknown>;
    broken.size = 1n; // BigInt: JSON.stringify throws

    expect(hub.insert(broken as unknown as TraceDocument)).toBe(false);
    expect(hub.insert(broken as unknown as TraceDocument)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(hub.insert(doc("t2"))).toBe(true);
    expect(client.named("trace")).toHaveLength(1);
  });

  it("sends a ping comment on every heartbeat, to every client", () => {
    vi.useFakeTimers();
    const hub = makeHub({ heartbeatMs: 15_000 });
    const { client } = connected(hub);
    vi.advanceTimersByTime(14_999);
    expect(client.text()).not.toContain(": ping");
    vi.advanceTimersByTime(1);
    expect(client.text()).toMatch(/\n\n: ping\n\n$/);
    vi.advanceTimersByTime(15_000);
    expect(client.text().match(/: ping\n\n/g)).toHaveLength(2);
  });

  it("runs no heartbeat timer without a client", () => {
    vi.useFakeTimers();
    const hub = makeHub();
    expect(vi.getTimerCount()).toBe(0);
    const { detach } = connected(hub);
    connected(hub);
    expect(vi.getTimerCount()).toBe(1);
    detach();
    hub.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() ends every stream, logs the counters, and is idempotent", () => {
    const lines: string[] = [];
    configureLogger({
      logLevel: "info",
      sink: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
    });
    const hub = makeHub();
    const clients = [connected(hub), connected(hub)].map((c) => c.client);
    hub.insert(doc("t1"));

    hub.close();
    hub.close();

    for (const client of clients) expect(client.ended).toBe(true);
    expect(hub.active()).toBe(false);
    expect(hub.insert(doc("t2"))).toBe(false);
    const summaries = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "live viewer closed");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ sent: 2, dropped: 0, endedSlow: 0 });
  });

  it("refuses new clients once closed", () => {
    const hub = makeHub();
    hub.close();
    const client = new FakeClient();
    hub.attach(client);
    expect(client.ended).toBe(true);
    expect(hub.active()).toBe(false);
  });

  describe("handle(req, res)", () => {
    class FakeResponse extends EventEmitter {
      status?: number;
      headers: Record<string, unknown> = {};
      body = "";
      ended = false;
      destroyed = false;
      writableEnded = false;
      writableLength = 0;
      flushed = false;
      writeHead(status: number, headers: Record<string, unknown>) {
        this.status = status;
        this.headers = headers;
        return this;
      }
      flushHeaders() {
        this.flushed = true;
      }
      write(chunk: Buffer | string) {
        this.body += chunk.toString();
        return true;
      }
      end(chunk?: string) {
        if (chunk) this.body += chunk;
        this.ended = true;
        this.writableEnded = true;
        return this;
      }
      destroy() {
        this.destroyed = true;
        return this;
      }
    }

    const request = (method: string, headers: Record<string, string> = {}) =>
      ({ method, headers }) as unknown as IncomingMessage;

    function call(hub: LiveTraceHub, method = "GET", headers: Record<string, string> = {}) {
      const res = new FakeResponse();
      hub.handle(request(method, headers), res as unknown as ServerResponse);
      return res;
    }

    it("opens an event stream and registers the client until the response closes", () => {
      const hub = makeHub();
      const res = call(hub);

      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject({
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      expect(res.flushed).toBe(true);
      expect(res.body).toMatch(/^event: hello\ndata: /);
      expect(res.body).not.toContain("retry:");
      expect(hub.active()).toBe(true);

      res.emit("close");
      expect(hub.active()).toBe(false);
    });

    it("drops the client on a response error", () => {
      const hub = makeHub();
      const res = call(hub);
      res.emit("error", new Error("EPIPE"));
      expect(hub.active()).toBe(false);
    });

    it("ignores Last-Event-ID: there is no history to replay", () => {
      const hub = makeHub();
      const res = call(hub, "GET", { "last-event-id": "1" });
      expect(res.body.split("\n\n").filter(Boolean)).toHaveLength(1);
    });

    it("answers HEAD with the stream headers only, without registering a client", () => {
      const hub = makeHub();
      const res = call(hub, "HEAD");
      expect(res.status).toBe(200);
      expect(res.headers).toMatchObject({ "Content-Type": "text/event-stream; charset=utf-8" });
      expect(res.body).toBe("");
      expect(res.ended).toBe(true);
      expect(hub.active()).toBe(false);
    });

    it("refuses a client over maxClients with 503, before any stream starts", () => {
      const hub = makeHub({ maxClients: 2 });
      call(hub);
      call(hub);
      const res = call(hub);

      expect(res.status).toBe(503);
      expect(res.headers).toMatchObject({ "Content-Type": "text/plain; charset=utf-8" });
      expect(res.body).toBe("Too many viewer clients\n");
      expect(res.ended).toBe(true);
      expect(hub.stats().clients).toBe(2);
    });

    it("answers 503 once closed", () => {
      const hub = makeHub();
      hub.close();
      expect(call(hub).status).toBe(503);
    });
  });
});
