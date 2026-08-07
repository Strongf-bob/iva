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
ACTIVE_COMPOSE_FILE="$RUNTIME_ROOT/compose.yml"
COMPOSE_FILE="${IVA_RELEASE_COMPOSE_FILE:-$ACTIVE_COMPOSE_FILE}"
ENV_FILE="$RUNTIME_ROOT/.env"
CURRENT_IMAGE_FILE="$DEPLOY_DIR/current-image"
PREVIOUS_IMAGE_FILE="$DEPLOY_DIR/previous-image"
REGISTRY_IMAGE="ghcr.io/strongf-bob/iva"
HEALTH_ATTEMPTS="${IVA_DEPLOY_HEALTH_ATTEMPTS:-36}"
HEALTH_DELAY="${IVA_DEPLOY_HEALTH_DELAY:-5}"
POLLER_SETTLE_DELAY="${IVA_DEPLOY_POLLER_SETTLE_DELAY:-5}"

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

[ -f "$ENV_FILE" ] || fail "runtime environment is missing"
docker info --format '{{json .SecurityOptions}}' | grep -q rootless ||
  fail "rootless Docker is required"
mkdir -p "$DEPLOY_DIR"

printf 'deploy: pulling immutable image for %s\n' "$sha"
docker pull "$candidate_image" || fail "image pull failed"

# The installed forced command is a stable bootstrap. Each release supplies its
# own Compose and deploy logic inside the exact image that CI published.
if [ "${IVA_DEPLOY_RELEASE_BUNDLE:-}" != "1" ] && [ "${IVA_DEPLOY_SKIP_BUNDLE:-}" != "1" ]; then
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$candidate_image")"
  [ "$revision" = "$sha" ] || fail "image revision does not match deployment command"
  release_dir="$DEPLOY_DIR/releases/$sha"
  temporary_dir="$release_dir.tmp.$$"
  rm -rf "$temporary_dir"
  mkdir -p "$temporary_dir"
  docker run --rm --entrypoint cat "$candidate_image" \
    /app/deploy/container/deploy.sh >"$temporary_dir/deploy.sh" ||
    fail "release deploy script extraction failed"
  docker run --rm --entrypoint cat "$candidate_image" \
    /app/deploy/container/compose.production.yml >"$temporary_dir/compose.yml" ||
    fail "release compose extraction failed"
  chmod 700 "$temporary_dir/deploy.sh"
  chmod 600 "$temporary_dir/compose.yml"
  rm -rf "$release_dir"
  mv "$temporary_dir" "$release_dir"
  exec env IVA_DEPLOY_RELEASE_BUNDLE=1 \
    IVA_RELEASE_COMPOSE_FILE="$release_dir/compose.yml" \
    bash "$release_dir/deploy.sh"
fi

[ -f "$COMPOSE_FILE" ] || fail "compose file is missing"

exec 9>"$DEPLOY_DIR/deploy.lock"
flock -n 9 || fail "another deployment is running"

compose() {
  local image="$1" allow_inert="$2"
  shift 2
  IVA_IMAGE="$image" TELEGRAM_USERBOT_ALLOW_INERT="$allow_inert" docker compose \
    --project-directory "$RUNTIME_ROOT" \
    -f "$COMPOSE_FILE" \
    "$@"
}

image_supports_userbot() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'test -x /opt/iva-userbot-venv/bin/python && test -f /app/services/telegram-userbot/container_supervisor.py'
}

telegram_token() {
  sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$ENV_FILE" | tail -n 1
}

telegram_bot_id() {
  sed -n 's/^TELEGRAM_BOT_ID=//p' "$ENV_FILE" | tail -n 1
}

telegram_proxy() {
  sed -n 's/^TELEGRAM_PROXY_URL=//p' "$ENV_FILE" |
    tail -n 1 |
    sed 's#://10\.0\.2\.2:#://127.0.0.1:#'
}

