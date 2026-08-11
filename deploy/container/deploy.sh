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
ACTIVE_DEPLOY_SCRIPT="$DEPLOY_DIR/deploy.sh"
LEGACY_OWNER_ROUTE_FILE="$RUNTIME_ROOT/data/control/legacy-owner-route.json"
REGISTRY_IMAGE="ghcr.io/strongf-bob/iva"
HEALTH_ATTEMPTS="${IVA_DEPLOY_HEALTH_ATTEMPTS:-36}"
HEALTH_DELAY="${IVA_DEPLOY_HEALTH_DELAY:-5}"
POLLER_SETTLE_DELAY="${IVA_DEPLOY_POLLER_SETTLE_DELAY:-5}"
CONTAINER_WORKERS_ALLOW_LEGACY=0

fail() {
  printf 'deploy: %s\n' "$1" >&2
  exit 1
}

command_text="${SSH_ORIGINAL_COMMAND:-}"
command_mode=""
backfill_action=""
backfill_run_id=""
if [[ "$command_text" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  command_mode="deploy"
  sha="${BASH_REMATCH[1]}"
elif [ "$command_text" = "contact-backfill dry-run" ]; then
  command_mode="contact-backfill"
  backfill_action="dry-run"
elif [[ "$command_text" =~ ^contact-backfill\ (apply|status|rollback)\ ([a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)$ ]]; then
  command_mode="contact-backfill"
  backfill_action="${BASH_REMATCH[1]}"
  backfill_run_id="${BASH_REMATCH[2]}"
else
  fail "invalid deployment command"
fi

[ -f "$ENV_FILE" ] || fail "runtime environment is missing"
docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless ||
  fail "rootless Docker is required"
mkdir -p "$DEPLOY_DIR"

compose() {
  local image="$1" allow_inert="$2"
  shift 2
  IVA_IMAGE="$image" TELEGRAM_USERBOT_ALLOW_INERT="$allow_inert" \
    IVA_CONTAINER_WORKERS_ALLOW_LEGACY="$CONTAINER_WORKERS_ALLOW_LEGACY" docker compose \
    --project-directory "$RUNTIME_ROOT" \
    -f "$COMPOSE_FILE" \
    "$@"
}

extract_contact_backfill_error() {
  local line safe=""
  while IFS= read -r line; do
    case "$line" in
      contact_backfill_failed | \
        contact_backfill_operator_failed | \
        contact_backfill_operator_output_limit | \
        contact_backfill_operator_owner_unavailable | \
        contact_backfill_operator_requires_container | \
        contact_backfill_operator_run_not_found | \
        contact_backfill_operator_state_binding_mismatch | \
        contact_backfill_operator_usage_error | \
        telegram_contact_analysis_requires_read_only | \
        telegram_private_backfill_already_active | \
        telegram_private_backfill_already_rolled_back | \
        telegram_private_backfill_backup_dir_absolute | \
        telegram_private_backfill_backup_dir_required | \
        telegram_private_backfill_backup_directory_mismatch | \
        telegram_private_backfill_backup_directory_not_empty | \
        telegram_private_backfill_backup_identity_mismatch | \
        telegram_private_backfill_concurrent_edit | \
        telegram_private_backfill_failed | \
        telegram_private_backfill_high_water_unreachable | \
        telegram_private_backfill_incremental_state_conflict | \
        telegram_private_backfill_invalid_dialog_cursor | \
        telegram_private_backfill_invalid_message_cursor | \
        telegram_private_backfill_manifest_missing | \
        telegram_private_backfill_messages_unavailable | \
        telegram_private_backfill_owner_only | \
        telegram_private_backfill_rollback_identity_mismatch | \
        telegram_private_backfill_rolled_back_run_is_terminal | \
        telegram_private_backfill_run_id_required | \
        telegram_private_backfill_state_account_mismatch | \
        telegram_private_backfill_state_missing | \
        telegram_private_backfill_vault_directory_mismatch)
        safe="$line"
        ;;
    esac
  done <"$1"
  printf '%s' "$safe"
}

if [ "$command_mode" = "contact-backfill" ]; then
  operator_output=""
  validated_output=""
  safe_error_code=""
  operator_error_file="$DEPLOY_DIR/contact-backfill-error.$$"
  : >"$operator_error_file" || fail "contact backfill operation failed"
  chmod 600 "$operator_error_file" || fail "contact backfill operation failed"
  trap 'rm -f "$operator_error_file"' EXIT
  [ -f "$ACTIVE_COMPOSE_FILE" ] || fail "compose file is missing"
  [ -f "$CURRENT_IMAGE_FILE" ] || fail "current image state is missing"
  current_image="$(sed -n '1p' "$CURRENT_IMAGE_FILE")"
  [[ "$current_image" =~ ^$REGISTRY_IMAGE:sha-[0-9a-f]{40}$ ]] ||
    fail "current image state is invalid"
  if [ "$backfill_action" != "status" ]; then
    exec 9>"$DEPLOY_DIR/deploy.lock"
    flock -n 9 || fail "another deployment or backfill is running"
  fi
  if [ "$backfill_action" = "dry-run" ]; then
    if operator_output="$(
      compose "$current_image" 0 exec -T telegram-poll node \
        scripts/production/contact-backfill-operator.ts dry-run 2>"$operator_error_file"
    )"; then
      :
    else
      safe_error_code="$(extract_contact_backfill_error "$operator_error_file")"
      [ -z "$safe_error_code" ] ||
        fail "contact backfill operation failed: $safe_error_code"
      fail "contact backfill operation failed"
    fi
  else
    if operator_output="$(
      compose "$current_image" 0 exec -T telegram-poll node \
        scripts/production/contact-backfill-operator.ts \
        "$backfill_action" "$backfill_run_id" 2>"$operator_error_file"
    )"; then
      :
    else
      safe_error_code="$(extract_contact_backfill_error "$operator_error_file")"
      [ -z "$safe_error_code" ] ||
        fail "contact backfill operation failed: $safe_error_code"
      fail "contact backfill operation failed"
    fi
  fi
  rm -f "$operator_error_file"
  validated_output="$(
    compose "$current_image" 0 exec -T telegram-poll node \
      scripts/production/contact-backfill-output-validator.ts \
      <<<"$operator_output" 2>/dev/null
  )" || fail "contact backfill operation failed"
  printf '%s\n' "$validated_output"
  exit 0
