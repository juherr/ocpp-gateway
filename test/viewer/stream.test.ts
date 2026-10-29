import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { type AddressInfo, connect as tcpConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_MESSAGE_BYTES, type ViewerConfig } from "../../src/config";
import type { Delivery, TraceDocument } from "../../src/trace/record";
import { LiveTraceHub, type LiveTraceHubOptions } from "../../src/viewer/hub";
import { startViewer, type ViewerServer } from "../../src/viewer/server";
import { boot, connectWhenOpen, makeCsms, sleep, startGateway, waitFor } from "../helpers";

const USERNAME = "viewer-user-77a1";
const PASSWORD = "viewer-pw-3e9c";
const AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

type Csms = ReturnType<typeof makeCsms>;

const answering = (tag: string, options: Parameters<typeof makeCsms>[2] = {}) =>
  makeCsms(tag, 0, {
    reply: (message) => {
      try {
        const [type, id] = JSON.parse(message) as [number, string];
        return type === 2 ? JSON.stringify([3, id, { from: tag }]) : undefined;
      } catch {
        return undefined;
      }
    },
    ...options,
  });

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function csmsFor(...servers: Csms[]) {
  for (const csms of servers) cleanups.push(() => csms.close());
  await Promise.all(servers.map((csms) => once(csms.wss, "listening")));
  return servers;
}

function routes(primary: Csms, ...secondaries: Csms[]) {
  return {
    default: {
      primary: { id: "csms-main", url: primary.url() },
      secondaries: secondaries.map((csms, i) => ({ id: `mirror-${i + 1}`, url: csms.url() })),
    },
  };
}

/** A gateway feeding a live hub, and the viewer streaming it. */
async function startStack(
  table: object,
  {
    hub: hubOptions = {},
    viewer: viewerOptions = {},
    gateway: gatewayOverrides = {},
  }: {
    hub?: Partial<LiveTraceHubOptions>;
    viewer?: Partial<ViewerConfig>;
    gateway?: object;
  } = {},
) {
  const maxClients = viewerOptions.maxClients ?? 5;
  const hub = new LiveTraceHub({
    maxClients,
    maxBufferedMessages: 500,
    maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
    ...hubOptions,
  });
  cleanups.push(() => hub.close());
  const gateway = await startGateway(table, gatewayOverrides, { liveSink: hub });
  cleanups.push(() => gateway.close());
  const viewer = startViewer(
    {
      username: USERNAME,
      password: PASSWORD,
      host: "127.0.0.1",
      port: 0,
      maxBufferedMessages: 500,
      maxClients,
      ...viewerOptions,
    },
    { assets: { html: "", js: "", css: "" }, events: hub.handle },
  );
  cleanups.push(() => viewer.close());
  await once(viewer.server, "listening");
  const viewerPort = (viewer.server.address() as AddressInfo).port;
  return { hub, gatewayPort: gateway.port, viewer, viewerPort };
}

async function charger(port: number, id = "CP-001", headers: Record<string, string> = {}) {
  const ws = await connectWhenOpen(`ws://127.0.0.1:${port}/${id}`, "ocpp1.6", 3000, headers);
  const received: string[] = [];
  ws.on("message", (data) => received.push(data.toString()));
  cleanups.push(() => ws.terminate());
  return { ws, received };
}

interface SseEvent {
  event?: string;
  id?: string;
  data: unknown;
}

/** An SSE reader over `http.request`, parsing the stream as it comes. */
async function openStream(port: number, headers: Record<string, string> = { authorization: AUTH }) {
  const req = request({ host: "127.0.0.1", port, path: "/events", headers, agent: false });
  req.on("error", () => undefined);
  req.end();
  const [res] = (await once(req, "response")) as [IncomingMessage];
  res.on("error", () => undefined);
  const events: SseEvent[] = [];
  let buffer = "";
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    body += chunk;
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith(":")) continue;
      const fields: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const colon = line.indexOf(":");
        fields[line.slice(0, colon)] = line.slice(colon + 2);
      }
      events.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data) });
    }
  });
  const closed = new Promise<void>((resolve) => res.once("close", resolve));
  const stream = {
    res,
    events,
    body: () => body,
    closed,
    named: (name: string) => events.filter((e) => e.event === name),
    traces: () => events.filter((e) => e.event === "trace").map((e) => e.data as TraceDocument),
    deliveries: () =>
      events
        .filter((e) => e.event === "delivery")
        .map((e) => e.data as { id: string; index: number; delivery: Delivery }),
    close: () => res.destroy(),
  };
  cleanups.push(stream.close);
  if (res.statusCode === 200) await waitFor(() => events.some((e) => e.event === "hello"));
  return stream;
}

