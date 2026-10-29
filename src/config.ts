import { isIP } from "node:net";
import { version } from "../package.json";
import type { LoggerConfig, LogLevel } from "./logger";
import { DEFAULT_DEBUG_MESSAGE_MAX_LENGTH, DEFAULT_LOG_LEVEL, LOG_LEVELS } from "./logger";
import { parseHostname } from "./tenants";
import {
  parseBoolean,
  parseEnv,
  parseIntegerInRange,
  parseOptionalIntegerInRange,
  parseOptionalHeaderName,
  parseOptionalPositiveInteger,
  parseOptionalString,
  parseStringUnion,
} from "./utils/value-parsers";

/**
 * A security default, not a protocol limit: typical OCPP frames are a few KiB,
 * but OCPP does not cap message size (1.6 `DataTransfer.data` has no maximum
 * length), so deployments with large vendor-specific payloads may need more.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
/** `ws` truncates `maxPayload` to a signed 32-bit integer; above this it wraps and the limit is lost. */
const MAX_MESSAGE_BYTES_UPPER_BOUND = 2 ** 31 - 1;
/**
 * Largest message that still fits a MongoDB document (16 MiB) as a raw frame,
 * with room for the envelope: trace archiving never truncates a frame.
 */
const TRACE_MAX_MESSAGE_BYTES = 15 * 1024 * 1024;

const DEFAULT_TRACE_DATABASE = "ocpp_gateway";
const DEFAULT_TRACE_RETENTION_DAYS = 30;
const DEFAULT_TRACE_QUEUE_MAX = 10_000;

/** MongoDB trace archiving settings; see README "Trace archiving". */
export interface TraceConfig {
  /** May carry credentials: never log it. */
  mongodbUri: string;
  database: string;
  /** Each trace expires this many days after it was received (MongoDB TTL). */
  retentionDays: number;
  /** Trace documents buffered in memory while waiting for MongoDB; more are dropped. */
  queueMax: number;
  /** Only write into an existing capped collection; never create it. */
  requireCapped: boolean;
}

const DEFAULT_VIEWER_HOST = "127.0.0.1";
const DEFAULT_VIEWER_PORT = 9001;
const DEFAULT_VIEWER_MAX_BUFFERED_MESSAGES = 1000;
const DEFAULT_VIEWER_MAX_CLIENTS = 5;

/** Live trace viewer settings; see README "Live trace viewer". */
export interface ViewerConfig {
  /** HTTP Basic username. May carry credentials: never log it. */
  username: string;
  /** HTTP Basic password, verbatim. May carry credentials: never log it. */
  password: string;
  /** Address or hostname the viewer listens on; loopback by default. */
  host: string;
  /** Always different from the gateway's `PORT`. */
  port: number;
  /** Most messages a browser keeps; older ones are discarded. */
  maxBufferedMessages: number;
  /** Most browsers streaming at once. */
  maxClients: number;
  /**
   * Header carrying the client's IP address, set by a trusted reverse proxy in
   * front of the viewer; a request without exactly one is rejected with `400`.
   * Unset: the socket's remote address is used.
   */
  clientIpHeader?: string;
}

/** Sentry error reporting settings; see README "Error reporting". */
export interface SentryConfig {
  /** Not a secret (it only allows sending events), but never echoed either. */
  dsn: string;
  environment?: string;
  release: string;
}

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
  /** Live charger sessions; more are closed with `1013`. Unset: unlimited. */
  maxSessions?: number;
  /** Sessions whose primary CSMS link is still connecting; more are closed with `1013`. Unset: unlimited. */
  maxPendingSessions?: number;
  /** Live charger sessions per client source; more are closed with `1013`. Unset: unlimited. */
  maxSessionsPerSource?: number;
  /**
   * Header carrying the client's IP address, set by a trusted reverse proxy in
   * front of the gateway; a connection without exactly one is rejected. Unset:
   * the socket's remote address is used.
   */
  clientIpHeader?: string;
  /** Trace archiving to MongoDB. Unset: disabled. */
  trace?: TraceConfig;
  /** Error reporting to Sentry. Unset: disabled. */
  sentry?: SentryConfig;
  /** Live trace viewer. Unset: disabled. */
  viewer?: ViewerConfig;
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

function parseMongodbUri(value: string | undefined): string {
  const uri = value?.trim() ?? "";
  // The URI may carry credentials: errors never echo it.
  if (uri === "") throw new Error("required when TRACE_ENABLED is true");
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error("must start with mongodb:// or mongodb+srv://");
  }
  return uri;
}

