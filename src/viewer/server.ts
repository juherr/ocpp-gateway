import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViewerConfig } from "../config";
import { createLogger } from "../logger";
import { readSingleHeader } from "../tenants";
import { clientSource } from "../utils/ip";
import {
  type AuthFailureLimiterOptions,
  AuthFailureLimiter,
  verifyBasicAuthorization,
} from "./auth";

const log = createLogger("viewer");

/** The page and its assets, served as given. Injected, so tests and builds choose them. */
export interface ViewerAssets {
  html: string;
  js: string;
  css: string;
}

/** Answers an authenticated request; the security headers are already set on `res`. */
export type ViewerRouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface ViewerDeps {
  assets: ViewerAssets;
  /**
   * Answers `GET`/`HEAD /events` (the live stream) once the request is
   * authenticated. Unset: `404`.
   */
  events?: ViewerRouteHandler;
  /** Failed-authentication limit; default 10 failures per source per minute. */
  authLimits?: AuthFailureLimiterOptions;
}

export interface ViewerServer {
  server: Server;
  /** Stop listening and drop every connection, keep-alive ones included. Idempotent. */
  close(): Promise<void>;
}

const REALM_CHALLENGE = 'Basic realm="OCPP Gateway Viewer", charset="UTF-8"';

/** Set on every response, errors included, before any handler runs. */
const SECURITY_HEADERS: readonly [string, string][] = [
  ["Cache-Control", "no-store"],
  [
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
  ["X-Frame-Options", "DENY"],
];

const TEXT = "text/plain; charset=utf-8";

interface Body {
  contentType: string;
  bytes: Buffer;
}

const body = (contentType: string, text: string): Body => ({
  contentType,
  bytes: Buffer.from(text, "utf8"),
});

function hasHeader(rawHeaders: readonly string[], name: string): boolean {
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) return true;
  }
  return false;
}

/**
 * The key a request is rate-limited under: the client IP header when one is
 * configured (exactly one value, a bare IP address), otherwise the socket
 * address; `null` when there is none, which fails closed.
 */
function requestSource(req: IncomingMessage, clientIpHeader: string | undefined): string | null {
  const address = clientIpHeader
    ? readSingleHeader(req.rawHeaders, clientIpHeader)
    : (req.socket.remoteAddress ?? null);
  return address === null ? null : clientSource(address);
}

/**
 * Starts the viewer's own HTTP server, apart from the OCPP port. Every request
 * is authenticated with HTTP Basic before anything else is looked at (route,
 * method), so nothing, not even a 404, is answered anonymously; a source that
 * failed too often is refused with `429` until its window ends.
 */
export function startViewer(config: ViewerConfig, deps: ViewerDeps): ViewerServer {
  const credentials = { username: config.username, password: config.password };
  const limiter = new AuthFailureLimiter(deps.authLimits);
  const routes = new Map<string, Body>([
    ["/", body("text/html; charset=utf-8", deps.assets.html)],
    ["/viewer.js", body("text/javascript; charset=utf-8", deps.assets.js)],
    ["/viewer.css", body("text/css; charset=utf-8", deps.assets.css)],
    [
      "/api/config",
      body(
        "application/json; charset=utf-8",
        JSON.stringify({ maxBufferedMessages: config.maxBufferedMessages }),
      ),
    ],
  ]);

  const send = (req: IncomingMessage, res: ServerResponse, status: number, content: Body) => {
    res.writeHead(status, {
      "Content-Type": content.contentType,
      "Content-Length": content.bytes.length,
    });
    res.end(req.method === "HEAD" ? undefined : content.bytes);
  };

  const recordFailure = (source: string) => {
    const { first, blocked, overflow } = limiter.recordFailure(source);
    // At most two lines per source and window; never the credentials tried.
    const where = overflow ? { source: null, otherSources: true } : { source };
    if (first) log.warn("viewer authentication failed", where);
    if (blocked) log.warn("viewer source blocked", where);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);

    const source = requestSource(req, config.clientIpHeader);
    if (source === null) return send(req, res, 400, body(TEXT, "Bad Request\n"));

    const retryAfterMs = limiter.retryAfterMs(source);
    if (retryAfterMs > 0) {
      res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
      return send(req, res, 429, body(TEXT, "Too Many Requests\n"));
    }

    // A duplicated header reads as none, and fails like a wrong one.
    const authorization = readSingleHeader(req.rawHeaders, "authorization");
    if (!verifyBasicAuthorization(authorization, credentials)) {
      // A browser's first request carries no credentials: only a wrong or
      // malformed attempt counts towards the limit.
      if (hasHeader(req.rawHeaders, "authorization")) recordFailure(source);
      res.setHeader("WWW-Authenticate", REALM_CHALLENGE);
      return send(req, res, 401, body(TEXT, "Unauthorized\n"));
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return send(req, res, 405, body(TEXT, "Method Not Allowed\n"));
    }

    // An exact match on the path: `//viewer.js` is not `/viewer.js`.
    const url = req.url ?? "";
    const query = url.indexOf("?");
    const path = query === -1 ? url : url.slice(0, query);
    if (path === "/events" && deps.events) return deps.events(req, res);
    const content = routes.get(path);
    if (!content) return send(req, res, 404, body(TEXT, "Not Found\n"));
    send(req, res, 200, content);
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // A bug here must never become an uncaught exception: that would end
      // every charger session along with the process.
      log.error("viewer request failed", undefined, { report: true, cause: err });
      if (res.headersSent) res.destroy();
      else send(req, res, 500, body(TEXT, "Internal Server Error\n"));
    }
  });

  server.on("error", (err) => {
    log.error(
      "viewer server error",
      { host: config.host, port: config.port },
      {
        report: true,
        cause: err,
      },
    );
  });

  server.listen(config.port, config.host, () => {
    log.info("viewer listening", {
      host: config.host,
      port: (server.address() as AddressInfo).port,
      clientIpHeader: config.clientIpHeader,
      maxBufferedMessages: config.maxBufferedMessages,
      maxClients: config.maxClients,
    });
  });

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      limiter.stop();
      // Resolves even when the server never listened (its callback then gets
      // ERR_SERVER_NOT_RUNNING): there is nothing left to wait for.
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  return { server, close };
}
