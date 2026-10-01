/**
 * The Worker → Container trust boundary, kept free of `cloudflare:*` imports so
 * it can be unit-tested under plain Node.
 *
 * The gateway resolves the tenant from the hostname the charger dialled. Behind
 * the Container SDK the `Host` header the gateway sees is not guaranteed to be
 * that hostname, so the Worker passes it in a dedicated header that the gateway
 * trusts (`TENANT_HOST_HEADER`). The container is only reachable through this
 * Worker, which overwrites whatever value a client sent: a charger can never
 * pick its own tenant.
 */

/** Must match the gateway's `TENANT_HOST_HEADER` (see wrangler.jsonc). */
export const TRUSTED_HOST_HEADER = "x-forwarded-host";

/** Client-supplied headers that must never reach the container. */
const STRIPPED_HEADERS = [
  TRUSTED_HOST_HEADER,
  // Read by `Container.fetch()` to choose the container port to connect to.
  "cf-container-target-port",
];

/** The subset of a Container stub the Worker needs (`fetch`). */
export interface GatewayStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Copy the charger's request for the container: drop internal headers a client
 * may have forged, then set the trusted host header from the URL Cloudflare
 * routed (lowercase, without port). The WebSocket handshake, the OCPP
 * subprotocol and `Authorization` pass through untouched.
 */
export function toContainerRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_HEADERS) headers.delete(name);
  headers.set(TRUSTED_HOST_HEADER, new URL(request.url).hostname);
  return new Request(request, { headers });
}

/** Forward WebSocket upgrades to the gateway; anything else is not OCPP. */
export async function handleRequest(request: Request, gateway: GatewayStub): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade (OCPP-J)\n", {
      status: 426,
      headers: { Upgrade: "websocket" },
    });
  }
  return gateway.fetch(toContainerRequest(request));
}
