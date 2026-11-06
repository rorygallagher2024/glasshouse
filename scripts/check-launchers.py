#!/usr/bin/env python3
"""
Checks the catalogue of launchers, docs/launchers/catalog.json, which the Home
tab offers to install (lib/home-launcher.js).

Each entry must describe itself fully, its file must match the size and
sha256 it lists, and the launcher in it must be a Glasshouse launcher:

  * it lists the TV's apps and inputs:   Glasshouse.catalogue(
  * Home brings it back to its start:    Glasshouse.onHome(
  * it offers a way to LG's Home:        Glasshouse.lgHome(
  * it stays on its own page: no setting location, location.assign or
    replace, window.open, refresh meta or links to other pages, since a page
    that leaves stops answering and LG's Home takes its place
  * it is self-contained: no scripts, styles or fonts from elsewhere, so it
    cannot change after it was reviewed
  * it is ES5 (scripts/check-es5.py), as the browser on webOS 3 and 4 needs

    scripts/check-launchers.py            check
    scripts/check-launchers.py --update   write each launcher kept in the repo's
                                          size and sha256 into the catalogue
"""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs' / 'launchers'
CATALOGUE = DOCS / 'catalog.json'
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,39}$')
VERSION_RE = re.compile(r'^\d+\.\d+\.\d+$')
SHA_RE = re.compile(r'^[0-9a-f]{64}$')
MAX_SIZE = 50 * 1024 * 1024

REQUIRED = [
    ('Glasshouse.catalogue(', 'list the TV\'s apps and inputs with Glasshouse.catalogue()'),
    ('Glasshouse.onHome(', 'go back to its start when Home is pressed, with Glasshouse.onHome()'),
    ('Glasshouse.lgHome(', 'offer a way to LG\'s Home with Glasshouse.lgHome()'),
]
LEAVES = [
    (re.compile(r'\blocation\s*(\.\s*href\s*)?=(?!=)'), 'sets location'),
    (re.compile(r'\blocation\s*\.\s*(assign|replace)\s*\('), 'calls location.assign or location.replace'),
    (re.compile(r'\bwindow\s*\.\s*open\s*\('), 'calls window.open'),
    (re.compile(r'<meta[^>]+http-equiv\s*=\s*["\']?refresh', re.I), 'has a refresh meta tag'),
    (re.compile(r'<a\s[^>]*href\s*=\s*["\']?(?!#)', re.I), 'has a link to another page'),
]
REMOTE = [
    (re.compile(r'<script[^>]+src\s*=\s*["\']?(https?:)?//', re.I), 'loads a script from elsewhere'),
    (re.compile(r'<link[^>]+href\s*=\s*["\']?(https?:)?//', re.I), 'loads a stylesheet from elsewhere'),
    (re.compile(r'@import\s+(url\()?["\']?(https?:)?//', re.I), 'imports a stylesheet from elsewhere'),
    (re.compile(r'url\(\s*["\']?(https?:)?//', re.I), 'loads a font or image from elsewhere'),
]


def kit_version():
    kit = (ROOT / 'server' / 'assets' / 'home-kit.js').read_text(encoding='utf-8')
    lib = (ROOT / 'server' / 'lib' / 'home-launcher.js').read_text(encoding='utf-8')
    a = re.search(r'^\s*version:\s*(\d+),', kit, re.M)
    b = re.search(r'^var KIT_VERSION = (\d+);', lib, re.M)
    if not a or not b or a.group(1) != b.group(1):
        sys.exit('home-kit.js\'s version and KIT_VERSION in lib/home-launcher.js must match')
    return int(a.group(1))


def fetch(entry):
    url = entry['url']
    if url.startswith('https://'):
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.read()
    return (DOCS / url).read_bytes()


def files_of(name, data):
    """The launcher's files as {path: bytes}, from a single page or a zip."""
    if name.endswith('.html'):
        return {'index.html': data}
    z = zipfile.ZipFile(io.BytesIO(data))
    out = {}
    for info in z.infolist():
        n = info.filename.replace('\\', '/')
        if n.endswith('/') or n.startswith('__MACOSX/') or n.split('/')[-1] == '.DS_Store':
            continue
        out[n] = z.read(info)
    tops = {n.split('/')[0] for n in out}
    if 'index.html' not in out and 'appinfo.json' not in out and len(tops) == 1 and all('/' in n for n in out):
        out = {n.split('/', 1)[1]: b for n, b in out.items()}
    return out


def start_page(files):
    if 'appinfo.json' in files:
        main = json.loads(files['appinfo.json'].decode('utf-8-sig')).get('main')
        if main in files:
            return main
    return 'index.html' if 'index.html' in files else None


