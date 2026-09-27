import { describe, expect, it, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import { ChargerConnection } from "../src/connection";
import type { Backend } from "../src/routes";

interface WsConnectCall {
  url: string;
  protocols: string | string[] | undefined;
}

let connectCalls: WsConnectCall[] = [];

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
      if (url !== null) {
        connectCalls.push({ url, protocols });
      }
    }

    send() {
      return undefined;
    }
    close() {
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
        "cp-abc",
        { primary, secondaries: [secondary] },
        protocol,
        undefined,
      );

      expect(connectCalls).toEqual([
        { url: expectedPrimaryUrl, protocols: [protocol] },
        { url: expectedSecondaryUrl, protocols: [protocol] },
      ]);
    },
  );
});
