# AGENTS.md

Generic guidance for AI agents working in this repository. (Claude Code reads this via `@AGENTS.md` from `CLAUDE.md`.)

## What this is

A lightweight OCPP WebSocket gateway (Node.js + TypeScript) that routes each charge point **by its chargeBoxId** (via a JSON routing table) to its own bidirectional **primary CSMS** and any number of read-only **secondary** mirrors. Supports OCPP 1.6 and 2.0.1. The only runtime dependency is `ws`.

This is a fork of [joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) (MIT); the fork's defining change is replacing the original's global `PRIMARY_CSMS_URL`/`SECONDARY_CSMS_URLS` env config with the per-chargeBoxId routing table. Preserve the MIT license and upstream attribution.

## Commands

The Node version is pinned in `mise.toml` (Node 24 LTS). With [mise](https://mise.jdx.dev) installed, run `mise install` once to get the right Node; CI and Docker use the same version.

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

`npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` are the verification gates — run all after changes. Type safety comes from `npm run typecheck` (`tsc --noEmit` under `strict: true`), not from the bundle step. Tests live in `test/` (not part of the bundle, which only takes `src/index.ts` and its imports).

CI validates every PR and push to `main`:

- `.github/workflows/commitlint.yml` — lints commit messages against Conventional Commits (the CI counterpart to the local `commit-msg` hook, which `--no-verify` can bypass).
- `.github/workflows/docker.yml` — a `test` job (lint + typecheck + build + `npm test`) and, only if it passes, a `build` job publishing a multi-arch image to `ghcr.io/juherr/ocpp-gateway`. Image tags are **semver-pinned** (`flavor: latest=false` — never publish `latest`).

Both workflows install Node via `jdx/mise-action`, which reads the version from `mise.toml` — the single source of truth shared with local dev and the Docker images (Node 24, the current LTS). GitHub Actions are pinned to commit SHAs with a `# vX.Y.Z` comment; Dependabot (`.github/dependabot.yml`) keeps npm, actions, and Docker deps current.

## Architecture

Modules in `src/`, bundled by `vp pack` into a single CommonJS `dist/index.cjs` (entry `src/index.ts`; `ws` and Node built-ins stay external):

- **`index.ts`** — entrypoint: load config → set log level → load the route table (**fail-fast** if missing/invalid) → start watching it for hot reload → start the gateway.
- **`config.ts`** — reads env vars (`PORT`, `ROUTES_FILE` default `./routes.json`, `LOG_LEVEL`). Throws on invalid port. No CSMS URLs live here anymore — those are in the routes file.
- **`routes.ts`** — the routing layer. Pure functions `parseRouteTable` (validates structure, throws on error), `resolveRoute` (`chargers[id] ?? default`), and `buildTargetUrl` (appends url-encoded chargeBoxId to a base URL, trims trailing slashes). `RouteStore` loads the file, resolves routes, and optionally `watch()`es for hot reload (a failed reload keeps the previous table).
- **`proxy.ts`** — HTTP server (`GET /healthz` → 200) + `WebSocketServer`. Negotiates the OCPP sub-protocol, extracts the chargeBoxId from the **last path segment** of the request URL (URL-decoded), resolves its route via the `RouteStore`, and spawns one `ChargerConnection`. Logs the resolved route on connect. Handles `SIGINT`/`SIGTERM` graceful shutdown.
- **`connection.ts`** — the core. `ChargerConnection` takes a resolved `Route` and owns the full lifecycle of one charger session and all its upstream links.
- **`logger.ts`** — structured JSON logging to stdout (stderr for errors), filtered by level. Each connection logs under a tag = chargeBoxId.
- **`types.ts`** — OCPP message-type constants and the sub-protocol preference list (`ocpp2.0.1` > `ocpp2.0` > `ocpp1.6`).

### Routing model

A `routes.json` has a required `default` route and an optional `chargers` map keyed by chargeBoxId. Each route = `{ primary: string, secondaries: string[] }`. Resolution is exact-match on the id, falling back to `default`. Real `routes.json` is gitignored; `routes.example.json` is the committed template.

### Connection model (the key invariant)

Per charger, the gateway holds one **primary** link and N **secondary** links:

- **Charger → upstream**: every message is forwarded to the primary AND mirrored to all secondaries.
- **Upstream → charger**: ONLY the primary's responses go back to the charger. Secondary responses are logged and discarded — secondaries are strictly one-way mirrors.
- **Primary failure tears down the whole session** (chargers expect exactly one CSMS). A **secondary failure must never affect the charger or the primary** — this is a hard rule; all secondary I/O is wrapped best-effort.

For each upstream the gateway builds `<baseUrl>/<chargeBoxId>` via `buildTargetUrl` (so different backends may use different base paths). HTTP Basic Auth (`Authorization` header) is forwarded as-is to all upstreams. Note: the **primary path is not buffered** — messages sent before the primary link is OPEN are dropped (only secondaries have a replay queue).

### Secondary resilience (in `connection.ts`)

Charger sessions live for days/weeks, so secondaries get extras tuned by the `SECONDARY_*` constants at the top of the file:

- **Auto-reconnect** after a fixed delay, retrying until the charger session ends.
- **Keepalive ping** on an interval to survive idle-connection timeouts.
- **Pong-timeout detection** — if no pong arrives within the timeout, the socket is force-closed to trigger reconnect.
- **Bounded replay queue** per secondary while disconnected; oldest messages drop first when full.

WebSocket ping/pong frames are forwarded between charger and primary via the module-level `forwardPing`/`forwardPong` helpers, which guard on `readyState === OPEN`.

## Conventions

- Runtime knobs are env vars (`config.ts`); CSMS topology is the routes file (`routes.ts`). Add env options in `config.ts` and surface them in `README.md`/`.env.example`; add routing fields in `routes.ts`'s validator and `routes.example.json`.
- Keep secondary-side code defensive: wrap sends/closes so a failing secondary can never throw into the charger or primary path.
- Log via `createLogger(tag)`, not `console.*`.
- Never put a real charger id, CSMS hostname, or other personal/infra reference in examples, docs, or tests — use generic placeholders (`CP-001`, `*.example.com`).
- Code and commit messages in English.

### Commits, hooks & changelog

- **Conventional Commits** are enforced by commitlint (`@commitlint/config-conventional`, config in `.commitlintrc.json`). Commit messages must look like `type(scope): subject` — e.g. `feat: add per-charger routing`, `fix(connection): guard secondary close`. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Git hooks** are managed by [husky](https://typicode.github.io/husky/) (installed via the `prepare` script on `npm install`). Hook scripts live in `.husky/`:
  - `pre-commit` → `lint-staged`: runs `vp fmt --write` then `vp lint --fix` on staged `*.{ts,js,mjs,cjs}` files and re-stages them (config under `lint-staged` in `package.json`).
  - `commit-msg` → `commitlint`: validates the message.
  - `pre-push` → `npm test`: the full suite must pass before pushing.
- Update **`CHANGELOG.md`** ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)) for any user-facing change: add entries under `## [Unreleased]` in the appropriate group (Added / Changed / Deprecated / Removed / Fixed / Security). On release, rename `[Unreleased]` to the new version with a date and update the comparison links at the bottom.