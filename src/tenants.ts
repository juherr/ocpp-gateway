/**
 * Tenant resolution: which tenant a charger connection belongs to.
 *
 * A tenant is a transport/routing concept, never an OCPP one: it is derived
 * from the hostname the charger dialled (e.g. `acme.ocpp.example.com`), not
 * from anything inside the OCPP frames.
 */

/** A tenant identifier: a single lowercase DNS label, e.g. `acme`. */
export type TenantId = string;

/** Maps the hostname a charger connected to onto its tenant, or `null` for none. */
export interface TenantResolver {
  resolve(host: string): TenantId | null;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST_WITH_PORT = /^([^:]*)(?::(\d{1,5}))?$/;

/** True if `value` is a valid tenant id (a lowercase DNS label). */
export function isTenantId(value: string): boolean {
  return DNS_LABEL.test(value);
}

/**
 * Validate a bare hostname (no port) and return it lowercased, without one
 * trailing dot. Returns `null` for anything that is not a plain ASCII DNS
 * name — IPv6 literals, userinfo, empty or malformed labels — so a crafted
 * value can never match a tenant by accident.
 */
export function parseHostname(value: string): string | null {
  let hostname = value.toLowerCase();
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "" || hostname.length > 253) return null;
  return hostname.split(".").every((label) => DNS_LABEL.test(label)) ? hostname : null;
}

/** Normalise a `Host`-header value: drop the port, then {@link parseHostname}. */
export function normalizeHostname(value: string): string | null {
  const match = HOST_WITH_PORT.exec(value);
  return match ? parseHostname(match[1]) : null;
}

/**
 * Read a header from Node's `rawHeaders` list, requiring it to be sent exactly
 * once. Node keeps only the first of duplicated `Host` headers in
 * `req.headers`, so a request carrying two of them is ambiguous and rejected.
 */
export function readSingleHeader(rawHeaders: readonly string[], name: string): string | null {
  const wanted = name.toLowerCase();
  let found: string | null = null;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== wanted) continue;
    if (found !== null) return null;
    found = rawHeaders[i + 1];
  }
  return found;
}

export interface HostnameTenantResolverOptions {
  /**
   * Tenants are the first label under this domain: with `ocpp.example.com`,
   * `acme.ocpp.example.com` resolves to `acme`. Nested subdomains do not match.
   */
  baseDomain?: string;
  /** Explicit hostname → tenant mappings (custom domains), checked first. */
  lookupHostname?: (hostname: string) => TenantId | null;
}

/** Resolves the tenant from the hostname, via explicit mappings then the base domain. */
export class HostnameTenantResolver implements TenantResolver {
  private readonly suffix: string | null;
  private readonly lookupHostname: (hostname: string) => TenantId | null;

  constructor(options: HostnameTenantResolverOptions) {
    const baseDomain = options.baseDomain === undefined ? null : parseHostname(options.baseDomain);
    this.suffix = baseDomain === null ? null : `.${baseDomain}`;
    this.lookupHostname = options.lookupHostname ?? (() => null);
  }

  resolve(host: string): TenantId | null {
    const hostname = normalizeHostname(host);
    if (hostname === null) return null;

    const explicit = this.lookupHostname(hostname);
    if (explicit !== null) return explicit;

    if (this.suffix === null || !hostname.endsWith(this.suffix)) return null;
    const label = hostname.slice(0, -this.suffix.length);
    return isTenantId(label) ? label : null;
  }
}
