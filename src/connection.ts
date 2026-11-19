import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { createLogger } from "./logger";
import { type Route, buildTargetUrl } from "./routes";
import { type SessionKey, formatSessionKey } from "./sessions";
import { type DeliveryTracker, type FrameEncoding, SessionTracer } from "./trace/session-tracer";
import type { TraceSink } from "./trace/writer";
import { errorMessage } from "./utils/errors";
import { OCPP_SUBPROTOCOLS } from "./types";
import { BoundedQueue } from "./utils/bounded-queue";
import { isOcppResponse } from "./utils/ocpp";
import { redactUrl } from "./utils/url";
import {
  type ForwardResult,
  MAX_PENDING_FORWARDED_CONTROL_FRAMES,
  forwardPing,
  forwardPong,
  isUtf8Data,
  rawDataToString,
} from "./utils/websocket";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - Messages from the charger are forwarded to the primary and mirrored
 *   to all secondaries, except its responses (CALLRESULT, CALLERROR): they
 *   answer the primary's CALLs and go to the primary only.
 * - Only the primary CSMS can send commands back to the charger.
 * - Every link (charger, primary, secondaries) rejects messages larger than
 *   `maxPayload`: `ws` closes it with 1009 before the message is seen here.
 * - Messages the charger sends while the primary is still connecting are
 *   held in a bounded queue and flushed in order once it opens.
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link. Secondaries auto-reconnect, send
 *   periodic keepalive pings, and buffer a bounded queue of
 *   messages while reconnecting so brief blips don't lose data.
 * - Every queue is bounded by count and by total bytes, dropping the
 *   oldest messages first.
 * - Pings and pongs are forwarded end to end, at most
 *   `MAX_PENDING_FORWARDED_CONTROL_FRAMES` not yet written out per link:
 *   past that, the charger is terminated and the session ends.
 * - No link may hold more than `maxBufferedBytes` not yet written out
 *   (`bufferedAmount`, checked before each message): the charger and the
 *   primary are the session, so either one over it ends the session; a
 *   secondary over it is cut and reconnected, its messages queued meanwhile.
 * - With trace sinks (the archive, a live viewer), every received frame is
 *   captured once, at ingress, and each destination's delivery outcome is
 *   tracked (queued, submitted, written, failed, dropped) on that same
 *   record. Without one, forwarding is exactly as if tracing did not exist.
 */

export const SECONDARY_RECONNECT_DELAY_MS = 10_000;
const SECONDARY_KEEPALIVE_INTERVAL_MS = 30_000;
const SECONDARY_PONG_TIMEOUT_MS = 90_000;
/** Pinged intervals without any frame from the charger before its session is closed. */
const CHARGER_PONG_TIMEOUT_INTERVALS = 3;
/** Messages buffered per upstream link while it is not open; oldest dropped first. */
export const UPSTREAM_MAX_QUEUE = 100;
/**
 * Total bytes buffered per upstream link while it is not open; raised to the
 * session's `maxPayload` when larger, so a maximum-size message always fits.
 */
export const UPSTREAM_MAX_QUEUE_BYTES = 1024 * 1024;

/** A message waiting for its link to open, with its trace delivery when archiving. */
interface QueuedMessage {
  raw: string;
  delivery?: DeliveryTracker;
}

interface SecondaryState {
  /** Backend id, the secondary's name in traces. */
  id: string;
  url: string;
  /** `url` without credentials: the only form that may be logged. */
  logUrl: string;
  ws: WebSocket | null;
  queue: BoundedQueue<QueuedMessage>;
  keepalive: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastPongAt: number;
}

export class ChargerConnection {
  /** Unique per charger WebSocket connection: tells apart sessions of the same charger. */
  readonly sessionId = randomUUID();
  private readonly log;
  private primary: WebSocket | null = null;
  private readonly primaryQueue: BoundedQueue<QueuedMessage>;
  private secondaries: SecondaryState[] = [];
  private tracer: SessionTracer | undefined;
  private alive = true;
  /** Pings the charger while the session is open; null when the option is off. */
  private chargerKeepalive: ReturnType<typeof setInterval> | null = null;
  /** Payload of the gateway's own pings, so their pongs never reach the primary. */
  private chargerPingToken: Buffer | null = null;
  private chargerLastSeenAt = Date.now();

