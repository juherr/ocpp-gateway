#!/usr/bin/env bash
# Lint the fork's own commits in <from>..<to> against Conventional Commits.
#
# Only the first-parent chain is checked: commits brought in through a merge
# (e.g. an upstream sync from joulo-nl/joulo-ocpp-proxy) follow upstream's
# conventions and are not ours to rewrite. Merge commits themselves are skipped.
set -euo pipefail

from="$1"
to="$2"
status=0

for sha in $(git rev-list --first-parent --no-merges "${from}..${to}"); do
  git log -1 --format=%B "$sha" | npx commitlint --verbose || status=1
done

exit "$status"
