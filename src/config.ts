export interface Config {
  port: number;
  routesFile: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function loadConfig(): Config {
  const routesFile = process.env.ROUTES_FILE ?? "./routes.json";

  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel = (LOG_LEVELS as readonly string[]).includes(level)
    ? (level as Config["logLevel"])
    : "info";

  const portRaw = process.env.PORT ?? "9000";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${portRaw}". Must be an integer between 1 and 65535.`);
  }

  return {
    port,
    routesFile,
    logLevel,
  };
}