  constructor(
    private readonly charger: WebSocket,
    private readonly key: SessionKey,
    private readonly route: Route,
    private readonly protocol: string,
    private readonly authHeader: string | undefined,
    private readonly maxPayload: number,
    private readonly onEnd: () => void,
    /** Where this session's frames are traced (archive, live viewer); none: not traced. */
    private readonly traceSinks: readonly TraceSink[] = [],
    /** Called once the primary link opens: the session is no longer pending. */
    private readonly onPrimaryOpen?: () => void,
    /** Interval between the gateway's pings to the charger; 0: never pinged. */
    private readonly chargerPingIntervalMs = 0,
    /**
     * Bytes a link may hold not yet written out before the next message to it
     * is refused; by default the size of an upstream queue.
     */
    private readonly maxBufferedBytes = Math.max(UPSTREAM_MAX_QUEUE_BYTES, maxPayload),
  ) {
    // Tag logs with the tenant too: two tenants may share a chargeBoxId.
    this.log = createLogger(formatSessionKey(key));
    this.primaryQueue = this.createQueue();
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
        // Only read when tracing (archive or live viewer), which requires
        // backend ids (see startProxy).
        id: backend.id!,
        url,
        logUrl: redactUrl(url),
        ws: null,
        queue: this.createQueue(),
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

    // Destinations are the secondaries actually set up, in forwarding order.
    if (this.traceSinks.length > 0) {
      this.tracer = new SessionTracer(
        {
          sessionId: this.sessionId,
          tenantId: this.key.tenantId,
          chargePointId: this.key.chargeBoxId,
          protocol: this.protocol,
          primaryId: this.route.primary.id!,
          secondaryIds: this.secondaries.map((sec) => sec.id),
        },
        this.traceSinks,
      );
    }

    this.charger.on("message", (data, isBinary) => {
      this.chargerLastSeenAt = Date.now();
      const raw = rawDataToString(data);
      this.log.debugOcppFrame("charger → proxy", raw);
      // A response answers a CALL from the primary: secondaries never asked.
      const mirrored = this.secondaries.length === 0 || !isOcppResponse(raw);
      const secondaries = mirrored ? this.secondaries : [];
      // Archived once, here at ingress, however many links it goes to.
      const frame = this.tracer?.fromCharger(raw, encodingOf(data, isBinary), mirrored);

      // ws still delivers frames in flight while the charger closes: nothing
      // forwards them once the session has ended.
      if (!this.alive) {
        this.log.warn("session ended, dropping message");
        if (frame) {
          for (let i = 0; i <= secondaries.length; i++) frame.delivery(i).dropped("session-ended");
          frame.commit();
        }
        return;
      }

      const primary = this.primary;
      const primaryDelivery = frame?.delivery(0);
      // The charger writes faster than the primary reads: forward nothing.
      if (primary?.readyState === WebSocket.OPEN && this.isSaturated(primary)) {
        primaryDelivery?.dropped("link-saturated");
        for (let i = 1; i <= secondaries.length; i++) frame?.delivery(i).dropped("session-ended");
        frame?.commit();
        this.closeCharger("send buffer full, closing the charger", {
          link: "primary",
          bufferedAmount: primary.bufferedAmount,
          maxBufferedBytes: this.maxBufferedBytes,
        });
        return;
      }
      if (primary?.readyState === WebSocket.OPEN) {
        send(primary, raw, primaryDelivery);
      } else if (primary?.readyState === WebSocket.CONNECTING) {
        this.enqueue("primary", this.primaryQueue, { raw, delivery: primaryDelivery });
      } else {
        this.log.warn("primary not open, dropping message", { readyState: primary?.readyState });
        primaryDelivery?.dropped("link-not-open");
      }

      secondaries.forEach((sec, index) => {
        const delivery = frame?.delivery(index + 1);
        if (sec.ws?.readyState === WebSocket.OPEN && this.isSaturated(sec.ws)) {
          this.reconnectSaturatedSecondary(sec, sec.ws);
        }
        if (sec.ws?.readyState === WebSocket.OPEN) {
          try {
            send(sec.ws, raw, delivery);
          } catch (err) {
            this.log.warn("secondary send failed", { url: sec.logUrl, error: errorMessage(err) });
            delivery?.failed(errorMessage(err));
          }
        } else {
          this.enqueue("secondary", sec.queue, { raw, delivery }, { url: sec.logUrl });
        }
      });

      frame?.commit();
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
      this.chargerLastSeenAt = Date.now();
      this.enforceControlFrameCap("primary", forwardPing(this.primary, data));
    });

    this.charger.on("pong", (data) => {
      this.chargerLastSeenAt = Date.now();
      // The answer to the gateway's own ping: the primary never asked for it.
      if (this.chargerPingToken?.equals(data)) return;
      this.enforceControlFrameCap("primary", forwardPong(this.primary, data));
    });

    this.log.info("session started", {
      primary: primaryLogUrl,
      secondaries: this.secondaries.map((secondary) => secondary.logUrl),
      protocol: this.protocol,
    });

    if (this.chargerPingIntervalMs > 0) this.startChargerKeepalive();
  }

