import { readFileSync } from "node:fs";
import { type FSWatcher, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("routes");

/**
 * A single routing target: one bidirectional primary CSMS and zero or more
 * read-only secondary mirrors. Each URL is a *base* URL; the chargeBoxId is
 * appended as a path segment when a charger connects (see {@link buildTargetUrl}),
 * so different backends may use entirely different base paths.
 */
export interface Route {
  primary: string;
  secondaries: string[];
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

function parseRoute(value: unknown, where: string): Route {
  if (typeof value !== "object" || value === null) {
    throw new Error(`route "${where}" must be an object`);
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.primary !== "string" || obj.primary.trim() === "") {
    throw new Error(`route "${where}" must have a non-empty string "primary"`);
  }

  let secondaries: string[] = [];
  if (obj.secondaries !== undefined) {
    if (!Array.isArray(obj.secondaries)) {
      throw new Error(`route "${where}" "secondaries" must be an array`);
    }
    secondaries = obj.secondaries.map((s, i) => {
      if (typeof s !== "string" || s.trim() === "") {
        throw new Error(`route "${where}" secondary #${i} must be a non-empty string`);
      }
      return s;
    });
  }

  return { primary: obj.primary, secondaries };
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
 * Build the final upstream URL for a charger by appending its (url-encoded)
 * chargeBoxId as a path segment to a base URL, trimming any trailing slashes.
 */
export function buildTargetUrl(baseUrl: string, chargeBoxId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(chargeBoxId)}`;
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