def check_entry(e, ids, kit, problems):
    who = 'catalogue entry %s' % e.get('id', '?')
    def bad(text):
        problems.append('%s: %s' % (who, text))

    if not isinstance(e.get('id'), str) or not ID_RE.match(e['id']) or e['id'] == 'own':
        bad('id must be lowercase letters, digits and dashes, and not "own"')
    elif e['id'] in ids:
        bad('id is listed twice')
    ids.add(e.get('id'))
    for field, most in (('title', 40), ('author', 40)):
        if not isinstance(e.get(field), str) or not e[field].strip() or len(e[field]) > most:
            bad('%s must be given, at most %d characters' % (field, most))
    d = e.get('description')
    if not isinstance(d, str) or not 20 <= len(d) <= 300:
        bad('description must be 20 to 300 characters')
    if not isinstance(e.get('version'), str) or not VERSION_RE.match(e['version']):
        bad('version must be like 1.0.0')
    url = e.get('url')
    if not isinstance(url, str) or not re.search(r'\.(html|zip)$', url) or \
            not (url.startswith('https://') or (DOCS / url).is_file()):
        bad('url must be an https address, or a file beside the catalogue, of an .html or .zip')
        return
    shot = e.get('screenshot')
    if not isinstance(shot, str) or not re.search(r'\.(jpg|png)$', shot) or \
            not (shot.startswith('https://') or (DOCS / shot).is_file()):
        bad('screenshot must be a .jpg or .png, beside the catalogue or at an https address')
    if not isinstance(e.get('kit'), int) or not 1 <= e['kit'] <= kit:
        bad('kit must be the window.Glasshouse version it needs, 1 to %d' % kit)
    if 'home' in e and not (isinstance(e['home'], str) and e['home'].startswith('https://')):
        bad('home, where it is from, must be an https address')
    if not isinstance(e.get('sha256'), str) or not SHA_RE.match(e['sha256']) or not isinstance(e.get('size'), int):
        bad('sha256 and size must be given (scripts/check-launchers.py --update writes them for a file beside the catalogue)')
        return

    try:
        data = fetch(e)
    except Exception as x:  # noqa: BLE001 - any failure to read it is the finding
        bad('could not be read: %s' % x)
        return
    if len(data) != e['size'] or len(data) > MAX_SIZE:
        bad('its file is %d bytes, not the %d listed (at most %d)' % (len(data), e['size'], MAX_SIZE))
    if hashlib.sha256(data).hexdigest() != e['sha256']:
        bad('its file does not match the sha256 listed')

    try:
        files = files_of(url, data)
    except zipfile.BadZipFile:
        bad('is not a readable zip')
        return
    main = start_page(files)
    if not main:
        bad('has no index.html, nor an appinfo.json naming its start page')
        return
    text = {n: b.decode('utf-8', 'replace') for n, b in files.items() if re.search(r'\.(html?|js|css)$', n)}
    every = '\n'.join(text.values())
    for call, need in REQUIRED:
        if call not in every:
            bad('must %s' % need)
    for name, src in text.items():
        for pattern, what in LEAVES + REMOTE:
            if pattern.search(src):
                bad('%s %s' % (name, what))
    with tempfile.TemporaryDirectory() as tmp:
        paths = []
        for name, src in text.items():
            if name.endswith('.css'):
                continue
            # check-es5.py applies its CSS rules to the TV's pages by name.
            p = pathlib.Path(tmp) / name.replace('/', '__')
            if name == main:
                p = pathlib.Path(tmp) / 'index.html'
            p.write_text(src, encoding='utf-8')
            paths.append(str(p))
        r = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'check-es5.py')] + paths,
                           capture_output=True, text=True)
        if r.returncode:
            for line in r.stdout.splitlines():
                if line.strip() and not re.search(r': \d+ lines?, \d+ ES6 constructs?$', line):
                    bad('not ES5: %s' % line.replace(tmp + '/', ''))


def update(doc):
    for e in doc['launchers']:
        url = e.get('url', '')
        if isinstance(url, str) and not url.startswith('https://') and (DOCS / url).is_file():
            data = (DOCS / url).read_bytes()
            e['size'] = len(data)
            e['sha256'] = hashlib.sha256(data).hexdigest()
    CATALOGUE.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def main():
    doc = json.loads(CATALOGUE.read_text(encoding='utf-8'))
    if not isinstance(doc.get('launchers'), list):
        sys.exit('catalog.json must hold {"launchers": [...]}')
    if '--update' in sys.argv:
        update(doc)
    kit = kit_version()
    problems, ids = [], set()
    for e in doc['launchers']:
        check_entry(e, ids, kit, problems)
    for p in problems:
        print(p)
    print('%d launcher%s in the catalogue, %d problem%s' % (len(doc['launchers']), '' if len(doc['launchers']) == 1 else 's',
                                                           len(problems), '' if len(problems) == 1 else 's'))
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
