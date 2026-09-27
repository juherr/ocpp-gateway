import type { LoggerConfig, LogLevel } from "./logger";
import { DEFAULT_DEBUG_MESSAGE_MAX_LENGTH, DEFAULT_LOG_LEVEL, LOG_LEVELS } from "./logger";
import {
  parseEnv,
  parseIntegerInRange,
  parseOptionalPositiveInteger,
  parseStringUnion,
} from "./utils/value-parsers";

export interface Config {
  port: number;
  routesFile: string;
  loggerConfig: LoggerConfig;
}

export function loadConfig(): Config {
  const routesFile = process.env.ROUTES_FILE ?? "./routes.json";

  const logLevel: LogLevel = parseEnv("LOG_LEVEL", (value) =>
    parseStringUnion(value, LOG_LEVELS, DEFAULT_LOG_LEVEL),
  );
  const debugMessageMaxLength: number | undefined = parseEnv(
    "LOG_DEBUG_MESSAGE_MAX_LENGTH",
    (value) => parseOptionalPositiveInteger(value, DEFAULT_DEBUG_MESSAGE_MAX_LENGTH),
  );

  const port: number = parseEnv("PORT", (value) => parseIntegerInRange(value ?? "9000", 1, 65535));

  return {
    port,
    routesFile,
    loggerConfig: {
      logLevel,
      debugMessageMaxLength,
    },
  };
}
