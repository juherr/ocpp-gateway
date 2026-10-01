import type { LoggerConfig, LogLevel } from "./logger";
import { DEFAULT_DEBUG_MESSAGE_MAX_LENGTH, DEFAULT_LOG_LEVEL, LOG_LEVELS } from "./logger";
import { parseHostname } from "./tenants";
import {
  parseEnv,
  parseIntegerInRange,
  parseOptionalHeaderName,
  parseOptionalPositiveInteger,
  parseStringUnion,
} from "./utils/value-parsers";

export interface Config {
  port: number;
  routesFile: string;
  loggerConfig: LoggerConfig;
  /** Tenants are subdomains of this domain (`acme.<base>` → `acme`). Unset: none. */
  tenantBaseDomain?: string;
  /**
   * Header carrying the hostname the charger dialled, set by a trusted reverse
   * proxy in front of the gateway. Unset: the `Host` header is used.
   */
  tenantHostHeader?: string;
}

function parseOptionalHostname(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const hostname = parseHostname(value.trim());
  if (hostname === null) throw new Error(`Invalid hostname: "${value}"`);
  return hostname;
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

  const tenantBaseDomain = parseEnv("TENANT_BASE_DOMAIN", parseOptionalHostname);
  const tenantHostHeader = parseEnv("TENANT_HOST_HEADER", parseOptionalHeaderName);

  return {
    port,
    routesFile,
    loggerConfig: {
      logLevel,
      debugMessageMaxLength,
    },
    tenantBaseDomain,
    tenantHostHeader,
  };
}
