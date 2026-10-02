import { isIP } from "node:net";
import type { LoggerConfig, LogLevel } from "./logger";
import { DEFAULT_DEBUG_MESSAGE_MAX_LENGTH, DEFAULT_LOG_LEVEL, LOG_LEVELS } from "./logger";
import { parseHostname } from "./tenants";
import {
  parseEnv,
  parseIntegerInRange,
  parseOptionalHeaderName,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  parseStringUnion,
} from "./utils/value-parsers";

/** OCPP frames are a few KiB; even large reports stay far below this. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

export interface Config {
  port: number;
  /** Address or hostname the gateway listens on. Unset: all interfaces. */
  listenHost?: string;
  routesFile: string;
  loggerConfig: LoggerConfig;
  /** Tenants are subdomains of this domain (`acme.<base>` → `acme`). Unset: none. */
  tenantBaseDomain?: string;
  /**
   * Header carrying the hostname the charger dialled, set by a trusted reverse
   * proxy in front of the gateway. Unset: the `Host` header is used.
   */
  tenantHostHeader?: string;
  /**
   * Largest WebSocket message accepted from a charger or an upstream CSMS;
   * a bigger one closes that connection with `1009`.
   */
  maxMessageBytes: number;
}

function parseOptionalHostname(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const hostname = parseHostname(value.trim());
  if (hostname === null) throw new Error(`Invalid hostname: "${value}"`);
  return hostname;
}

function parseOptionalListenHost(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const host = value.trim();
  if (isIP(host) === 0 && parseHostname(host) === null) {
    throw new Error(`Invalid listen host: "${value}"`);
  }
  return host;
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
  const listenHost = parseEnv("LISTEN_HOST", parseOptionalListenHost);

  const tenantBaseDomain = parseEnv("TENANT_BASE_DOMAIN", parseOptionalHostname);
  const tenantHostHeader = parseEnv("TENANT_HOST_HEADER", parseOptionalHeaderName);
  const maxMessageBytes = parseEnv("MAX_MESSAGE_BYTES", (value) =>
    value === undefined || value.trim() === ""
      ? DEFAULT_MAX_MESSAGE_BYTES
      : parsePositiveInteger(value),
  );

  return {
    port,
    listenHost,
    routesFile,
    loggerConfig: {
      logLevel,
      debugMessageMaxLength,
    },
    tenantBaseDomain,
    tenantHostHeader,
    maxMessageBytes,
  };
}
