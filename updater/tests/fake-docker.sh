#!/usr/bin/env bash
# Stand-in for the docker CLI used by run-tests.sh. It models just enough of a
# compose stack (two services, a registry, local tags, running containers) for
# picpeak-updater.sh to walk every path. State lives in $FAKE_STATE:
#
#   images/<id>/version|label|migrations|local   per-image facts
#   registry/<svc>     image id the channel tag points at upstream
#   tags/<svc>         image id the local tag points at
#   running/<svc>      image id the running container uses
#   pull_failures      number of pulls that fail before one succeeds
#   broken             image ids that never become healthy, one per line
#   config_files       value of the compose config_files label (optional)
#   fail_label_read    when present, reading an image label fails
#   calls              every invocation, appended
set -euo pipefail

S="$FAKE_STATE"
echo "$*" >> "$S/calls"

ref_of() { echo "ghcr.io/picpeak/picpeak/$1:stable"; }
svc_of_ref() { local r="${1##*/}"; echo "${r%%:*}"; }
services() { ls "$S/running"; }

if [[ "$1" == "compose" ]]; then
    # Skip the global options (--project-directory DIR -p NAME [-f FILE]...)
    shift
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project-directory|-p|-f) shift 2 ;;
            *) break ;;
        esac
    done
    case "$1" in
        config)
            [[ -f "$S/build_context" ]] && printf 'services:\n  backend:\n    build:\n      context: ./backend\n'
            exit 0 ;;
        pull)
            shift; [[ "${1:-}" == "--quiet" ]] && shift
            n=$(cat "$S/pull_failures" 2>/dev/null || echo 0)
            if (( n > 0 )); then
                echo $(( n - 1 )) > "$S/pull_failures"
                echo "Error response from daemon: toomanyrequests: retry later" >&2
                exit 1
            fi
            for svc in "$@"; do cp "$S/registry/$svc" "$S/tags/$svc"; done
            exit 0 ;;
        up)
            shift
            # Real compose reports progress on stderr even when it succeeds.
            echo " Container picpeak-backend  Recreated" >&2
            echo " Container picpeak-backend  Started" >&2
            for a in "$@"; do
                [[ "$a" == -* ]] && continue
                cp "$S/tags/$a" "$S/running/$a"
            done
            exit 0 ;;
        ps)
            echo "c-${3:-$2}"; exit 0 ;;
    esac
    echo "fake compose: unhandled $*" >&2; exit 99
fi

case "$1" in
    ps)
        if [[ "$*" == *"com.docker.compose.service=backend"* ]]; then echo "c-backend"
        elif [[ "$*" == *"status=running"* ]]; then for s in $(services); do echo "c-$s"; done
        fi
        exit 0 ;;
    inspect)
        fmt="$3"; cid="$4"; svc="${cid#c-}"
        case "$fmt" in
            *com.docker.compose.project\"*) echo "picpeak" ;;
            *config_files*) cat "$S/config_files" 2>/dev/null || echo "<no value>" ;;
            *Config.Image*) printf '%s\t%s\t%s\n' "$svc" "$(ref_of "$svc")" "$(cat "$S/running/$svc")" ;;
            *State.Status*) echo running ;;
            *State.Health*)
                id=$(cat "$S/running/$svc")
                if grep -qx "$id" "$S/broken" 2>/dev/null; then echo unhealthy; else echo healthy; fi ;;
            *) echo "fake inspect: $fmt" >&2; exit 99 ;;
        esac
        exit 0 ;;
    image)
        fmt="$4"; target="$5"
        if [[ "$target" == ghcr.io/* ]]; then
            f="$S/tags/$(svc_of_ref "$target")"
            [[ -f "$f" ]] || exit 1
            target=$(cat "$f")
        fi
        case "$fmt" in
            *RepoDigests*) [[ -f "$S/images/$target/local" ]] && echo 0 || echo 1 ;;
            *auto-from*)
                [[ -f "$S/fail_label_read" ]] && { echo "Error: daemon unreachable" >&2; exit 1; }
                cat "$S/images/$target/label" 2>/dev/null || echo "<no value>" ;;
            *.Id*) echo "$target" ;;
        esac
        exit 0 ;;
    tag)
        echo "$2" > "$S/tags/$(svc_of_ref "$3")"; exit 0 ;;
    create)
        echo "tmp-$2"; exit 0 ;;
    cp)
        id="${2#tmp-}"; id="${id%%:*}"; path="${2#*:}"
        d=$(mktemp -d)
        if [[ "$path" == /app/package.json ]]; then
            printf '{\n  "name": "picpeak-backend",\n  "version": "%s",\n' "$(cat "$S/images/$id/version")" > "$d/package.json"
            tar -cf - -C "$d" package.json
        else
            mkdir -p "$d/migrations/core"
            while read -r m; do [[ -n "$m" ]] && touch "$d/migrations/core/$m"; done < "$S/images/$id/migrations"
            tar -cf - -C "$d" migrations
        fi
        rm -rf "$d"; exit 0 ;;
    rm) exit 0 ;;
esac
echo "fake docker: unhandled $*" >&2
exit 99
