#!/usr/bin/env python3
"""
Every name the server reaches for on one of its own modules must be one that
module exports.

A module is reached through a variable holding require('./x'), or through one
handed over by init() and typed /** @type {typeof import('./x')} */. A renamed
export left one caller behind once (screensavers.held() after the rename to
heldBack()), and the server threw each time the Apps tab opened. TypeScript does
not flag it here: in JavaScript, with noImplicitAny off, a missing property on
a module's exports reads as any.

Exports are read from `module.exports = { name: ..., ... }`, and from
`module.exports.name =` / `exports.name =`. A module exporting anything else (a
function, a constructor) is not checked.
"""
import os
import re
import sys

# A project root may be given, which the test uses with a small fake server.
ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SERVER = os.path.join(ROOT, 'server')
LIB = os.path.join(SERVER, 'lib')


def strip_comments(src):
    src = re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), src, flags=re.S)
    return re.sub(r'(?m)(^|[^:\\])//.*$', r'\1', src)


def exports_of(path):
    """The names a module exports, or None where they cannot be read."""
    src = strip_comments(open(path, encoding='utf-8').read())
    names = set(re.findall(r'(?m)^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=', src))
    m = re.search(r'module\.exports\s*=\s*\{', src)
    if m:
        depth, i = 1, m.end()
        while i < len(src) and depth:
            depth += {'{': 1, '}': -1}.get(src[i], 0)
            i += 1
        body = src[m.end():i - 1]
        # Top-level keys only: drop nested braces first.
        flat, d = [], 0
        for ch in body:
            if ch == '{':
                d += 1
            elif ch == '}':
                d -= 1
            elif d == 0:
                flat.append(ch)
        flat = ''.join(flat)
        names |= set(re.findall(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?::|,|$)', flat))
        return names
    return names or None


def module_vars(src, here):
    """variable -> module file, for requires of ./x and typeof import('./x')."""
    out = {}
    for var, rel in re.findall(r"\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*require\('(\.[^']+)'\)\s*;", src):
        out[var] = rel
    for rel, var in re.findall(r"@type \{typeof import\('(\.[^']+)'\)\}\s*\*/\s*\n\s*var\s+([A-Za-z_$][\w$]*)", src):
        out[var] = rel
    resolved = {}
    for var, rel in out.items():
        p = os.path.normpath(os.path.join(os.path.dirname(here), rel))
        if not p.endswith('.js'):
            p += '.js'
        if os.path.exists(p):
            resolved[var] = p
    return resolved


def main():
    files = [os.path.join(SERVER, 'tvweb.js')] + sorted(
        os.path.join(LIB, f) for f in os.listdir(LIB) if f.endswith('.js'))
    problems, checked = [], 0
    cache = {}
    for f in files:
        raw = open(f, encoding='utf-8').read()
        mods = module_vars(raw, f)
        src = strip_comments(raw)
        for var, mod in mods.items():
            if mod not in cache:
                cache[mod] = exports_of(mod)
            names = cache[mod]
            if names is None:
                continue
            for m in re.finditer(r'(?<![\w$.])' + re.escape(var) + r'\.([A-Za-z_$][\w$]*)', src):
                checked += 1
                if m.group(1) not in names:
                    line = src.count('\n', 0, m.start()) + 1
                    problems.append('%s:%d: %s.%s is not exported by %s' % (
                        os.path.relpath(f, ROOT), line, var, m.group(1), os.path.relpath(mod, ROOT)))
    for p in problems:
        print(p)
    print('%d module uses checked, %d problem%s' % (checked, len(problems), '' if len(problems) == 1 else 's'))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
