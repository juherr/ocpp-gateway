import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config";
import { ChargerConnection } from "./connection";
import { createLogger } from "./logger";
import type { RouteStore } from "./routes";
import { SessionRegistry } from "./sessions";
import { OCPP_SUBPROTOCOLS } from "./types";

const log = createLogger("proxy");

/**
 * Start the OCPP proxy server.
 *
 * Chargers connect via:
 *   ws(s)://proxy-host:port/<chargeBoxId>
 *
 * The chargeBoxId (last path segment) is resolved against the routing table
 * to pick a primary CSMS and optional read-only secondaries; the same id is
 * then appended to each upstream URL unless that backend opts out.
 */
export function startProxy(config: Config, routes: RouteStore) {
  const sessions = new SessionRegistry<ChargerConnection>();

  const server = createServer((req, res) => {
    if (handleHttp(req, res)) return;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ocpp-gateway is running.\nConnect your charge point via WebSocket.\n");
  });

  const wss = new WebSocketServer({
    server,
    autoPong: false,
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) {
        if (protocols.has(p)) return p;
      }
      return false;
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const chargePointId = extractChargePointId(req.url);
    if (!chargePointId) {
      log.warn("rejected connection: no charge point ID in path", {
        url: req.url,
      });
      ws.close(1002, "Charge point ID required in URL path");
      return;
    }

    const protocol = ws.protocol;
    const authHeader = req.headers.authorization;
    const route = routes.resolve(chargePointId);

    log.info("charger connected", {
      chargePointId,
      protocol: protocol || "none",
      ip: req.socket.remoteAddress,
      primary: route.primary.url,
      secondaries: route.secondaries.map((backend) => backend.url),
    });

    // Replace this charger's stale session, if any: some CSMS reject a new
    // connection while the old one is still open, forcing a reconnect loop.
    // Only sessions opened with the same credentials are replaced (see
    // SessionRegistry).
    const { replaced, kept } = sessions.evict(chargePointId, authHeader);
    if (replaced > 0) log.info("replaced existing session", { chargePointId, replaced });
    if (kept > 0) {
      log.warn("existing session kept: new connection has different credentials", {
        chargePointId,
        kept,
        ip: req.socket.remoteAddress,
      });
    }

    const conn = new ChargerConnection(ws, chargePointId, route, protocol, authHeader, () => {
      sessions.remove(chargePointId, conn);
    });
    sessions.add(chargePointId, authHeader, conn);
  });

  wss.on("error", (err) => {
    log.error("WebSocket server error", { error: err.message });
  });

  server.listen(config.port, () => {
    log.info("proxy listening", {
      port: config.port,
      routesFile: config.routesFile,
    });
  });

  /** Close every charger session, then stop accepting connections. */
  const close = () =>
    new Promise<void>((resolve) => {
      for (const ws of wss.clients) ws.close(1001, "Server shutting down");
      wss.close();
      server.close(() => resolve());
    });

  return { server, close };
}

/** Handle plain-HTTP endpoints. Returns true if the request was served. */
function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return true;
  }
  return false;
}

function extractChargePointId(url: string | undefined): string | null {
  if (!url) return null;
  const segments = url.split("?")[0].split("/").filter(Boolean);
  // Accept /ocpp/<id>, /ws/<id>, or just /<id>
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
