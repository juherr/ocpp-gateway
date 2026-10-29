import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../logger";
import type { Delivery, TraceDocument } from "../trace/record";
import type { TraceSink } from "../trace/writer";

const log = createLogger("viewer");

/**
 * Bytes a client may have waiting to be sent (`writableLength`) before its
 * events are dropped, as a multiple of `MAX_MESSAGE_BYTES`. An event is only
 * written below this bound, so any single frame still reaches a client that
 * keeps up. A trace event carries the frame twice (`raw`, escaped, and the
 * parsed payload): about 2 to 3 times the frame's size.
 */
export const SOFT_LIMIT_MESSAGES = 4;
/** Past this many more frames' worth of waiting bytes, the client is ended. */
export const HARD_LIMIT_EXTRA_MESSAGES = 4;
/** Events dropped in a row before a slow client is ended. */
export const MAX_DROPPED_EVENTS = 1000;
/** How long a client may keep dropping events before it is ended. */
export const MAX_DROPPING_MS = 30_000;
/** Interval of the `: ping` comment that keeps idle streams (and proxies) alive. */
export const HEARTBEAT_MS = 15_000;

export interface LiveTraceHubOptions {
  /** Most clients streaming at once; more get `503`. */
  maxClients: number;
  /** Advertised in `hello`: how many messages a browser keeps. */
  maxBufferedMessages: number;
  /** The gateway's `MAX_MESSAGE_BYTES`; sizes the default buffer bounds. */
  maxMessageBytes: number;
  /** Default `SOFT_LIMIT_MESSAGES × maxMessageBytes`. */
  softLimitBytes?: number;
  /** Default `softLimitBytes + HARD_LIMIT_EXTRA_MESSAGES × maxMessageBytes`. */
  hardLimitBytes?: number;
  maxDroppedEvents?: number;
  maxDroppingMs?: number;
  heartbeatMs?: number;
}

/**
 * The end of one event stream, an `http.ServerResponse` in production. Only
 * what the hub needs, so it can be tested without sockets.
 */
export interface StreamClient {
  /** Bytes written but not yet handed to the peer. */
  readonly writableLength: number;
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: Buffer): boolean;
  /** Ends the stream once its buffer is sent (shutdown). */
  end(): void;
  /** Cuts the stream at once, freeing its buffer (slow or failing clients). */
  destroy(): void;
}

export interface LiveTraceHubStats {
  clients: number;
  /** Events (trace, delivery) written, summed over clients. */
  sent: number;
  /** Events not written to a client that was behind, summed over clients. */
  dropped: number;
  /** Clients ended for being too slow. */
  endedSlow: number;
  /** Highest `writableLength` seen right after a write, over every client. */
  peakBufferedBytes: number;
}

type EndReason = "disconnected" | "slow" | "write-failed" | "shutdown";

interface Client {
  stream: StreamClient;
  connectedAt: number;
  sent: number;
  droppedTotal: number;
  /** Events dropped since the last one written: reported in the next `gap`. */
  pendingGap: number;
  /** When the current run of drops started. */
  droppingSince?: number;
}

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

const PING = Buffer.from(": ping\n\n");

