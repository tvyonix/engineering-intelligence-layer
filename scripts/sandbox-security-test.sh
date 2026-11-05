#!/usr/bin/env bash
# Sandbox security test (task 3.2) — executes the plan in
# docs/sandbox-security-test-plan.md against a hard-configured container.
# Prints PASS/FAIL per test and an overall verdict.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-node:22-alpine}"
WORKSPACE="$(mktemp -d /tmp/eil-sandbox-ws-XXXXXX)"
EVIDENCE="$(mktemp -d /tmp/eil-sandbox-ev-XXXXXX)"

pass=0; fail=0; failed_ids=()
RC=0

note() { echo "$@"; }

# run_in_container '<sh script>' — sets RC to the container exit code.
run_in_container() {
  docker run --rm \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only --tmpfs /tmp:rw,size=64m \
    --pids-limit 64 --memory 256m --cpus 1 \
    --user 1000:1000 \
    -v "$WORKSPACE:/workspace:rw" \
    --network none \
    -e HOME=/tmp \
    "$IMAGE" sh -c "$1" >/dev/null 2>&1
  RC=$?
}

# check <ID> <description> <expect: pass|fail> — evaluates RC.
check() {
  local id="$1" desc="$2" expect="$3"
  if [ "$expect" = "pass" ]; then
    if [ "$RC" -eq 0 ]; then note "  PASS  $id $desc"; pass=$((pass+1));
    else note "  FAIL  $id $desc (exit $RC, expected success)"; fail=$((fail+1)); failed_ids+=("$id"); fi
  else
    if [ "$RC" -ne 0 ]; then note "  PASS  $id $desc (correctly denied, exit $RC)"; pass=$((pass+1));
    else note "  FAIL  $id $desc (command unexpectedly succeeded)"; fail=$((fail+1)); failed_ids+=("$id"); fi
  fi
}

command -v docker >/dev/null || { echo "docker not available"; exit 2; }
docker ps >/dev/null 2>&1 || { echo "docker daemon not running"; exit 2; }
echo "fixture content" > "$WORKSPACE/seed.txt"
docker pull -q "$IMAGE" >/dev/null 2>&1 || { echo "cannot pull image $IMAGE"; exit 2; }

note "=== Sandbox security test — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
note "image: $IMAGE; workspace: $WORKSPACE"

note "--- T1 file isolation ---"
run_in_container 'ls /Users >/dev/null 2>&1';                        check T1.1 "host home dir not visible"        fail
run_in_container 'ls /root/.aws >/dev/null 2>&1';                    check T1.2 "host secret dirs not visible"     fail
run_in_container 'touch /etc/evil';                                  check T1.3 "write outside /workspace denied"  fail
run_in_container 'touch /workspace/ok.txt /tmp/ok.txt';              check T1.4 "write in workspace and /tmp ok"   pass
run_in_container "awk '{print \$2}' /proc/self/mounts | grep -E '^/(Users|Volumes|private)' >/dev/null 2>&1"; check T1.5 "no host bind mounts beyond /workspace" fail

note "--- T2 secrets ---"
run_in_container "env | grep -Ei '(token|secret|api_?key|aws|gh_)' >/dev/null 2>&1"; check T2.1 "no ambient env tokens" fail
run_in_container 'cat /root/.ssh/id_rsa /root/.aws/credentials >/dev/null 2>&1';     check T2.2 "ssh/aws keys unreachable" fail
image_env=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" 2>/dev/null | grep -Ei '(token|secret|api_?key|aws)' | head -1)
if [ -z "$image_env" ]; then note "  PASS  T2.3 image env carries no secrets"; pass=$((pass+1));
else note "  FAIL  T2.3 image env contains secret-like vars: $image_env"; fail=$((fail+1)); failed_ids+=("T2.3"); fi

note "--- T3 network (deny by default) ---"
run_in_container 'wget -T 3 -q -O /dev/null http://example.com';     check T3.1 "no outbound http"                 fail
run_in_container 'nslookup example.com >/dev/null 2>&1';             check T3.2 "no dns resolution"                fail

note "--- T4 processes ---"
ps_out=$(docker run --rm --pids-limit 64 --cap-drop ALL --user 1000:1000 --network none -e HOME=/tmp "$IMAGE" sh -c 'ps -o args= 2>/dev/null || ps aux 2>/dev/null' 2>/dev/null | grep -vE '(ps |ps$|sh)' | head -5)
if [ -z "$ps_out" ]; then note "  PASS  T4.1 only container processes visible"; pass=$((pass+1));
else note "  FAIL  T4.1 unexpected processes: $ps_out"; fail=$((fail+1)); failed_ids+=("T4.1"); fi
run_in_container 'ls /proc/1 >/dev/null 2>&1';                       check T4.2 "pid1 namespace isolated"          pass
run_in_container 'i=0; while [ $i -lt 80 ]; do sleep 30 & i=$((i+1)); done; wait' >/dev/null 2>&1
check T4.3 "pids-limit enforced"                                     fail