/** MongoDB database names: none of `/`, `\`, `.`, space, `"`, `$`, `*`, `<`, `>`, `:`, `|`, `?`, NUL; under 64 bytes. */
function parseDatabaseName(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return DEFAULT_TRACE_DATABASE;
  const name = value.trim();
  if (/[/\\. "$*<>:|?]/.test(name) || name.includes("\0") || Buffer.byteLength(name) > 63) {
    throw new Error(`Invalid database name: "${value}"`);
  }
  return name;
}

function loadTraceConfig(maxMessageBytes: number): TraceConfig | undefined {
  if (!parseEnv("TRACE_ENABLED", (value) => parseBoolean(value, false))) return undefined;

  const config: TraceConfig = {
    mongodbUri: parseEnv("TRACE_MONGODB_URI", parseMongodbUri),
    database: parseEnv("TRACE_MONGODB_DATABASE", parseDatabaseName),
    retentionDays: parseEnv("TRACE_RETENTION_DAYS", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_TRACE_RETENTION_DAYS, 1, 36_500),
    ),
    queueMax: parseEnv("TRACE_QUEUE_MAX", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_TRACE_QUEUE_MAX, 1, 1_000_000),
    ),
    requireCapped: parseEnv("TRACE_REQUIRE_CAPPED", (value) => parseBoolean(value, false)),
  };
  if (maxMessageBytes > TRACE_MAX_MESSAGE_BYTES) {
    throw new Error(
      `Invalid value for environment variable MAX_MESSAGE_BYTES: must not exceed ${TRACE_MAX_MESSAGE_BYTES} when TRACE_ENABLED is true`,
    );
  }
  return config;
}

function parseOptionalSentryDsn(value: string | undefined): string | undefined {
  const dsn = parseOptionalString(value);
  if (dsn === undefined) return undefined;
  // Errors never echo the DSN, like TRACE_MONGODB_URI. The checks are the
  // SDK's own: it would silently drop a DSN failing them.
  const url = URL.parse(dsn);
  if (
    !url ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !/^\w+$/.test(url.username) ||
    !/^\d+$/.test(url.pathname.split("/").pop() ?? "")
  ) {
    throw new Error("must be http(s)://<key>@<host>/<numeric projectId>");
  }
  return dsn;
}

function loadSentryConfig(): SentryConfig | undefined {
  const dsn = parseEnv("SENTRY_DSN", parseOptionalSentryDsn);
  if (dsn === undefined) return undefined;

  return {
    dsn,
    environment: parseOptionalString(process.env.SENTRY_ENVIRONMENT),
    release: parseOptionalString(process.env.SENTRY_RELEASE) ?? `ocpp-gateway@${version}`,
  };
}

/**
 * A Basic credential, verbatim: never trimmed, since that would change the
 * secret, but blank means unset. Errors never echo it.
 */
function credentialParser(allowColon: boolean) {
  return (value: string | undefined): string => {
    if (value === undefined || value.trim() === "") {
      throw new Error("required when VIEWER_ENABLED is true");
    }
    // RFC 7617: the user-id ends at the first colon, and neither part may
    // carry a control character.
    const hasControl = [...value].some((char) => char < " " || char === "\u007f");
    if (hasControl || (!allowColon && value.includes(":"))) {
      throw new Error(
        allowColon
          ? "must not contain a control character"
          : "must not contain a colon or a control character",
      );
    }
    return value;
  };
}

function loadViewerConfig(gatewayPort: number): ViewerConfig | undefined {
  if (!parseEnv("VIEWER_ENABLED", (value) => parseBoolean(value, false))) return undefined;

  const config: ViewerConfig = {
    username: parseEnv("VIEWER_USERNAME", credentialParser(false)),
    password: parseEnv("VIEWER_PASSWORD", credentialParser(true)),
    host: parseEnv("VIEWER_HOST", parseOptionalListenHost) ?? DEFAULT_VIEWER_HOST,
    port: parseEnv("VIEWER_PORT", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_VIEWER_PORT, 1, 65535),
    ),
    maxBufferedMessages: parseEnv("VIEWER_MAX_BUFFERED_MESSAGES", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_VIEWER_MAX_BUFFERED_MESSAGES, 1, 100_000),
    ),
    maxClients: parseEnv("VIEWER_MAX_CLIENTS", (value) =>
      parseOptionalIntegerInRange(value, DEFAULT_VIEWER_MAX_CLIENTS, 1, 1000),
    ),
    clientIpHeader: parseEnv("VIEWER_CLIENT_IP_HEADER", parseOptionalHeaderName),
  };
  // Kept apart even when the hosts differ, so the viewer can be firewalled alone.
  if (config.port === gatewayPort) {
    throw new Error("Invalid value for environment variable VIEWER_PORT: must differ from PORT");
  }
  return config;
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
    parseOptionalIntegerInRange(value, DEFAULT_MAX_MESSAGE_BYTES, 1, MAX_MESSAGE_BYTES_UPPER_BOUND),
  );

  const maxSessions = parseEnv("MAX_SESSIONS", parseOptionalPositiveInteger);
  const maxPendingSessions = parseEnv("MAX_PENDING_SESSIONS", parseOptionalPositiveInteger);
  const maxSessionsPerSource = parseEnv("MAX_SESSIONS_PER_SOURCE", parseOptionalPositiveInteger);
  const clientIpHeader = parseEnv("CLIENT_IP_HEADER", parseOptionalHeaderName);

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
    maxSessions,
    maxPendingSessions,
    maxSessionsPerSource,
    clientIpHeader,
    trace: loadTraceConfig(maxMessageBytes),
    sentry: loadSentryConfig(),
    viewer: loadViewerConfig(port),
  };
}
