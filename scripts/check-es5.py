#!/usr/bin/env python3
"""
Check that the on-TV server is still ES5.

The TV runs node v0.12.2. An ES6 construct is not a degraded feature there, it
is a parse error: node prints "SyntaxError: Unexpected token" and exits, so the
server never binds, the dashboard never answers and the MQTT bridge never
connects. Nothing else in this repo catches that - the check scripts talk to a
running server, and a laptop's node parses all of it happily.

    ./scripts/check-es5.py [files...]

Defaults to the server (tvweb.js and lib/), and the pages the TV's own browser
runs - the dashboard app, setup and the helper they load - whose inline scripts
are checked in place. server/assets/ui.html and the scripts it loads from
assets/ui/ run in a phone or computer's browser and are not restricted.

Strings, template literals, regex literals and comments are blanked before the
scan, so a `=>` inside a string or a comment mentioning `const` is not a hit.

For the server, syntax only. ES6 library calls (Object.assign, Array.from,
String.prototype.includes) parse fine and fail later at the call, which is
visible in the log and in the unit tests run on node 0.12; a parse error is
silent because there is no process left to log it.

The pages the TV's browser runs are also checked for calls and CSS that its
engine lacks. webOS 3.x runs Chromium 38: nothing runs those pages in CI, and a
missing call there stops the script with nothing on screen to say why - the TV
app showed its header and no rows for want of fetch.

Exits non-zero if anything is flagged.
"""
import re, sys, pathlib

# Constructs node 0.12 cannot parse, and what to say about each.
RULES = [
    (r'(?<![.\w$])(?:let|const)\s+(?=[A-Za-z_$\[{])', 'let/const - use var'),
    (r'=>', 'arrow function - use function ()'),
    (r'(?<![.\w$])class(?![\w$])\s*[A-Za-z_$\{]', 'class - use a constructor function'),
    (r'\.\.\.', 'spread/rest - build the array or arguments explicitly'),
    (r'(?<![.\w$])async(?![\w$])\s*(?:function\b|\(|[A-Za-z_$])', 'async - use a callback'),
    (r'(?<![.\w$])await(?![\w$])\s', 'await - use a callback'),
    (r'(?<![.\w$])yield(?![\w$])', 'yield - generators are ES6'),
    (r'(?<![.\w$])function\s*\*', 'generator function'),
    (r'(?<![.\w$])for\s*\(\s*(?:var\s+|let\s+|const\s+)?[A-Za-z_$][\w$]*\s+of(?![\w$])',
     'for...of - use an index loop'),
    (r'(?<![.\w$])function\s*[A-Za-z_$\w]*\s*\([^)]*=[^)]*\)\s*\{', 'default parameter value'),
]


# Calls and CSS newer than Chromium 38 (webOS 3.x), for the pages the TV's own
# browser runs. Matched against code with strings and comments blanked.
TV_RULES = [
    (r'(?<![.\w$])fetch\s*\(', 'fetch - Chrome 42; use XMLHttpRequest, or the fallback dashboard.html defines'),
    (r'Object\.(?:assign|values|entries|fromEntries)\b', 'Object.assign/values/entries - Chrome 45+'),
    (r'\.(?:includes|startsWith|endsWith|padStart|padEnd|repeat|find|findIndex)\s*\(',
     'String/Array ES6 method - Chrome 41+; use indexOf or a loop'),
    (r'\.closest\s*\(', 'Element.closest - Chrome 41; walk parentNode'),
    (r'(?<![.\w$])(?:URLSearchParams|AbortController|IntersectionObserver|ResizeObserver|Symbol)\b',
     'API newer than Chrome 38'),
    (r'Array\.from\b|Number\.is(?:Finite|Integer|NaN)\b', 'ES6 built-in - Chrome 45+'),
    (r'new\s+(?:Map|Set|WeakMap|WeakSet|Proxy)\b', 'Map/Set/Proxy - incomplete or missing in Chrome 38'),
]
TV_CSS_RULES = [
    (r'var\(--', 'CSS custom property - Chrome 49'),
    (r'display\s*:\s*(?:inline-)?grid', 'CSS grid - Chrome 57'),
    (r'(?<![-\w])(?:row-|column-)?gap\s*:', 'gap - Chrome 57 for grid, 84 for flex'),
    (r'position\s*:\s*sticky', 'position: sticky - Chrome 56'),
    (r'(?<![-\w])(?:aspect-ratio|inset)\s*:', 'aspect-ratio/inset - Chrome 87'),
    (r'(?<![-\w.])(?:min|max|clamp)\(', 'CSS min()/max()/clamp() - Chrome 79'),
    (r':(?:is|where)\(', ':is()/:where() - Chrome 88'),
    (r'backdrop-filter', 'backdrop-filter - Chrome 76'),
]
# Pages the TV's own browser runs, and the scripts they load.
TV_PAGES = {'dashboard.html', 'setup.html', 'i18n.js', 'qr.js'}