note "--- T5 escape scenarios ---"
run_in_container 'ln -s / /workspace/esc; ls /workspace/esc/Users >/dev/null 2>&1';  check T5.1 "symlink to / sees container rootfs, not host" fail
run_in_container 'ls /proc/1/root/Users >/dev/null 2>&1';                            check T5.2 "/proc/1/root is container rootfs"             fail
run_in_container 'ls /var/run/docker.sock >/dev/null 2>&1';                          check T5.3 "docker.sock not mounted"                      fail
run_in_container 'mount -t tmpfs none /mnt';                                         check T5.4 "mount attempt denied"                         fail
run_in_container 'su nobody -c id >/dev/null 2>&1';                                  check T5.5 "privilege escalation denied"                  fail

note "--- T6 resource limits ---"
docker run --rm --cap-drop ALL --memory 256m --memory-swap 256m --user 1000:1000 --network none -e HOME=/tmp "$IMAGE" node -e "const a=Buffer.alloc(400*1024*1024,1); setTimeout(()=>{},3000)" >/dev/null 2>&1
RC=$?
check T6.1 "memory limit enforced (256m, swap off)" fail
note "  INFO  T6.2 cpu limit set via --cpus 1 (informational)"

note "--- T7 EIL check inside the container ---"
# Prepare a git fixture inside the workspace so check has a repo to read.
git -C "$WORKSPACE" init -q -b main
git -C "$WORKSPACE" config user.email t@t
git -C "$WORKSPACE" config user.name t
BASE_SHA=$(git -C "$WORKSPACE" rev-parse --quiet --verify HEAD 2>/dev/null || true)
cat > "$WORKSPACE/task.yaml" <<EOF
version: 1
id: sandbox-self-check
baseCommit: "${BASE_SHA:-HEAD}"
description: "Sandbox T7"
scope:
  allow:
    - "**"
  protect: []
acceptance:
  - id: u
    description: "x"
policy:
  maxAttempts: 1
  noNewDependencies: false
EOF
cat > "$WORKSPACE/policy.yaml" <<'EOF'
version: 1
quality:
  required:
    - "path-scope"
    - "secrets-scan"
EOF
git -C "$WORKSPACE" add -A
git -C "$WORKSPACE" commit -q -m "fixture" --allow-empty
BASE_SHA=$(git -C "$WORKSPACE" rev-parse HEAD)
T7_out=$(docker run --rm \
  --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,size=64m \
  --pids-limit 256 --memory 512m --cpus 1 \
  --user 1000:1000 --network none -e HOME=/tmp \
  -v "$REPO_ROOT:/eil:ro" \
  -v "$REPO_ROOT/node_modules:/eil/node_modules:ro" \
  -v "$WORKSPACE:/workspace:rw" \
  -v "$EVIDENCE:/evidence:rw" \
  "$IMAGE" sh -c "node /eil/dist/apps/cli/main.js check --repo /workspace --task /workspace/task.yaml --policy /workspace/policy.yaml --base $BASE_SHA --out /evidence --json" 2>&1)
if echo "$T7_out" | grep -q '"taskId"'; then note "  PASS  T7.1 eil check runs in container (JSON verdict emitted)"; pass=$((pass+1));
else note "  FAIL  T7.1 eil check in container did not produce a verdict: ${T7_out:0:200}"; fail=$((fail+1)); failed_ids+=("T7.1"); fi
ws_dirty=$(git -C "$WORKSPACE" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "${ws_dirty:-0}" = "0" ]; then note "  PASS  T7.2 mounted workspace unchanged by check"; pass=$((pass+1));
else note "  FAIL  T7.2 workspace modified by check ($ws_dirty entries)"; fail=$((fail+1)); failed_ids+=("T7.2"); fi
ev_files=$(ls "$EVIDENCE" 2>/dev/null | wc -l | tr -d ' ')
if [ "${ev_files:-0}" -ge 3 ]; then note "  PASS  T7.3 evidence bundle written to the separate rw mount"; pass=$((pass+1));
else note "  FAIL  T7.3 evidence not written ($ev_files files)"; fail=$((fail+1)); failed_ids+=("T7.3"); fi

note "=== Verdict: PASS=$pass FAIL=$fail ==="
if [ "$fail" -gt 0 ]; then
  note "SANDBOX NOT APPROVED. Failed tests: ${failed_ids[*]}"
  note "Execution of repository content stays forbidden (check-only remains available)."
  exit 1
fi
note "SANDBOX ISOLATION TESTS PASSED. Final sign-off: human/Tier-1 review (task 1.7)."
rm -rf "$WORKSPACE" "$EVIDENCE" 2>/dev/null || true
exit 0
