# AGENTS.md

Generic guidance for AI agents working in this repository. (Claude Code reads this via `@AGENTS.md` from `CLAUDE.md`.)

## What this is

A lightweight OCPP WebSocket gateway (Node.js + TypeScript) that routes each charge point **by its (tenant, chargeBoxId)** (via a JSON routing table; the tenant comes from the dialled hostname) to its own bidirectional **primary CSMS** and any number of read-only **secondary** mirrors. Supports OCPP 1.6 and 2.0.1. Optionally archives every OCPP frame in MongoDB as Open OCPP Trace records (`TRACE_ENABLED`). Optionally reports crashes and internal anomalies to Sentry (`SENTRY_DSN`). Runtime dependencies: `ws`, `mongodb` (loaded only when trace archiving is enabled) and `@sentry/node` (loaded only when error reporting is enabled). The trace format comes from the [Open OCPP Trace SDK](https://github.com/open-ocpp-trace/sdk) (`@open-ocpp-trace/core`: record types and validation; `@open-ocpp-trace/jsonl`: JSONL reader and writer), ESM-only **devDependencies bundled** into `dist/`, like `prismjs`.

This is a fork of [joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) (MIT); the fork's defining change is replacing the original's global `PRIMARY_CSMS_URL`/`SECONDARY_CSMS_URLS` env config with the per-chargeBoxId routing table. Preserve the MIT license and upstream attribution.

## Commands

The SDK is published to GitHub Packages, whose npm registry needs a token with `read:packages` even for a public package: `.npmrc` maps the `@open-ocpp-trace` scope and reads `GITHUB_TOKEN`, so set it (`export GITHUB_TOKEN=$(gh auth token)`, after a one-time `gh auth refresh -s read:packages`: gh's default scopes lack it) before `npm ci`/`npm install`. CI passes the workflow's `GITHUB_TOKEN` (`packages: read`), the Dockerfile's build stage takes it as the `github_token` build secret (`docker build --secret id=github_token,env=GITHUB_TOKEN .`, `docker-compose.yml` reads it from the environment or `.env`), and Dependabot uses the `DEPENDABOT_PACKAGES_TOKEN` secret. Running the bundle needs no token.

The Node version is pinned in `mise.toml` (Node 26 LTS). With [mise](https://mise.jdx.dev) installed, run `mise install` once to get the right Node; CI and Docker use the same version.

```bash
npm run lint       # vp lint && vp fmt --check (Vite+: Oxlint + Oxfmt)
npm run format     # vp fmt --write && vp lint --fix (auto-fix)
npm run typecheck  # tsc --noEmit (Vite+ bundling strips types, so type-check separately)
npm run build      # vp pack → dist/index.cjs (Rolldown/tsdown bundle, ws external)
npm test           # vitest run (unit + integration)
npm run test:watch # vitest watch
npm start          # node dist/index.cjs (requires built dist/ + a routes file)
npm run dev        # vp pack --watch + node --watch dist/index.cjs

# Run locally
cp routes.example.json routes.json
ROUTES_FILE=./routes.json npm start
```

`npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` are the verification gates — run all after changes. Type safety comes from `npm run typecheck` (`tsc --noEmit` under `strict: true`, then the same for the browser sources with `-p tsconfig.web.json`), not from the bundle step. Tests live in `test/` (not part of the bundle, which only takes `src/index.ts` and its imports).

CI validates every PR and push to `main`:

- `.github/workflows/commitlint.yml` — lints commit messages against Conventional Commits (the CI counterpart to the local `commit-msg` hook, which `--no-verify` can bypass).
- `.github/workflows/docker.yml` — a `test` job (lint + typecheck + build + `npm test`, with a `mongo` service so the real-MongoDB trace tests run), a `cloudflare` job (root `npm ci`, then `deploy/cloudflare`: `npm ci`, `npm run typecheck`, `npm run dry-run` — builds the root bundle, validates `wrangler.jsonc` and builds the container image, no Cloudflare credentials needed), a `cloudflare-smoke` job (runs the Worker + gateway container under `wrangler dev` with the runner's Docker and drives them with `deploy/cloudflare/test/smoke.test.ts`), and, only if all three pass, a `build` job publishing a multi-arch image to `ghcr.io/juherr/ocpp-gateway`. Image tags are **semver-pinned** (`flavor: latest=false` — never publish `latest`).

Both workflows install Node via `jdx/mise-action`, which reads the version from `mise.toml` — the single source of truth shared with local dev and the Docker images (Node 26, the current LTS). GitHub Actions are pinned to commit SHAs with a `# vX.Y.Z` comment; Dependabot (`.github/dependabot.yml`) keeps npm, actions, and Docker deps current.

## Architecture

Modules in `src/`, bundled by `vp pack` into CommonJS `dist/index.cjs` (entry `src/index.ts`; `ws`, `mongodb` and Node built-ins stay external; `trace/mongo-store.ts` and `monitoring/sentry.ts` become their own lazily loaded chunks). Two more `vp pack` configs build the viewer pages from `web/viewer/` and `web/viewer-next/` into `dist/viewer/` and `dist/viewer-next/`; the Docker runtime image copies `dist/` only. **[`docs/architecture.md`](docs/architecture.md) describes every module in detail: read the entry of a module before changing it.**

- **`index.ts`** — entrypoint: config, error reporter, route table (fail-fast), viewer assets, trace archive, gateway, viewer, graceful shutdown on `SIGINT`/`SIGTERM`.
- **`config.ts`** — env vars → `Config` (`trace`, `sentry`, `viewer` undefined when disabled); throws on invalid values, never echoing secrets.
- **`routes.ts`** — routes file: `parseRouteTable`, `resolveRoute`, per-scope `trace`/`viewer` switches, `buildTargetUrl`, `RouteStore` (load, hot reload).
- **`proxy.ts`** — HTTP + `WebSocketServer`: sub-protocol, chargeBoxId, tenant, route, client source, session limits, then one `ChargerConnection`; every refusal through `refuse()`.
- **`tenants.ts`**, **`limits.ts`**, **`sessions.ts`** — tenant resolution from the host header, admission control (`SessionLimiter`, `RejectionLog`), live-session registry (`SessionRegistry`).
- **`connection.ts`** — the core: `ChargerConnection`, one charger session and all its upstream links.
- **`trace/`** — trace archiving (`frame.ts`, `record.ts`, `correlator.ts`, `session-tracer.ts`, `writer.ts`, `mongo-store.ts`, `archive.ts`); only `mongo-store.ts` imports `mongodb`.
- **`viewer/`** — the live viewer's HTTP server (`auth.ts`, `server.ts`, `hub.ts`, `assets.ts`).
- **`web/viewer/`**, **`web/viewer-next/`** — the browser pages, type-checked by `tsconfig.web.json`.
- **`logger.ts`**, **`error-reporter.ts`**, **`monitoring/sentry.ts`** — structured logging, the `ErrorReporter` port, its Sentry adapter (the only file importing `@sentry/node`).
- **`utils/`**, **`types.ts`** — shared helpers and OCPP constants.

### Routing model

A `routes.json` has a `default` route (required unless `tenants` is present) and an optional `chargers` map keyed by chargeBoxId. Each route = `{ primary: Backend, secondaries: Backend[] }`, where a backend is written as a URL string or `{ id?, url, appendChargeBoxId? }` and normalised to `{ id?, url, appendChargeBoxId }` (default `true`); URLs are validated at load time. `id` names the logical CSMS in traces (never the URL): unique within a route, one server (scheme, host, port) per id within a scope — paths may differ, required on every backend when trace archiving is enabled. A `chargers` key ending with `*` is a prefix pattern (`"ACME-*"`, kept in the scope's `prefixes`, longest first; `*` anywhere else, or a bare `"*"`, is rejected). Resolution is exact-match on the id, then the longest matching prefix, falling back to `default`. An optional `tenants` map (keyed by tenant id, a lowercase DNS label) holds per-tenant `{ hostnames?, default?, chargers?, trace?, viewer? }`. `trace: false` keeps a scope out of the trace archive and `viewer: false` out of the live viewer, independently (default `true`; at the root they cover only the global scope, never the tenants); `proxy.ts` decides both at connect time, passing an excluded session neither the archive's `TraceSink` nor the live one (`ProxyOptions.liveSink`). A connection that resolves a tenant only ever uses that tenant's routes — **never the global ones** — and one that resolves none uses the global routes, so a file without `tenants` behaves as before as long as `TENANT_BASE_DOMAIN` is unset (once set, any `<label>.<base>` host names a tenant and an unknown one is rejected). Real `routes.json` is gitignored; `routes.example.json` and `routes.multi-tenant.example.json` are the committed templates.

### Tenancy and the trust boundary

The tenant is transport/routing context, never read from or written to OCPP frames. Sessions are keyed by `(tenantId, chargeBoxId)`, so the same chargeBoxId in two tenants never collides (no eviction across tenants). Never trust a tenant-selecting header from a charger: only the header named by `TENANT_HOST_HEADER` is read (instead of `Host`, no fallback), and it must be set by a proxy that strips client-supplied values. A missing or duplicated host header is rejected, never treated as "no tenant" — the global routes are for requests that unambiguously name no tenant. `deploy/cloudflare/` is that proxy for Cloudflare: a Worker (`src/forward.ts`, runtime-agnostic and tested by the root `npm test`) forwarding to a Container running the unchanged bundle in the root Dockerfile's runtime stage (`deploy/cloudflare/Dockerfile`, copying the `dist/` built on the host by its `pre*` scripts: wrangler cannot pass the root build stage its token secret; keep both runtime stages in sync). It has its own `package.json`/`tsconfig.json` (`npm run typecheck` and `npm run dry-run` there, run by the `cloudflare` CI job), not part of the root build.

### Connection model (the key invariant)

Per charger, the gateway holds one **primary** link and N **secondary** links:

- **Charger → upstream**: every message is forwarded to the primary AND mirrored to all secondaries, except the charger's responses (`CALLRESULT`/`CALLERROR`, `isOcppResponse` in `utils/ocpp.ts`, type id as a number or a decimal string): they answer the primary's CALLs, so they go to the primary only (traced with the primary as their only destination, `SessionTracer.fromCharger(raw, encoding, mirrored)`, never as a `dropped` delivery). Frames that cannot be classified are still mirrored.
- **Upstream → charger**: ONLY the primary's responses go back to the charger. Secondary responses are logged and discarded — secondaries are strictly one-way mirrors.
- **Primary failure tears down the whole session** (chargers expect exactly one CSMS). A **secondary failure must never affect the charger or the primary** — this is a hard rule; all secondary I/O is wrapped best-effort. Connection setup never throws: `new WebSocket()` rejects some URLs synchronously (bad scheme, `#fragment`), so a refused secondary is skipped and a refused primary closes the charger with 1011, like an unreachable one.

For each upstream the gateway builds `<baseUrl>/<chargeBoxId>` via `buildTargetUrl` (so different backends may use different base paths), or uses the URL unchanged when the backend sets `appendChargeBoxId: false`. When a charger reconnects with an id that already has a live session in the same tenant, `proxy.ts` tears the old session down first (some CSMS reject a second connection for the same id) — but only if the newcomer presents the **same `Authorization` header** (`SessionRegistry` in `sessions.ts`, constant-time comparison). The gateway does not authenticate chargers itself, so this stops anyone who knows a chargeBoxId from kicking the real charger; a mismatched newcomer runs alongside and the CSMS decides. `autoPong` is disabled on the charger server and the primary socket so pings/pongs are forwarded end-to-end instead of being answered locally. HTTP Basic Auth (`Authorization` header) is forwarded as-is to all upstreams. Messages the charger sends while the primary link is still `CONNECTING` (typically the first `BootNotification`) are held in a bounded queue (`UPSTREAM_MAX_QUEUE` messages and `max(UPSTREAM_MAX_QUEUE_BYTES, MAX_MESSAGE_BYTES)` bytes, shared with secondaries; oldest dropped first with a warning — `BoundedQueue` in `utils/bounded-queue.ts`) and flushed in order on `open`. A message arriving when the primary is neither `CONNECTING` nor `OPEN` is dropped with a warning. Every link (charger server, primary, secondaries) sets `maxPayload` to `MAX_MESSAGE_BYTES`, so `ws` closes a link with `1009` on an oversized message before it is forwarded or queued. What an open link has not yet written out (`bufferedAmount`) is checked against `MAX_BUFFERED_BYTES` before each message forwarded live. It is a threshold, not a hard cap: a link just under it still takes the message, so it can hold up to the threshold plus one message. A connect queue flushed when its link opens is not checked: it is bounded on its own, and never larger than the threshold's minimum. Over the threshold, the charger or the primary over it ends the session (charger terminated, a saturated primary too, frame `dropped`/`link-saturated`), a secondary over it is terminated and reconnects, never affecting the charger or the primary.

### Secondary resilience (in `connection.ts`)

Charger sessions live for days/weeks, so secondaries get extras tuned by the `SECONDARY_*` constants at the top of the file:

- **Auto-reconnect** after a fixed delay, retrying until the charger session ends.
- **Keepalive ping** on an interval to survive idle-connection timeouts.
- **Pong-timeout detection** — if no pong arrives within the timeout, the socket is force-closed to trigger reconnect.
- **Bounded replay queue** per secondary while disconnected, by count and bytes; oldest messages drop first when full.

WebSocket ping/pong frames are forwarded between charger and primary via the `forwardPing`/`forwardPong` helpers in `utils/websocket.ts`, which guard on `readyState === OPEN` and cap the forwarded frames not yet written out per target socket (`MAX_PENDING_FORWARDED_CONTROL_FRAMES`, 60 like `ws`'s `maxPendingAutoPongs`, which `autoPong: false` bypasses). Past the cap, `connection.ts` terminates the charger (a close frame would never reach a peer that does not read) and ends the session, whichever link is full: the charger drives the flood either way.

**Charger keepalive** (opt-in, `CHARGER_PING_INTERVAL`): the session pings the charger every interval with a random per-session payload, and the charger `pong` handler swallows the pongs carrying it — they answer the gateway, never the primary — while every other pong is still forwarded. Any frame from the charger (message, ping, pong) counts as a sign of life; none for `CHARGER_PONG_TIMEOUT_INTERVALS` (3) intervals → `terminate()` (a dead peer never completes a close handshake) and teardown. Off (0), no token exists and the wire is unchanged. Pings are never archived: the tracer only runs in `message` handlers. `test/charger-keepalive.test.ts` stands in for an idle-cutting proxy with a TCP relay.

### Trace archiving (in `connection.ts` and `trace/`)

Optional (`config.trace`). The invariants:

- **One document per received frame**, captured at ingress in the three `message` handlers, before forwarding; replays from a queue never create a document. The `trace` field is an Open OCPP Trace v1.1 record and is immutable; `raw` is the frame as received, never re-serialised. Frames v1.1 cannot represent are stored as `kind: "frame"` (never as `trace`).
- **Delivery outcomes** live in the document's `deliveries` (outside `trace`), one per destination, and only move forward (`queued` → `submitted` → `written` | `failed` | `dropped`). Queued messages carry their `DeliveryTracker`; evictions, teardown and closed links report `dropped`. `written` = `ws` send callback without error, not a peer acknowledgement. `dropped` is a loss on the way to a destination the frame was routed to (the viewer's `syntheticStatus` ranks it above `written`): a destination the gateway deliberately skips is not listed, never recorded as `dropped`.
- **Never interfere with forwarding:** the `TraceSink` is synchronous and non-throwing; a frame is sent before it is decoded for the archive (on `commit()`); MongoDB is only touched by `BufferedTraceWriter`'s background batches. `MongoTraceStore` masks credentials in every error it throws. Without a sink, `send()` calls `ws.send(raw)` exactly as before (no callback).
- **Several sinks per session** (archive, live viewer): a `SessionTracer` builds each document once and inserts it into every sink whose optional `active()` (cheap, never throws; absent = always) is true at `commit()`, each with its own `deliveries` array (the record is shared, never mutated); delivery updates go only to the sinks that accepted it. While no sink is active, frames are not decoded and pending CALLs are forgotten.
- **Correlation is per conversation** (session × CSMS), so secondary responses never answer the charger's CALL in the primary's conversation; responses carry `meta.gateway.correlation`, never a top-level `action`.
- Tests: `test/trace/` (unit, plus `mongo-store.test.ts` against a real MongoDB when `TRACE_TEST_MONGODB_URI` is set — CI runs a `mongo` service) and `test/trace-integration.test.ts` (gateway end to end with an in-memory sink). Records are checked with `@open-ocpp-trace/core`'s `validateRecord` (schema-equivalent), against the vendored spec fixtures (`test/fixtures/open-ocpp-trace/`, Apache-2.0, excluded from formatting) and the ported reference consumer (`test/trace/conformance.ts`). No validation on the forwarding path.

## Conventions

- Runtime knobs are env vars (`config.ts`); CSMS topology is the routes file (`routes.ts`). Add env options in `config.ts` and surface them in `README.md`/`.env.example`; add routing fields in `routes.ts`'s validator and `routes.example.json`.
- Keep secondary-side code defensive: wrap sends/closes so a failing secondary can never throw into the charger or primary path. The same goes for trace archiving: never await it nor let it throw on the forwarding path, and keep its memory bounded.
- Log via `createLogger(tag)`, not `console.*`.
- Report only crashes and internal anomalies, with `log.error(..., { report: true, cause: err })` and the original error; never charger or CSMS network errors, and at most once per outage for a repeated one. Never import `@sentry/node` outside `monitoring/sentry.ts`.
- Never put a real charger id, CSMS hostname, or other personal/infra reference in examples, docs, or tests — use generic placeholders (`CP-001`, `*.example.com`).
- Code and commit messages in English.

### Commits, hooks & changelog

- **Conventional Commits** are enforced by commitlint (`@commitlint/config-conventional`, config in `.commitlintrc.json`). Commit messages must look like `type(scope): subject` — e.g. `feat: add per-charger routing`, `fix(connection): guard secondary close`. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Git hooks** are managed by [husky](https://typicode.github.io/husky/) (installed via the `prepare` script on `npm install`). Hook scripts live in `.husky/`:
  - `pre-commit` → `lint-staged`: runs `vp fmt --write` then `vp lint --fix` on staged `*.{ts,mts,js,mjs,cjs}` files and re-stages them (config under `lint-staged` in `package.json`).
  - `commit-msg` → `commitlint`: validates the message.
  - `pre-push` → `npm test`: the full suite must pass before pushing.
- Update **`CHANGELOG.md`** ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) for any user-facing change: add entries under `## [Unreleased]` in the appropriate group (Added / Changed / Deprecated / Removed / Fixed / Security). On release, rename `[Unreleased]` to the new version with a date and update the comparison links at the bottom.
