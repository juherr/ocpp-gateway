/**
 * Live smoke test of the Worker → Container relay, run against `npm run dev`
 * (wrangler dev: the Worker in workerd, the gateway image in local Docker).
 * Skipped unless SMOKE_GATEWAY_URL is set:
 *
 *   cd deploy/cloudflare && cp .dev.vars.example .dev.vars && npm run dev
 *   SMOKE_GATEWAY_URL=http://127.0.0.1:8787 npx vitest run deploy/cloudflare/test/smoke.test.ts
 *
 * The mock CSMS listen on this machine (ports 9100–9102); the container reaches
 * them at host.docker.internal, as configured by .dev.vars.example.
 */
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { connectWhenOpen, makeCsms, sleep, waitFor, waitForClose } from "../../../test/helpers";

const GATEWAY_URL = process.env.SMOKE_GATEWAY_URL;
const BASE_DOMAIN = process.env.SMOKE_BASE_DOMAIN ?? "ocpp.example.com";
const CSMS_PORT = Number(process.env.SMOKE_CSMS_PORT ?? 9100);
// Optional: a real CSMS (e.g. a test SteVe) routed from ROUTES_JSON in .dev.vars.
const REAL_TENANT = process.env.SMOKE_REAL_TENANT;
const REAL_CHARGE_BOX_ID = process.env.SMOKE_REAL_CHARGE_BOX_ID;
const REAL_AUTH = process.env.SMOKE_REAL_AUTHORIZATION;

const AUTH = "Basic c21va2U6dGVzdA==";
// The first request cold-starts the container.
const OPEN_TIMEOUT = 30_000;

/** A mock CSMS that also logs every upstream connection the gateway opens. */
function csms(tag: string, port: number) {
  const server = makeCsms(tag, port);
  const connections: { path?: string; protocol: string; auth?: string; ws: WebSocket }[] = [];
  server.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    connections.push({ path: req.url, protocol: ws.protocol, auth: req.headers.authorization, ws });
  });
  const to = (id: string) => connections.filter((c) => c.path?.endsWith(`/${id}`));
  return { ...server, connections, to };
}

let globalCsms: ReturnType<typeof csms>;
let csmsA: ReturnType<typeof csms>;
let csmsB: ReturnType<typeof csms>;
let sockets: WebSocket[] = [];

/** Open a charger connection through the Worker as if it dialled `<tenant>.<base>`. */
async function charger(
  tenant: string,
  id: string,
  options: { protocol?: string; headers?: Record<string, string> } = {},
) {
  const ws = await connectWhenOpen(
    `${GATEWAY_URL!.replace(/^http/, "ws")}/${id}`,
    options.protocol ?? "ocpp1.6",
    OPEN_TIMEOUT,
    { host: `${tenant}.${BASE_DOMAIN}`, Authorization: AUTH, ...options.headers },
  );
  sockets.push(ws);
  const received: string[] = [];
  ws.on("message", (data) => received.push(data.toString()));
  return { ws, received };
}

const boot = (id: string) =>
  JSON.stringify([
    2,
    id,
    "BootNotification",
    { chargePointVendor: "Smoke", chargePointModel: "Test" },
  ]);