fi

candidate_image="$REGISTRY_IMAGE:sha-$sha"

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

image_supports_userbot() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'test -x /opt/iva-userbot-venv/bin/python && test -f /app/services/telegram-userbot/container_supervisor.py'
}

image_supports_routing_health() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'test -f /app/scripts/production/routing-health.ts'
}

image_supports_scheduler() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'test -f /app/scripts/reminder-scheduler.ts'
}

image_supports_container_workers() {
  docker run --rm --entrypoint /bin/sh "$1" -c \
    'test -f /app/scripts/container-runtime.ts && test -f /app/scripts/lib/container-worker-control.ts'
}

legacy_rollback_is_safe() {
  docker run --rm --read-only \
    -v "$RUNTIME_ROOT/data:/app/data:ro" \
    --entrypoint node "$1" -e '
      const fs = require("node:fs");
      const path = "/app/data/control/users.json";
      if (!fs.existsSync(path)) process.exit(0);
      const registry = JSON.parse(fs.readFileSync(path, "utf8"));
      process.exit(
        Array.isArray(registry.users) &&
        registry.users.every((user) => user?.status === "blocked") ? 0 : 1,
      );
    '
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

userbot_session_ok() {
  local container_id="$1"
  [ -f "$RUNTIME_ROOT/data/telegram-userbot.enabled" ] || return 0
  docker exec "$container_id" /bin/sh -c '
    set -eu
    token="$(cat /app/data/telegram-userbot.token)"
    case "$token" in
      ""|*[!A-Za-z0-9_-]*) exit 1 ;;
    esac
    [ "${#token}" -ge 40 ]
    printf '\''header = "Authorization: Bearer %s"\n'\'' "$token" |
      curl --config - --fail --silent --show-error --max-time 5 \
        http://127.0.0.1:8724/healthz >/dev/null
  '
}

runtime_ok() {
  local image="$1" allow_inert="$2" scheduler_required="$3" container_workers_required="$4"
  local container_id health poller_id poller_state userbot_id userbot_state scheduler_id scheduler_state
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
  if [ "$container_workers_required" = "1" ]; then
    docker exec "$poller_id" node scripts/container-runtime.ts status --require-pristine || return 1
  fi
  docker exec "$poller_id" node scripts/production/routing-health.ts || return 1
  userbot_id="$(compose "$image" "$allow_inert" ps -q telegram-userbot)" || return 1
  [ -n "$userbot_id" ] || return 1
  userbot_state="$(
    docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$userbot_id"
  )" || return 1
  [ "$userbot_state" = "running 0" ] || return 1
  userbot_session_ok "$userbot_id" || return 1
  if [ "$scheduler_required" = "1" ]; then
    scheduler_id="$(compose "$image" "$allow_inert" ps -q reminder-scheduler)" || return 1
    [ -n "$scheduler_id" ] || return 1
    scheduler_state="$(
      docker inspect --format '{{.State.Health.Status}} {{.RestartCount}}' "$scheduler_id"
    )" || return 1
    [ "$scheduler_state" = "healthy 0" ] || return 1
  fi
  curl --fail --silent --show-error --max-time 5 \
    "http://127.0.0.1:8723/eve/v1/health" >/dev/null || return 1
  telegram_ok
}

