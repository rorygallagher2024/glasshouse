#!/usr/bin/env python3
"""
Make docs/development/remotes.md from the remote catalogue, server/lib/remotes.json.

The page is written from the data so the two cannot drift. scripts/check-drift.py
runs this with --check, which fails when the page is not what the catalogue
makes.

    ./scripts/gen-remotes-doc.py          write docs/development/remotes.md
    ./scripts/gen-remotes-doc.py --check  fail if it would change
"""
import json, pathlib, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
catalogue = root / 'server' / 'lib' / 'remotes.json'
page = root / 'docs' / 'development' / 'remotes.md'

EVIDENCE = [
    ('measured', 'seen on a TV: a press read from the remote, or a filter that received it'),
    ('documented', 'stated in LG\'s manual or in this project\'s docs'),
    ('assumed', 'expected, not confirmed'),
]


def key_titles():
    """The Remote tab's key names and titles, from remotekeys.js."""
    out = subprocess.run(
        ['node', '-e', "console.log(JSON.stringify(require('./server/lib/remotekeys').keyTitles()))"],
        cwd=str(root), capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def render():
    remotes = json.loads(catalogue.read_text(encoding='utf-8'))['remotes']
    titles = key_titles()
    out = []
    w = out.append
    w('# Remotes')
    w('')
    w('<!-- Made by scripts/gen-remotes-doc.py from server/lib/remotes.json: edit that file, then run the script. -->')
    w('')
    w('The LG remotes Glasshouse knows, with the Remote tab keys each is known to have. A remote not listed here,'
      ' or a list with a button missing, is fine to add: see [Adding a remote](#adding-a-remote).')
    w('')
    w('| Remote | Year | Reported by the TV as | Keys known | List complete |')
    w('| :----- | :--- | :-------------------- | ---------: | :------------ |')
    for r in remotes:
        w('| [%s](#%s) | %s | %s | %d | %s |' % (
            r['title'], r['id'].lower(), r['year'] or 'not known',
            ', '.join('`%s`' % n for n in r['names']), len(r['keys']), 'yes' if r['complete'] else 'no'))
    w('')
    w('How sure each fact is:')
    w('')
    for name, text in EVIDENCE:
        w('* **%s:** %s.' % (name.capitalize(), text))
    w('')
    for r in remotes:
        w('## %s' % r['title'])
        w('')
        w('<a id="%s"></a>' % r['id'].lower())
        w('')
        facts = ['Reported by the TV as %s (%s).' % (', '.join('`%s`' % n for n in r['names']), r['nameEvidence'])]
        if r['year']:
            facts.append('From %s.' % r['year'])
        if r['numberKeys'] is True:
            facts.append('Has number keys.')
        elif r['numberKeys'] is False:
            facts.append('Has no number keys.')
        facts.append('The list of keys below is %s.' % (
            'every button the remote has' if r['complete'] else 'what is known so far, not every button'))
        w(' '.join(facts))
        w('')
        if r['keys']:
            w('| Remote tab key | Evidence |')
            w('| :------------- | :------- |')
            labels = r.get('labels') or {}
            for key, ev in r['keys'].items():
                printed = ', printed as %s' % labels[key] if key in labels else ''
                w('| %s (`%s`)%s | %s |' % (titles.get(key, key), key, printed, ev))
            w('')
        if r['notes']:
            w(r['notes'])
            w('')
        w('Where this comes from:')
        w('')
        for s in r['sources']:
            w('* %s' % s)
        w('')
    w('## Adding a remote')
    w('')
    w('The catalogue is [`server/lib/remotes.json`](https://github.com/rorygallagher2024/glasshouse/blob/main/server/lib/remotes.json).'
      ' To add a remote, or a button to one, add or edit its entry there and run `scripts/gen-remotes-doc.py`,'
      ' which rewrites this page; `scripts/check-all.sh` fails while the two disagree.')
    w('')
    w('* `id`, `title`, `names` (what the TV reports: the paired remote\'s name on the Metrics tab, or `remote_type`'
      ' in `/var/log/messages`), `year` and `numberKeys` (`null` where not known).')
    w('* `keys`: the Remote tab key ids (the `KEYS` list in `server/lib/remotekeys.js`) with how sure the fact is.')
    w('* `labels` (optional): the name printed on the remote for a key, where it differs from the Remote tab\'s, such as'
      ' `{"voice": "AI"}`. The Remote tab then shows the key under that name while the remote is selected.')
    w('* `complete`: `true` only when the list is every button the remote has. Only a complete list lets the Remote tab'
      ' treat a key as not on that remote.')
    w('* `sources`: which TV and webOS version each fact came from.')
    w('* `image`: the file name of a small picture under `server/assets/remotes/`, about 160 px wide, a PNG with a'
      ' transparent background, under 20 KB, original artwork or a picture you may share. A remote without one'
      ' shows the generic outline. The file also goes in `FILES` in `server/deploy.sh`.')
    w('')
    w('To read a remote\'s reported name and button presses over SSH on a rooted TV, see'
      ' [Remote keys](remote-keys.md#reading-keys-on-a-rooted-tv).')
    w('')
    return '\n'.join(out)


def main():
    text = render()
    if '--check' in sys.argv:
        have = page.read_text(encoding='utf-8') if page.exists() else ''
        if have != text:
            print('docs/development/remotes.md is not what server/lib/remotes.json makes: run scripts/gen-remotes-doc.py')
            return 1
        return 0
    page.write_text(text, encoding='utf-8')
    print('wrote %s' % page.relative_to(root))
    return 0


if __name__ == '__main__':
    sys.exit(main())
