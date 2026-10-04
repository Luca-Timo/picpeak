#!/usr/bin/env bash
# Tests for updater/picpeak-updater.sh. Runs the real script against
# fake-docker.sh, so no Docker daemon is needed: `bash updater/tests/run-tests.sh`.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATER="$HERE/../picpeak-updater.sh"
FAILS=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); echo "  ok   $1"; }
fail() {
    FAILS=$((FAILS + 1))
    echo "  FAIL $1"
    if [[ -n "${2:-}" ]]; then echo "       $2"; fi
}

expect_eq() {
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "expected '$3', got '$2'"; fi
}

status_field() {
    sed -n "s/^  \"$1\": \"\{0,1\}\([^\"]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$PROJECT/update/status/status.json"
}

################################################################################
# Pure helpers (sourced)
################################################################################

echo "version_cmp / json_value"
# shellcheck source=../picpeak-updater.sh
source "$UPDATER"
set +e
expect_eq "newer minor"            "$(version_cmp 3.160.0 3.159.4)" 1
expect_eq "older patch"            "$(version_cmp 3.159.3 3.159.4)" -1
expect_eq "equal"                  "$(version_cmp 3.159.4 3.159.4)" 0
expect_eq "stable above its beta"  "$(version_cmp 3.160.0 3.160.0-beta.3)" 1
expect_eq "beta below its stable"  "$(version_cmp 3.160.0-beta.3 3.160.0)" -1
expect_eq "beta order"             "$(version_cmp 3.160.0-beta.10 3.160.0-beta.9)" 1
expect_eq "numeric not lexical"    "$(version_cmp 3.10.0 3.9.0)" 1
expect_eq "v prefix accepted"      "$(version_cmp v3.1.0 3.1.0)" 0
version_cmp 3.1 3.1.0 >/dev/null; expect_eq "unparsable fails closed" "$?" 1
version_cmp 3.1.0-rc.1 3.1.0 >/dev/null; expect_eq "unknown prerelease fails closed" "$?" 1
expect_eq "json escapes quotes"    "$(json_value 'say "hi"')" '"say \"hi\""'
expect_eq "json escapes newline"   "$(json_value $'a\nb')" '"a\nb"'
expect_eq "json empty is null"     "$(json_value '')" 'null'

################################################################################
# Full runs against the fake docker
################################################################################

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin"
ln -s "$HERE/fake-docker.sh" "$ROOT/bin/docker"
printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/sleep"
chmod +x "$ROOT/bin/sleep" "$HERE/fake-docker.sh"
# macOS has no flock; CI and every Linux host do.
if ! command -v flock >/dev/null 2>&1; then
    printf '#!/bin/sh\nexit 0\n' > "$ROOT/bin/flock"
    chmod +x "$ROOT/bin/flock"
fi

# new_image ID VERSION [MIGRATIONS...]
new_image() {
    local id="$1" version="$2"; shift 2
    mkdir -p "$FAKE_STATE/images/$id"
    echo "$version" > "$FAKE_STATE/images/$id/version"
    printf '%s\n' "$@" > "$FAKE_STATE/images/$id/migrations"
}

# scenario NAME: a stack running backend "old" (3.159.0) + frontend "fe-old",
# with the registry already serving backend "new" (3.160.0) + frontend "fe-new".
scenario() {
    echo
    echo "$1"
    PROJECT="$ROOT/$(echo "$1" | tr -c 'a-z0-9' '-')"
    FAKE_STATE="$PROJECT.state"
    export FAKE_STATE
    mkdir -p "$PROJECT/update/request" "$FAKE_STATE"/{images,registry,tags,running}
    new_image old 3.159.0 001_a.js 002_b.js
    new_image new 3.160.0 001_a.js 002_b.js
    new_image fe-old 3.159.0
    new_image fe-new 3.160.0
    echo old > "$FAKE_STATE/running/backend";  echo old > "$FAKE_STATE/tags/backend";  echo new > "$FAKE_STATE/registry/backend"
    echo fe-old > "$FAKE_STATE/running/frontend"; echo fe-old > "$FAKE_STATE/tags/frontend"; echo fe-new > "$FAKE_STATE/registry/frontend"
    touch "$PROJECT/update/request/update-requested"
}

run_updater() {
    PATH="$ROOT/bin:$PATH" \
    PICPEAK_PROJECT_DIR="$PROJECT" \
    PICPEAK_UPDATE_DIR="$PROJECT/update" \
    PICPEAK_UPDATER_HEALTH_TIMEOUT=1 \
    PICPEAK_UPDATER_PULL_ATTEMPTS=3 \
        bash "$UPDATER" "${1:-run}" 2>"$PROJECT.log"
}

running() { cat "$FAKE_STATE/running/$1"; }
tagged() { cat "$FAKE_STATE/tags/$1"; }

scenario "update succeeds"
run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "from" "$(status_field from_version)" 3.159.0
expect_eq "to" "$(status_field to_version)" 3.160.0
expect_eq "backend runs new" "$(running backend)" new
expect_eq "frontend runs new" "$(running frontend)" fe-new
[[ ! -e "$PROJECT/update/request/update-requested" ]] && pass "request consumed" || fail "request consumed"
expect_eq "contract" "$(sed -n 's/^  "contract": \([0-9]*\),$/\1/p' "$PROJECT/update/status/status.json")" 1