wait_healthy() {
  local image="$1" allow_inert="$2" scheduler_required="$3" container_workers_required="$4" attempt=1
  while [ "$attempt" -le "$HEALTH_ATTEMPTS" ]; do
    if runtime_ok "$image" "$allow_inert" "$scheduler_required" "$container_workers_required"; then
      return 0
    fi
    sleep "$HEALTH_DELAY"
    attempt=$((attempt + 1))
  done
  return 1
}

start_image() {
  local image="$1" allow_inert="$2" scheduler_required="$3" container_workers_required="$4"
  if [ "$scheduler_required" = "1" ]; then
    compose "$image" "$allow_inert" up -d --remove-orphans \
      iva telegram-poll telegram-userbot reminder-scheduler || return 1
  else
    compose "$image" "$allow_inert" rm -sf reminder-scheduler >/dev/null 2>&1 || true
    compose "$image" "$allow_inert" up -d --remove-orphans \
      iva telegram-poll telegram-userbot || return 1
  fi
  sleep "$POLLER_SETTLE_DELAY"
  wait_healthy "$image" "$allow_inert" "$scheduler_required" "$container_workers_required"
}

write_state() {
  local path="$1" value="$2" temporary
  temporary="$path.tmp.$$"
  printf '%s\n' "$value" >"$temporary" || return 1
  chmod 600 "$temporary" || return 1
  mv "$temporary" "$path" || return 1
}

previous_image=""
if [ -f "$CURRENT_IMAGE_FILE" ]; then
  previous_image="$(sed -n '1p' "$CURRENT_IMAGE_FILE")"
fi

# Stage release control files before touching the running services. The later
# same-directory renames are atomic, so copy/permission failures leave both the
# runtime and persisted release state on the previous version.
temporary_deploy=""
temporary_compose=""
promotion_backup_dir="$DEPLOY_DIR/promotion-backup.$$"
mkdir -p "$promotion_backup_dir" || fail "release control backup failed"
for control_file in \
  "$ACTIVE_DEPLOY_SCRIPT" \
  "$ACTIVE_COMPOSE_FILE" \
  "$CURRENT_IMAGE_FILE" \
  "$PREVIOUS_IMAGE_FILE"; do
  if [ -f "$control_file" ]; then
    cp -p "$control_file" "$promotion_backup_dir/$(basename "$control_file")" ||
      fail "release control backup failed"
  fi
done
if [ "$0" != "$ACTIVE_DEPLOY_SCRIPT" ]; then
  temporary_deploy="$ACTIVE_DEPLOY_SCRIPT.tmp.$$"
  cp "$0" "$temporary_deploy" || fail "release deploy script staging failed"
  chmod 700 "$temporary_deploy" || fail "release deploy script staging failed"
fi
if [ "$COMPOSE_FILE" != "$ACTIVE_COMPOSE_FILE" ]; then
  temporary_compose="$ACTIVE_COMPOSE_FILE.tmp.$$"
  cp "$COMPOSE_FILE" "$temporary_compose" || fail "release compose staging failed"
  chmod 600 "$temporary_compose" || fail "release compose staging failed"
fi

image_supports_userbot "$candidate_image" || fail "candidate image lacks the userbot runtime"
image_supports_routing_health "$candidate_image" || fail "candidate image lacks owner routing health support"
image_supports_scheduler "$candidate_image" || fail "candidate image lacks the reminder scheduler"
image_supports_container_workers "$candidate_image" || fail "candidate image lacks the container worker runtime"

owner_route_backup="$DEPLOY_DIR/legacy-owner-route.rollback.$$"
owner_route_existed=0
if [ -f "$LEGACY_OWNER_ROUTE_FILE" ]; then
  cp -p "$LEGACY_OWNER_ROUTE_FILE" "$owner_route_backup" ||
    fail "owner routing state backup failed"
  owner_route_existed=1
fi
cleanup_owner_route_backup() {
  rm -f "$owner_route_backup"
  [ -z "$temporary_deploy" ] || rm -f "$temporary_deploy"
  [ -z "$temporary_compose" ] || rm -f "$temporary_compose"
  rm -rf "$promotion_backup_dir"
}
trap cleanup_owner_route_backup EXIT

restore_owner_route() {
  if [ "$owner_route_existed" = "1" ]; then
    temporary_route="$LEGACY_OWNER_ROUTE_FILE.rollback.$$"
    cp -p "$owner_route_backup" "$temporary_route" || return 1
    mv "$temporary_route" "$LEGACY_OWNER_ROUTE_FILE" || return 1
  else
    rm -f "$LEGACY_OWNER_ROUTE_FILE" || return 1
  fi
}

