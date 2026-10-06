import { describe, expect, it, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import {
  ChargerConnection,
  SECONDARY_RECONNECT_DELAY_MS,
  UPSTREAM_MAX_QUEUE,
  UPSTREAM_MAX_QUEUE_BYTES,
} from "../src/connection";
import { configureLogger } from "../src/logger";
import type { Backend } from "../src/routes";

/** The test-facing surface of an upstream socket from the `ws` mock below. */
interface MockSocket {
  url: string;
  protocols: string | string[] | undefined;
  options: { maxPayload?: number } | undefined;
  readyState: number;
  sent: string[];
  emit(event: string, ...args: unknown[]): boolean;
}

let outbound: MockSocket[] = [];
let closeCodes: (number | undefined)[] = [];

/*
 * ChargerConnection creates outbound WebSocket instances internally. Mocking
 * the module is the smallest seam that lets this unit test inspect connection
 * arguments and drive socket events without opening real network connections.
 */
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class MockWebSocket extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState: number;
    sent: string[] = [];

    constructor(
      readonly url: string | null,
      readonly protocols?: string | string[],
      readonly options?: { maxPayload?: number },
    ) {
      super();
      // Like the real ws, reject some URLs synchronously from the constructor.
      if (url?.includes("#")) throw new SyntaxError("The URL contains a fragment identifier");
      // The charger socket (`null`) is already open; upstream sockets are still dialling.
      this.readyState = url === null ? MockWebSocket.OPEN : MockWebSocket.CONNECTING;
      if (url !== null) outbound.push(this as MockSocket);
    }

    emit(event: string, ...args: unknown[]) {
      if (event === "open") this.readyState = MockWebSocket.OPEN;
      return super.emit(event, ...args);
    }

    send(data: string) {
      this.sent.push(data);
    }
    close(code?: number) {
      closeCodes.push(code);
      this.readyState = MockWebSocket.CLOSED;
    }
    ping() {
      return undefined;
    }
    pong() {
      return undefined;
    }
  }

  return {
    default: MockWebSocket,
  };
});

/** Frame size limit every test session is created with. */
const MAX_PAYLOAD = 4096;

beforeEach(() => {
  outbound = [];
  closeCodes = [];
});

/** Where ChargerConnection dialled, in order. */
const connectCalls = () => outbound.map(({ url, protocols }) => ({ url, protocols }));

function createMockChargerSocket() {
  // `null` is handled by the WebSocket mock above; the real `ws` constructor
  // cannot be used this way outside this test.
  return new WebSocket(null);
}

/** A structured log entry, as written to the logger sink. */
type LogEntry = { msg: string } & Record<string, unknown>;

/** Capture the warnings logged from now on. */
function captureWarnings() {
  const warnings: LogEntry[] = [];
  configureLogger({
    logLevel: "warn",
    sink: {
      stdout: (line) => warnings.push(JSON.parse(line) as LogEntry),
      stderr: () => undefined,
    },
  });
  return warnings;
}

const messagesOf = (entries: LogEntry[]) => entries.map(({ msg }) => msg);

/** Start a session for a charger routed to a single primary and, by default, no secondaries. */
function startSession({ maxPayload = MAX_PAYLOAD, secondaries = [] as Backend[] } = {}) {
  const charger = createMockChargerSocket();
  new ChargerConnection(
    charger,
    { tenantId: null, chargeBoxId: "cp-abc" },
    { primary: { url: "ws://csms.example/ocpp", appendChargeBoxId: true }, secondaries },
    "ocpp1.6",
    undefined,
    maxPayload,
    () => undefined,
  );
  const [primary, secondary] = outbound;
  const send = (raw: string) => {
    // The real ws closes the charger with 1009 before such a frame reaches the session.
    if (Buffer.byteLength(raw) > maxPayload) {
      throw new Error(`test frame exceeds maxPayload (${maxPayload} bytes)`);
    }
    charger.emit("message", Buffer.from(raw));
  };
  return { charger, primary, secondary, send };
}

/** Three distinct messages whose total size exceeds the default queue byte budget. */
function oversizedBatch() {
  const size = Math.ceil(UPSTREAM_MAX_QUEUE_BYTES / 2);
  return ["0", "1", "2"].map((digit) => digit.repeat(size));
}

