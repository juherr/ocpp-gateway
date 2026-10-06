#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_root="$(mktemp -d)"
project_dir="$temp_root/project"
project_name="ocpp-compose-smoke-$$"

mkdir -p "$project_dir"
cp "$repo_root/Dockerfile" \
  "$repo_root/package.json" \
  "$repo_root/package-lock.json" \
  "$repo_root/tsconfig.json" \
  "$repo_root/vite.config.ts" \
  "$repo_root/docker-compose.yml" \
  "$repo_root/docker-compose.local.yml" \
  "$project_dir/"
cp -R "$repo_root/src" "$project_dir/src"

cat > "$project_dir/.env" <<'EOF'
PORT=19001
LISTEN_HOST=127.0.0.1
EOF

cat > "$project_dir/routes.json" <<'EOF'
{
  "default": {
    "primary": "ws://csms.example.com/ocpp",
    "secondaries": []
  }
}
EOF
chmod 644 "$project_dir/routes.json"
cp "$project_dir/routes.json" "$temp_root/routes-explicit.json"
chmod 644 "$temp_root/routes-explicit.json"

compose=(docker compose --project-directory "$project_dir" -f "$project_dir/docker-compose.yml" -p "$project_name")

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$temp_root"
}
trap cleanup EXIT

unset ROUTES_HOST_PATH
fallback_config="$("${compose[@]}" config --format json)"
node -e '
  const assert = require("node:assert/strict");
  const config = JSON.parse(process.argv[1]);
  const routeMount = config.services["ocpp-gateway"].volumes.find((volume) => volume.target === "/app/routes.json");

  assert.equal(routeMount.source, process.argv[2], "Unset ROUTES_HOST_PATH must fall back to ./routes.json");
  assert.equal(routeMount.read_only, true, "The routes file mount must be read-only");
' "$fallback_config" "$project_dir/routes.json"

export ROUTES_HOST_PATH="$temp_root/routes-explicit.json"
rendered_config="$("${compose[@]}" config --format json)"
node -e '
  const assert = require("node:assert/strict");
  const config = JSON.parse(process.argv[1]);
  const service = config.services["ocpp-gateway"];
  const routeMount = service.volumes.find((volume) => volume.target === "/app/routes.json");

  assert.equal(service.environment.PORT, "9000", "Compose must pin PORT to 9000");
  assert.equal(service.environment.LISTEN_HOST, "0.0.0.0", "Compose must listen on the container network");
  assert.equal(service.environment.ROUTES_FILE, "/app/routes.json");
  assert.deepEqual(service.ports ?? [], [], "Coolify deployment must not publish a host port");
  assert.ok(service.expose.includes("9000"), "Compose must expose internal port 9000");
  assert.equal(routeMount.source, process.argv[2], "ROUTES_HOST_PATH must resolve to the mounted routes file");
  assert.equal(routeMount.read_only, true, "The routes file mount must be read-only");
' "$rendered_config" "$ROUTES_HOST_PATH"

local_config="$("${compose[@]}" -f "$project_dir/docker-compose.local.yml" config --format json)"
node -e '
  const assert = require("node:assert/strict");
  const config = JSON.parse(process.argv[1]);
  const localPort = config.services["ocpp-gateway"].ports[0];
  assert.equal(localPort.published, "9000");
  assert.equal(localPort.host_ip, "127.0.0.1");
' "$local_config"

"${compose[@]}" up --build -d

container_id="$("${compose[@]}" ps -q ocpp-gateway)"
if [ -z "$container_id" ]; then
  echo "Compose did not start the gateway container" >&2
  exit 1
fi

for _ in {1..30}; do
  health_status="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")"
  if [ "$health_status" = "healthy" ]; then
    break
  fi
  if [ "$health_status" = "unhealthy" ]; then
    docker logs "$container_id" >&2
    echo "The gateway container became unhealthy" >&2
    exit 1
  fi
  sleep 2
done

if [ "${health_status:-}" != "healthy" ]; then
  docker logs "$container_id" >&2
  echo "Timed out waiting for the gateway container to become healthy" >&2
  exit 1
fi

"${compose[@]}" exec -T ocpp-gateway node -e '
  const assert = require("node:assert/strict");
  const os = require("node:os");
  assert.equal(process.env.PORT, "9000");
  assert.equal(process.env.LISTEN_HOST, "0.0.0.0");
  assert.equal(process.env.ROUTES_FILE, "/app/routes.json");
  const address = Object.values(os.networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal);
  assert.ok(address, "Expected a container network interface");
  fetch(`http://${address.address}:9000/healthz`).then(async (response) => {
    assert.equal(response.status, 200);
    assert.equal((await response.text()).trim(), "ok");
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
'

echo "Compose deployment smoke test passed"
