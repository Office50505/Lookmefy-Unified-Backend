#!/usr/bin/env bash
set -Eeuo pipefail

AWS_REGION=${AWS_REGION:-ap-south-1}
ASG_NAME=${ASG_NAME:-lookmefy-backend-asg}
TARGET_GROUP_NAME=${TARGET_GROUP_NAME:-fitlook-api}
PUBLIC_READY_URL=${PUBLIC_READY_URL:-https://api.lookmefy.in/api/ready}
LOCAL_READY_URL=${LOCAL_READY_URL:-http://127.0.0.1:5050/api/ready}
SSH_USER=${LOOKMEFY_SSH_USER:-ubuntu}
SSH_KEY=${LOOKMEFY_SSH_KEY:-"$HOME/Downloads/fitlook-backend-medium-key.pem"}
DEPLOY_LOG=${DEPLOY_LOG:-deployment/lookmefy-production-deployments.log}
REMOTE_DEPLOY=${REMOTE_DEPLOY:-/opt/lookmefy-deploy/deploy.sh}
REMOTE_READY_RETRIES=${REMOTE_READY_RETRIES:-30}
TARGET_HEALTH_RETRIES=${TARGET_HEALTH_RETRIES:-30}
TARGET_HEALTH_SLEEP=${TARGET_HEALTH_SLEEP:-10}
MIN_OTHER_HEALTHY_TARGETS=${MIN_OTHER_HEALTHY_TARGETS:-2}
SSH_OPTIONS=(
  -i "$SSH_KEY"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)

DRY_RUN=0
TARGET_SHA=""
TARGET_GROUP_ARN=""
DESIRED_CAPACITY=""
MIN_CAPACITY=""
MAX_CAPACITY=""
INITIAL_INSTANCE_SET=""
DEPLOYMENT_STARTED=0

INSTANCE_IDS=()
PUBLIC_IPS=()
PRIVATE_IPS=()
PRIVATE_DNS=()

usage() {
  cat <<'USAGE'
Usage: deployment/deploy-lookmefy-production.sh [--dry-run] [--help]

ASG-aware rolling production deployment for Lookmefy backend.

Environment overrides:
  AWS_REGION                      Default: ap-south-1
  ASG_NAME                        Default: lookmefy-backend-asg
  TARGET_GROUP_NAME               Default: fitlook-api
  LOOKMEFY_SSH_KEY                Default: ~/Downloads/fitlook-backend-medium-key.pem
  LOOKMEFY_SSH_USER               Default: ubuntu
  PUBLIC_READY_URL                Default: https://api.lookmefy.in/api/ready

Dry run resolves origin/main, discovers current ASG instances, validates public
readiness, performs SSH preflight, checks ALB target health, and prints rollout
order. It does not run remote deploy.sh or restart services.
USAGE
}

log() {
  printf '%s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  if [ "$DEPLOYMENT_STARTED" -eq 1 ]; then
    append_deployment_log "failure" "$*"
  fi
  exit 1
}

append_deployment_log() {
  local status=$1
  local detail=${2:-}
  local ids
  local timestamp

  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  ids=$(join_by "," "${INSTANCE_IDS[@]:-}")
  mkdir -p "$(dirname "$DEPLOY_LOG")"
  {
    printf 'timestamp=%s status=%s target_sha=%s instances=%s' "$timestamp" "$status" "${TARGET_SHA:-unknown}" "${ids:-none}"
    if [ -n "$detail" ]; then
      printf ' detail=%q' "$detail"
    fi
    printf '\n'
  } >> "$DEPLOY_LOG"
}

join_by() {
  local delimiter=$1
  shift || true
  local first=1
  local item

  for item in "$@"; do
    if [ "$first" -eq 1 ]; then
      printf '%s' "$item"
      first=0
    else
      printf '%s%s' "$delimiter" "$item"
    fi
  done
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command is unavailable: $1"
}

ssh_to() {
  local host=$1
  shift
  ssh "${SSH_OPTIONS[@]}" "$SSH_USER@$host" "$@"
}

run_aws() {
  aws --region "$AWS_REGION" "$@"
}

sorted_words() {
  tr '\t' '\n' | tr ' ' '\n' | sed '/^$/d' | sort
}

parse_ready_json() {
  local context=$1

  node -e '
    const fs = require("fs");
    const context = process.argv[1];
    const input = fs.readFileSync(0, "utf8");
    let data;
    try {
      data = JSON.parse(input);
    } catch (error) {
      console.error(`${context}: readiness response is not JSON: ${error.message}`);
      process.exit(1);
    }
    const checks = data.checks || {};
    const failures = [];
    if (data.ok !== true) failures.push("ok !== true");
    for (const key of ["mongo", "redis", "queue"]) {
      if (checks[key] !== "ready") failures.push(`checks.${key} !== ready`);
    }
    if (failures.length > 0) {
      console.error(`${context}: ${failures.join(", ")}`);
      process.exit(1);
    }
  ' "$context"
}

validate_ssh_key() {
  local mode
  local group_other

  [ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY"

  if stat -f '%Lp' "$SSH_KEY" >/dev/null 2>&1; then
    mode=$(stat -f '%Lp' "$SSH_KEY")
  else
    mode=$(stat -c '%a' "$SSH_KEY")
  fi

  group_other=$((10#$mode % 100))
  if [ "$group_other" -ne 0 ]; then
    die "SSH key permissions are too open ($mode). Use chmod 600 or chmod 400: $SSH_KEY"
  fi
}

ensure_clean_worktree() {
  git fetch origin main
  TARGET_SHA=$(git rev-parse 'origin/main^{commit}')

  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git status --porcelain)" ]; then
    die "Local working tree is not clean. Commit or stash changes before deploying origin/main."
  fi
}

resolve_target_group() {
  TARGET_GROUP_ARN=$(
    run_aws elbv2 describe-target-groups \
      --names "$TARGET_GROUP_NAME" \
      --query 'TargetGroups[0].TargetGroupArn' \
      --output text
  )

  [ -n "$TARGET_GROUP_ARN" ] && [ "$TARGET_GROUP_ARN" != "None" ] || die "Target group not found by name: $TARGET_GROUP_NAME"
}

load_asg_capacity() {
  local capacity

  capacity=$(
    run_aws autoscaling describe-auto-scaling-groups \
      --auto-scaling-group-names "$ASG_NAME" \
      --query 'AutoScalingGroups[0].[DesiredCapacity,MinSize,MaxSize]' \
      --output text
  )

  [ -n "$capacity" ] && [ "$capacity" != "None" ] || die "ASG not found: $ASG_NAME"
  read -r DESIRED_CAPACITY MIN_CAPACITY MAX_CAPACITY <<EOF_CAPACITY
$capacity
EOF_CAPACITY
  case "$DESIRED_CAPACITY" in
    ''|*[!0-9]*)
      die "ASG not found or desired capacity is unavailable: $ASG_NAME"
      ;;
  esac
}

current_asg_instance_set() {
  run_aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$ASG_NAME" \
    --query 'AutoScalingGroups[0].Instances[].InstanceId' \
    --output text | sorted_words | paste -sd ' ' -
}

record_initial_instance_set() {
  INITIAL_INSTANCE_SET=$(current_asg_instance_set)
  [ -n "$INITIAL_INSTANCE_SET" ] || die "ASG has no instances: $ASG_NAME"
}

discover_instances() {
  local instance_ids_text
  local id
  local details
  local found
  local row_id public_ip private_ip private_dns state

  instance_ids_text=$(
    run_aws autoscaling describe-auto-scaling-groups \
      --auto-scaling-group-names "$ASG_NAME" \
      --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService` && HealthStatus==`Healthy`].InstanceId' \
      --output text
  )

  while IFS= read -r id; do
    INSTANCE_IDS+=("$id")
  done < <(printf '%s\n' "$instance_ids_text" | sorted_words)

  [ "${#INSTANCE_IDS[@]}" -gt 0 ] || die "No InService/Healthy instances found in ASG: $ASG_NAME"

  if [ "${#INSTANCE_IDS[@]}" -lt "$DESIRED_CAPACITY" ]; then
    die "Discovered ${#INSTANCE_IDS[@]} healthy InService instance(s), below desired capacity $DESIRED_CAPACITY"
  fi

  for id in "${INSTANCE_IDS[@]}"; do
    details=$(
      run_aws ec2 describe-instances \
        --instance-ids "$id" \
        --query 'Reservations[0].Instances[0].[InstanceId,PublicIpAddress,PrivateIpAddress,PrivateDnsName,State.Name]' \
        --output text
    )
    read -r row_id public_ip private_ip private_dns state <<EOF_INSTANCE
$details
EOF_INSTANCE

    [ "$row_id" = "$id" ] || die "EC2 instance lookup failed for $id"
    [ "$state" = "running" ] || die "EC2 instance $id is not running; state=$state"
    [ -n "$public_ip" ] && [ "$public_ip" != "None" ] || die "InService instance $id has no public IP"

    PUBLIC_IPS+=("$public_ip")
    PRIVATE_IPS+=("${private_ip:-unknown}")
    PRIVATE_DNS+=("${private_dns:-unknown}")
  done

  found=$(join_by "," "${INSTANCE_IDS[@]}")
  log "Discovered ASG instances: $found"
}

assert_asg_membership_unchanged() {
  local current_set

  current_set=$(current_asg_instance_set)
  if [ "$current_set" != "$INITIAL_INSTANCE_SET" ]; then
    die "ASG membership changed during rollout. Initial=[$INITIAL_INSTANCE_SET] Current=[$current_set]. Rerun deployment."
  fi
}

verify_instance_ready_for_rollout() {
  local id=$1
  local state
  local lifecycle
  local health
  local ec2_state

  assert_asg_membership_unchanged

  state=$(
    run_aws autoscaling describe-auto-scaling-groups \
      --auto-scaling-group-names "$ASG_NAME" \
      --query "AutoScalingGroups[0].Instances[?InstanceId=='$id'].[LifecycleState,HealthStatus] | [0]" \
      --output text
  )
  read -r lifecycle health <<EOF_STATE
$state
EOF_STATE
  [ "$lifecycle" = "InService" ] && [ "$health" = "Healthy" ] || die "Instance $id is no longer InService/Healthy in ASG; state=$state"

  ec2_state=$(
    run_aws ec2 describe-instances \
      --instance-ids "$id" \
      --query 'Reservations[0].Instances[0].State.Name' \
      --output text
  )
  [ "$ec2_state" = "running" ] || die "Instance $id is no longer running; state=$ec2_state"
}

target_health_state() {
  local id=$1

  run_aws elbv2 describe-target-health \
    --target-group-arn "$TARGET_GROUP_ARN" \
    --targets "Id=$id" \
    --query 'TargetHealthDescriptions[0].TargetHealth.State' \
    --output text
}

healthy_target_count_excluding() {
  local excluded_id=$1
  local count=0
  local id
  local state

  for id in "${INSTANCE_IDS[@]}"; do
    [ "$id" != "$excluded_id" ] || continue
    state=$(target_health_state "$id")
    if [ "$state" = "healthy" ]; then
      count=$((count + 1))
    fi
  done

  printf '%s\n' "$count"
}

assert_target_group_has_enough_healthy_targets() {
  local healthy=0
  local id
  local state

  for id in "${INSTANCE_IDS[@]}"; do
    state=$(target_health_state "$id")
    if [ "$state" = "healthy" ]; then
      healthy=$((healthy + 1))
    fi
  done

  if [ "$healthy" -lt "$DESIRED_CAPACITY" ]; then
    die "Target group has $healthy healthy discovered ASG target(s), below desired capacity $DESIRED_CAPACITY"
  fi
}

assert_minimum_other_healthy_targets() {
  local id=$1
  local count

  count=$(healthy_target_count_excluding "$id")
  if [ "$count" -lt "$MIN_OTHER_HEALTHY_TARGETS" ]; then
    die "Refusing to deploy $id: only $count other healthy target(s), minimum required is $MIN_OTHER_HEALTHY_TARGETS"
  fi
}

wait_for_target_healthy() {
  local id=$1
  local attempt
  local state

  for attempt in $(seq 1 "$TARGET_HEALTH_RETRIES"); do
    state=$(target_health_state "$id")
    log "ALB target health for $id: $state (attempt $attempt/$TARGET_HEALTH_RETRIES)"
    if [ "$state" = "healthy" ]; then
      return 0
    fi
    sleep "$TARGET_HEALTH_SLEEP"
  done

  die "Target $id did not become healthy within bounded wait"
}

ssh_preflight_all() {
  local index
  local id
  local ip

  log "Running SSH preflight on every discovered instance..."
  for index in "${!INSTANCE_IDS[@]}"; do
    id=${INSTANCE_IDS[$index]}
    ip=${PUBLIC_IPS[$index]}
    log "SSH preflight: $id ($ip)"
    ssh_to "$ip" hostname >/dev/null || die "SSH preflight failed for $id ($ip)"
  done
}

public_preflight() {
  log "Checking public readiness: $PUBLIC_READY_URL"
  curl -fsS "$PUBLIC_READY_URL" | parse_ready_json "public readiness"
}

remote_verify_instance() {
  local id=$1
  local ip=$2

  ssh_to "$ip" "TARGET_SHA='$TARGET_SHA' LOCAL_READY_URL='$LOCAL_READY_URL' REMOTE_READY_RETRIES='$REMOTE_READY_RETRIES' bash -s" <<'REMOTE_VERIFY'
set -Eeuo pipefail

current_sha=$(git -C /opt/lookmefy rev-parse HEAD)
[ "$current_sha" = "$TARGET_SHA" ] || {
  echo "remote HEAD mismatch: expected $TARGET_SHA got $current_sha" >&2
  exit 1
}

systemctl is-active --quiet lookmefy-backend.service
systemctl is-active --quiet lookmefy-worker.service

for attempt in $(seq 1 "$REMOTE_READY_RETRIES"); do
  if body=$(curl -fsS "$LOCAL_READY_URL"); then
    if printf '%s' "$body" | node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      const checks = data.checks || {};
      if (data.ok !== true || checks.mongo !== "ready" || checks.redis !== "ready" || checks.queue !== "ready") {
        process.exit(1);
      }
    '; then
      exit 0
    fi
  fi
  sleep 2
done

echo "remote readiness failed after ${REMOTE_READY_RETRIES} attempts" >&2
exit 1
REMOTE_VERIFY
  log "Remote verification passed: $id"
}

deploy_one_instance() {
  local index=$1
  local id=${INSTANCE_IDS[$index]}
  local ip=${PUBLIC_IPS[$index]}
  local private_ip=${PRIVATE_IPS[$index]}
  local private_dns=${PRIVATE_DNS[$index]}

  verify_instance_ready_for_rollout "$id"
  assert_minimum_other_healthy_targets "$id"

  log "----------------------------------------"
  log "Deploying instance_id=$id"
  log "public_ip=$ip"
  log "private_ip=$private_ip"
  log "private_dns=$private_dns"
  log "target_sha=$TARGET_SHA"
  log "----------------------------------------"

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN: would run $REMOTE_DEPLOY '$TARGET_SHA' on $id"
    return 0
  fi

  if ! ssh_to "$ip" "$REMOTE_DEPLOY '$TARGET_SHA'"; then
    local untouched=()
    local next
    for next in $(seq $((index + 1)) $((${#INSTANCE_IDS[@]} - 1))); do
      untouched+=("${INSTANCE_IDS[$next]}")
    done
    log "Deployment failed on instance: $id"
    log "Untouched instances: $(join_by "," "${untouched[@]:-}")"
    die "Remote deploy failed for $id. Server-side deploy.sh is responsible for local rollback; rolling deployment stopped."
  fi

  remote_verify_instance "$id" "$ip"
  wait_for_target_healthy "$id"
}

final_validation() {
  local index
  local id
  local ip

  log "Running final validation against initial ASG instance set..."
  assert_asg_membership_unchanged

  for index in "${!INSTANCE_IDS[@]}"; do
    id=${INSTANCE_IDS[$index]}
    ip=${PUBLIC_IPS[$index]}
    verify_instance_ready_for_rollout "$id"
    wait_for_target_healthy "$id"
    if [ "$DRY_RUN" -eq 0 ]; then
      remote_verify_instance "$id" "$ip"
    fi
  done

  public_preflight
  curl -fsS "$PUBLIC_READY_URL" | parse_ready_json "public readiness repeat 1"
  curl -fsS "$PUBLIC_READY_URL" | parse_ready_json "public readiness repeat 2"
}

print_rollout_order() {
  local index

  log "Rollout order:"
  for index in "${!INSTANCE_IDS[@]}"; do
    log "  $((index + 1)). ${INSTANCE_IDS[$index]} public=${PUBLIC_IPS[$index]} private=${PRIVATE_IPS[$index]} dns=${PRIVATE_DNS[$index]}"
  done
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

main() {
  local index

  parse_args "$@"

  log "========================================"
  log " LOOKMEFY ASG ROLLING PRODUCTION DEPLOY"
  log "========================================"
  log "region=$AWS_REGION"
  log "asg=$ASG_NAME"
  log "target_group=$TARGET_GROUP_NAME"
  [ "$DRY_RUN" -eq 0 ] || log "mode=dry-run"

  require_command aws
  require_command git
  require_command ssh
  require_command curl
  require_command node

  validate_ssh_key
  ensure_clean_worktree
  resolve_target_group
  load_asg_capacity
  record_initial_instance_set
  discover_instances
  assert_target_group_has_enough_healthy_targets
  ssh_preflight_all
  public_preflight
  print_rollout_order

  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY RUN COMPLETE"
    log "target_sha=$TARGET_SHA"
    log "instances=${#INSTANCE_IDS[@]}"
    log "public_ready=ok"
    return 0
  fi

  DEPLOYMENT_STARTED=1
  for index in "${!INSTANCE_IDS[@]}"; do
    deploy_one_instance "$index"
  done

  final_validation
  append_deployment_log "success" "rolling deployment complete"

  log "ROLLING DEPLOYMENT COMPLETE"
  log "target_sha=$TARGET_SHA"
  log "instances=${#INSTANCE_IDS[@]}"
  log "public_ready=ok"
}

main "$@"