const traceOf = (doc: TraceDocument | undefined) => (doc?.kind === "trace" ? doc.trace : undefined);

/** Latest status per delivery index of `doc`, from its initial state and its updates. */
function finalStatuses(stream: Awaited<ReturnType<typeof openStream>>, doc: TraceDocument) {
  const statuses = doc.deliveries.map((d) => d.status as string);
  for (const update of stream.deliveries()) {
    if (update.id === doc.id) statuses[update.index] = update.delivery.status;
  }
  return statuses;
}

describe("live stream through a real gateway and viewer", () => {
  it("streams a charger CALL and the primary's correlated CALLRESULT, with their deliveries", async () => {
    const [primary, mirror] = await csmsFor(answering("primary"), answering("mirror-1"));
    const { viewerPort, gatewayPort } = await startStack(routes(primary, mirror));
    const stream = await openStream(viewerPort);
    const { ws, received } = await charger(gatewayPort);
    await waitFor(() => mirror.connected());

    ws.send(boot("m1"));
    await waitFor(() => received.length === 1);
    // CALL, primary result, mirror result (ignored).
    await waitFor(() => stream.traces().length === 3);
    const [call] = stream.traces().filter((d) => traceOf(d)?.messageType === "CALL");
    await waitFor(() => finalStatuses(stream, call).every((s) => s === "written"));

    // Shown once, though routed to two CSMS.
    expect(stream.traces().filter((d) => traceOf(d)?.messageType === "CALL")).toHaveLength(1);
    expect(traceOf(call)).toMatchObject({
      direction: "cp-to-csms",
      messageType: "CALL",
      action: "BootNotification",
      chargePointId: "CP-001",
      raw: boot("m1"),
    });
    expect(typeof call.receivedAt).toBe("string");
    expect(call.deliveries.map((d) => [d.target, d.role])).toEqual([
      ["csms-main", "primary"],
      ["mirror-1", "secondary"],
    ]);
    const updates = stream.deliveries().filter((u) => u.id === call.id);
    expect(updates.length).toBeGreaterThan(0);
    expect(new Set(updates.map((u) => u.index))).toEqual(new Set([0, 1]));

    const results = stream.traces().filter((d) => traceOf(d)?.messageType === "CALLRESULT");
    const fromPrimary = results.find((d) => !traceOf(d)?.meta.gateway.ignored);
    const fromMirror = results.find((d) => traceOf(d)?.meta.gateway.ignored);
    expect(traceOf(fromPrimary)?.meta.gateway).toMatchObject({
      source: { type: "csms", id: "csms-main", role: "primary" },
      correlation: { callTraceId: call.id, action: "BootNotification" },
    });
    expect(traceOf(fromMirror)?.meta.gateway).toMatchObject({
      source: { type: "csms", id: "mirror-1", role: "secondary" },
      ignored: true,
      correlation: { callTraceId: call.id },
    });
    // No event ids: there is no history a Last-Event-ID could resume.
    expect(stream.body()).not.toMatch(/^id:/m);
  });

  it("streams a primary CALLERROR, correlated", async () => {
    const [primary] = await csmsFor(
      makeCsms("primary", 0, {
        reply: (message) => {
          const [, id] = JSON.parse(message) as [number, string];
          return JSON.stringify([4, id, "NotImplemented", "Unknown action", {}]);
        },
      }),
    );
    const { viewerPort, gatewayPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);
    const { ws } = await charger(gatewayPort);

    ws.send(JSON.stringify([2, "m1", "VendorSpecific", {}]));
    await waitFor(() => stream.traces().length === 2);
    const [call, error] = stream.traces();
    expect(traceOf(error)).toMatchObject({
      direction: "csms-to-cp",
      messageType: "CALLERROR",
      error: { code: "NotImplemented" },
      meta: { gateway: { correlation: { callTraceId: call.id, action: "VendorSpecific" } } },
    });
  });

  it("streams a primary-initiated CALL and the charger's answer", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { viewerPort, gatewayPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);
    const { ws, received } = await charger(gatewayPort);
    await waitFor(() => primary.connected());

    primary.connections()[0].ws.send(JSON.stringify([2, "r1", "Reset", { type: "Soft" }]));
    await waitFor(() => received.length === 1);
    ws.send(JSON.stringify([3, "r1", { status: "Accepted" }]));
    await waitFor(() => stream.traces().length === 2);

    const [reset, answer] = stream.traces();
    expect(traceOf(reset)).toMatchObject({
      direction: "csms-to-cp",
      messageType: "CALL",
      action: "Reset",
    });
    expect(traceOf(answer)?.meta.gateway.correlation).toMatchObject({
      callTraceId: reset.id,
      action: "Reset",
    });
  });

  it("streams an unparsed frame with its reason and raw text", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { viewerPort, gatewayPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);
    const { ws } = await charger(gatewayPort);

    ws.send("{oops");
    await waitFor(() => stream.traces().length === 1);
    const [doc] = stream.traces();
    expect(doc.kind).toBe("frame");
    expect(doc.kind === "frame" && doc.frame).toMatchObject({
      raw: "{oops",
      reason: "invalid-json",
    });
  });

  it("shows a viewer connected after the BootNotification the frames that follow", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { viewerPort, gatewayPort } = await startStack(routes(primary));
    const { ws, received } = await charger(gatewayPort);
    ws.send(boot("m1"));
    await waitFor(() => received.length === 1);

    const stream = await openStream(viewerPort);
    ws.send(JSON.stringify([2, "m2", "Heartbeat", {}]));
    await waitFor(() => stream.traces().length === 2);

    const [heartbeat, result] = stream.traces().map(traceOf);
    expect(heartbeat).toMatchObject({ messageType: "CALL", action: "Heartbeat" });
    expect(result?.meta.gateway.correlation).toMatchObject({ action: "Heartbeat" });
  });

  it("keeps a viewer: false tenant out of the stream", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const route = { default: { primary: { id: "csms-main", url: primary.url() } } };
    const { viewerPort, gatewayPort } = await startStack(
      { ...route, tenants: { "tenant-a": route, demo: { ...route, viewer: false } } },
      { gateway: { tenantBaseDomain: "ocpp.example.com" } },
    );
    const stream = await openStream(viewerPort);

    for (const tenant of ["demo", "tenant-a"]) {
      const { ws, received } = await charger(gatewayPort, "CP-001", {
        host: `${tenant}.ocpp.example.com`,
      });
      ws.send(boot("m1"));
      await waitFor(() => received.length === 1);
    }
    await waitFor(() => stream.traces().length === 2);
    await sleep(50);

    expect(new Set(stream.traces().map((d) => d.tenantId))).toEqual(new Set(["tenant-a"]));
  });

  it("keeps the OCPP session working when a viewer disconnects mid-stream", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { hub, viewerPort, gatewayPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);
    const { ws, received } = await charger(gatewayPort);
    ws.send(boot("m1"));
    await waitFor(() => stream.traces().length === 2);

    stream.close();
    await waitFor(() => hub.stats().clients === 0);
    ws.send(JSON.stringify([2, "m2", "Heartbeat", {}]));
    await waitFor(() => received.length === 2);
    expect(JSON.parse(received[1])).toEqual([3, "m2", { from: "primary" }]);
  });

  it("answers an unauthenticated /events with 401 and registers no client", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { hub, viewerPort } = await startStack(routes(primary));

    const stream = await openStream(viewerPort, {});
    expect(stream.res.statusCode).toBe(401);
    await stream.closed;
    expect(hub.stats().clients).toBe(0);
    expect(hub.active()).toBe(false);
  });

  it("closes the viewer server alone with a stream open, and the hub drops that client", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { hub, viewer, viewerPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);
    expect(hub.active()).toBe(true);

    const started = Date.now();
    await viewer.close();
    await stream.closed;
    expect(Date.now() - started).toBeLessThan(1000);
    await waitFor(() => hub.stats().clients === 0);
    expect(hub.active()).toBe(false);
  });

  it("lets the viewer close while a stream is open", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { hub, viewer, viewerPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);

    const started = Date.now();
    hub.close();
    await (viewer as ViewerServer).close();
    await stream.closed;
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("live stream under load", () => {
  it("serves several clients the same events, and refuses one over the limit with 503", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { viewerPort, gatewayPort } = await startStack(routes(primary), {
      viewer: { maxClients: 3 },
    });
    const streams = await Promise.all([1, 2, 3].map(() => openStream(viewerPort)));
    const refused = await openStream(viewerPort);
    expect(refused.res.statusCode).toBe(503);

    const { ws, received } = await charger(gatewayPort);
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify([2, `h${i}`, "Heartbeat", {}]));
    await waitFor(() => received.length === 20);
    await waitFor(() => streams.every((s) => s.traces().length === 40));

    const ids = streams.map((s) => s.named("trace").map((e) => (e.data as { id: string }).id));
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
  });

  it("bounds a paused reader's buffer, drops then ends it, and keeps forwarding", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const soft = 64 * 1024;
    const hard = 256 * 1024;
    const { hub, viewerPort, gatewayPort } = await startStack(routes(primary), {
      hub: { softLimitBytes: soft, hardLimitBytes: hard, maxDroppedEvents: 200 },
    });
    // A raw socket that never reads: the kernel buffers fill, then the hub's.
    const socket = tcpConnect(viewerPort, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    await once(socket, "connect");
    socket.pause();
    socket.write(`GET /events HTTP/1.1\r\nHost: viewer\r\nAuthorization: ${AUTH}\r\n\r\n`);
    await waitFor(() => hub.stats().clients === 1);

    const { ws, received } = await charger(gatewayPort);
    // Past the primary's connect queue, which would drop the oldest frames.
    await waitFor(() => primary.connected());
    // Send in batches until the hub ends the client, whatever the kernel's
    // socket buffers absorb first (they differ between macOS and Linux).
    const filler = "x".repeat(2048);
    const batch = 200;
    const maxFrames = 40_000;
    let frames = 0;
    while (hub.stats().endedSlow === 0) {
      if (frames >= maxFrames)
        throw new Error(`client never ended: ${JSON.stringify(hub.stats())}`);
      for (let i = 0; i < batch; i++, frames++) {
        ws.send(JSON.stringify([2, `d${frames}`, "DataTransfer", { vendorId: "X", data: filler }]));
      }
      await waitFor(() => received.length === frames, 10_000);
    }

    const stats = hub.stats();
    expect(stats.clients).toBe(0);
    expect(stats.dropped).toBeGreaterThanOrEqual(200);
    expect(stats.peakBufferedBytes).toBeLessThanOrEqual(hard);
    expect(primary.received()).toHaveLength(frames);
  }, 30_000);

  it("survives frequent reconnects and still streams to the last client", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { hub, viewerPort, gatewayPort } = await startStack(routes(primary), {
      viewer: { maxClients: 2 },
    });
    const { ws, received } = await charger(gatewayPort);
    for (let i = 0; i < 25; i++) {
      // The previous stream's close may still be on its way to the hub.
      await waitFor(() => hub.stats().clients <= 1);
      const stream = await openStream(viewerPort);
      expect(stream.res.statusCode).toBe(200);
      ws.send(JSON.stringify([2, `h${i}`, "Heartbeat", {}]));
      stream.close();
    }
    await waitFor(() => received.length === 25);
    await waitFor(() => hub.stats().clients === 0);

    const last = await openStream(viewerPort);
    ws.send(boot("m1"));
    await waitFor(() => last.traces().length === 2);
  });

  it("delivers a frame of almost MAX_MESSAGE_BYTES, quote-heavy, to a healthy client", async () => {
    const [primary] = await csmsFor(answering("primary"));
    const { hub, viewerPort, gatewayPort } = await startStack(routes(primary));
    const stream = await openStream(viewerPort);
    const { ws, received } = await charger(gatewayPort);

    const head = JSON.stringify([2, "big", "DataTransfer", { vendorId: "X", data: "" }]);
    // Every `"` in the data is `\"` in the frame, then `\\\"` once streamed.
    const quotes = Math.floor((DEFAULT_MAX_MESSAGE_BYTES - head.length) / 2);
    const frame = JSON.stringify([
      2,
      "big",
      "DataTransfer",
      { vendorId: "X", data: '"'.repeat(quotes) },
    ]);
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(DEFAULT_MAX_MESSAGE_BYTES);
    ws.send(frame);
    await waitFor(() => received.length === 1, 5000);
    await waitFor(() => stream.traces().length === 2, 5000);

    expect(traceOf(stream.traces()[0])?.raw).toBe(frame);
    expect(hub.stats()).toMatchObject({ dropped: 0, endedSlow: 0 });
  });
});