telegram_ok() {
  local token expected_id proxy response
  local -a proxy_args=()
  token="$(telegram_token)"
  [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || return 1
  expected_id="$(telegram_bot_id)"
  [[ "$expected_id" =~ ^[0-9]+$ ]] || return 1
  proxy="$(telegram_proxy)"
  if [ -n "$proxy" ]; then
    proxy_args=(--proxy "$proxy")
  fi
  response="$(
    printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token" |
      curl "${proxy_args[@]}" --config - --fail --silent --show-error --max-time 10
  )" || return 1
  printf '%s' "$response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' ||
    return 1
  printf '%s' "$response" |
    grep -Eq '"id"[[:space:]]*:[[:space:]]*'"$expected_id"'([^0-9]|$)'
}

runtime_ok() {
  local image="$1" allow_inert="$2" container_id health poller_id poller_state userbot_id userbot_state
  container_id="$(compose "$image" "$allow_inert" ps -q iva)" || return 1
  [ -n "$container_id" ] || return 1
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" || return 1
  [ "$health" = "healthy" ] || return 1
  poller_id="$(compose "$image" "$allow_inert" ps -q telegram-poll)" || return 1
  [ -n "$poller_id" ] || return 1
  poller_state="$(
    docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$poller_id"
  )" || return 1
  [ "$poller_state" = "running 0" ] || return 1
  userbot_id="$(compose "$image" "$allow_inert" ps -q telegram-userbot)" || return 1
  [ -n "$userbot_id" ] || return 1
  userbot_state="$(
    docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$userbot_id"
  )" || return 1
  [ "$userbot_state" = "running 0" ] || return 1
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:8723/eve/v1/health" >/dev/null || return 1
  telegram_ok
}

wait_healthy() {
  local image="$1" allow_inert="$2" attempt=1
  while [ "$attempt" -le "$HEALTH_ATTEMPTS" ]; do
    if runtime_ok "$image" "$allow_inert"; then
      return 0
    fi
    sleep "$HEALTH_DELAY"
    attempt=$((attempt + 1))
  done
  return 1
}

start_image() {
  local image="$1" allow_inert="$2"
  compose "$image" "$allow_inert" up -d --remove-orphans iva telegram-poll telegram-userbot || return 1
  sleep "$POLLER_SETTLE_DELAY"
  wait_healthy "$image" "$allow_inert"
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

image_supports_userbot "$candidate_image" || fail "candidate image lacks the userbot runtime"

if ! start_image "$candidate_image" 0; then
  printf 'deploy: candidate failed health checks; rolling back\n' >&2
  if [ -n "$previous_image" ] && [ "$previous_image" != "$candidate_image" ]; then
    docker pull "$previous_image" >/dev/null 2>&1 || true
    rollback_allow_inert=0
    if ! image_supports_userbot "$previous_image"; then
      rollback_allow_inert=1
    fi
    if start_image "$previous_image" "$rollback_allow_inert"; then
      printf 'deploy: previous image restored\n' >&2
    else
      fail "candidate and rollback image are unhealthy"
    fi
  else
    compose "$candidate_image" 0 down >/dev/null 2>&1 || true
  fi
  exit 1
fi

if [ -n "$previous_image" ] && [ "$previous_image" != "$candidate_image" ]; then
  write_state "$PREVIOUS_IMAGE_FILE" "$previous_image"
fi
write_state "$CURRENT_IMAGE_FILE" "$candidate_image"
if [ "$COMPOSE_FILE" != "$ACTIVE_COMPOSE_FILE" ]; then
  temporary_compose="$ACTIVE_COMPOSE_FILE.tmp.$$"
  cp "$COMPOSE_FILE" "$temporary_compose"
  chmod 600 "$temporary_compose"
  mv "$temporary_compose" "$ACTIVE_COMPOSE_FILE"
fi

printf 'deploy: healthy release %s is active\n' "$sha"
