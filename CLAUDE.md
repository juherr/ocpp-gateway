# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code specifics

- **Verification before "done":** run `npm run lint && npm run typecheck && npm run build && npm test` and confirm they pass before claiming a change works or committing.
- **Commits/pushes:** create commits or push only when explicitly asked. Messages in English and in [Conventional Commits](https://www.conventionalcommits.org/) form (`type(scope): subject`) — commitlint rejects anything else. Husky hooks run lint-staged on commit and the test suite on push; never bypass them with `--no-verify`. Update `CHANGELOG.md` (`[Unreleased]`) for user-facing changes.
- **Reviews:** use the `code-review` skill before opening a PR.