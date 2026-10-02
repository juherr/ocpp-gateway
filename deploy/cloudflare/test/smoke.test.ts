/**
 * Live smoke test of the Worker → Container relay under `npm run dev`; skipped
 * unless SMOKE_GATEWAY_URL is set. See README.md, "Smoke test".
 */
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  boot,
  connectWhenOpen,
  makeCsms,
  sleep,
  waitFor,
  waitForClose,
} from "../../../test/helpers";

const WS_URL = process.env.SMOKE_GATEWAY_URL?.replace(/^http/, "ws");
// Optional: a real CSMS (e.g. a test SteVe) routed from ROUTES_JSON in .dev.vars.
// Without SMOKE_REAL_AUTHORIZATION the charger sends no Authorization header.
const REAL_TENANT = process.env.SMOKE_REAL_TENANT;
const REAL_CHARGE_BOX_ID = process.env.SMOKE_REAL_CHARGE_BOX_ID;
const REAL_AUTH = process.env.SMOKE_REAL_AUTHORIZATION;

// Must match wrangler.jsonc (TENANT_BASE_DOMAIN) and .dev.vars.example (ports).
const BASE_DOMAIN = "ocpp.example.com";
const CSMS_PORT = 9100;
const AUTH = "Basic c21va2U6dGVzdA==";
// The first request cold-starts the container.
const OPEN_TIMEOUT = 30_000;
const STEP_TIMEOUT = 5000;

type Csms = ReturnType<typeof makeCsms>;

let globalCsms: Csms;
let csmsA: Csms;
let csmsB: Csms;
let allCsms: Csms[];
let sockets: WebSocket[] = [];

/** The upstream connections a mock CSMS accepted for `id`. */
const upstreams = (csms: Csms, id: string) =>
  csms.connections().filter((c) => c.path?.endsWith(`/${id}`));

/** Handshake headers for `<tenant>.<base>`; `authorization: null` sends none. */
const headers = (tenant: string, authorization: string | null = AUTH) => ({
  host: `${tenant}.${BASE_DOMAIN}`,
  ...(authorization === null ? {} : { Authorization: authorization }),
});

