import WebSocket from "ws";
import { createLogger } from "./logger";
import { type Route, buildTargetUrl } from "./routes";
import { type SessionKey, formatSessionKey } from "./sessions";
import { OCPP_SUBPROTOCOLS } from "./types";
import { redactUrl } from "./utils/url";
import { forwardPing, forwardPong, rawDataToString } from "./utils/websocket";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - Messages from the charger are forwarded to the primary and mirrored
 *   to all secondaries.
 * - Only the primary CSMS can send commands back to the charger.
 * - Every link (charger, primary, secondaries) rejects messages larger than
 *   `maxPayload`: `ws` closes it with 1009 before the message is seen here.
 * - Messages the charger sends while the primary is still connecting are
 *   held in a small bounded queue and flushed in order once it opens.
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link. Secondaries auto-reconnect, send
 *   periodic keepalive pings, and buffer a small bounded queue of
 *   messages while reconnecting so brief blips don't lose data.
 */

const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;
/** Messages buffered per upstream link while it is not open; oldest dropped first. */
export const UPSTREAM_MAX_QUEUE = 100;

interface SecondaryState {
  url: string;
  /** `url` without credentials: the only form that may be logged. */
  logUrl: string;
  ws: WebSocket | null;
  queue: string[];
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
}

export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private primaryQueue: string[] = [];
  private secondaries: SecondaryState[] = [];
  private alive = true;

  constructor(
    private readonly charger: WebSocket,
    private readonly key: SessionKey,
    private readonly route: Route,
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly maxPayload: number,
    private readonly onEnd: () => void,
  ) {
    // Tag logs with the tenant too: two tenants may share a chargeBoxId.
    this.log = createLogger(formatSessionKey(key));
    this.setup();
  }

  private setup() {
    // `new WebSocket()` throws synchronously on URLs it refuses to dial (bad
    // scheme, fragment, …). Never let that escape into the server's connection
    // handler: it would crash the gateway for every charger.
    const primaryUrl = buildTargetUrl(this.route.primary, this.key.chargeBoxId);
    const primaryLogUrl = redactUrl(primaryUrl);
    try {
      this.primary = this.connectPrimary(primaryUrl, primaryLogUrl);
    } catch (err) {
      this.log.error("primary error", { url: primaryLogUrl, error: errorMessage(err) });
      // Fail like an unreachable primary, once the caller has registered us.
      queueMicrotask(() => {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      });
      return;
    }

    for (const backend of this.route.secondaries) {
      const url = buildTargetUrl(backend, this.key.chargeBoxId);
      const state: SecondaryState = {
        url,
        logUrl: redactUrl(url),
        ws: null,
        queue: [],
        keepalive: null,
        reconnectTimer: null,
        lastPongAt: Date.now(),
      };
      try {
        state.ws = this.connectSecondary(state);
      } catch (err) {
        // A secondary must never affect the charger or the primary: skip it.
        this.log.error("secondary skipped", { url: state.logUrl, error: errorMessage(err) });
        continue;
      }
      this.secondaries.push(state);
    }

    this.charger.on("message", (data) => {
      const raw = rawDataToString(data);
      this.log.debugOcppFrame("charger → proxy", raw);

      const primary = this.primary;
      if (primary?.readyState === WebSocket.OPEN) {
        primary.send(raw);
      } else if (primary?.readyState === WebSocket.CONNECTING) {
        this.enqueueForPrimary(raw);
      } else {
        this.log.warn("primary not open, dropping message", { readyState: primary?.readyState });
      }

      for (const sec of this.secondaries) {
        if (sec.ws?.readyState === WebSocket.OPEN) {
          try {
            sec.ws.send(raw);
          } catch (err) {
            this.log.warn("secondary send failed", { url: sec.logUrl, error: errorMessage(err) });
          }
        } else {
          this.enqueueForSecondary(sec, raw);
        }
      }
    });

    this.charger.on("close", (code, reason) => {
      this.log.info("charger disconnected", {
        code,
        reason: reason.toString(),
      });
      this.teardown();
    });

    this.charger.on("error", (err) => {
      this.log.error("charger connection error", { error: err.message });
    });

    this.charger.on("ping", (data) => {
      forwardPing(this.primary, data);
    });

    this.charger.on("pong", (data) => {
      forwardPong(this.primary, data);
    });

    this.log.info("session started", {
      primary: primaryLogUrl,
      secondaries: this.secondaries.map((secondary) => secondary.logUrl),
      protocol: this.protocol,
    });
  }

  /**
   * Connect to the primary CSMS. The primary is bidirectional: its
   * responses are forwarded back to the charger, and a primary failure
   * tears the whole session down (chargers expect to talk to exactly one
   * CSMS at a time).
   */
  private connectPrimary(url: string, logUrl: string): WebSocket {
    const ws = new WebSocket(url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers: this.buildHeaders(),
      handshakeTimeout: 10_000,
      autoPong: false,
      maxPayload: this.maxPayload,
    });

    ws.on("open", () => {
      this.log.info("primary connected", { url: logUrl });
      this.flushPrimaryQueue(ws);
    });

    ws.on("message", (data) => {
      const raw = rawDataToString(data);
      this.log.debugOcppFrame("primary → charger", raw);
      if (this.charger.readyState === WebSocket.OPEN) {
        this.charger.send(raw);
      }
    });

    ws.on("close", (code, reason) => {
      this.log.warn("primary disconnected", {
        url: logUrl,
        code,
        reason: reason.toString(),
      });
      this.charger.close(1001, "Primary CSMS disconnected");
      this.teardown();
    });

    ws.on("error", (err) => {
      this.log.error("primary error", { url: logUrl, error: err.message });
      if (this.alive) {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      }
    });

    ws.on("ping", (data) => {
      forwardPing(this.charger, data);
    });
    ws.on("pong", (data) => {
      forwardPong(this.charger, data);
    });

    return ws;
  }

  /**
   * Connect (or reconnect) a secondary CSMS. Secondaries are one-way
   * mirrors: their responses are logged and discarded. They auto-reconnect
   * on disconnect/error and send periodic keepalive pings so idle
   * connections aren't dropped by intermediaries.
   */
  private connectSecondary(state: SecondaryState): WebSocket {
    const ws = new WebSocket(state.url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers: this.buildHeaders(),
      handshakeTimeout: 10_000,
      maxPayload: this.maxPayload,
    });

    ws.on("open", () => {
      this.log.info("secondary connected", { url: state.logUrl });
      state.lastPongAt = Date.now();
      this.flushSecondaryQueue(state, ws);
      this.startSecondaryKeepalive(state, ws);
    });

    ws.on("message", (data) => {
      const raw = rawDataToString(data);
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }
      this.log.debugOcppFrame("secondary response (ignored)", raw, { url: state.logUrl });
    });

    ws.on("pong", () => {
      state.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      this.log.warn("secondary disconnected", {
        url: state.logUrl,
        code,
        reason: reason.toString(),
      });
      this.stopSecondaryKeepalive(state);
      this.scheduleSecondaryReconnect(state);
    });

    ws.on("error", (err) => {
      this.log.error("secondary error", {
        url: state.logUrl,
        error: err.message,
      });
    });

    return ws;
  }

  private enqueueForPrimary(raw: string) {
    if (pushBounded(this.primaryQueue, raw)) {
      this.log.warn("primary queue full, dropping oldest message", { max: UPSTREAM_MAX_QUEUE });
    }
  }

  /** Teardown empties the queue, so nothing reaches the primary of an ended session. */
  private flushPrimaryQueue(ws: WebSocket) {
    if (this.primaryQueue.length === 0) return;
    this.log.info("primary flushing queued messages", { count: this.primaryQueue.length });
    for (const msg of this.primaryQueue) ws.send(msg);
    this.primaryQueue = [];
  }

  private enqueueForSecondary(state: SecondaryState, raw: string) {
    if (pushBounded(state.queue, raw)) {
      this.log.warn("secondary queue full, dropping oldest message", {
        url: state.logUrl,
        max: UPSTREAM_MAX_QUEUE,
      });
    }
  }

  private flushSecondaryQueue(state: SecondaryState, ws: WebSocket) {
    if (state.queue.length === 0) return;
    this.log.info("secondary flushing queued messages", {
      url: state.logUrl,
      count: state.queue.length,
    });
    for (const msg of state.queue) {
      try {
        ws.send(msg);
      } catch {
        /* best-effort */
      }
    }
    state.queue = [];
  }

  private startSecondaryKeepalive(state: SecondaryState, ws: WebSocket) {
    this.stopSecondaryKeepalive(state);
    state.keepalive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - state.lastPongAt > SECONDARY_PONG_TIMEOUT_MS) {
        this.log.warn("secondary pong timeout, forcing reconnect", {
          url: state.logUrl,
        });
        try {
          ws.close(4000, "pong timeout");
        } catch {
          /* */
        }
        return;
      }

      try {
        ws.ping();
      } catch {
        /* best-effort */
      }
    }, SECONDARY_KEEPALIVE_INTERVAL_MS);
  }

  private stopSecondaryKeepalive(state: SecondaryState) {
    if (state.keepalive !== null) {
      clearInterval(state.keepalive);
      state.keepalive = null;
    }
  }

  private scheduleSecondaryReconnect(state: SecondaryState) {
    if (!this.alive) return;
    if (state.reconnectTimer !== null) return;

    this.log.info("secondary reconnecting", {
      url: state.logUrl,
      delayMs: SECONDARY_RECONNECT_DELAY_MS,
    });

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!this.alive) return;
      state.ws = this.connectSecondary(state);
    }, SECONDARY_RECONNECT_DELAY_MS);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }

  teardown() {
    if (!this.alive) return;
    this.alive = false;
    this.primaryQueue = [];

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
      sec.queue = [];
    }

    const close = (ws: WebSocket | null) => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(1000);
      }
    };

    close(this.primary);
    for (const sec of this.secondaries) close(sec.ws);
    close(this.charger);

    this.log.info("session ended");
    this.onEnd();
  }
}

/** Append `raw` to `queue`, dropping the oldest message when full; true if one was dropped. */
function pushBounded(queue: string[], raw: string): boolean {
  const full = queue.length >= UPSTREAM_MAX_QUEUE;
  if (full) queue.shift();
  queue.push(raw);
  return full;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
