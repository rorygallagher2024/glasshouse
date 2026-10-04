#!/usr/bin/env python3
"""
Adds the last 14 days of GitHub traffic to a CSV, which GitHub itself keeps
for no longer.

    TRAFFIC_TOKEN=... GITHUB_TOKEN=... REPO=owner/name scripts/traffic.py traffic.csv

Each row is a UTC day: clones and unique cloners, views and unique visitors,
and how many of the clones were this repository's own CI. Every CI job checks
the repository out, and on a busy day those were over half the clones, so
clones_not_ci is the closer measure of people installing. Bots and mirrors are
still in it; GitHub does not separate them.

The windows overlap, so a day already in the file is replaced with the newer
figures, which for the most recent day are more complete.

TRAFFIC_TOKEN needs read access to the repository's administration, which the
traffic endpoints ask for and a workflow's own token cannot have. GITHUB_TOKEN
reads the Actions runs.
"""
import csv
import json
import os
import sys
import urllib.request

API = 'https://api.github.com'
FIELDS = ['date', 'clones', 'unique_cloners', 'views', 'unique_visitors', 'ci_checkouts', 'clones_not_ci']


def get(path, token):
    req = urllib.request.Request(API + path, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'glasshouse-traffic'
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def ci_checkouts(repo, token, days):
    """Jobs started on each of `days` (UTC): one checkout each. Counting a
    run's jobs takes a request per run, so only the days asked for."""
    per_day, page = dict((d, 0) for d in days), 1
    if not days:
        return per_day
    while True:
        d = get('/repos/%s/actions/runs?created=>=%s&per_page=100&page=%d' % (repo, min(days), page), token)
        runs = d.get('workflow_runs', [])
        for run in runs:
            day = run['created_at'][:10]
            if day not in per_day:
                continue
            jobs = get('/repos/%s/actions/runs/%d/jobs?per_page=1' % (repo, run['id']), token)
            per_day[day] += int(jobs.get('total_count', 0))
        if len(runs) < 100:
            return per_day
        page += 1


def main():
    if len(sys.argv) != 2:
        sys.exit('usage: traffic.py <csv file>')
    out = sys.argv[1]
    repo = os.environ.get('REPO')
    traffic_token = os.environ.get('TRAFFIC_TOKEN')
    actions_token = os.environ.get('GITHUB_TOKEN') or traffic_token
    if not repo or not traffic_token:
        sys.exit('REPO and TRAFFIC_TOKEN are needed; see the comment at the top of this script')

    clones = get('/repos/%s/traffic/clones?per=day' % repo, traffic_token).get('clones', [])
    views = get('/repos/%s/traffic/views?per=day' % repo, traffic_token).get('views', [])
    days = {}
    for c in clones:
        days.setdefault(c['timestamp'][:10], {})['clones'] = (c['count'], c['uniques'])
    for v in views:
        days.setdefault(v['timestamp'][:10], {})['views'] = (v['count'], v['uniques'])
    if not days:
        print('no traffic returned')
        return 0
    rows = {}
    if os.path.exists(out):
        with open(out, newline='') as f:
            for r in csv.DictReader(f):
                rows[r['date']] = r
    # CI for a finished day does not change: counted once, then kept. The
    # two latest days are counted again, as runs may still have been starting.
    recent = sorted(days)[-2:]
    todo = [day for day in days if day in recent or day not in rows or rows[day].get('ci_checkouts', '') == '']
    ci = ci_checkouts(repo, actions_token, todo)
    for day, d in days.items():
        c, cu = d.get('clones', (0, 0))
        v, vu = d.get('views', (0, 0))
        k = ci[day] if day in ci else int(rows[day]['ci_checkouts'])
        rows[day] = {'date': day, 'clones': c, 'unique_cloners': cu, 'views': v, 'unique_visitors': vu,
                     'ci_checkouts': k, 'clones_not_ci': max(0, c - k)}
    with open(out, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for day in sorted(rows):
            w.writerow({k: rows[day].get(k, '') for k in FIELDS})
    print('%d days in %s, %d updated' % (len(rows), out, len(days)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
