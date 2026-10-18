#!/bin/sh
set -eu

db_pid=''
app_pid=''

# Keep the embedded demo graph on loopback and require a per-process password.
graph_password=$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
export REDIS_ARGS="--bind 127.0.0.1 --requirepass $graph_password --maxmemory 128mb --maxmemory-policy noeviction"
export TRACEMIND_FALKORDB_URL="redis://:$graph_password@127.0.0.1:6379"

stop_children() {
  if [ -n "$app_pid" ]; then
    kill -TERM "$app_pid" 2>/dev/null || true
  fi
  if [ -n "$db_pid" ]; then
    kill -TERM "$db_pid" 2>/dev/null || true
  fi
  if [ -n "$app_pid" ]; then
    wait "$app_pid" 2>/dev/null || true
  fi
  if [ -n "$db_pid" ]; then
    wait "$db_pid" 2>/dev/null || true
  fi
}

trap stop_children INT TERM EXIT

/var/lib/falkordb/bin/run.sh &
db_pid=$!

ready=0
attempt=0
while [ "$attempt" -lt 30 ]; do
  if ! kill -0 "$db_pid" 2>/dev/null; then
    wait "$db_pid" || true
    echo "FalkorDB process exited before readiness" >&2
    exit 1
  fi
  if REDISCLI_AUTH="$graph_password" redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$ready" -ne 1 ]; then
  echo "FalkorDB did not become ready within 30 seconds" >&2
  exit 1
fi

node /app/dist/cli.js server \
  --host 0.0.0.0 \
  --port "${PORT:-10000}" \
  --base-dir "${TRACEMIND_BASE_DIR:-/tmp/tracemind-staging}" &
app_pid=$!

set +e
wait "$app_pid"
app_status=$?
set -e
exit "$app_status"