scenario "no request does nothing"
rm "$PROJECT/update/request/update-requested"
run_updater
expect_eq "state" "$(status_field state)" idle
expect_eq "backend untouched" "$(running backend)" old

scenario "already up to date"
echo old > "$FAKE_STATE/registry/backend"; echo fe-old > "$FAKE_STATE/registry/frontend"
run_updater
expect_eq "state" "$(status_field state)" up_to_date
grep -q '^compose.* up ' "$FAKE_STATE/calls" && fail "no recreate" || pass "no recreate"

scenario "downgrade refused"
new_image new 3.158.0
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" downgrade
expect_eq "backend untouched" "$(running backend)" old
expect_eq "old tag restored" "$(tagged backend)" old
expect_eq "frontend tag restored" "$(tagged frontend)" fe-old

scenario "manual-only release refused"
echo 3.160.0 > "$FAKE_STATE/images/new/label"
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" manual_required
expect_eq "backend untouched" "$(running backend)" old
expect_eq "old tag restored" "$(tagged backend)" old

scenario "auto-from floor at or below running version allows the update"
echo 3.159.0 > "$FAKE_STATE/images/new/label"
run_updater
expect_eq "state" "$(status_field state)" succeeded

scenario "source build refused before pulling"
touch "$FAKE_STATE/images/old/local"
run_updater
expect_eq "state" "$(status_field state)" refused
expect_eq "reason" "$(status_field reason)" source_build
grep -q ' pull ' "$FAKE_STATE/calls" && fail "nothing pulled" || pass "nothing pulled"

scenario "build context in compose refused"
touch "$FAKE_STATE/build_context"
run_updater
expect_eq "reason" "$(status_field reason)" source_build

scenario "pull retried until it succeeds"
echo 2 > "$FAKE_STATE/pull_failures"
run_updater
expect_eq "state" "$(status_field state)" succeeded
expect_eq "three pull attempts" "$(grep -c ' pull ' "$FAKE_STATE/calls")" 3

scenario "pull fails on every attempt"
echo 9 > "$FAKE_STATE/pull_failures"
run_updater
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" pull_failed
expect_eq "backend untouched" "$(running backend)" old
grep -q 'toomanyrequests' "$PROJECT/update/status/status.json" && pass "real error reported" || fail "real error reported"

scenario "unhealthy without migrations rolls back"
echo new > "$FAKE_STATE/broken"
run_updater
expect_eq "state" "$(status_field state)" rolled_back
expect_eq "backend back on old" "$(running backend)" old
expect_eq "frontend back on old" "$(running frontend)" fe-old
expect_eq "old tag restored" "$(tagged backend)" old

scenario "unhealthy with new migrations stops without rollback"
new_image new 3.160.0 001_a.js 002_b.js 003_c.js
echo new > "$FAKE_STATE/broken"
run_updater
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" migrations_may_have_run
expect_eq "backend left on new" "$(running backend)" new

scenario "compose files come from the running stack"
echo "$PROJECT/docker-compose.production.yml,$PROJECT/docker-compose.override.yml" > "$FAKE_STATE/config_files"
run_updater
expect_eq "state" "$(status_field state)" succeeded
grep -q -- "-f $PROJECT/docker-compose.production.yml -f $PROJECT/docker-compose.override.yml up" "$FAKE_STATE/calls" \
    && pass "up uses both files" || fail "up uses both files"

scenario "unexpected docker failure mid-run is reported, not left running"
touch "$FAKE_STATE/fail_label_read"
run_updater
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" internal_error
expect_eq "step recorded" "$(status_field step)" verify

scenario "a second updater cannot claim the same request"
mkdir -p "$PROJECT/update/status"
exec 8>"$PROJECT/update/status/.lock"
if command -v flock >/dev/null 2>&1 && [[ "$(command -v flock)" != "$ROOT/bin/flock" ]]; then
    flock -n 8
    run_updater
    expect_eq "lock holder blocks the run" "$(running backend)" old
    [[ -e "$PROJECT/update/request/update-requested" ]] && pass "request left for the holder" || fail "request left for the holder"
    flock -u 8
else
    echo "  skip (no flock on this host)"
fi
exec 8>&-

scenario "request dir is created when missing"
rm -rf "$PROJECT/update/request"
run_updater init
[[ -d "$PROJECT/update/request" ]] && pass "request dir exists" || fail "request dir exists"

scenario "interrupted run is reported"
mkdir -p "$PROJECT/update/status"
printf '{\n  "state": "running",\n  "from_version": "3.159.0",\n  "started_at": "2026-10-03T10:00:00Z",\n}\n' \
    > "$PROJECT/update/status/status.json"
rm "$PROJECT/update/request/update-requested"
run_updater init
expect_eq "state" "$(status_field state)" failed
expect_eq "reason" "$(status_field reason)" interrupted
expect_eq "from kept" "$(status_field from_version)" 3.159.0

scenario "planted symlink as request is removed, not followed"
rm "$PROJECT/update/request/update-requested"
echo keep > "$PROJECT.target"
ln -s "$PROJECT.target" "$PROJECT/update/request/update-requested"
run_updater
expect_eq "target intact" "$(cat "$PROJECT.target")" keep
expect_eq "state" "$(status_field state)" succeeded
expect_eq "no claimed leftovers" "$(ls -A "$PROJECT/update/request")" ""

echo
echo "$PASSES passed, $FAILS failed"
(( FAILS == 0 ))
