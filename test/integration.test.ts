import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Config } from "../src/config";
import { boot, makeCsms, sleep, startGateway, waitFor, waitForClose } from "./helpers";

interface Harness {
  proxyPort: number;
  primary: ReturnType<typeof makeCsms>;
  secondary: ReturnType<typeof makeCsms>;
  close: () => Promise<void>;
}

async function setup(
  routesFor: (primaryPort: number, secondaryPort: number) => object,
  primaryOptions: Parameters<typeof makeCsms>[2] = {},
  gatewayOverrides: Partial<Config> = {},
): Promise<Harness> {
  const primary = makeCsms("primary", 0, primaryOptions);
  const secondary = makeCsms("secondary");
  await Promise.all([once(primary.wss, "listening"), once(secondary.wss, "listening")]);

  const gateway = await startGateway(routesFor(primary.port(), secondary.port()), gatewayOverrides);

  return {
    proxyPort: gateway.port,
    primary,
    secondary,
    close: async () => {
      primary.close();
      secondary.close();
      await gateway.close();
    },
  };
}

describe("OCPP proxy integration", () => {
  it("routes CP-001 to primary (bidirectional) + secondary (one-way mirror), forwarding auth and subprotocol", async () => {
    const h = await setup((pp, sp) => ({
      default: { primary: `ws://127.0.0.1:${pp}`, secondaries: [] },
      chargers: {
        "CP-001": {
          primary: `ws://127.0.0.1:${pp}`,
          secondaries: [`ws://127.0.0.1:${sp}`],
        },
      },
    }));

    const fromClient: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"], {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    client.on("message", (d) => fromClient.push(d.toString()));
    await once(client, "open");

    const message = boot("msg-1");
    client.send(message);

    // (a) primary receives the charger message and (b) secondary receives it too
    await waitFor(() => h.primary.received().length >= 1 && h.secondary.received().length >= 1);
    expect(h.primary.received()).toContain(message);
    expect(h.secondary.received()).toContain(message);

    // (a) the primary's reply reaches the charger
    await waitFor(() => fromClient.length >= 1);
    expect(fromClient.some((m) => m.includes('"from":"primary"'))).toBe(true);

    // (b) the secondary's reply must NEVER reach the charger
    await sleep(150);
    expect(fromClient.some((m) => m.includes('"from":"secondary"'))).toBe(false);

    // (c) Authorization and subprotocol propagated to BOTH upstreams
    expect(h.primary.auth()).toBe("Basic dXNlcjpwYXNz");
    expect(h.secondary.auth()).toBe("Basic dXNlcjpwYXNz");
    expect(h.primary.protocol()).toBe("ocpp1.6");
    expect(h.secondary.protocol()).toBe("ocpp1.6");
    expect(client.protocol).toBe("ocpp1.6");

    client.close();
    await h.close();
  });

  it("routes an unknown chargeBoxId to the default route (no secondary mirror)", async () => {
    const h = await setup((pp, sp) => ({
      default: { primary: `ws://127.0.0.1:${pp}`, secondaries: [] },
      chargers: {
        "CP-001": {
          primary: `ws://127.0.0.1:${pp}`,
          secondaries: [`ws://127.0.0.1:${sp}`],
        },
      },
    }));

    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/SIMULATOR-001`, ["ocpp1.6"]);
    await once(client, "open");
    const message = boot("m");
    client.send(message);

    await waitFor(() => h.primary.received().length >= 1);
    expect(h.primary.received()).toContain(message);

    // default route has no secondaries → mirror CSMS gets nothing
    await sleep(150);
    expect(h.secondary.received()).toHaveLength(0);

    client.close();
    await h.close();
  });

  it("connects to a fixed endpoint URL when appendChargeBoxId is false", async () => {
    const h = await setup((pp, sp) => ({
      default: {
        primary: { url: `ws://127.0.0.1:${pp}/fixed/XXXXXXXX`, appendChargeBoxId: false },
        secondaries: [`ws://127.0.0.1:${sp}/ocpp`],
      },
    }));

    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"]);
    await once(client, "open");
    await waitFor(() => h.primary.connected() && h.secondary.connected());

    expect(h.primary.path()).toBe("/fixed/XXXXXXXX");
    expect(h.secondary.path()).toBe("/ocpp/CP-001");

    client.close();
    await h.close();
  });

  it("delivers charger messages sent before the primary CSMS accepts, in order, once it does", async () => {
    const h = await setup(
      (pp, sp) => ({
        default: { primary: `ws://127.0.0.1:${pp}`, secondaries: [`ws://127.0.0.1:${sp}`] },
      }),
      { holdHandshakes: true },
    );

    const fromClient: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"]);
    client.on("message", (d) => fromClient.push(d.toString()));
    await once(client, "open");
    await waitFor(() => h.primary.heldHandshakes() === 1);

    client.send(boot("b-1"));
    client.send(boot("b-2"));
    // The secondary is open, so once it has both, the gateway has handled them.
    await waitFor(() => h.secondary.received().length === 2);
    expect(h.primary.received()).toEqual([]);

    h.primary.releaseHandshakes();
    await waitFor(() => h.primary.received().length === 2);
    expect(h.primary.received()).toEqual([boot("b-1"), boot("b-2")]);
    await waitFor(() => fromClient.length === 2);
    expect(fromClient.every((m) => m.includes('"from":"primary"'))).toBe(true);

    client.close();
    await h.close();
  });
});

