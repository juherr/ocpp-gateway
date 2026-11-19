import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { configureLogger } from "../src/logger";
import { MAX_PENDING_FORWARDED_CONTROL_FRAMES } from "../src/utils/websocket";
import { connectWhenOpen, startGateway, waitForClose } from "./helpers";

/** The largest payload a control frame may carry. */
const MAX_CONTROL_PAYLOAD = Buffer.alloc(125, 0x61);

const CAPPED = "forwarded control frames piling up, closing the charger";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

/**
 * A gateway routing every charger to one primary CSMS that answers each ping
 * itself, without `ws`'s own cap on automatic pongs: under load, that cap
 * would cut the gateway's link first and hide what the gateway does.
 */
async function setup() {
  const csms = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    autoPong: false,
    handleProtocols: (protocols) => (protocols.has("ocpp1.6") ? "ocpp1.6" : false),
  });
  await once(csms, "listening");
  cleanups.push(() => csms.close());
  /** Called with each ping the CSMS receives, once it has answered it. */
  const pings: { answered: number; onPing?: () => void } = { answered: 0 };
  const upstream = new Promise<WebSocket>((resolve) => {
    csms.once("connection", (ws) => {
      ws.on("ping", (data) => {
        ws.pong(data);
        pings.answered++;
        pings.onPing?.();
      });
      resolve(ws);
    });
  });

  const { port } = csms.address() as AddressInfo;
  const gateway = await startGateway({
    default: { primary: `ws://127.0.0.1:${port}`, secondaries: [] },
  });
  cleanups.push(() => gateway.close());
  const charger = await connectWhenOpen(`ws://127.0.0.1:${gateway.port}/CP-001`, "ocpp1.6");
  cleanups.push(() => charger.terminate());
  return { charger, upstream: await upstream, pings };
}

describe("forwarded control frames", () => {
  it("returns every pong to a charger that pings at a normal rate", async () => {
    const { charger } = await setup();

    for (let i = 0; i < 100; i++) {
      const payload = Buffer.from(`ping-${i}`);
      const pong = once(charger, "pong");
      charger.ping(payload);
      const [data] = (await pong) as [Buffer];
      expect(data.toString()).toBe(`ping-${i}`);
    }
  });

  it("ends the session of a charger that stops reading the pongs", async () => {
    const warnings: Record<string, unknown>[] = [];
    configureLogger({
      logLevel: "warn",
      sink: {
        stdout: (line) => warnings.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
      },
    });
    // A charger that stops reading: the pongs the gateway forwards to it (the
    // only pongs passing a write callback here) are never written out. A real
    // paused socket would only stall once the host's TCP buffers are full,
    // and how many pongs that takes, or whether the flood stalls first,
    // depends on the kernel's settings.
    const pong = WebSocket.prototype.pong;
    vi.spyOn(WebSocket.prototype, "pong").mockImplementation(function (
      this: WebSocket,
      ...args: Parameters<WebSocket["pong"]>
    ) {
      if (typeof args[2] === "function") return;
      pong.apply(this, args);
    });
    const { charger, upstream, pings } = await setup();
    // Bound before pinging: the end of the session closes the primary link.
    const primaryClosed = waitForClose(upstream);

    // One ping at a time: the next leaves once the CSMS has answered.
    const ping = () => charger.ping(MAX_CONTROL_PAYLOAD);
    pings.onPing = ping;
    ping();

    try {
      await expect(primaryClosed).resolves.toMatchObject({ code: 1000 });
    } finally {
      pings.onPing = undefined;
    }
    expect(pings.answered).toBe(MAX_PENDING_FORWARDED_CONTROL_FRAMES + 1);
    const capped = warnings.filter(({ msg }) => msg === CAPPED);
    expect(capped).toEqual([expect.objectContaining({ link: "charger" })]);
  });
});
