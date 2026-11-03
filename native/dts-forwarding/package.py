"""Assemble an already-built, exact-target native forwarding package."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('build', type=Path)
args = parser.parse_args()
source = Path(__file__).resolve().parent
destination = args.build / 'native-package'
(destination / 'gst').mkdir(parents=True, exist_ok=True)
files = {'control.py': source / 'control.py',
         'gst/libgstghdts.so': args.build / 'libgstghdts.so'}
for index in (0, 1):
    name = 'gh_dts_native-apply' + str(index) + '.ko'
    manifest = json.loads((args.build / ('native-target-apply' + str(index) + '.json')).read_text())
    if hashlib.sha256((args.build / name).read_bytes()).hexdigest() != manifest['moduleSha256']:
        raise SystemExit('Module differs from its target build manifest')
    files[name] = args.build / name
manifest = {'target': {'modelName': 'OLED83G54LW.BEKYLJP', 'firmwareVersion': '33.31.68'}, 'files': {}}
for name, path in files.items():
    shutil.copyfile(path, destination / name)
    manifest['files'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
shutil.copyfile(source / '90-glasshouse-dts-native', destination / '90-glasshouse-dts-native')
print('Package:', destination)
print('Audio profile file pins:', json.dumps(manifest['files'], indent=2))
