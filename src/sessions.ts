import { createHash, timingSafeEqual } from "node:crypto";

interface Entry<T> {
  session: T;
  authHeader: string | undefined;
}

/**
 * Tracks the live charger sessions per chargeBoxId so a reconnecting charger
 * can replace its own stale session (some CSMS reject a second connection for
 * the same id while the old one is still open).
 *
 * The gateway does not authenticate chargers itself, so a session is only
 * replaced by a newcomer presenting the *same* `Authorization` header.
 * Otherwise anyone who knows a chargeBoxId could disconnect the real charger
 * before the CSMS gets a chance to reject the intruder's credentials. A
 * mismatched newcomer runs alongside the existing session, and the CSMS decides.
 */
export class SessionRegistry<T extends { teardown(): void }> {
  private readonly sessions = new Map<string, Set<Entry<T>>>();

  /**
   * Tear down the live sessions for `id` that were opened with the same
   * credentials. Returns how many were replaced and how many were kept
   * because their credentials differ.
   */
  evict(id: string, authHeader: string | undefined): { replaced: number; kept: number } {
    const entries = this.sessions.get(id);
    if (!entries) return { replaced: 0, kept: 0 };

    let replaced = 0;
    let kept = 0;
    // Copy first: teardown() ends the session, which calls remove() on this set.
    for (const entry of [...entries]) {
      if (sameCredentials(entry.authHeader, authHeader)) {
        entry.session.teardown();
        replaced += 1;
      } else {
        kept += 1;
      }
    }
    return { replaced, kept };
  }

  add(id: string, authHeader: string | undefined, session: T): void {
    let entries = this.sessions.get(id);
    if (!entries) {
      entries = new Set();
      this.sessions.set(id, entries);
    }
    entries.add({ session, authHeader });
  }

  remove(id: string, session: T): void {
    const entries = this.sessions.get(id);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.session === session) entries.delete(entry);
    }
    if (entries.size === 0) this.sessions.delete(id);
  }
}

/** Constant-time comparison, so response timing does not leak the stored credentials. */
function sameCredentials(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return timingSafeEqual(digest(a), digest(b));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
