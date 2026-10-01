import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy } from "../src/proxy";
import { RouteStore } from "../src/routes";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Start the gateway on an ephemeral port with the given routing table and
 * resolve once it is listening. Call `close()` to shut it down.
 */
export async function startGateway(table: object) {
  const dir = mkdtempSync(join(tmpdir(), "ocpp-gateway-test-"));
  const routesFile = join(dir, "routes.json");
  writeFileSync(routesFile, JSON.stringify(table));
  const routes = RouteStore.load(routesFile);
  rmSync(dir, { recursive: true });

  const gateway = startProxy({ port: 0, routesFile, loggerConfig: { logLevel: "error" } }, routes);
  await once(gateway.server, "listening");
  return {
    port: (gateway.server.address() as AddressInfo).port,
    close: gateway.close,
  };
}
