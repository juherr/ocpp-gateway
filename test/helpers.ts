import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { Config } from "../src/config";
import { startProxy } from "../src/proxy";
import { RouteStore } from "../src/routes";
import { OCPP_SUBPROTOCOLS } from "../src/types";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start the gateway on an ephemeral port with the given routing table and
 * resolve once it is listening. Call `close()` to shut it down.
 */
export async function startGateway(table: object, overrides: Partial<Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-test-"));
  const routesFile = join(dir, "routes.json");
  writeFileSync(routesFile, JSON.stringify(table));
  const routes = RouteStore.load(routesFile);
  rmSync(dir, { recursive: true });

  const gateway = startProxy(
    { port: 0, routesFile, loggerConfig: { logLevel: "error" }, ...overrides },
    routes,
  );
  await once(gateway.server, "listening");
  return {
    port: (gateway.server.address() as AddressInfo).port,
    close: gateway.close,
  };
}

/**
 * A mock CSMS that records what it receives and replies with a tagged result.
 * Listens on an ephemeral port unless `port` is given.
 */
export function makeCsms(tag: string, port = 0) {
  const received: string[] = [];
  let connections = 0;
  let auth: string | undefined;
  let protocol: string | undefined;
  let path: string | undefined;
  let host: string | undefined;

  const wss = new WebSocketServer({
    port,
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
    host = req.headers.host;
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
    host: () => host,
    port: () => (wss.address() as AddressInfo).port,
    url: () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    close: () => wss.close(),
  };
}

export async function waitFor(cond: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(15);
  }
}

export function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket timeout"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function waitForClose(
  socket: WebSocket,
  timeoutMs = 2000,
): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket close timeout"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve({ code, reason: Buffer.from(reason) });
    };
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

/** Open a charger socket; callers start the gateway (and await "listening") first. */
export async function connectWhenOpen(
  url: string,
  protocol: string,
  timeoutMs = 3000,
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  const socket = new WebSocket(url, protocol, { headers });
  await waitForOpen(socket, timeoutMs);
  return socket;
}