def blank(src):
    """
    Replace comment, string, template and regex bodies with spaces, keeping
    every newline so line numbers still line up. Returns the blanked source and
    the lines on which a template literal was opened - backticks are themselves
    ES6, and blanking one would otherwise hide it.
    """
    out, templates = [], []
    i, n, line = 0, len(src), 1
    # A '/' opens a regex rather than dividing when the last meaningful token
    # cannot end an expression.
    prev = ''

    def keep(ch):
        out.append(ch)

    while i < n:
        c = src[i]
        if c == '\n':
            line += 1
            keep(c)
            i += 1
            continue

        if c == '/' and i + 1 < n and src[i + 1] == '/':
            while i < n and src[i] != '\n':
                keep(' ')
                i += 1
            continue

        if c == '/' and i + 1 < n and src[i + 1] == '*':
            while i < n and not (src[i] == '*' and i + 1 < n and src[i + 1] == '/'):
                keep('\n' if src[i] == '\n' else ' ')
                if src[i] == '\n':
                    line += 1
                i += 1
            for _ in range(min(2, n - i)):
                keep(' ')
                i += 1
            continue

        if c in '"\'':
            quote = c
            keep(' ')
            i += 1
            while i < n and src[i] != quote:
                if src[i] == '\\':
                    keep(' ')
                    i += 1
                if i < n:
                    keep('\n' if src[i] == '\n' else ' ')
                    if src[i] == '\n':
                        line += 1
                    i += 1
            keep(' ')
            i += 1
            prev = 'x'
            continue

        if c == '`':
            templates.append(line)
            depth = 0
            keep(' ')
            i += 1
            while i < n:
                if src[i] == '\\':
                    keep(' ')
                    i += 1
                    if i < n:
                        keep(' ')
                        i += 1
                    continue
                if src[i] == '$' and i + 1 < n and src[i + 1] == '{':
                    depth += 1
                elif src[i] == '}' and depth:
                    depth -= 1
                elif src[i] == '`' and not depth:
                    break
                keep('\n' if src[i] == '\n' else ' ')
                if src[i] == '\n':
                    line += 1
                i += 1
            keep(' ')
            i += 1
            prev = 'x'
            continue

        if c == '/' and prev not in ('x', ')', ']'):
            # Regex literal: run to the closing '/', skipping escapes and the
            # character class, where '/' is literal.
            keep(' ')
            i += 1
            klass = False
            while i < n and src[i] != '\n':
                if src[i] == '\\':
                    keep(' ')
                    i += 1
                    if i < n:
                        keep(' ')
                        i += 1
                    continue
                if src[i] == '[':
                    klass = True
                elif src[i] == ']':
                    klass = False
                elif src[i] == '/' and not klass:
                    break
                keep(' ')
                i += 1
            keep(' ')
            i += 1
            prev = 'x'
            continue

        if not c.isspace():
            prev = 'x' if (c.isalnum() or c in '_$)]') else c
        keep(c)
        i += 1

    return ''.join(out), templates


def check(path):
    src = path.read_text(encoding='utf-8')
    raw = src
    if path.suffix == '.html':
        # Inline scripts only, each left on its own lines so a hit reports the
        # page's line number; the markup around them becomes blank lines.
        src = re.sub(r'(?s)(^|</script>).*?(<script>|$)',
                     lambda m: '\n' * m.group(0).count('\n'), src)
    code, templates = blank(src)
    hits = [(ln, 'template literal - use string concatenation') for ln in templates]
    rules = list(RULES)
    if path.name in TV_PAGES:
        rules += [r for r in TV_RULES
                  if not (r[0].startswith('(?<![.\\w$])fetch') and 'window.fetch = function' in raw)]
    for pattern, why in rules:
        for m in re.finditer(pattern, code):
            hits.append((code[:m.start()].count('\n') + 1, why))
    if path.name in TV_PAGES and path.suffix == '.html':
        # Style blocks and attributes; scripts become blank lines.
        css = re.sub(r'(?s)<script.*?</script>', lambda m: '\n' * m.group(0).count('\n'), raw)
        for pattern, why in TV_CSS_RULES:
            for m in re.finditer(pattern, css):
                hits.append((css[:m.start()].count('\n') + 1, why))
    for ln, why in sorted(hits):
        print('%s:%d: %s' % (path, ln, why))
    print('%s: %d line%s, %d ES6 construct%s'
          % (path, src.count('\n') + 1, '' if src.count('\n') == 0 else 's',
             len(hits), '' if len(hits) == 1 else 's'))
    return len(hits)


if len(sys.argv) > 1:
    targets = [pathlib.Path(a) for a in sys.argv[1:]]
else:
    root = pathlib.Path(__file__).resolve().parent.parent
    targets = [root / 'server' / 'tvweb.js']
    lib_dir = root / 'server' / 'lib'
    if lib_dir.exists():
        targets.extend(sorted(lib_dir.glob('*.js')))
    # The pages the TV's own browser runs, and the helpers they load: webOS 3.x
    # runs Chromium 38. ui.html and assets/ui/ are for a phone or computer's
    # browser.
    assets = root / 'server' / 'assets'
    targets += [assets / 'i18n.js', assets / 'qr.js', assets / 'dashboard.html', assets / 'setup.html',
                assets / 'setup-phone.html']

sys.exit(1 if sum(check(t) for t in targets) else 0)
