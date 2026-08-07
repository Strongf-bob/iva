#!/usr/bin/env bash
set -eu

umask 077

if [ "${IVA_DEPLOY_TESTING:-}" = "1" ]; then
  PATH="${IVA_DEPLOY_TEST_PATH:?IVA_DEPLOY_TEST_PATH is required in test mode}"
  RUNTIME_ROOT="${IVA_RUNTIME_ROOT:?IVA_RUNTIME_ROOT is required in test mode}"
else
  PATH="/usr/local/bin:/usr/bin:/bin"
  RUNTIME_ROOT="/home/strongf/iva-runtime"
fi
export PATH

DEPLOY_DIR="$RUNTIME_ROOT/deploy"
COMPOSE_FILE="$RUNTIME_ROOT/compose.yml"
ENV_FILE="$RUNTIME_ROOT/.env"
CURRENT_IMAGE_FILE="$DEPLOY_DIR/current-image"
PREVIOUS_IMAGE_FILE="$DEPLOY_DIR/previous-image"
REGISTRY_IMAGE="ghcr.io/strongf-bob/iva"
HEALTH_ATTEMPTS="${IVA_DEPLOY_HEALTH_ATTEMPTS:-36}"
HEALTH_DELAY="${IVA_DEPLOY_HEALTH_DELAY:-5}"

fail() {
  printf 'deploy: %s\n' "$1" >&2
  exit 1
}

command_text="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$command_text" =~ ^deploy\ [0-9a-f]{40}$ ]]; then
  fail "invalid deployment command"
fi

sha="${command_text#deploy }"
candidate_image="$REGISTRY_IMAGE:sha-$sha"

[ -f "$COMPOSE_FILE" ] || fail "compose file is missing"
[ -f "$ENV_FILE" ] || fail "runtime environment is missing"
docker info --format '{{json .SecurityOptions}}' | grep -q rootless ||
  fail "rootless Docker is required"
mkdir -p "$DEPLOY_DIR"

exec 9>"$DEPLOY_DIR/deploy.lock"
flock -n 9 || fail "another deployment is running"

compose() {
  IVA_IMAGE="$1" docker compose \
    --project-directory "$RUNTIME_ROOT" \
    -f "$COMPOSE_FILE" \
    "${@:2}"
}

telegram_token() {
  sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | tail -n 1
}

telegram_proxy() {
  sed -n 's/^TELEGRAM_PROXY_URL=//p' "$ENV_FILE" |
    tail -n 1 |
    sed 's#://10\.0\.2\.2:#://127.0.0.1:#'
}

telegram_ok() {
  local token proxy response
  local -a proxy_args=()
  token="$(telegram_token)"
  [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || return 1
  proxy="$(telegram_proxy)"
  if [ -n "$proxy" ]; then
    proxy_args=(--proxy "$proxy")
  fi
  response="$(
    printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token" |
      curl "${proxy_args[@]}" --config - --fail --silent --show-error --max-time 10
  )" || return 1
  printf '%s' "$response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'
}

runtime_ok() {
  local image="$1" container_id health
  container_id="$(compose "$image" ps -q iva)" || return 1
  [ -n "$container_id" ] || return 1
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" || return 1
  [ "$health" = "healthy" ] || return 1
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:8723/eve/v1/health" >/dev/null || return 1
  telegram_ok
}

wait_healthy() {
  local image="$1" attempt=1
  while [ "$attempt" -le "$HEALTH_ATTEMPTS" ]; do
    if runtime_ok "$image"; then
      return 0
    fi
    sleep "$HEALTH_DELAY"
    attempt=$((attempt + 1))
  done
  return 1
}

start_image() {
  local image="$1"
  compose "$image" up -d --remove-orphans iva telegram-poll || return 1
  wait_healthy "$image"
}

write_state() {
  local path="$1" value="$2" temporary
  temporary="$path.tmp.$$"
  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$path"
}

previous_image=""
if [ -f "$CURRENT_IMAGE_FILE" ]; then
  previous_image="$(sed -n '1p' "$CURRENT_IMAGE_FILE")"
fi

printf 'deploy: pulling immutable image for %s\n' "$sha"
docker pull "$candidate_image" || fail "image pull failed"

if ! start_image "$candidate_image"; then
  printf 'deploy: candidate failed health checks; rolling back\n' >&2
  if [ -n "$previous_image" ] && [ "$previous_image" != "$candidate_image" ]; then
    docker pull "$previous_image" >/dev/null 2>&1 || true
    if start_image "$previous_image"; then
      printf 'deploy: previous image restored\n' >&2
    else
      fail "candidate and rollback image are unhealthy"
    fi
  else
    compose "$candidate_image" down >/dev/null 2>&1 || true
  fi
  exit 1
fi

if [ -n "$previous_image" ] && [ "$previous_image" != "$candidate_image" ]; then
  write_state "$PREVIOUS_IMAGE_FILE" "$previous_image"
fi
write_state "$CURRENT_IMAGE_FILE" "$candidate_image"

printf 'deploy: healthy release %s is active\n' "$sha"
