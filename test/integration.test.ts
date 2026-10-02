import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { boot, makeCsms, sleep, startGateway, waitFor } from "./helpers";

interface Harness {
  proxyPort: number;
  primary: ReturnType<typeof makeCsms>;
  secondary: ReturnType<typeof makeCsms>;
  close: () => Promise<void>;
}

async function setup(
  routesFor: (primaryPort: number, secondaryPort: number) => object,
  primaryOptions: Parameters<typeof makeCsms>[2] = {},
): Promise<Harness> {
  const primary = makeCsms("primary", 0, primaryOptions);
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
