#!/bin/sh
#
# scripts/check-all.sh - the checks CI runs, side by side, before a push
#
#   scripts/check-all.sh            everything below
#   scripts/check-all.sh --quick    without the dashboard check and the updater check
#
# Each check's output is shown only when it fails. npm ci runs only when
# package-lock.json is newer than what is installed. The dashboard check runs
# where playwright-core is installed (npm install --no-save playwright-core),
# with Chrome, and is otherwise listed as skipped. check-upgrade.js reads the
# committed tree, so commit first.
#
cd "$(dirname "$0")/.." || exit 1

quick=0
[ "$1" = --quick ] && quick=1

if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "npm ci"
  npm ci --silent >/dev/null 2>&1 || { echo "npm ci failed"; exit 1; }
fi

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
names=""
start=$(date +%s)

run() {
  name=$1; shift
  names="$names $name"
  ( "$@" >"$out/$name.log" 2>&1; echo $? >"$out/$name.code" ) &
}

run tsc npx tsc
run es5 python3 scripts/check-es5.py
run module-calls python3 scripts/check-module-calls.py
run ui-ids python3 scripts/check-ui-ids.py
run strings python3 scripts/check-strings.py
run screensavers python3 scripts/check-screensavers.py
run drift python3 scripts/check-drift.py
run entity-stability python3 scripts/check-entity-stability.py
run entities python3 scripts/check-entities.py --stats test/fixtures/stats-b8-webos4.json
run shellcheck shellcheck server/deploy.sh server/tvwebctl server/50-tvweb.sh tvstats.sh scripts/check-all.sh scripts/tv.sh
run tests node test/run-all.js
if [ "$quick" = 0 ]; then
  run upgrade node scripts/check-upgrade.js
  if [ -d node_modules/playwright-core ]; then
    BROWSER_CHANNEL=${BROWSER_CHANNEL:-chrome}
    export BROWSER_CHANNEL
    run dashboards node scripts/check-dashboards.js
  else
    echo "dashboards: skipped (npm install --no-save playwright-core)"
  fi
fi
wait

failed=0
for name in $names; do
  if [ "$(cat "$out/$name.code")" = 0 ]; then
    echo "ok    $name"
  else
    echo "FAIL  $name"
    sed 's/^/      /' "$out/$name.log" | tail -40
    failed=$((failed + 1))
  fi
done
echo "$failed failed, in $(( $(date +%s) - start ))s"
[ "$failed" = 0 ]
