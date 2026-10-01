import { describe, expect, it, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import { ChargerConnection } from "../src/connection";
import type { Backend } from "../src/routes";

interface WsConnectCall {
  url: string;
  protocols: string | string[] | undefined;
}

let connectCalls: WsConnectCall[] = [];
let closeCodes: (number | undefined)[] = [];

/*
 * ChargerConnection creates outbound WebSocket instances internally. Mocking
 * the module is the smallest seam that lets this unit test inspect connection
 * arguments without opening real network connections.
 */
vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;

    on() {
      return this;
    }

    constructor(url: string | null, protocols?: string | string[]) {
      // Like the real ws, reject some URLs synchronously from the constructor.
      if (url?.includes("#")) throw new SyntaxError("The URL contains a fragment identifier");
      if (url !== null) {
        connectCalls.push({ url, protocols });
      }
    }

    send() {
      return undefined;
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
  connectCalls = [];
  closeCodes = [];
});

function createMockChargerSocket() {
  // `null` is handled by the WebSocket mock above; the real `ws` constructor
  // cannot be used this way outside this test.
  return new WebSocket(null);
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

      expect(connectCalls).toEqual([
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

    expect(connectCalls.map((call) => call.url)).toEqual([
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

    expect(connectCalls).toEqual([]);
    expect(closeCodes[0]).toBe(1011);
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
