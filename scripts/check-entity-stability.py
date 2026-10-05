#!/usr/bin/env python3
"""
No Home Assistant entity a release published may disappear without a reason
on record.

Home Assistant keys an entity on its unique id and domain. One that goes, is
renamed or changes domain leaves the old entity unavailable, and any
automation, dashboard or script that used it stops working, with nothing to
say why. This builds every entity from the code now and from the last
release (scripts/discovery-configs.js, with the same LG settings rows), and
fails on any the release had that the code no longer does, unless it is in
scripts/retired-entities.txt. Entities added are listed and allowed.

    ./scripts/check-entity-stability.py [--against <tag>]

Defaults to the newest v* tag before HEAD. CI needs the tags fetched.
"""
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import io

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts' / 'discovery-configs.js'


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT)] + list(args))


def entities(server_dir=None):
    cmd = ['node', str(SCRIPT)] + (['--server', str(server_dir)] if server_dir else [])
    return {c['type'] + '.' + c['id'] for c in json.loads(subprocess.check_output(cmd))}


def retired():
    out = set()
    for line in (ROOT / 'scripts' / 'retired-entities.txt').read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            out.add(line.split()[0])
    return out


def main():
    args = sys.argv[1:]
    if '--against' in args:
        tag = args[args.index('--against') + 1]
    else:
        tag = git('describe', '--tags', '--abbrev=0', '--match', 'v*').decode().strip()
    with tempfile.TemporaryDirectory() as tmp:
        tarfile.open(fileobj=io.BytesIO(git('archive', tag, 'server'))).extractall(tmp)
        before = entities(pathlib.Path(tmp) / 'server')
    now = entities()
    allowed = retired()
    gone = sorted(before - now - allowed)
    for e in sorted(now - before):
        print('new since %s: %s' % (tag, e))
    for e in sorted((before - now) & allowed):
        print('retired: %s' % e)
    for e in gone:
        print('%s was published by %s and is gone. Restore it, or list it in scripts/retired-entities.txt with why.' % (e, tag))
    print('%d entities in %s, %d now, %d gone without a reason' % (len(before), tag, len(now), len(gone)))
    return 1 if gone else 0


sys.exit(main())
