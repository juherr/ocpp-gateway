import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/sessions";

class FakeSession {
  tornDown = false;
  onEnd: () => void = () => undefined;

  teardown() {
    if (this.tornDown) return;
    this.tornDown = true;
    this.onEnd();
  }
}

/** Register a fake session the way proxy.ts does: evict, create with onEnd, add. */
function open(registry: SessionRegistry<FakeSession>, id: string, auth: string | undefined) {
  const result = registry.evict(id, auth);
  const session = new FakeSession();
  session.onEnd = () => registry.remove(id, session);
  registry.add(id, auth, session);
  return { session, ...result };
}

describe("SessionRegistry", () => {
  it("replaces a live session opened with the same Authorization header", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, "CP-001", "Basic dXNlcjpwYXNz");

    const second = open(registry, "CP-001", "Basic dXNlcjpwYXNz");

    expect(first.session.tornDown).toBe(true);
    expect(second).toMatchObject({ replaced: 1, kept: 0 });
    expect(second.session.tornDown).toBe(false);
  });

  it("replaces a live session when neither connection sends credentials", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, "CP-001", undefined);

    const second = open(registry, "CP-001", undefined);

    expect(first.session.tornDown).toBe(true);
    expect(second).toMatchObject({ replaced: 1, kept: 0 });
  });

  it.each([
    { description: "different credentials", auth: "Basic b3RoZXI6b3RoZXI=" },
    { description: "no credentials", auth: undefined },
  ])("keeps a live session when the newcomer sends $description", ({ auth }) => {
    const registry = new SessionRegistry<FakeSession>();
    const legit = open(registry, "CP-001", "Basic dXNlcjpwYXNz");

    const intruder = open(registry, "CP-001", auth);

    expect(legit.session.tornDown).toBe(false);
    expect(intruder).toMatchObject({ replaced: 0, kept: 1 });
  });

  it("does not touch sessions of other charge points", () => {
    const registry = new SessionRegistry<FakeSession>();
    const other = open(registry, "CP-002", "Basic dXNlcjpwYXNz");

    const result = open(registry, "CP-001", "Basic dXNlcjpwYXNz");

    expect(other.session.tornDown).toBe(false);
    expect(result).toMatchObject({ replaced: 0, kept: 0 });
  });

  it("still replaces the matching session when a mismatched one runs alongside", () => {
    const registry = new SessionRegistry<FakeSession>();
    const legit = open(registry, "CP-001", "Basic dXNlcjpwYXNz");
    const intruder = open(registry, "CP-001", "Basic b3RoZXI6b3RoZXI=");

    const reconnect = open(registry, "CP-001", "Basic dXNlcjpwYXNz");

    expect(legit.session.tornDown).toBe(true);
    expect(intruder.session.tornDown).toBe(false);
    expect(reconnect).toMatchObject({ replaced: 1, kept: 1 });
  });

  it("forgets a session once it has ended", () => {
    const registry = new SessionRegistry<FakeSession>();
    const first = open(registry, "CP-001", "Basic dXNlcjpwYXNz");
    first.session.teardown();

    const second = open(registry, "CP-001", "Basic dXNlcjpwYXNz");

    expect(second).toMatchObject({ replaced: 0, kept: 0 });
  });
});