describe("ChargerConnection", () => {
  it.each([
    {
      description: "opens primary and secondary connections using resolved URLs",
      appendChargeBoxId: true,
      primaryUrl: "ws://csms.example/endpoint",
      secondaryUrl: "ws://secondary.example/inspect",
      protocol: "ocpp1.6",
      expectedPrimaryUrl: "ws://csms.example/endpoint/cp-abc",
      expectedSecondaryUrl: "ws://secondary.example/inspect/cp-abc",
    },
    {
      description: "keeps connection URLs unchanged when appending is disabled",
      appendChargeBoxId: false,
      primaryUrl: "ws://csms.example/raw-endpoint?tenant=emea",
      secondaryUrl: "ws://secondary.example/raw-mirror?source=mirror",
      protocol: "ocpp2.0.1",
      expectedPrimaryUrl: "ws://csms.example/raw-endpoint?tenant=emea",
      expectedSecondaryUrl: "ws://secondary.example/raw-mirror?source=mirror",
    },
  ])(
    "$description",
    ({
      appendChargeBoxId,
      primaryUrl,
      secondaryUrl,
      protocol,
      expectedPrimaryUrl,
      expectedSecondaryUrl,
    }) => {
      const charger = createMockChargerSocket();
      const primary: Backend = {
        url: primaryUrl,
        appendChargeBoxId,
      };
      const secondary: Backend = {
        url: secondaryUrl,
        appendChargeBoxId,
      };

      new ChargerConnection(
        charger,
        { tenantId: null, chargeBoxId: "cp-abc" },
        { primary, secondaries: [secondary] },
        protocol,
        undefined,
        MAX_PAYLOAD,
        () => undefined,
      );

      expect(connectCalls()).toEqual([
        { url: expectedPrimaryUrl, protocols: [protocol] },
        { url: expectedSecondaryUrl, protocols: [protocol] },
      ]);
    },
  );

  it("caps the frame size of the primary and secondary links", () => {
    new ChargerConnection(
      createMockChargerSocket(),
      { tenantId: null, chargeBoxId: "cp-abc" },
      {
        primary: { url: "ws://csms.example/ocpp", appendChargeBoxId: true },
        secondaries: [{ url: "ws://mirror.example/ocpp", appendChargeBoxId: true }],
      },
      "ocpp1.6",
      undefined,
      MAX_PAYLOAD,
      () => undefined,
    );

    expect(outbound.map((socket) => socket.options?.maxPayload)).toEqual([
      MAX_PAYLOAD,
      MAX_PAYLOAD,
    ]);
  });

  it("skips a secondary that ws refuses to dial without affecting the primary", () => {
    const charger = createMockChargerSocket();

    expect(
      () =>
        new ChargerConnection(
          charger,
          { tenantId: null, chargeBoxId: "cp-abc" },
          {
            primary: { url: "ws://csms.example/ocpp", appendChargeBoxId: true },
            secondaries: [
              { url: "ws://broken.example/ocpp#fragment", appendChargeBoxId: false },
              { url: "ws://mirror.example/ocpp", appendChargeBoxId: true },
            ],
          },
          "ocpp1.6",
          undefined,
          MAX_PAYLOAD,
          () => undefined,
        ),
    ).not.toThrow();

    expect(connectCalls().map((call) => call.url)).toEqual([
      "ws://csms.example/ocpp/cp-abc",
      "ws://mirror.example/ocpp/cp-abc",
    ]);
    expect(closeCodes).toEqual([]);
  });

  it("closes the charger instead of throwing when ws refuses to dial the primary", async () => {
    const charger = createMockChargerSocket();
    const onEnd = vi.fn();

    expect(
      () =>
        new ChargerConnection(
          charger,
          { tenantId: null, chargeBoxId: "cp-abc" },
          {
            primary: { url: "ws://csms.example/ocpp#fragment", appendChargeBoxId: false },
            secondaries: [{ url: "ws://mirror.example/ocpp", appendChargeBoxId: true }],
          },
          "ocpp1.6",
          undefined,
          MAX_PAYLOAD,
          onEnd,
        ),
    ).not.toThrow();

    // The session ends asynchronously, like any other primary failure, so the
    // caller can finish registering it first.
    expect(onEnd).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(connectCalls()).toEqual([]);
    expect(closeCodes[0]).toBe(1011);
    expect(onEnd).toHaveBeenCalledOnce();
  });
});