  /**
   * Ping the charger every `chargerPingIntervalMs`, so that idle proxies in
   * front of the gateway keep its connection open, and close the session once
   * the charger has sent nothing for `CHARGER_PONG_TIMEOUT_INTERVALS`
   * intervals: a dead socket must not keep the primary open. Any frame counts
   * as a sign of life, not only the pong: some stacks do not echo the payload.
   *
   * RFC 6455 §5.5.3 lets a peer answer only the latest of several pings, so a
   * primary ping crossing the gateway's may go unanswered; the primary's next
   * one is.
   */
  private startChargerKeepalive() {
    const token = randomBytes(8);
    this.chargerPingToken = token;
    const timeoutMs = CHARGER_PONG_TIMEOUT_INTERVALS * this.chargerPingIntervalMs;
    this.chargerLastSeenAt = Date.now();
    this.chargerKeepalive = setInterval(() => {
      if (this.charger.readyState !== WebSocket.OPEN) return;

      if (Date.now() - this.chargerLastSeenAt > timeoutMs) {
        this.log.warn("charger pong timeout, closing the session", { timeoutMs });
        try {
          // No close handshake: a dead peer would never complete it.
          this.charger.terminate();
        } catch {
          /* best-effort */
        }
        this.teardown();
        return;
      }

      try {
        this.charger.ping(token);
      } catch {
        /* best-effort */
      }
    }, this.chargerPingIntervalMs);
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
      this.onPrimaryOpen?.();
      this.flushPrimaryQueue(ws);
    });

    ws.on("message", (data, isBinary) => {
      const raw = rawDataToString(data);
      this.log.debugOcppFrame("primary → charger", raw);
      const frame = this.tracer?.fromPrimary(raw, encodingOf(data, isBinary));
      if (this.charger.readyState === WebSocket.OPEN && this.isSaturated(this.charger)) {
        // The charger stopped reading what it asked for: cut it.
        frame?.delivery(0).dropped("link-saturated");
        this.closeCharger("send buffer full, closing the charger", {
          link: "charger",
          bufferedAmount: this.charger.bufferedAmount,
          maxBufferedBytes: this.maxBufferedBytes,
        });
      } else if (this.charger.readyState === WebSocket.OPEN) {
        send(this.charger, raw, frame?.delivery(0));
      } else {
        frame?.delivery(0).dropped("link-not-open");
      }
      frame?.commit();
    });

    ws.on("close", (code, reason) => {
      // After teardown, the gateway closed it itself: not an outage.
      const level = this.alive ? "warn" : "info";
      this.log[level]("primary disconnected", {
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
      this.enforceControlFrameCap("charger", forwardPing(this.charger, data));
    });
    ws.on("pong", (data) => {
      this.enforceControlFrameCap("charger", forwardPong(this.charger, data));
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

    ws.on("message", (data, isBinary) => {
      const raw = rawDataToString(data);
      // An application-level keepalive some CSMS send, not an OCPP frame: never archived.
      if (raw === "__pong__") {
        state.lastPongAt = Date.now();
        return;
      }
      this.log.debugOcppFrame("secondary response (ignored)", raw, { url: state.logUrl });
      this.tracer?.fromSecondary(state.id, raw, encodingOf(data, isBinary));
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

  /**
   * Act on a forwarded ping or pong refused because its target holds too many
   * not yet written out. The charger drives that flood in either direction
   * (its pings make the primary answer, its own pings and pongs pile up on a
   * slower primary link), so the charger link is the one cut: terminated,
   * since a close frame would wait behind frames a peer that does not read
   * never takes. Once terminated, no link forwards again: logged once.
   */
  private enforceControlFrameCap(link: "charger" | "primary", result: ForwardResult) {
    if (result !== "over-cap") return;
    this.closeCharger("forwarded control frames piling up, closing the charger", {
      link,
      pending: MAX_PENDING_FORWARDED_CONTROL_FRAMES,
    });
  }

  /** Whether `ws` holds more than `maxBufferedBytes` not yet written out. */
  private isSaturated(ws: WebSocket): boolean {
    return ws.bufferedAmount > this.maxBufferedBytes;
  }

  /**
   * End the session of a charger that floods a link: terminated, since a
   * close frame would wait behind frames a peer that does not read never
   * takes. Once ended, nothing forwards again, so this is logged once.
   */
  private closeCharger(message: string, fields: Record<string, unknown>) {
    if (!this.alive) return;
    this.log.warn(message, fields);
    try {
      this.charger.terminate();
    } catch {
      /* best-effort */
    }
    this.teardown();
  }

  /**
   * Cut a secondary that reads slower than the charger writes, never the
   * session: its `close` schedules the reconnect, and messages wait in its
   * bounded queue meanwhile, as for any other outage.
   */
  private reconnectSaturatedSecondary(state: SecondaryState, ws: WebSocket) {
    this.log.warn("secondary send buffer full, reconnecting", {
      url: state.logUrl,
      bufferedAmount: ws.bufferedAmount,
      maxBufferedBytes: this.maxBufferedBytes,
    });
    try {
      ws.terminate();
    } catch {
      /* best-effort */
    }
  }

  private createQueue(): BoundedQueue<QueuedMessage> {
    // Sized so a maximum-size message always fits; the queue also keeps any
    // single incoming message, as a safety net for frames that grow when
    // decoded (invalid UTF-8 becomes U+FFFD).
    return new BoundedQueue<QueuedMessage>(
      UPSTREAM_MAX_QUEUE,
      Math.max(UPSTREAM_MAX_QUEUE_BYTES, this.maxPayload),
    );
  }

  private enqueue(
    link: "primary" | "secondary",
    queue: BoundedQueue<QueuedMessage>,
    message: QueuedMessage,
    fields: Record<string, unknown> = {},
  ) {
    message.delivery?.queued();
    const dropped = queue.push(message);
    for (const old of dropped) old.delivery?.dropped("queue-overflow");
    if (dropped.length > 0) {
      this.log.warn(`${link} queue full, dropping oldest message`, {
        ...fields,
        dropped: dropped.length,
        ...queueStats(queue),
      });
    }
  }

  /** Teardown empties the queue, so nothing reaches the primary of an ended session. */
  private flushPrimaryQueue(ws: WebSocket) {
    if (this.primaryQueue.length === 0) return;
    this.log.info("primary flushing queued messages", queueStats(this.primaryQueue));
    for (const msg of this.primaryQueue.drain()) send(ws, msg.raw, msg.delivery);
  }

  private flushSecondaryQueue(state: SecondaryState, ws: WebSocket) {
    if (state.queue.length === 0) return;
    this.log.info("secondary flushing queued messages", {
      url: state.logUrl,
      ...queueStats(state.queue),
    });
    for (const msg of state.queue.drain()) {
      try {
        send(ws, msg.raw, msg.delivery);
      } catch (err) {
        /* best-effort */
        msg.delivery?.failed(errorMessage(err));
      }
    }
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
    if (this.chargerKeepalive !== null) {
      clearInterval(this.chargerKeepalive);
      this.chargerKeepalive = null;
    }
    dropAll(this.primaryQueue);

    for (const sec of this.secondaries) {
      this.stopSecondaryKeepalive(sec);
      if (sec.reconnectTimer !== null) {
        clearTimeout(sec.reconnectTimer);
        sec.reconnectTimer = null;
      }
      dropAll(sec.queue);
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

/**
 * Send `raw`, reporting the outcome to `delivery` when archiving: `written`
 * once ws has written it to the socket, `failed` on error. Without a
 * delivery, a plain send as before archiving existed.
 */
function send(ws: WebSocket, raw: string, delivery: DeliveryTracker | undefined) {
  if (!delivery) {
    ws.send(raw);
    return;
  }
  delivery.submitted();
  ws.send(raw, (error) => delivery.settled(error));
}

/** Empty `queue` of a session that ended: its messages will never be sent. */
function dropAll(queue: BoundedQueue<QueuedMessage>) {
  for (const msg of queue.drain()) msg.delivery?.dropped("session-ended");
}

/** Log fields describing a queue's fill level and bounds. */
function queueStats(queue: BoundedQueue<QueuedMessage>) {
  return {
    count: queue.length,
    bytes: queue.bytes,
    maxCount: queue.maxCount,
    maxBytes: queue.maxBytes,
  };
}

/** How a frame arrived, for the archive: bytes that are not UTF-8 were decoded lossily. */
function encodingOf(data: WebSocket.RawData, isBinary: boolean): FrameEncoding {
  if (!isBinary) return "text";
  return isUtf8Data(data) ? "binary" : "lossy-binary";
}
