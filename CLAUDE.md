# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code specifics

- **Verification before "done":** run `npm run lint && npm run typecheck && npm run build && npm test` and confirm they pass before claiming a change works or committing.
- **Fresh worktree:** it has no `node_modules` — run `npm ci` before any gate.
- **Lint baseline:** one known warning, `unicorn(no-useless-spread)` in `src/sessions.ts` (`[...entries]`); keep it — the copy is deliberate (`teardown()` mutates the map during iteration).
- **Tests are not type-checked:** `tsconfig.json` only includes `src/`, so type errors in `test/` surface at runtime only.
- **Cloudflare example (`deploy/cloudflare/`):** separate package outside the root gates. Verify with `npm install && npx tsc --noEmit` and `npx wrangler deploy --dry-run` (builds the image, needs Docker). `npm run dev` there runs Worker + Container locally; gateway logs come from `docker logs` of the `cloudflare-dev/ocppgateway*` container.
- **Host spoofing in tests:** pass `headers: { host: "tenant-a.ocpp.example.com" }` to `new WebSocket(...)`; Node accepts duplicate `Host` headers (only a raw socket can send them, see `test/multi-tenant.test.ts`).
- **Commits/pushes:** create commits or push only when explicitly asked. Messages in English and in [Conventional Commits](https://www.conventionalcommits.org/) form (`type(scope): subject`) — commitlint rejects anything else. Husky hooks run lint-staged on commit and the test suite on push; never bypass them with `--no-verify`. Update `CHANGELOG.md` (`[Unreleased]`) for user-facing changes.
- **Reviews:** use the `code-review` skill before opening a PR.