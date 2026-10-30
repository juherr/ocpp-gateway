# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code specifics

- **Verification before "done":** run `npm run lint && npm run typecheck && npm run build && npm test` and confirm they pass before claiming a change works or committing.
- **Fresh worktree:** it has no `node_modules` — run `npm ci` before any gate; run it again after switching to a branch whose `package-lock.json` differs.
- **Lint baseline:** zero warnings — CI annotates any new one on the PR.
- **Tests are not type-checked:** `tsconfig.json` includes only `src/` and `tsconfig.web.json` only `web/`, so type errors in `test/` surface at runtime only.
- **Docker build inputs:** after changing the `Dockerfile`, `.dockerignore` or what the image builds (`web/`, `tsconfig*.json`, `vite.config.ts`), also run `bash test/compose-smoke.sh; echo "exit=$?"` (needs Docker; CI runs it in `cloudflare-smoke`).
- **Viewer UI changes:** `web/viewer/app.ts` has no unit tests (vitest runs in Node); check UI changes in a browser: `npm run build`, then `ROUTES_FILE=./routes.json VIEWER_ENABLED=true VIEWER_USERNAME=dev VIEWER_PASSWORD=dev npm start` and open `http://127.0.0.1:9001` (routes need backend ids). Watch the console for CSP violations.
- **Cloudflare example (`deploy/cloudflare/`):** separate package outside the root gates (CI jobs `cloudflare` and `cloudflare-smoke`). Verify there with `npm ci && npm run typecheck && npm run dry-run` (the dry run builds the image, needs Docker, no Cloudflare credentials). `npm run dev` there runs Worker + Container locally; gateway logs come from `docker logs` of the `cloudflare-dev/ocppgateway*` container.
- **Host spoofing in tests:** pass `headers: { host: "tenant-a.ocpp.example.com" }` to `new WebSocket(...)`; Node accepts duplicate `Host` headers (only a raw socket can send them, see `test/multi-tenant.test.ts`).
- **Commits/pushes:** create commits or push only when explicitly asked. Messages in English and in [Conventional Commits](https://www.conventionalcommits.org/) form (`type(scope): subject`) — commitlint rejects anything else. Husky hooks run lint-staged on commit and the test suite on push; never bypass them with `--no-verify`. Update `CHANGELOG.md` (`[Unreleased]`) for user-facing changes.
- **Reviews:** use the `code-review` skill before opening a PR.