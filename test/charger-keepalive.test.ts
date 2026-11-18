import { once } from "node:events";
import { type AddressInfo, type Socket, createServer, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { makeCsms, sleep, startGateway, waitFor, waitForClose, waitForOpen } from "./helpers";

/** How long the relay lets a connection sit without a byte in either direction. */
const IDLE_TIMEOUT_MS = 400;
const PING_INTERVAL_MS = 100;

/**
 * A TCP relay to `targetPort` that destroys a connection once no byte has
 * crossed it, in either direction, for `idleMs`: a stand-in for the idle
 * timeout of a proxy such as Cloudflare's in front of the gateway.
 */
async function startIdleCuttingRelay(targetPort: number, idleMs: number) {
  const pairs: { client: Socket; upstream: Socket; lastActivity: number }[] = [];
  const server = createServer((client) => {
    const upstream = connect(targetPort, "127.0.0.1");
    const pair = { client, upstream, lastActivity: Date.now() };
    pairs.push(pair);
    const touch = () => (pair.lastActivity = Date.now());
    client.on("data", touch);
    upstream.on("data", touch);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const sweeper = setInterval(() => {
    for (const pair of pairs) {
      if (Date.now() - pair.lastActivity > idleMs) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
    }
  }, 20);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      clearInterval(sweeper);
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      server.close();
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A gateway behind an idle-cutting relay, with one idle charger connected
 * through it. The charger counts the pings it receives; the CSMS the pongs.
 */
async function connectIdleCharger(chargerPingIntervalMs: number) {
  const csms = makeCsms("primary");
  await once(csms.wss, "listening");
  cleanups.push(() => csms.close());
  const gateway = await startGateway(
    { default: { primary: csms.url(), secondaries: [] } },
    { chargerPingIntervalMs },
  );
  cleanups.push(() => gateway.close());
  const relay = await startIdleCuttingRelay(gateway.port, IDLE_TIMEOUT_MS);
  cleanups.push(() => relay.close());

  const charger = new WebSocket(`ws://127.0.0.1:${relay.port}/CP-001`, "ocpp1.6");
  cleanups.push(() => charger.terminate());
  const pingsReceived: Buffer[] = [];
  charger.on("ping", (data) => pingsReceived.push(data));
  await waitForOpen(charger);
  await waitFor(() => csms.connected());

  const csmsSide = csms.connections()[0].ws;
  const pongsAtCsms: Buffer[] = [];
  csmsSide.on("pong", (data) => pongsAtCsms.push(data));
  return { csms, csmsSide, charger, pingsReceived, pongsAtCsms };
}

describe("charger keepalive ping (CHARGER_PING_INTERVAL)", () => {
  it("keeps an idle charger's session open through an idle-cutting proxy", async () => {
    const { csms, charger, pingsReceived, pongsAtCsms } =
      await connectIdleCharger(PING_INTERVAL_MS);

    await sleep(4 * IDLE_TIMEOUT_MS);

    expect(charger.readyState).toBe(WebSocket.OPEN);
    expect(csms.connections()).toHaveLength(1);
    expect(csms.connections()[0].ws.readyState).toBe(WebSocket.OPEN);
    expect(pingsReceived.length).toBeGreaterThanOrEqual(5);
    // The charger answered every ping, and none of its answers reached the CSMS.
    expect(pongsAtCsms).toEqual([]);
    // Ping frames are not OCPP: nothing was forwarded as a message.
    expect(csms.received()).toEqual([]);
  });

  it("still forwards the charger's answer to a ping from the CSMS", async () => {
    const { csmsSide, pongsAtCsms } = await connectIdleCharger(PING_INTERVAL_MS);

    csmsSide.ping(Buffer.from("csms-ping"));

    await waitFor(() => pongsAtCsms.length > 0);
    expect(pongsAtCsms).toEqual([Buffer.from("csms-ping")]);
  });

  it("without the option, sends no ping and the idle cut ends the session", async () => {
    const { csmsSide, charger, pingsReceived } = await connectIdleCharger(0);

    const { code } = await waitForClose(charger, 4 * IDLE_TIMEOUT_MS);
    expect(code).toBe(1006);
    await waitFor(() => csmsSide.readyState === WebSocket.CLOSED);
    expect(pingsReceived).toEqual([]);
  });
});
