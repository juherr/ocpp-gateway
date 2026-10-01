import { describe, expect, it, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import { ChargerConnection, UPSTREAM_MAX_QUEUE } from "../src/connection";
import { configureLogger } from "../src/logger";
import type { Backend } from "../src/routes";

/** The test-facing surface of an upstream socket from the `ws` mock below. */
interface MockSocket {
  url: string;
  protocols: string | string[] | undefined;
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

/** Capture the messages of warnings logged from now on. */
function captureWarnings() {
  const warnings: string[] = [];
  configureLogger({
    logLevel: "warn",
    sink: {
      stdout: (line) => warnings.push((JSON.parse(line) as { msg: string }).msg),
      stderr: () => undefined,
    },
  });
  return warnings;
}

/** Start a session for a charger routed to a single primary and no secondaries. */
function startSession() {
  const charger = createMockChargerSocket();
  new ChargerConnection(
    charger,
    { tenantId: null, chargeBoxId: "cp-abc" },
    { primary: { url: "ws://csms.example/ocpp", appendChargeBoxId: true }, secondaries: [] },
    "ocpp1.6",
    undefined,
    () => undefined,
  );
  const [primary] = outbound;
  const send = (raw: string) => charger.emit("message", Buffer.from(raw));
  return { charger, primary, send };
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
        () => undefined,
      );

      expect(connectCalls()).toEqual([
        { url: expectedPrimaryUrl, protocols: [protocol] },
        { url: expectedSecondaryUrl, protocols: [protocol] },
      ]);
    },
  );

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
    expect(warnings).toEqual(["primary queue full, dropping oldest message"]);
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
    expect(warnings).toEqual(["primary not open, dropping message"]);
  });
});
