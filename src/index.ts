import { loadConfig } from "./config";
import { configureLogger, createLogger } from "./logger";
import { startProxy } from "./proxy";
import { RouteStore } from "./routes";

const log = createLogger("proxy");

const config = loadConfig();
configureLogger(config.loggerConfig);

let routes: RouteStore;
try {
  routes = RouteStore.load(config.routesFile);
} catch (err) {
  log.error("failed to load routes file", {
    path: config.routesFile,
    error: (err as Error).message,
  });
  process.exit(1);
}

// Nice-to-have: hot-reload the routing table on file change. Existing charger
// sessions keep the route they were opened with; only new connections see the
// updated table.
routes.watch();

const gateway = startProxy(config, routes);

const shutdown = () => {
  log.info("shutting down…");
  routes.close();
  setTimeout(() => process.exit(1), 5000).unref();
  void gateway.close().then(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
