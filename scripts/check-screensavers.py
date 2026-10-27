#!/usr/bin/env python3
"""
Check the screen saver QML against the QtQuick version it declares.

qml-runner on the TV reports nothing at all for a file it cannot load - not on
stdout, not in the system log - so a QML mistake shows up as a screen saver
that simply never draws. These are the two mistakes that have actually shipped:

  * a property newer than the `import QtQuick x.y` line at the top, which makes
    the whole file fail to load. A B8 runs Qt 5.6 and a C2 runs Qt 5.12, but
    the import version is what decides availability, not the Qt build.
  * anchors on a direct child of a Row or Column, which QML refuses for the
    axis that the layout owns, so the item silently lands somewhere else.

It also checks each screen saver folder, as the server reads them
(docs/development/SCREENSAVER-DESIGN.md has the format): its saver.json
parses, is format 1 and has a name, a description and a version;
its main file is there; and every placeholder its QML uses is one it asks for
in uses. Glasshouse's own, in server/assets/screensavers, also need Spanish and
the MIT license. The ones in server/screensavers are installed into the TV's
folder for added screen savers, as an example of one, so they are checked as
anyone's would be.

    ./scripts/check-screensavers.py                every folder in the repository
    ./scripts/check-screensavers.py my-saver/      a screen saver of your own
    ./scripts/check-screensavers.py a.qml b.qml    single QML files

A folder given by path is checked as one added on a TV would be.

Exits non-zero if anything is flagged.
"""
import json, re, sys, pathlib

# property -> QtQuick version that introduced it
SINCE = {
    'topPadding': (2, 6), 'bottomPadding': (2, 6),
    'leftPadding': (2, 6), 'rightPadding': (2, 6), 'padding': (2, 6),
    'advance': (2, 10), 'renderTypeQuality': (2, 15),
    'palette': (2, 13), 'containmentMask': (2, 11),
}
# anchors a Row or Column will not honour on its own children
BANNED = {
    'Column': ('left', 'right', 'horizontalCenter', 'fill', 'centerIn'),
    'Row':    ('top', 'bottom', 'verticalCenter', 'fill', 'centerIn'),
}

def check(path):
    src = path.read_text(encoding='utf-8')
    lines = src.splitlines()
    bad = []

    # Braces, ignoring those inside strings and comments. An unbalanced file
    # fails to load with no message at all, the same as any other QML mistake.
    # Strings first: a path like "file:///usr/share/fonts/x.ttf" contains //,
    # and stripping comments before strings would eat the rest of that line.
    stripped = re.sub(r'"(?:[^"\\\n]|\\.)*"', '""', src)
    stripped = re.sub(r"'(?:[^'\\\n]|\\.)*'", "''", stripped)
    stripped = re.sub(r'/\*.*?\*/', '', stripped, flags=re.S)
    stripped = re.sub(r'//[^\n]*', '', stripped)
    opens, closes = stripped.count('{'), stripped.count('}')
    if opens != closes:
        bad.append((0, 'unbalanced braces: %d open, %d close' % (opens, closes)))

    m = re.search(r'^\s*import\s+QtQuick\s+(\d+)\.(\d+)\s*$', src, re.M)
    if not m:
        bad.append((0, 'no plain "import QtQuick x.y" line found'))
        ver = (99, 99)
    else:
        ver = (int(m.group(1)), int(m.group(2)))

    # Track brace depth so a Row/Column's direct children can be told apart
    # from anything nested deeper inside them.
    depth = 0
    layouts = []          # (depth_of_body, kind)
    for n, line in enumerate(lines, 1):
        code = re.sub(r'//.*$', '', line)

        for prop, since in SINCE.items():
            if re.search(r'(^|[\s{;])' + prop + r'\s*:', code) and ver < since:
                bad.append((n, '%s needs QtQuick %d.%d, file imports %d.%d'
                            % (prop, since[0], since[1], ver[0], ver[1])))

        am = re.search(r'anchors\.(\w+)\s*:', code)
        if am and layouts:
            body_depth, kind = layouts[-1]
            # Depth at the anchor itself, not at the start of the line: an
            # element written on one line opens its own brace first, and
            # without this a legal `Item { Text { anchors... } }` reads the
            # same as a direct child.
            before = code[:am.start()]
            here = depth + before.count('{') - before.count('}')
            if here == body_depth + 1 and am.group(1) in BANNED[kind]:
                bad.append((n, 'anchors.%s on a direct child of %s is ignored'
                            % (am.group(1), kind)))

        start = re.match(r'\s*(Row|Column)\s*\{', code)
        opens = code.count('{')
        closes = code.count('}')
        if start and opens:
            layouts.append((depth + 1, start.group(1)))
        depth += opens - closes
        while layouts and depth < layouts[-1][0]:
            layouts.pop()

    return bad

