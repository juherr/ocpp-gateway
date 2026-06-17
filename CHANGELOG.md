# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First cut of **ocpp-gateway**, a fork of
[joulo-ocpp-proxy](https://github.com/joulo-nl/joulo-ocpp-proxy) (MIT). The
defining change is per-chargeBoxId routing in place of the upstream's single
global primary/secondary configuration. Nothing has been released yet.

### Added

- Per-chargeBoxId routing table loaded from a JSON file (`ROUTES_FILE`, default
  `./routes.json`): a required `default` route and optional exact-match
  `chargers` overrides, each with one `primary` and any number of read-only
  `secondaries`. The gateway **fails to start** if the file is missing or
  invalid.
- Hot reload of the routing table: the file is watched and reloaded on change;
  a failed reload keeps the previous table in effect. Existing charger sessions
  keep the route they connected with.
- `GET /healthz` health-check endpoint returning `200 ok`.
- Structured route logging on connect (chargeBoxId, resolved primary and
  secondaries).
- Multi-arch Docker image (`linux/amd64`, `linux/arm64`) published to GitHub
  Container Registry, with semver-pinned tags (never `latest`).
- Dependabot configuration for npm, GitHub Actions, and Docker dependencies.
- Conventional-commit linting (commitlint) and Git hooks (husky + lint-staged):
  format and lint staged files on commit, validate the commit message, and run
  the test suite on push.
- This changelog.

### Changed

- Replaced the upstream global `PRIMARY_CSMS_URL` / `SECONDARY_CSMS_URLS`
  environment configuration with the per-chargeBoxId routing table. Each
  upstream target URL is built as `<baseUrl>/<chargeBoxId>`.
- Renamed the project from `joulo-ocpp-proxy` to `ocpp-gateway`.
- Switched the toolchain to Vite+ (Oxlint + Oxfmt for lint/format, `vp pack`
  for bundling to `dist/index.cjs`); `tsc --noEmit` is kept as a separate
  type-check gate.
- Pinned the Node version with mise (`mise.toml`, Node 24 LTS) as the single
  source of truth for local dev, CI (`jdx/mise-action`), and the Docker images.

### Preserved

- OCPP 1.6 / 2.0.1 sub-protocol negotiation, with the negotiated sub-protocol
  propagated to every upstream.
- Bidirectional primary link; read-only secondary mirrors whose responses are
  never returned to the charger.
- HTTP Basic Auth (`Authorization` header) forwarded as-is to all upstreams.
- Secondary resilience: auto-reconnect, keepalive ping with pong-timeout
  detection, and a bounded per-secondary replay queue.
- MIT license and upstream attribution.

[Unreleased]: https://github.com/juherr/ocpp-gateway/commits/main