describe.skipIf(!GATEWAY_URL)("live smoke: Worker → Container → CSMS", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    globalCsms = csms("global", CSMS_PORT);
    csmsA = csms("csms-a", CSMS_PORT + 1);
    csmsB = csms("csms-b", CSMS_PORT + 2);
    await Promise.all([globalCsms, csmsA, csmsB].map((s) => once(s.wss, "listening")));
  });

  afterEach(() => {
    for (const ws of sockets) ws.close();
    sockets = [];
  });

  afterAll(() => {
    for (const s of [globalCsms, csmsA, csmsB]) s.close();
  });

  it.each(["ocpp1.6", "ocpp2.0.1"])(
    "relays %s both ways, keeping the subprotocol and Authorization",
    async (protocol) => {
      const id = `CP-${protocol.replace(/\W/g, "")}`;
      const { ws, received } = await charger("tenant-a", id, { protocol });
      expect(ws.protocol).toBe(protocol);

      await waitFor(() => csmsA.to(id).length === 1, 5000);
      const [upstream] = csmsA.to(id);
      expect(upstream).toMatchObject({ path: `/csms-a/${id}`, protocol, auth: AUTH });

      // Charger → CSMS, and the CSMS reply back.
      ws.send(boot("boot-1"));
      await waitFor(() => received.some((m) => m.includes('"csms-a"')), 5000);

      // CSMS → charger (a CALL initiated by the CSMS), and the charger's result back.
      upstream.ws.send(JSON.stringify([2, "csms-1", "TriggerMessage", {}]));
      await waitFor(() => received.some((m) => m.includes('"csms-1"')), 5000);
      ws.send(JSON.stringify([3, "csms-1", { status: "Accepted" }]));
      await waitFor(() => csmsA.received().some((m) => m.includes('"csms-1"')), 5000);
    },
  );

  it("rejects an unknown tenant with 1008 without dialling any CSMS", async () => {
    const id = "CP-UNKNOWN";
    const ws = new WebSocket(`${GATEWAY_URL!.replace(/^http/, "ws")}/${id}`, "ocpp1.6", {
      headers: { host: `nope.${BASE_DOMAIN}`, Authorization: AUTH },
    });
    sockets.push(ws);

    const { code } = await waitForClose(ws, OPEN_TIMEOUT);
    expect(code).toBe(1008);
    await sleep(500);
    for (const s of [globalCsms, csmsA, csmsB]) expect(s.to(id)).toHaveLength(0);
  });

  it("ignores a forged x-forwarded-host and cf-container-target-port", async () => {
    const id = "CP-FORGED";
    const { ws } = await charger("tenant-a", id, {
      headers: {
        "X-Forwarded-Host": `tenant-b.${BASE_DOMAIN}`,
        "cf-container-target-port": "22",
      },
    });

    await waitFor(() => csmsA.to(id).length === 1, 5000);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(csmsB.to(id)).toHaveLength(0);
    expect(globalCsms.to(id)).toHaveLength(0);
  });

  it("keeps the same chargeBoxId in two tenants apart", async () => {
    const id = "CP-SHARED";
    const a = await charger("tenant-a", id);
    const b = await charger("tenant-b", id);

    await waitFor(() => csmsA.to(id).length === 1 && csmsB.to(id).length === 1, 5000);
    a.ws.send(boot("boot-a"));
    b.ws.send(boot("boot-b"));
    await waitFor(() => a.received.length > 0 && b.received.length > 0, 5000);
    await sleep(500);

    expect(a.received.join()).toContain('"csms-a"');
    expect(a.received.join()).not.toContain('"csms-b"');
    expect(b.received.join()).toContain('"csms-b"');
    expect(b.received.join()).not.toContain('"csms-a"');
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("replaces a reconnecting charger's stale session", async () => {
    const id = "CP-RECONNECT";
    const first = await charger("tenant-a", id);
    const closed = waitForClose(first.ws, 5000);

    const second = await charger("tenant-a", id);

    expect((await closed).code).toBe(1000);
    // The gateway does not buffer the primary path: wait for the new upstream link.
    await waitFor(
      () => csmsA.to(id).filter((c) => c.ws.readyState === WebSocket.OPEN).length === 1,
    );
    second.ws.send(boot("boot-2"));
    await waitFor(() => second.received.some((m) => m.includes('"csms-a"')), 5000);
  });

  it.skipIf(!REAL_TENANT || !REAL_CHARGE_BOX_ID)(
    "boots against the real CSMS of SMOKE_REAL_TENANT",
    async () => {
      const { ws, received } = await charger(REAL_TENANT!, REAL_CHARGE_BOX_ID!, {
        headers: REAL_AUTH ? { Authorization: REAL_AUTH } : {},
      });
      expect(ws.protocol).toBe("ocpp1.6");

      // Messages sent before the gateway's primary link is open are dropped (the
      // primary path is not buffered), so retry like a charger would.
      const result = () =>
        received
          .map((m) => JSON.parse(m))
          .find(([type, id]) => type === 3 && id.startsWith("boot-"));
      for (let attempt = 1; !result() && attempt <= 5; attempt++) {
        ws.send(boot(`boot-${attempt}`));
        await waitFor(() => result() !== undefined, 2000).catch(() => undefined);
      }
      expect(result()?.[2].status).toBe("Accepted");
    },
  );
});
