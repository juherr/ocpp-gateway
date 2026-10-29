import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_MESSAGE_BYTES } from "../../../src/config";
import { LiveTraceHub } from "../../../src/viewer/hub";
import { startViewer } from "../../../src/viewer/server";
import { type ConnectionState, TraceStore } from "../../../web/viewer/model";
import { startLiveStream } from "../../../web/viewer/stream";
import { boot, connectWhenOpen, makeCsms, startGateway, waitFor } from "../../helpers";

/**
 * The page's logic (stream, parser, model) against a real gateway and viewer:
 * what a browser would derive from the live stream.
 */

const USERNAME = "viewer-user-c41d";
const PASSWORD = "viewer-pw-8b02";
const AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startStack() {
  const csms = makeCsms("primary", 0, {
    reply: (message) => {
      const [type, id] = JSON.parse(message) as [number, string];
      return type === 2
        ? JSON.stringify([3, id, { currentTime: "2026-10-29T00:00:00Z" }])
        : undefined;
    },
  });
  cleanups.push(() => csms.close());
  await once(csms.wss, "listening");
  const hub = new LiveTraceHub({
    maxClients: 5,
    maxBufferedMessages: 50,
    maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  });
  cleanups.push(() => hub.close());
  const gateway = await startGateway(
    { default: { primary: { id: "csms-main", url: csms.url() } } },
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
      maxBufferedMessages: 50,
      maxClients: 5,
    },
    { assets: { html: "", js: "", css: "" }, events: hub.handle },
  );
  cleanups.push(() => viewer.close());
  await once(viewer.server, "listening");
  return { gatewayPort: gateway.port, viewerPort: (viewer.server.address() as AddressInfo).port };
}

function follow(viewerPort: number, authorization: string) {
  const store = new TraceStore(10);
  const states: ConnectionState[] = [];
  const stream = startLiveStream(
    {
      onState: (state) => states.push(state),
      onLost: (at) => store.addGap({ reason: "disconnected", at: new Date(at).toISOString() }),
      onConnected: ({ restarted }) => store.closeGap(new Date().toISOString(), restarted),
      onEvent: (event) => {
        if (event.type === "hello") store.setCapacity(event.hello.maxBufferedMessages);
        else if (event.type === "trace") store.addTrace(event.doc);
        else if (event.type === "delivery") store.applyDelivery(event.update);
      },
    },
    { url: `http://127.0.0.1:${viewerPort}/events`, headers: { authorization } },
  );
  cleanups.push(() => stream.stop());
  return { store, states };
}

describe("the viewer page's logic against a live gateway", () => {
  it("shows a CALL and its correlated response, with their deliveries", async () => {
    const { gatewayPort, viewerPort } = await startStack();
    const { store, states } = follow(viewerPort, AUTH);
    await waitFor(() => states.includes("connected"));

    const ws = await connectWhenOpen(`ws://127.0.0.1:${gatewayPort}/CP-001`, "ocpp1.6");
    cleanups.push(() => ws.terminate());
    ws.send(boot("boot-1"));

    await waitFor(
      () =>
        store.size === 2 &&
        store.entries().every((e) => e.kind === "trace" && e.summary.delivery === "written"),
    );
    const summaries = store.entries().map((e) => (e.kind === "trace" ? e.summary : undefined));
    expect(summaries).toEqual([
      expect.objectContaining({
        chargePointId: "CP-001",
        type: "CALL",
        action: "BootNotification",
        correlated: false,
        arrow: "↑",
        source: "charger",
        tenant: "—",
        ocppVersion: "1.6",
        messageId: "boot-1",
      }),
      expect.objectContaining({
        type: "CALLRESULT",
        action: "BootNotification",
        correlated: true,
        arrow: "↓",
        source: "primary csms-main",
        messageId: "boot-1",
      }),
    ]);
    expect(store.received).toBe(2);
    expect(store.sessions).toBe(1);
  });

  it("stops on wrong credentials", async () => {
    const { viewerPort } = await startStack();
    const wrong = `Basic ${Buffer.from(`${USERNAME}:nope`).toString("base64")}`;
    const { states } = follow(viewerPort, wrong);
    await waitFor(() => states.includes("auth-failed"));
    expect(states).toEqual(["connecting", "auth-failed"]);
  });
});
