#!/bin/sh
# scripts/ci-heartbeat.sh <name> - posts what run-all is running to GitHub
#
# Now and then a unit-test job's runner stops answering: the job is cancelled
# at 10 minutes and its log is lost, so nothing says which suites were running.
# This keeps a check run on the commit, created finished ("neutral") so it never
# shows as pending, and puts run-all's status line (RUN_ALL_STATUS, written at
# each suite's start and finish and every 5 s) in it, at most every 10 s and
# only when it has changed. The last update stays on GitHub when the runner
# goes. Every 10 s keeps a run to about 35 calls across its six jobs, well
# inside the workflow token's 1,000 an hour, which the rerun workflow shares.
#
# Needs GH_TOKEN with checks: write, HEAD_SHA, GITHUB_REPOSITORY, RUN_ALL_STATUS.
# Without them, as on a fork's pull request, it posts nothing and exits.
name=$1
[ -n "$GH_TOKEN" ] && [ -n "$HEAD_SHA" ] && [ -n "$RUN_ALL_STATUS" ] || exit 0
job_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/${GITHUB_RUN_ATTEMPT:-1}"
id=$(gh api "repos/$GITHUB_REPOSITORY/check-runs" \
  -f name="Test heartbeat ($name)" -f head_sha="$HEAD_SHA" \
  -f status=completed -f conclusion=neutral \
  -f "output[title]=starting" -f "output[summary]=Run: $job_url" \
  -q .id 2>/dev/null) || exit 0
[ -n "$id" ] || exit 0
last=
while sleep 10; do
  line=$(cat "$RUN_ALL_STATUS" 2>/dev/null) || continue
  [ -n "$line" ] && [ "$line" != "$last" ] || continue
  last=$line
  # The title shows on the PR's checks list; the summary keeps the whole line.
  title=$(printf '%s' "$line" | cut -c1-70)
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/check-runs/$id" \
    -f "output[title]=$title" -f "output[summary]=$(date -u +%H:%M:%S) $line

Run: $job_url" >/dev/null 2>&1 || true
done
