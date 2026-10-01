import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";
import { TRUSTED_HOST_HEADER, handleRequest } from "./forward";

// Bindings from wrangler.jsonc (what `wrangler types` would generate).
declare global {
  namespace Cloudflare {
    interface Env {
      OCPP_GATEWAY: DurableObjectNamespace<OcppGateway>;
      /** Tenants are subdomains of this domain, e.g. `ocpp.example.com`. */
      TENANT_BASE_DOMAIN: string;
      /** The gateway's routes.json content (a secret: `wrangler secret put ROUTES_JSON`). */
      ROUTES_JSON: string;
      LOG_LEVEL?: string;
    }
  }
}

const PORT = 9000;
const ROUTES_FILE = "/tmp/routes.json";

/**
 * Runs the unchanged ocpp-gateway image (the repository's Dockerfile). The
 * routing table comes from the `ROUTES_JSON` secret, written to a file before
 * the gateway starts so that no tenant configuration is baked into the image.
 */
export class OcppGateway extends Container {
  defaultPort = PORT;
  // Only counts once the last WebSocket has closed: live sessions keep it awake.
  sleepAfter = "15m";
  entrypoint = [
    "sh",
    "-c",
    `printf '%s' "$ROUTES_JSON" > ${ROUTES_FILE} && exec node dist/index.cjs`,
  ];
  envVars = {
    PORT: String(PORT),
    ROUTES_FILE,
    ROUTES_JSON: env.ROUTES_JSON,
    TENANT_BASE_DOMAIN: env.TENANT_BASE_DOMAIN,
    // Trust the hostname set by the Worker (see forward.ts), not `Host`.
    TENANT_HOST_HEADER: TRUSTED_HOST_HEADER,
    LOG_LEVEL: env.LOG_LEVEL ?? "info",
  };
}

export default {
  fetch(request, workerEnv) {
    // One gateway instance for every tenant: sessions live in its memory, so a
    // reconnecting charger must land on the instance that holds its old session.
    return handleRequest(request, getContainer(workerEnv.OCPP_GATEWAY));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
