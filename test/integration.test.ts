import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { OCPP_SUBPROTOCOLS } from "../src/types";
import { sleep, startGateway } from "./helpers";

/** A mock CSMS that records what it receives and replies with a tagged result. */
function makeCsms(tag: string) {
  const received: string[] = [];
  let connections = 0;
  let auth: string | undefined;
  let protocol: string | undefined;
  let path: string | undefined;

  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) if (protocols.has(p)) return p;
      return false;
    },
  });

  wss.on("connection", (ws, req) => {
    connections += 1;
    auth = req.headers.authorization;
    protocol = ws.protocol;
    path = req.url;
    ws.on("message", (data) => {
      received.push(data.toString());
      ws.send(JSON.stringify([3, "reply", { from: tag }]));
    });
  });

  return {
    wss,
    received: () => received,
    connected: () => connections > 0,
    auth: () => auth,
    protocol: () => protocol,
    path: () => path,
    port: () => (wss.address() as AddressInfo).port,
    close: () => wss.close(),
  };
}

async function waitFor(cond: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface Harness {
  proxyPort: number;
  primary: ReturnType<typeof makeCsms>;
  secondary: ReturnType<typeof makeCsms>;
  close: () => Promise<void>;
}

async function setup(
  routesFor: (primaryPort: number, secondaryPort: number) => object,
): Promise<Harness> {
  const primary = makeCsms("primary");
  const secondary = makeCsms("secondary");
  await Promise.all([once(primary.wss, "listening"), once(secondary.wss, "listening")]);

  const gateway = await startGateway(routesFor(primary.port(), secondary.port()));

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

    // Wait until the proxy has established the upstream primary link (the
    // primary path is not buffered, unlike secondaries) before sending.
    await waitFor(() => h.primary.connected());

    const boot = JSON.stringify([2, "msg-1", "BootNotification", { model: "X" }]);
    client.send(boot);

    // (a) primary receives the charger message and (b) secondary receives it too
    await waitFor(() => h.primary.received().length >= 1 && h.secondary.received().length >= 1);
    expect(h.primary.received()).toContain(boot);
    expect(h.secondary.received()).toContain(boot);

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
    await waitFor(() => h.primary.connected());
    const boot = JSON.stringify([2, "m", "BootNotification", {}]);
    client.send(boot);

    await waitFor(() => h.primary.received().length >= 1);
    expect(h.primary.received()).toContain(boot);

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
});