/** Open a charger connection through the Worker as if it dialled `<tenant>.<base>`. */
async function charger(
  tenant: string,
  id: string,
  options: {
    protocol?: string;
    authorization?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const ws = await connectWhenOpen(`${WS_URL}/${id}`, options.protocol ?? "ocpp1.6", OPEN_TIMEOUT, {
    ...headers(tenant, options.authorization),
    ...options.headers,
  });
  sockets.push(ws);
  const received: string[] = [];
  ws.on("message", (data) => received.push(data.toString()));
  return { ws, received };
}

/** Wait until the gateway's link to `csms` for `id` is open. */
const upstreamOpen = (csms: Csms, id: string) =>
  waitFor(() => upstreams(csms, id).some((c) => c.ws.readyState === WebSocket.OPEN), STEP_TIMEOUT);

const reply = (tag: string) => JSON.stringify([3, "reply", { from: tag }]);

describe.skipIf(!WS_URL)("live smoke: Worker → Container → CSMS", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    // All interfaces: on Linux, host.docker.internal is the Docker bridge, not loopback.
    const host = "0.0.0.0";
    globalCsms = makeCsms("global", CSMS_PORT, { host });
    csmsA = makeCsms("csms-a", CSMS_PORT + 1, { host });
    csmsB = makeCsms("csms-b", CSMS_PORT + 2, { host });
    allCsms = [globalCsms, csmsA, csmsB];
    await Promise.all(allCsms.map((s) => once(s.wss, "listening")));
  });

  afterEach(() => {
    for (const ws of sockets) ws.close();
    sockets = [];
  });

  afterAll(() => {
    for (const s of allCsms) s.close();
  });

  it.each(["ocpp1.6", "ocpp2.0.1"])(
    "relays %s both ways, keeping the subprotocol and Authorization",
    async (protocol) => {
      const id = `CP-${protocol.replace(/\W/g, "")}`;
      const { ws, received } = await charger("tenant-a", id, { protocol });
      expect(ws.protocol).toBe(protocol);

      // Charger → CSMS, and the CSMS reply back; sent at once, before the
      // gateway's link to the CSMS is open.
      ws.send(boot("boot-1"));
      await waitFor(() => received.includes(reply("csms-a")), STEP_TIMEOUT);

      const [upstream] = upstreams(csmsA, id);
      expect(upstream).toMatchObject({ path: `/csms-a/${id}`, protocol, auth: AUTH });

      // CSMS → charger (a CALL initiated by the CSMS), and the charger's result back.
      upstream.ws.send(JSON.stringify([2, "csms-1", "TriggerMessage", {}]));
      await waitFor(() => received.some((m) => m.includes('"csms-1"')), STEP_TIMEOUT);
      ws.send(JSON.stringify([3, "csms-1", { status: "Accepted" }]));
      await waitFor(() => csmsA.received().some((m) => m.includes('"csms-1"')), STEP_TIMEOUT);
    },
  );

  it("sends no Authorization upstream when the charger sends none", async () => {
    const id = "CP-NOAUTH";
    await charger("tenant-a", id, { authorization: null });

    await upstreamOpen(csmsA, id);
    expect(upstreams(csmsA, id)[0].auth).toBeUndefined();
  });

  it("rejects an unknown tenant with 1008 without dialling any CSMS", async () => {
    const id = "CP-UNKNOWN";
    // Not via charger(): the gateway may close the socket before it is open.
    const ws = new WebSocket(`${WS_URL}/${id}`, "ocpp1.6", { headers: headers("nope") });
    sockets.push(ws);

    const { code } = await waitForClose(ws, OPEN_TIMEOUT);
    expect(code).toBe(1008);
    await sleep(500);
    for (const s of allCsms) expect(upstreams(s, id)).toHaveLength(0);
  });

  it("ignores a forged x-forwarded-host and cf-container-target-port", async () => {
    const id = "CP-FORGED";
    const { ws } = await charger("tenant-a", id, {
      headers: {
        "X-Forwarded-Host": `tenant-b.${BASE_DOMAIN}`,
        "cf-container-target-port": "22",
      },
    });

    await upstreamOpen(csmsA, id);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(upstreams(csmsB, id)).toHaveLength(0);
    expect(upstreams(globalCsms, id)).toHaveLength(0);
  });

  it("keeps the same chargeBoxId in two tenants apart", async () => {
    const id = "CP-SHARED";
    const a = await charger("tenant-a", id);
    const b = await charger("tenant-b", id);

    a.ws.send(boot("boot-a"));
    b.ws.send(boot("boot-b"));
    await waitFor(() => a.received.length > 0 && b.received.length > 0, STEP_TIMEOUT);
    await sleep(500);

    expect(a.received).toEqual([reply("csms-a")]);
    expect(b.received).toEqual([reply("csms-b")]);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("replaces a reconnecting charger's stale session", async () => {
    const id = "CP-RECONNECT";
    const first = await charger("tenant-a", id);
    // Replace an established session, not one still dialling its CSMS.
    await upstreamOpen(csmsA, id);
    const closed = waitForClose(first.ws, STEP_TIMEOUT);

    const second = await charger("tenant-a", id);

    expect((await closed).code).toBe(1000);
    // The old session's upstream link is fully closed, and the new one is open.
    await waitFor(() => {
      const [stale, fresh] = upstreams(csmsA, id);
      return stale?.ws.readyState === WebSocket.CLOSED && fresh?.ws.readyState === WebSocket.OPEN;
    }, STEP_TIMEOUT);
    expect(upstreams(csmsA, id)).toHaveLength(2);
    second.ws.send(boot("boot-2"));
    await waitFor(() => second.received.includes(reply("csms-a")), STEP_TIMEOUT);
  });

  it.skipIf(!REAL_TENANT || !REAL_CHARGE_BOX_ID)(
    "boots against the real CSMS of SMOKE_REAL_TENANT",
    async () => {
      const { ws, received } = await charger(REAL_TENANT!, REAL_CHARGE_BOX_ID!, {
        authorization: REAL_AUTH ?? null,
      });
      expect(ws.protocol).toBe("ocpp1.6");

      // A single boot, sent before the gateway's link to the real CSMS is open:
      // a remote dial can take seconds, up to the gateway's 10 s handshake timeout.
      const result = () =>
        received.map((m) => JSON.parse(m)).find(([type, id]) => type === 3 && id === "boot-1");
      ws.send(boot("boot-1"));
      await waitFor(() => result() !== undefined, 15_000);
      expect(result()?.[2].status).toBe("Accepted");
    },
  );
});
