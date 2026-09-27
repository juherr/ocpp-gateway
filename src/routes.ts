import { readFileSync } from "node:fs";
import { type FSWatcher, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("routes");

/**
 * One upstream CSMS endpoint. By default the chargeBoxId is appended to `url`
 * as a path segment when a charger connects (see {@link buildTargetUrl}); set
 * `appendChargeBoxId: false` for backends that expose a fixed endpoint URL.
 */
export interface Backend {
  url: string;
  appendChargeBoxId: boolean;
}

/**
 * A single routing target: one bidirectional primary CSMS and zero or more
 * read-only secondary mirrors. Different backends may use entirely different
 * base paths.
 */
export interface Route {
  primary: Backend;
  secondaries: Backend[];
}

/**
 * The full routing table: a mandatory `default` route plus an optional
 * per-chargeBoxId override map. Resolution is exact-match on the id, falling
 * back to `default`.
 */
export interface RouteTable {
  default: Route;
  chargers: Record<string, Route>;
}

function parseUrl(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must have a non-empty string url`);
  }
  if (!URL.canParse(value)) {
    throw new Error(`${where} url "${value}" is not a valid URL`);
  }
  return value;
}

/** Accept either a bare URL string or `{ url, appendChargeBoxId? }`. */
function parseBackend(value: unknown, where: string): Backend {
  if (typeof value === "string") {
    return { url: parseUrl(value, where), appendChargeBoxId: true };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be a URL string or an object with a "url"`);
  }
  const obj = value as Record<string, unknown>;

  const append = obj.appendChargeBoxId ?? true;
  if (typeof append !== "boolean") {
    throw new Error(`${where} "appendChargeBoxId" must be a boolean`);
  }

  return { url: parseUrl(obj.url, where), appendChargeBoxId: append };
}

function parseRoute(value: unknown, where: string): Route {
  if (typeof value !== "object" || value === null) {
    throw new Error(`route "${where}" must be an object`);
  }
  const obj = value as Record<string, unknown>;

  if (obj.primary === undefined) {
    throw new Error(`route "${where}" must define a "primary"`);
  }
  const primary = parseBackend(obj.primary, `route "${where}" primary`);

  let secondaries: Backend[] = [];
  if (obj.secondaries !== undefined) {
    if (!Array.isArray(obj.secondaries)) {
      throw new Error(`route "${where}" "secondaries" must be an array`);
    }
    secondaries = obj.secondaries.map((s, i) =>
      parseBackend(s, `route "${where}" secondary #${i}`),
    );
  }

  return { primary, secondaries };
}

/**
 * Validate and normalise an arbitrary parsed-JSON value into a RouteTable.
 * Throws with a descriptive message on any structural problem (fail-fast).
 */
export function parseRouteTable(value: unknown): RouteTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("routes file must be a JSON object");
  }
  const obj = value as Record<string, unknown>;

  if (obj.default === undefined) {
    throw new Error('routes file must define a "default" route');
  }
  const def = parseRoute(obj.default, "default");

  const chargers: Record<string, Route> = {};
  if (obj.chargers !== undefined) {
    if (typeof obj.chargers !== "object" || obj.chargers === null || Array.isArray(obj.chargers)) {
      throw new Error('"chargers" must be an object keyed by chargeBoxId');
    }
    for (const [id, route] of Object.entries(obj.chargers as Record<string, unknown>)) {
      chargers[id] = parseRoute(route, `chargers.${id}`);
    }
  }

  return { default: def, chargers };
}

/**
 * Resolve the route for a chargeBoxId: an exact match in `chargers` wins,
 * otherwise the `default` route is returned.
 */
export function resolveRoute(table: RouteTable, chargeBoxId: string): Route {
  return table.chargers[chargeBoxId] ?? table.default;
}

/**
 * Build the final upstream URL for a charger. Unless the backend opts out via
 * `appendChargeBoxId: false`, the (url-encoded) chargeBoxId is appended as a
 * path segment, trailing slashes are collapsed, and query parameters are kept.
 */
export function buildTargetUrl(backend: Backend, chargeBoxId: string): string {
  if (!backend.appendChargeBoxId) return backend.url;

  const url = new URL(backend.url);
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${encodeURIComponent(chargeBoxId)}`;
  return url.toString();
}

/**
 * Loads a RouteTable from disk and validates it. Throws (fail-fast) if the
 * file is missing or invalid.
 */
export function loadRouteTable(path: string): RouteTable {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read routes file "${path}": ${(err as Error).message}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`routes file "${path}" is not valid JSON: ${(err as Error).message}`);
  }

  return parseRouteTable(json);
}

/**
 * Holds the active RouteTable and, optionally, watches the routes file so it
 * can be reloaded at runtime. A reload that fails validation is logged and
 * ignored — the previously-valid table stays in effect, and existing charger
 * sessions are never disturbed (each captures its route at connect time).
 */
export class RouteStore {
  private table: RouteTable;
  private watcher: FSWatcher | null = null;
  private readonly path: string;

  private constructor(path: string, table: RouteTable) {
    this.path = path;
    this.table = table;
  }

  /** Load and validate the routes file (fail-fast on error). */
  static load(path: string): RouteStore {
    const absolute = resolvePath(path);
    return new RouteStore(absolute, loadRouteTable(absolute));
  }

  resolve(chargeBoxId: string): Route {
    return resolveRoute(this.table, chargeBoxId);
  }

  /** Re-read the routes file; keep the current table if the new one is invalid. */
  reload(): void {
    try {
      this.table = loadRouteTable(this.path);
      log.info("routes reloaded", {
        path: this.path,
        chargers: Object.keys(this.table.chargers).length,
      });
    } catch (err) {
      log.error("routes reload failed, keeping previous table", {
        path: this.path,
        error: (err as Error).message,
      });
    }
  }

  /** Start watching the routes file for changes and hot-reload on write. */
  watch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => {
        this.reload();
      });
      log.info("watching routes file for changes", { path: this.path });
    } catch (err) {
      log.warn("could not watch routes file; hot reload disabled", {
        path: this.path,
        error: (err as Error).message,
      });
    }
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}