SAVERS = pathlib.Path('server/assets/screensavers')
EXAMPLES = pathlib.Path('server/screensavers')
USES = {'level': '__TVWEB_LEVEL__', 'stats': '__TVWEB_URL__'}

def check_folder(d, own):
    """Problems with one saver folder's saver.json, and its main QML file."""
    bad = []
    if not re.match(r'^[a-z0-9][a-z0-9-]{0,31}$', d.name):
        bad.append('folder name can only have lowercase letters, digits and -, starting with a letter or digit, up to 32 characters')
    try:
        m = json.loads((d / 'saver.json').read_text(encoding='utf-8'))
    except Exception as e:
        return ['saver.json: %s' % e], []
    if not isinstance(m, dict):
        return ['saver.json is not an object'], []
    if m.get('manifest') != 1:
        bad.append('saver.json: manifest must be 1')
    for field in ('name', 'description'):
        v = m.get(field)
        if own and not (isinstance(v, dict) and v.get('en') and v.get('es')):
            bad.append('saver.json: %s needs en and es' % field)
        elif not (isinstance(v, str) and v) and not (isinstance(v, dict) and v.get('en')):
            bad.append('saver.json: %s needs English' % field)
    if not isinstance(m.get('version'), str) or not m.get('version'):
        bad.append('saver.json: version missing')
    if own and m.get('license') != 'MIT':
        bad.append('saver.json: Glasshouse\'s own screen savers are MIT')
    if not own and 'stats' in m.get('uses', []):
        bad.append('saver.json: only Glasshouse\'s own screen savers are given stats')
    if 'id' in m:
        bad.append('saver.json: no id - the folder name is the id')
    main = m.get('main', 'main.qml')
    uses = m.get('uses', [])
    for u in uses:
        if u not in USES:
            bad.append('saver.json: unknown use "%s"' % u)
    qml = d / main
    if not qml.is_file():
        return bad + ['%s missing' % main], []
    src = qml.read_text(encoding='utf-8')
    for u, ph in USES.items():
        if ph in src and u not in uses:
            bad.append('%s uses %s without "%s" in uses' % (main, ph, u))
    # Every QML file in it, as the TV checks them all.
    return bad, sorted(p for p in d.rglob('*.qml') if p.is_file())

args = [pathlib.Path(a) for a in sys.argv[1:]]
files = []
fails = 0
for a in args:
    if a.is_dir():
        if not (a / 'saver.json').is_file():
            fails += 1
            print('%s: no saver.json - not a screen saver folder' % a)
            continue
        problems, qmls = check_folder(a if a.name else a.resolve(), False)
        if problems:
            fails += 1
            for msg in problems:
                print('%s: %s' % (a, msg))
        files += qmls
    else:
        files.append(a)
if not args:
    shown = lambda root: sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith('.'))
    folders = [(d, True) for d in shown(SAVERS)]
    if EXAMPLES.is_dir():
        folders += [(d, False) for d in shown(EXAMPLES)]
    for d, own in folders:
        problems, qmls = check_folder(d, own)
        if problems:
            fails += 1
            for msg in problems:
                print('%s: %s' % (d, msg))
        files += qmls
    stray = sorted(p for p in SAVERS.iterdir() if p.is_file())
    for p in stray:
        fails += 1
        print('%s: belongs in a saver\'s own folder' % p)

for f in files:
    problems = check(f)
    if problems:
        fails += 1
        for n, msg in problems:
            print('%s:%d: %s' % (f, n, msg))
    else:
        print('%s: ok' % f)

sys.exit(1 if fails else 0)