/** One SSE event; `data` is JSON, a single line (JSON.stringify never emits a raw newline). */
function sseEvent(event: string, data: unknown, id?: number): Buffer {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return Buffer.from(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Streams captured frames to the viewer's browsers over Server-Sent Events.
 *
 * A {@link TraceSink}: `insert` serialises each document once, then writes the
 * same bytes to every client; nothing is retained, so there is no history and
 * a client only sees frames received while it is connected. Every client has a
 * bounded buffer: a client that falls behind loses events (counted, reported
 * by a `gap` event once it catches up) and is ended if it does not catch up.
 * Never blocks nor throws into the forwarding path.
 */
export class LiveTraceHub implements TraceSink {
  private readonly clients = new Set<Client>();
  private readonly startedAt = new Date();
  private readonly softLimitBytes: number;
  private readonly hardLimitBytes: number;
  private readonly maxDroppedEvents: number;
  private readonly maxDroppingMs: number;
  private readonly heartbeatMs: number;
  private heartbeat?: NodeJS.Timeout;
  private nextEventId = 1;
  private closed = false;
  private failureReported = false;
  private readonly totals = { sent: 0, dropped: 0, endedSlow: 0, peakBufferedBytes: 0 };

  constructor(private readonly options: LiveTraceHubOptions) {
    this.softLimitBytes = options.softLimitBytes ?? SOFT_LIMIT_MESSAGES * options.maxMessageBytes;
    this.hardLimitBytes =
      options.hardLimitBytes ??
      this.softLimitBytes + HARD_LIMIT_EXTRA_MESSAGES * options.maxMessageBytes;
    this.maxDroppedEvents = options.maxDroppedEvents ?? MAX_DROPPED_EVENTS;
    this.maxDroppingMs = options.maxDroppingMs ?? MAX_DROPPING_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  active(): boolean {
    return this.clients.size > 0;
  }

  insert(doc: TraceDocument): boolean {
    if (this.clients.size === 0) return false;
    try {
      const json = JSON.stringify(doc);
      this.broadcast(Buffer.from(`id: ${this.nextEventId++}\nevent: trace\ndata: ${json}\n\n`));
      return true;
    } catch (err) {
      this.reportFailure(err);
      return false;
    }
  }

  updateDelivery(id: string, index: number, delivery: Delivery): void {
    if (this.clients.size === 0) return;
    try {
      this.broadcast(sseEvent("delivery", { id, index, delivery }));
    } catch (err) {
      this.reportFailure(err);
    }
  }

  /**
   * Answers `GET`/`HEAD /events`, once authenticated. `HEAD` gets the stream's
   * headers only and is not a client; over `maxClients`, `503`.
   */
  readonly handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === "HEAD") {
      res.writeHead(200, STREAM_HEADERS);
      res.end();
      return;
    }
    if (this.closed || this.clients.size >= this.options.maxClients) {
      const body = "Too many viewer clients\n";
      res.writeHead(503, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    // `Last-Event-ID` is ignored: there is no history to resume from.
    res.writeHead(200, STREAM_HEADERS);
    res.flushHeaders();
    const detach = this.attach(res);
    res.on("close", detach);
    res.on("error", detach);
  };

  /**
   * Registers a stream and greets it with `hello`. Returns the function to
   * call when it closes (idempotent).
   */
  attach(stream: StreamClient): () => void {
    if (this.closed) {
      safely(() => stream.end());
      return () => undefined;
    }
    const client: Client = {
      stream,
      connectedAt: Date.now(),
      sent: 0,
      droppedTotal: 0,
      pendingGap: 0,
    };
    this.clients.add(client);
    if (this.clients.size === 1) this.startHeartbeat();
    this.write(
      client,
      sseEvent("hello", {
        serverTime: new Date().toISOString(),
        startedAt: this.startedAt.toISOString(),
        maxBufferedMessages: this.options.maxBufferedMessages,
      }),
    );
    return () => this.remove(client, "disconnected");
  }

  stats(): LiveTraceHubStats {
    return { clients: this.clients.size, ...this.totals };
  }

  /** Stops the heartbeat and ends every stream; logs the counters. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) {
      this.remove(client, "shutdown");
      safely(() => client.stream.end());
    }
    log.info("live viewer closed", {
      sent: this.totals.sent,
      dropped: this.totals.dropped,
      endedSlow: this.totals.endedSlow,
    });
  }

  private broadcast(event: Buffer): void {
    for (const client of this.clients) {
      if (client.stream.writableLength >= this.softLimitBytes) {
        this.drop(client);
        continue;
      }
      if (client.pendingGap > 0 && !this.flushGap(client)) continue;
      if (this.write(client, event)) {
        client.sent++;
        this.totals.sent++;
      }
    }
  }

  private drop(client: Client): void {
    client.pendingGap++;
    client.droppedTotal++;
    this.totals.dropped++;
    client.droppingSince ??= Date.now();
    if (client.pendingGap > this.maxDroppedEvents) this.endSlow(client);
  }

  /** Tells a client that caught up how many events it missed. */
  private flushGap(client: Client): boolean {
    const ok = this.write(client, sseEvent("gap", { dropped: client.pendingGap }));
    if (ok) {
      client.pendingGap = 0;
      client.droppingSince = undefined;
    }
    return ok;
  }

  /** Writes to one client; false once that client is gone. Never throws. */
  private write(client: Client, chunk: Buffer): boolean {
    const { stream } = client;
    if (stream.destroyed || stream.writableEnded) {
      this.remove(client, "disconnected");
      return false;
    }
    try {
      stream.write(chunk);
    } catch {
      this.remove(client, "write-failed");
      safely(() => stream.destroy());
      return false;
    }
    const buffered = stream.writableLength;
    if (buffered > this.totals.peakBufferedBytes) this.totals.peakBufferedBytes = buffered;
    if (buffered > this.hardLimitBytes) {
      this.endSlow(client);
      return false;
    }
    return true;
  }

  private endSlow(client: Client): void {
    if (!this.clients.has(client)) return;
    this.totals.endedSlow++;
    this.remove(client, "slow");
    // Not end(): a peer that does not read would keep the buffer forever.
    safely(() => client.stream.destroy());
  }

  private remove(client: Client, reason: EndReason): void {
    if (!this.clients.delete(client)) return;
    if (this.clients.size === 0) this.stopHeartbeat();
    log.debug("viewer client disconnected", {
      reason,
      durationMs: Date.now() - client.connectedAt,
      sent: client.sent,
      dropped: client.droppedTotal,
    });
  }

  private tick(): void {
    const now = Date.now();
    for (const client of this.clients) {
      const behind = client.stream.writableLength >= this.softLimitBytes;
      if (client.pendingGap > 0) {
        if (!behind) this.flushGap(client);
        else if (now - (client.droppingSince ?? now) > this.maxDroppingMs) this.endSlow(client);
      } else if (!behind) {
        this.write(client, PING);
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => this.tick(), this.heartbeatMs);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private reportFailure(err: unknown): void {
    if (this.failureReported) return;
    this.failureReported = true;
    log.error("live viewer failed to stream a trace", undefined, { report: true, cause: err });
  }
}

function safely(action: () => void): void {
  try {
    action();
  } catch {
    // The stream is being dropped anyway.
  }
}
