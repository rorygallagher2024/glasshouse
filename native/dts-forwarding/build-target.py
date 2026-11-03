"""Build the separate native target from matched, private device artefacts."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import struct

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--inputs', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--apply', action='store_true', help='build the native route with a renewable 20-second producer lease')
parser.add_argument('--source-index', type=int, choices=(0, 1), default=0)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
image = (args.inputs / 'kernel.bin').read_bytes()
expected = 'c219532590e1d691a459ef8c0faab95745d04d36b6cbee4a32685409f3e7460e'
if hashlib.sha256(image).hexdigest() != expected:
    raise SystemExit('Unrecognised native target image')
symbols = {}
for line in (args.inputs / 'kallsyms.txt').read_text().splitlines():
    fields = line.split()
    if len(fields) == 3:
        symbols.setdefault(fields[2], []).append(int(fields[0], 16))

def address(name):
    values = symbols.get(name, [])
    if len(values) != 1:
        raise SystemExit('Target symbol is not unique: ' + name)
    return values[0]

def readelf(*arguments):
    return subprocess.check_output(['aarch64-linux-gnu-readelf', *map(str, arguments)], text=True)

def module_abi(path):
    sections = readelf('-SW', path)
    row = next(line for line in sections.splitlines() if '.gnu.linkonce.this_module ' in line and 'RELA' not in line)
    size = int(row.split('PROGBITS')[1].split()[2], 16)
    info = readelf('-p', '.modinfo', path)
    magic = next(line.split('vermagic=')[1] for line in info.splitlines() if 'vermagic=' in line)
    relocations = readelf('-rW', path).split("Relocation section '.rela.gnu.linkonce.this_module'")[1]
    offsets = {name: int(re.search(r'^([0-9a-f]+).* ' + name + r' \+', relocations, re.M).group(1), 16)
               for name in ('init_module', 'cleanup_module')}
    return {'size': size, 'vermagic': magic, **offsets}

stock = module_abi(args.inputs / 'stock-module.ko')
if stock['size'] != 0x380 or stock['init_module'] != 0x150 or stock['cleanup_module'] != 0x338:
    raise SystemExit('Unrecognised stock module ABI')
functions = {'NATIVE_PRINTK': 'printk', 'NATIVE_BM_GET': 'bm_get_block_info_by_index',
             'NATIVE_CONNECT': 'bm_connect_block', 'NATIVE_DISCONNECT': 'bm_disconnect_block',
             'NATIVE_HAL_FORMAT': 'audio_hal_earc_set_output_format',
             'NATIVE_PCM_HEAD': 'renderer_get_uid_pcm_bypass_head',
             'NATIVE_SEND_COMMAND': 'aimc_send_command',
             'NATIVE_UPDATE_CLOCK': 'aud_clock_update_output',
             'NATIVE_CLOCK_CALLBACK': 'aud_hal_set_arc_sample_rate',
             'NATIVE_HAL_CHANNEL': 'audio_hal_earc_set_channel',
             'NATIVE_HAL_MUTE': 'audio_hal_earc_set_mute',
             'NATIVE_HAL_AUDIO_MODE': 'audio_hal_earc_set_audio_mode',
             'NATIVE_HAL_SET_ON': 'audio_hal_earc_set_on',
             'NATIVE_FIND_BLOCK': '_bm_find_block_by_block_info',
             'NATIVE_GET_PORT': '_bm_get_block_port',
             'NATIVE_CONNECT_LOCKED': '_bm_connect_block_locked',
             'NATIVE_DISCONNECT_LOCKED': '_bm_disconnect_block_locked'}
base = 0xffffffc010088000
header = ['/* Generated only for the analysed OLED83G54LW 33.31.68 target. */']
checks = []
for macro, name in functions.items():
    location = address(name)
    data = image[location - base:location - base + 64]
    if len(data) != 64:
        raise SystemExit('Symbol outside captured kernel: ' + name)
    header.append('#define ' + macro + ' ' + hex(location) + 'UL')
    checks.append({'name': name, 'address': hex(location), 'bytes': data.hex()})
# Data addresses recovered from the disassembly of the eARC HAL and block-manager functions on this image.
header += ['#define NATIVE_HAL_NONPCM 0xffffffc01264d5c4UL',
           '#define NATIVE_HAL_CS0 0xffffffc01264d5b8UL',
           '#define NATIVE_HAL_CS2 0xffffffc01264d5c0UL',
           '#define NATIVE_HAL_CHANNEL_COUNT 0xffffffc0122a7e68UL',
           '#define NATIVE_HAL_CHANNEL_ACMOD 0xffffffc0122a7eccUL',
           '#define NATIVE_HAL_CONTROL 0xffffffc0122a7e74UL',
           '#define NATIVE_OUTPUT_CLOCK_ENTRY 0xffffffc0122a1fe0UL',
           '#define NATIVE_HAL_RATE 0xffffffc0122a7ec8UL',
           '#define NATIVE_BM_MUTEX 0xffffffc01264cc98UL',
           '#define NATIVE_VERMAGIC ' + json.dumps('vermagic=' + stock['vermagic']),
           'static const struct { unsigned long address; unsigned char bytes[64]; } native_checks[] = {']
for check in checks:
    header.append(' {' + check['address'] + 'UL, {' + ','.join('0x' + check['bytes'][at:at + 2] for at in range(0, 128, 2)) + '}},')
header.append('};\n')
(args.output / 'target.h').write_text('\n'.join(header))
source = Path(__file__).resolve().parent / 'native-route.c'
module = args.output / ('gh_dts_native-apply' + str(args.source_index) + '.ko' if args.apply else 'gh_dts_native.ko')
subprocess.run(['aarch64-linux-gnu-gcc', '-c', '-O2', '-Wall', '-Wextra', '-Werror',
                '-fno-stack-protector', '-fno-pic', '-fno-pie', '-fno-asynchronous-unwind-tables',
                '-ffreestanding', '-fno-builtin', '-mgeneral-regs-only', '-mno-outline-atomics',
                '-DNATIVE_APPLY=' + str(int(args.apply)), '-DNATIVE_SOURCE_INDEX=' + str(args.source_index),
                '-I', str(args.output), str(source), '-o', str(module)], check=True)
actual = module_abi(module)
if actual != stock:
    raise SystemExit('Built module ABI differs from stock: ' + repr(actual))
undefined = subprocess.check_output(['aarch64-linux-gnu-nm', '-u', str(module)], text=True)
imports = {line.split()[-1] for line in undefined.splitlines() if line.strip()}
standard = {'kthread_create_on_node', 'wake_up_process', 'kthread_stop', 'kthread_should_stop', 'msleep',
            'param_set_uint', 'param_get_uint'}
standard.update({'mutex_lock', 'mutex_unlock'})
if imports - standard:
    raise SystemExit('Unexpected unresolved imports: ' + repr(imports - standard))
# The scheduler APIs use the kernel's ordinary exported-symbol relocations.
# Two kthread_stop instructions differ in the live image; its exported ABI
# avoids depending on the unestablished cause of those runtime text changes.
positions = {}
for name in imports:
    needle = b'\0' + name.encode() + b'\0'
    at = image.find(needle)
    while at >= 0:
        positions[at + 1] = name
        at = image.find(needle, at + 1)
exports = {}
for index, (relative,) in enumerate(struct.iter_unpack('<i', image[:len(image) // 4 * 4])):
    at = index * 4
    name = positions.get(at + relative)
    if name and at >= 4 and at + 8 <= len(image):
        value = at - 4 + struct.unpack_from('<i', image, at - 4)[0]
        namespace = at + 4 + struct.unpack_from('<i', image, at + 4)[0]
        if base + value == address(name) and 0 <= namespace < len(image) and image[namespace] == 0:
            exports[name] = hex(base + value)
if set(exports) != imports:
    raise SystemExit('Imports not proved in target PREL32 exports: ' + repr(imports - set(exports)))
manifest = {'model': 'OLED83G54LW.BEKYLJP', 'firmware': '33.31.68',
            'kernel': '5.4.268-329.ptl4tv.5', 'kernelSha256': expected,
            'abi': actual, 'checks': checks, 'mode': 'producer-leased route' if args.apply else 'audit only',
            'standardExports': exports,
            'sourceIndex': args.source_index,
            'moduleSha256': hashlib.sha256(module.read_bytes()).hexdigest()}
(args.output / ('native-target-apply' + str(args.source_index) + '.json' if args.apply else 'native-target.json')).write_text(json.dumps(manifest, indent=2) + '\n')
print('Built exact-target module; stock ABI, exports and code guards checked:', module)