// Clients dial 127.0.0.1: a server on the `::` wildcard can lose the port's
// IPv4 loopback to another process bound to 127.0.0.1 (flaky 404s, #10).
describe("listen address", () => {
  it("binds the test gateway and mock CSMS to 127.0.0.1", async () => {
    const csms = makeCsms("csms");
    await once(csms.wss, "listening");
    const gateway = await startGateway({ default: { primary: csms.url(), secondaries: [] } });

    expect(gateway.address).toBe("127.0.0.1");
    expect(csms.address()).toBe("127.0.0.1");

    csms.close();
    await gateway.close();
  });

  it("listens on all interfaces when listenHost is unset", async () => {
    const gateway = await startGateway(
      { default: { primary: "ws://127.0.0.1:1", secondaries: [] } },
      { listenHost: undefined },
    );

    expect(["::", "0.0.0.0"]).toContain(gateway.address);

    await gateway.close();
  });
});

/** An OCPP DataTransfer CALL padded to exactly `bytes` bytes. */
function dataTransfer(bytes: number) {
  const frame = (data: string) =>
    JSON.stringify([2, "dt-1", "DataTransfer", { vendorId: "Test", data }]);
  return frame("x".repeat(bytes - frame("").length));
}

describe("OCPP proxy frame size limit", () => {
  const maxMessageBytes = 1024;
  const routes = (pp: number, sp: number) => ({
    default: { primary: `ws://127.0.0.1:${pp}`, secondaries: [`ws://127.0.0.1:${sp}`] },
  });

  it("forwards a charger frame at the limit", async () => {
    const h = await setup(routes, {}, { maxMessageBytes });

    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"]);
    await once(client, "open");
    const message = dataTransfer(maxMessageBytes);
    client.send(message);

    await waitFor(() => h.primary.received().length === 1 && h.secondary.received().length === 1);
    expect(h.primary.received()).toEqual([message]);
    expect(h.secondary.received()).toEqual([message]);

    client.close();
    await h.close();
  });

  it("closes a charger sending a frame over the limit with 1009, without forwarding or queueing it", async () => {
    // The primary stays CONNECTING, so the frame would be queued if it got through.
    const h = await setup(routes, { holdHandshakes: true }, { maxMessageBytes });

    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"]);
    await once(client, "open");
    await waitFor(() => h.primary.heldHandshakes() === 1 && h.secondary.connected());

    const closed = waitForClose(client);
    client.send(dataTransfer(maxMessageBytes + 1));
    expect((await closed).code).toBe(1009);

    h.primary.releaseHandshakes();
    await sleep(150);
    expect(h.primary.received()).toEqual([]);
    expect(h.secondary.received()).toEqual([]);

    await h.close();
  });

  it("drops only the secondary link when a secondary sends a frame over the limit", async () => {
    const h = await setup(routes, {}, { maxMessageBytes });

    const fromClient: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"]);
    client.on("message", (d) => fromClient.push(d.toString()));
    await once(client, "open");
    await waitFor(() => h.primary.connected() && h.secondary.connected());

    const [mirror] = h.secondary.connections();
    const mirrorClosed = waitForClose(mirror!.ws);
    mirror!.ws.send(dataTransfer(maxMessageBytes + 1));
    expect((await mirrorClosed).code).toBe(1009);

    // The charger and the primary carry on as if nothing happened.
    const message = boot("after-oversize");
    client.send(message);
    await waitFor(() => h.primary.received().includes(message) && fromClient.length === 1);
    expect(fromClient[0]).toContain('"from":"primary"');
    expect(client.readyState).toBe(WebSocket.OPEN);
    expect(h.primary.connections()).toHaveLength(1);
    expect(h.primary.connections()[0]?.ws.readyState).toBe(WebSocket.OPEN);

    client.close();
    await h.close();
  });

  it("ends the session when the primary sends a frame over the limit, without delivering it", async () => {
    const h = await setup(routes, {}, { maxMessageBytes });

    const fromClient: string[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${h.proxyPort}/CP-001`, ["ocpp1.6"]);
    client.on("message", (d) => fromClient.push(d.toString()));
    await once(client, "open");
    await waitFor(() => h.primary.connected());

    const closed = waitForClose(client);
    h.primary.connections()[0]?.ws.send(dataTransfer(maxMessageBytes + 1));
    expect((await closed).code).toBe(1011);
    expect(fromClient).toEqual([]);

    await h.close();
  });
});