describe("ChargerConnection primary buffering", () => {
  it("delivers messages sent while the primary is connecting, in order, once it opens", () => {
    const { primary, send } = startSession();

    send("m-1");
    send("m-2");
    expect(primary.sent).toEqual([]);

    primary.emit("open");
    expect(primary.sent).toEqual(["m-1", "m-2"]);

    send("m-3");
    expect(primary.sent).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("bounds the queue, dropping the oldest message with a warning", () => {
    const warnings = captureWarnings();
    const { primary, send } = startSession();

    const messages = Array.from({ length: UPSTREAM_MAX_QUEUE + 1 }, (_, i) => `m-${i}`);
    for (const message of messages) send(message);
    primary.emit("open");

    expect(primary.sent).toEqual(messages.slice(1));
    expect(messagesOf(warnings)).toEqual(["primary queue full, dropping oldest message"]);
  });

  it("sends nothing to the primary once the session has ended", () => {
    const { charger, primary, send } = startSession();

    send("m-1");
    charger.emit("close", 1000, Buffer.from(""));
    primary.emit("open");

    expect(primary.sent).toEqual([]);
  });

  it("drops a message with a warning when the primary is neither connecting nor open", () => {
    const warnings = captureWarnings();
    const { primary, send } = startSession();
    primary.readyState = WebSocket.CLOSING;

    send("m-1");
    primary.emit("open");

    expect(primary.sent).toEqual([]);
    expect(messagesOf(warnings)).toEqual(["primary not open, dropping message"]);
  });
});

describe.each(["primary", "secondary"] as const)(
  "ChargerConnection %s queue byte bound",
  (link) => {
    /** A session whose `link` is still connecting while the other link is open. */
    function startBufferingSession(maxPayload?: number) {
      const session = startSession({
        maxPayload,
        secondaries: [{ url: "ws://mirror.example/ocpp", appendChargeBoxId: true }],
      });
      const [target, other] =
        link === "primary"
          ? [session.primary, session.secondary]
          : [session.secondary, session.primary];
      other.emit("open");
      return { target, send: session.send };
    }

    it("drops the oldest messages with a warning when their total size exceeds the budget", () => {
      const warnings = captureWarnings();
      // Large enough for the frames to get past ws, without raising the budget.
      const { target, send } = startBufferingSession(UPSTREAM_MAX_QUEUE_BYTES);

      const messages = oversizedBatch();
      for (const message of messages) send(message);
      target.emit("open");

      expect(target.sent).toEqual(messages.slice(1));
      const queuedBytes = messages
        .slice(1)
        .reduce((total, message) => total + Buffer.byteLength(message), 0);
      expect(warnings).toEqual([
        expect.objectContaining({
          msg: `${link} queue full, dropping oldest message`,
          dropped: 1,
          count: 2,
          bytes: queuedBytes,
          maxCount: UPSTREAM_MAX_QUEUE,
          maxBytes: UPSTREAM_MAX_QUEUE_BYTES,
        }),
      ]);
    });

    it("queues and delivers a single message of the maximum size", () => {
      const maxPayload = 2 * UPSTREAM_MAX_QUEUE_BYTES;
      const { target, send } = startBufferingSession(maxPayload);

      send("m-1");
      const largest = "x".repeat(maxPayload);
      send(largest);
      target.emit("open");

      expect(target.sent).toEqual([largest]);
    });
  },
);

describe("ChargerConnection secondary failure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  it("reconnects only the secondary after ws closes it for an oversized message", () => {
    const charger = createMockChargerSocket();
    const onEnd = vi.fn();
    new ChargerConnection(
      charger,
      { tenantId: null, chargeBoxId: "cp-abc" },
      {
        primary: { url: "ws://csms.example/ocpp", appendChargeBoxId: true },
        secondaries: [{ url: "ws://mirror.example/ocpp", appendChargeBoxId: true }],
      },
      "ocpp1.6",
      undefined,
      MAX_PAYLOAD,
      onEnd,
    );
    const [primary, secondary] = outbound;
    primary.emit("open");
    secondary.emit("open");

    // What ws does on a message above maxPayload: an error, then a 1009 close.
    secondary.emit("error", new RangeError("Max payload size exceeded"));
    secondary.emit("close", 1009, Buffer.from(""));

    expect(closeCodes).toEqual([]);
    expect(onEnd).not.toHaveBeenCalled();
    charger.emit("message", Buffer.from("m-1"));
    expect(primary.sent).toEqual(["m-1"]);

    vi.advanceTimersByTime(SECONDARY_RECONNECT_DELAY_MS);
    expect(connectCalls().map((call) => call.url)).toEqual([
      "ws://csms.example/ocpp/cp-abc",
      "ws://mirror.example/ocpp/cp-abc",
      "ws://mirror.example/ocpp/cp-abc",
    ]);
  });
});
