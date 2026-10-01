import { describe, expect, it } from "vitest";
import { TRUSTED_HOST_HEADER, handleRequest, toContainerRequest } from "../src/forward";

function upgrade(url: string, headers: Record<string, string> = {}) {
  return new Request(url, {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
      ...headers,
    },
  });
}

/** Records what the Worker hands to the container instead of calling Cloudflare. */
function fakeGateway() {
  const seen: Request[] = [];
  return {
    seen,
    fetch: async (request: Request) => {
      seen.push(request);
      return new Response(null, { status: 204 });
    },
  };
}

describe("toContainerRequest", () => {
  it("passes the hostname the charger dialled in the trusted header", () => {
    const forwarded = toContainerRequest(upgrade("https://tenant-a.ocpp.example.com/ocpp/CP-001"));

    expect(forwarded.headers.get(TRUSTED_HOST_HEADER)).toBe("tenant-a.ocpp.example.com");
  });

  it("overwrites a trusted header forged by the client", () => {
    const forwarded = toContainerRequest(
      upgrade("https://tenant-a.ocpp.example.com/CP-001", {
        [TRUSTED_HOST_HEADER]: "tenant-b.ocpp.example.com",
      }),
    );

    expect(forwarded.headers.get(TRUSTED_HOST_HEADER)).toBe("tenant-a.ocpp.example.com");
  });

  it("strips the header the Container SDK reads to pick the target port", () => {
    const forwarded = toContainerRequest(
      upgrade("https://tenant-a.ocpp.example.com/CP-001", { "cf-container-target-port": "22" }),
    );

    expect(forwarded.headers.has("cf-container-target-port")).toBe(false);
  });

  it("keeps the URL, the WebSocket handshake, the OCPP subprotocol and Authorization", () => {
    const forwarded = toContainerRequest(
      upgrade("https://tenant-a.ocpp.example.com/ocpp/CP-001?x=1", {
        "Sec-WebSocket-Protocol": "ocpp2.0.1, ocpp1.6",
        Authorization: "Basic dXNlcjpwYXNz",
      }),
    );

    expect(forwarded.url).toBe("https://tenant-a.ocpp.example.com/ocpp/CP-001?x=1");
    expect(forwarded.headers.get("upgrade")).toBe("websocket");
    expect(forwarded.headers.get("sec-websocket-key")).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(forwarded.headers.get("sec-websocket-protocol")).toBe("ocpp2.0.1, ocpp1.6");
    expect(forwarded.headers.get("authorization")).toBe("Basic dXNlcjpwYXNz");
  });
});

describe("handleRequest", () => {
  it("forwards a WebSocket upgrade to the gateway container", async () => {
    const gateway = fakeGateway();

    const response = await handleRequest(
      upgrade("https://tenant-a.ocpp.example.com/CP-001"),
      gateway,
    );

    expect(response.status).toBe(204);
    expect(gateway.seen).toHaveLength(1);
    expect(gateway.seen[0].headers.get(TRUSTED_HOST_HEADER)).toBe("tenant-a.ocpp.example.com");
  });

  it("rejects plain HTTP requests without reaching the container", async () => {
    const gateway = fakeGateway();

    const response = await handleRequest(
      new Request("https://tenant-a.ocpp.example.com/CP-001"),
      gateway,
    );

    expect(response.status).toBe(426);
    expect(gateway.seen).toHaveLength(0);
  });
});
