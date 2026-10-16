#!/usr/bin/env bash
# Manual, pinned upstream A2A conformance check. Requires Node 22, Python 3.12,
# uv 0.12.10, git, curl, and network access to the upstream TCK repository.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tck_sha=263b9cfaf16a554bdfb166a7ba5b67716e946349
work_dir="$(mktemp -d)"
tck_dir="$work_dir/a2a-tck"
agent_pid=''
proxy_pid=''

stop_services() {
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$agent_pid" ]]; then kill "$agent_pid" 2>/dev/null || true; fi
  printf 'A2A TCK evidence and logs remain at %s\n' "$work_dir"
}
trap stop_services EXIT

wait_for() {
  local url="$1"
  for attempt in $(seq 1 30); do
    if curl --fail --silent "$url" >/dev/null; then return 0; fi
    sleep 1
  done
  printf 'A2A test service did not become ready: %s\n' "$url" >&2
  return 1
}

npm ci --prefix "$repo_root/server"
(
  cd "$repo_root"
  NODE_ENV=test AGENT_A2A_V1_ENABLED=true PORT=5089 \
    AGENT_A2A_PUBLIC_URL=http://127.0.0.1:5088 \
    AGENT_A2A_DEV_TOKEN=manual-a2a-test-token \
    AGENT_IDENTITY_PROVIDER=development RESEARCH_SEARCH_PROVIDER=fixture \
    node server/agents/research/researchAgentServer.js
) >"$work_dir/research-agent.log" 2>&1 &
agent_pid=$!
wait_for http://127.0.0.1:5089/health/live

status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request POST http://127.0.0.1:5089/a2a/message:send \
  --header 'Content-Type: application/json' --data '{}')"
test "$status" = 401

A2A_TCK_PROXY_TOKEN=manual-a2a-test-token \
  A2A_TCK_PROXY_LISTEN_PORT=5088 A2A_TCK_PROXY_UPSTREAM_PORT=5089 \
  node "$repo_root/server/scripts/a2aTckAuthProxy.js" \
  >"$work_dir/a2a-tck-proxy.log" 2>&1 &
proxy_pid=$!
wait_for http://127.0.0.1:5088/__ci-health

git init "$tck_dir"
git -C "$tck_dir" remote add origin https://github.com/a2aproject/a2a-tck.git
git -C "$tck_dir" fetch --depth 1 origin "$tck_sha"
git -C "$tck_dir" checkout --detach FETCH_HEAD
test "$(git -C "$tck_dir" rev-parse HEAD)" = "$tck_sha"
(
  cd "$tck_dir"
  uv sync --locked --no-dev --python 3.12
)
test -z "$(git -C "$tck_dir" status --porcelain=v1 --untracked-files=all)"
python "$repo_root/scripts/test_validate_a2a_tck_policy.py"
NODE_ENV=test AGENT_A2A_V1_ENABLED=true AGENT_A2A_DEV_TOKEN=manual-a2a-test-token \
  AGENT_IDENTITY_PROVIDER=development RESEARCH_SEARCH_PROVIDER=fixture \
  node --test --test-concurrency=1 \
    "$repo_root/server/test/researchMesh.test.js" \
    "$repo_root/server/test/researchTaskStore.test.js" \
    "$repo_root/server/test/a2aTckAuthProxy.test.js"

cd "$tck_dir"
started_at="$(date +%s.%N)"
set +e
uv run --locked python run_tck.py --sut-host http://127.0.0.1:5088 --transport http_json --level must
raw_tck_exit_code=$?
set -e
printf 'RAW_TCK_EXIT_CODE=%s\n' "$raw_tck_exit_code"
python "$repo_root/scripts/validate_a2a_tck_policy.py" \
  --junit reports/junitreport.xml \
  --policy "$repo_root/.github/a2a-tck-known-blockers.json" \
  --tck-dir . --tck-sha "$tck_sha" \
  --raw-exit-code "$raw_tck_exit_code" --started-at "$started_at" \
  --summary-path "$work_dir/summary.md"