restore_control_file() {
  local target="$1" backup="$promotion_backup_dir/$(basename "$1")" temporary
  if [ -f "$backup" ]; then
    temporary="$target.restore.$$"
    cp -p "$backup" "$temporary" || return 1
    mv "$temporary" "$target" || return 1
  else
    rm -f "$target" || return 1
  fi
}

restore_release_controls() {
  restore_control_file "$ACTIVE_DEPLOY_SCRIPT" || return 1
  restore_control_file "$ACTIVE_COMPOSE_FILE" || return 1
  restore_control_file "$CURRENT_IMAGE_FILE" || return 1
  restore_control_file "$PREVIOUS_IMAGE_FILE" || return 1
}

restore_runtime_after_promotion_failure() {
  restore_owner_route || return 1
  if [ "$previous_image" = "$candidate_image" ]; then
    return 0
  fi
  compose "$candidate_image" 0 stop telegram-poll >/dev/null 2>&1 || true
  if [ -z "$previous_image" ]; then
    compose "$candidate_image" 0 down >/dev/null 2>&1 || true
    return 0
  fi
  docker pull "$previous_image" >/dev/null 2>&1 || true
  local allow_inert=0 scheduler=0 container_workers=1
  if ! image_supports_userbot "$previous_image"; then
    allow_inert=1
  fi
  image_supports_routing_health "$previous_image" || return 1
  if image_supports_scheduler "$previous_image"; then
    scheduler=1
  fi
  if ! image_supports_container_workers "$previous_image"; then
    legacy_rollback_is_safe "$candidate_image" || return 1
    container_workers=0
    CONTAINER_WORKERS_ALLOW_LEGACY=1
  fi
  start_image "$previous_image" "$allow_inert" "$scheduler" "$container_workers"
}

if ! start_image "$candidate_image" 0 1 1; then
  printf 'deploy: candidate failed health checks; rolling back\n' >&2
  compose "$candidate_image" 0 stop telegram-poll >/dev/null 2>&1 || true
  restore_owner_route || fail "owner routing state restoration failed; polling remains stopped"
  if [ -n "$previous_image" ] && [ "$previous_image" != "$candidate_image" ]; then
    docker pull "$previous_image" >/dev/null 2>&1 || true
    rollback_allow_inert=0
    if ! image_supports_userbot "$previous_image"; then
      rollback_allow_inert=1
    fi
    if ! image_supports_routing_health "$previous_image"; then
      compose "$previous_image" "$rollback_allow_inert" up -d --remove-orphans \
        iva telegram-userbot >/dev/null 2>&1 || true
      fail "previous image lacks owner routing support; polling remains stopped"
    fi
    rollback_scheduler=0
    if image_supports_scheduler "$previous_image"; then
      rollback_scheduler=1
    fi
    rollback_container_workers=1
    if ! image_supports_container_workers "$previous_image"; then
      if ! legacy_rollback_is_safe "$candidate_image"; then
        fail "previous image lacks container worker support; polling remains stopped"
      fi
      rollback_container_workers=0
      CONTAINER_WORKERS_ALLOW_LEGACY=1
    fi
    if start_image "$previous_image" "$rollback_allow_inert" "$rollback_scheduler" "$rollback_container_workers"; then
      printf 'deploy: previous image restored\n' >&2
    else
      fail "candidate and rollback image are unhealthy"
    fi
  else
    compose "$candidate_image" 0 down >/dev/null 2>&1 || true
  fi
  exit 1
fi

promote_release() {
  if [ -n "$temporary_deploy" ]; then
    mv "$temporary_deploy" "$ACTIVE_DEPLOY_SCRIPT" || return 1
    temporary_deploy=""
  fi
  if [ -n "$temporary_compose" ]; then
    mv "$temporary_compose" "$ACTIVE_COMPOSE_FILE" || return 1
    temporary_compose=""
  fi
  if [ -n "$previous_image" ] && [ "$previous_image" != "$candidate_image" ]; then
    write_state "$PREVIOUS_IMAGE_FILE" "$previous_image" || return 1
  fi
  write_state "$CURRENT_IMAGE_FILE" "$candidate_image" || return 1
}

if ! promote_release; then
  restore_release_controls || fail "release promotion and control restoration failed; polling remains stopped"
  restore_runtime_after_promotion_failure ||
    fail "release promotion failed and previous runtime could not be restored"
  fail "release promotion failed; previous release restored"
fi

printf 'deploy: healthy release %s is active\n' "$sha"
