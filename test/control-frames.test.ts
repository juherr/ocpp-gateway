import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { configureLogger } from "../src/logger";
import { connectWhenOpen, startGateway, waitForClose } from "./helpers";

/** The largest payload a control frame may carry. */
const MAX_CONTROL_PAYLOAD = Buffer.alloc(125, 0x61);

const CAPPED = "forwarded control frames piling up, closing the charger";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
  const pings: { onPing?: () => void } = {};
  const upstream = new Promise<WebSocket>((resolve) => {
    csms.once("connection", (ws) => {
      ws.on("ping", (data) => {
        ws.pong(data);
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

  it("ends the session of a charger that floods pings without reading", async () => {
    const warnings: Record<string, unknown>[] = [];
    configureLogger({
      logLevel: "warn",
      sink: {
        stdout: (line) => warnings.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
      },
    });
    const { charger, upstream, pings } = await setup();
    // Bound before flooding: the end of the session closes the primary link.
    const primaryClosed = waitForClose(upstream, 15_000);

    charger.pause();
    // The next ping leaves once the CSMS has answered the previous one: the
    // gateway never reads a burst of pings (a burst over the cap is refused
    // on its own), so only the pongs the charger leaves unread pile up.
    const ping = () => charger.ping(MAX_CONTROL_PAYLOAD, undefined, () => undefined);
    pings.onPing = ping;
    ping();

    try {
      // The kernel buffers absorb thousands of pongs before the gateway holds
      // any: the session ends once they are full, not after a fixed count.
      await expect(primaryClosed).resolves.toMatchObject({ code: 1000 });
    } finally {
      pings.onPing = undefined;
    }
    const capped = warnings.filter(({ msg }) => msg === CAPPED);
    expect(capped).toEqual([expect.objectContaining({ link: "charger" })]);
  }, 20_000);
});
