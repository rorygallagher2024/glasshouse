#!/usr/bin/env python3
"""Assembles channel-keys.s and prints the bytes lib/guidepatch.js writes.

Needs clang with the ARM backend (Xcode's does). The two calls into LG's PLT,
PmLogGetContext at 0x4878 and PmLogString_ at 0x473c, are nop.w in the source
and filled in here for the stub's address, 0x18858, as is the repeat counter's
offset (0x5eedc0de in the source) from the add r6, pc that reads it. --check
compares the result with CHANNEL_STUB in server/lib/guidepatch.js.
"""
import os
import re
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = 0x18858
END = 0x18a20  # the page's data (.init_array's file offset)
CALLS = ((0x4878, 'PmLogGetContext'), (0x473c, 'PmLogString_'))
NOP_W = bytes.fromhex('aff30080')
COUNTER = 0x1a2c0  # past .bss (0x1a2b4), in the page the loader zeroes
COUNTER_MARK = struct.pack('<I', 0x5eedc0de)
ADD_R6_PC = struct.pack('<H', 0x447e)


def blx(addr, target):
    """Thumb BLX (immediate) to ARM code at target, from addr."""
    imm = target - ((addr + 4) & ~3)
    s, i1, i2 = (imm >> 24) & 1, (imm >> 23) & 1, (imm >> 22) & 1
    j1, j2 = (~(i1 ^ s)) & 1, (~(i2 ^ s)) & 1
    hw1 = 0xF000 | s << 10 | ((imm >> 12) & 0x3ff)
    hw2 = 0xC000 | j1 << 13 | j2 << 11 | ((imm >> 2) & 0x3ff) << 1
    return struct.pack('<HH', hw1, hw2)


def text_section(obj):
    shoff = struct.unpack_from('<I', obj, 0x20)[0]
    size, count, names = struct.unpack_from('<HHH', obj, 0x2e)
    secs = [struct.unpack_from('<10I', obj, shoff + i * size) for i in range(count)]
    strtab = secs[names][4]
    for sec in secs:
        name = obj[strtab + sec[0]:obj.index(b'\0', strtab + sec[0])]
        if name == b'.text':
            return bytearray(obj[sec[4]:sec[4] + sec[5]])
    raise SystemExit('no .text in the object')


def build():
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, 'stub.o')
        subprocess.check_call(['clang', '-target', 'armv7-none-linux-gnueabi', '-mthumb', '-c',
                               os.path.join(HERE, 'channel-keys.s'), '-o', out])
        stub = text_section(open(out, 'rb').read())
    nops = [i for i in range(0, len(stub) - 3, 2) if stub[i:i + 4] == NOP_W]
    if len(nops) != len(CALLS):
        raise SystemExit('expected %d nop.w, found %d' % (len(CALLS), len(nops)))
    for at, (target, _) in zip(nops, CALLS):
        stub[at:at + 4] = blx(BASE + at, target)
    marks = [i for i in range(0, len(stub) - 3, 4) if stub[i:i + 4] == COUNTER_MARK]
    adds = [i for i in range(0, marks[0] if marks else 0, 2) if stub[i:i + 2] == ADD_R6_PC]
    if len(marks) != 1 or len(adds) != 1:
        raise SystemExit('expected one counter offset and one add r6, pc')
    stub[marks[0]:marks[0] + 4] = struct.pack('<i', COUNTER - (BASE + adds[0] + 4))
    if BASE + len(stub) > END:
        raise SystemExit('the stub does not fit before 0x%x' % END)
    return bytes(stub)


def main():
    stub = build().hex()
    if '--check' in sys.argv:
        src = open(os.path.join(HERE, '..', '..', 'server', 'lib', 'guidepatch.js')).read()
        found = re.search(r"var CHANNEL_STUB = ([^;]+);", src)
        have = ''.join(re.findall(r"'([0-9a-f]*)'", found.group(1))) if found else ''
        print('CHANNEL_STUB matches' if have == stub else 'CHANNEL_STUB differs')
        sys.exit(0 if have == stub else 1)
    print(stub)


if __name__ == '__main__':
    main()
