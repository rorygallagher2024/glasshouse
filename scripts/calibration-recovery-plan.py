#!/usr/bin/env python3
"""Inspect a private research bundle offline. No TV connection or restore path."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

FORMAT = 'glasshouse-calibration-research-bundle'
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
REQUIRED = {
    'calibration-archive', 'picture-database', 'eeprom-first', 'eeprom-repeat',
    'emmc-nvm-first', 'emmc-nvm-repeat', 'preservation-check'
}
ROLES = REQUIRED | {'evidence', 'calibration-report'}
IDENTITY = ['model', 'firmware', 'board', 'sdk', 'binding']
PROTECTED = re.compile(r'^(?:oledtpc|oledgsr|screenshift|logoluminanceadjust)$', re.I)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique,
                      parse_constant=lambda value: require(False, 'Non-finite JSON number'))


def read_artifact(root, name, limit=MAX_FILE):
    require(isinstance(name, str) and '\\' not in name and '\x00' not in name,
            'Invalid artifact path')
    parts = name.split('/')
    require(parts and all(part not in ['', '.', '..'] for part in parts)
            and not PurePosixPath(name).is_absolute(), 'Unsafe artifact path')
    path = root
    for part in parts:
        path = path / part
        require(not path.is_symlink(), 'Symlink artifact refused')
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and before.st_size <= limit, 'Unsafe artifact file')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as handle:
        opened = os.fstat(handle.fileno())
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino)
                and opened.st_nlink == 1, 'Artifact replaced before read')
        data = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
    final = path.lstat()
    require(len(data) == before.st_size and len(data) <= limit
            and (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)
            and (final.st_dev, final.st_ino) == (before.st_dev, before.st_ino)
            and not stat.S_ISLNK(final.st_mode), 'Artifact changed during read')
    return data


def identity(value):
    require(isinstance(value, dict) and all(isinstance(value.get(key), str)
            and 0 < len(value[key]) <= 128 for key in IDENTITY), 'Invalid identity')
    require(re.fullmatch(r'OLED\d{2}C9[A-Z0-9]+', value['model']) is not None
            and value['firmware'] == '05.50.00', 'Unqualified capture profile')
    require(re.fullmatch(r'[0-9a-f]{64}', value['binding']) is not None,
            'Invalid identity binding')
    return {key: value[key] for key in IDENTITY}


def inspect_bundle(directory, target):
    root = Path(directory).absolute()
    require(root.is_dir() and not root.is_symlink(), 'Real bundle directory required')
    manifest = read_json(read_artifact(root, 'manifest.json', 128 * 1024))
    require(manifest.get('format') == FORMAT and type(manifest.get('version')) is int
            and manifest['version'] == 1, 'Unsupported research bundle')
    source = identity(manifest.get('source'))
    supplied = identity(target)
    entries = manifest.get('artifacts')
    require(isinstance(entries, list) and 1 <= len(entries) <= 256, 'Invalid artifact inventory')
    roles, paths, total = {}, set(), 0
    for entry in entries:
        require(isinstance(entry, dict) and entry.get('role') in ROLES, 'Unknown artifact role')
        require(isinstance(entry.get('path'), str) and entry['path'] not in paths,
                'Duplicate or invalid artifact path')
        paths.add(entry['path'])
        data = read_artifact(root, entry['path'])
        require(type(entry.get('size')) is int and entry['size'] == len(data)
                and entry.get('sha256') == hashlib.sha256(data).hexdigest(), 'Artifact integrity failed')
        total += len(data)
        require(total <= MAX_TOTAL, 'Research bundle exceeds size limit')
        if entry['role'] in REQUIRED:
            require(entry['role'] not in roles, 'Duplicate required artifact')
            roles[entry['role']] = data
    require(REQUIRED <= roles.keys(), 'Required evidence missing')
    archive = read_json(roles['calibration-archive'])
    require(archive.get('format') == 'glasshouse-calibration-archive'
            and type(archive.get('version')) is int and archive['version'] == 2
            and identity(archive.get('source')) == source, 'Calibration archive identity or format differs')
    files = archive.get('files')
    require(isinstance(files, list) and 0 < len(files) <= 128, 'Invalid calibration file inventory')
    calibration_paths = set()
    stored_calibration_bytes = 0
    for entry in files:
        require(isinstance(entry, dict) and isinstance(entry.get('area'), str)
                and isinstance(entry.get('name'), str) and isinstance(entry.get('data'), str),
                'Invalid stored calibration file')
        name = entry['area'] + '/' + entry['name']
        require(name not in calibration_paths and entry['area'] in ['external_pqldb', 'dolby']
                and '/' not in entry['name'] and '\\' not in entry['name']
                and entry['name'] not in ['', '.', '..'], 'Invalid stored calibration path')
        calibration_paths.add(name)
        decoded = base64.b64decode(entry['data'], validate=True)
        require(base64.b64encode(decoded).decode() == entry['data']
                and type(entry.get('size')) is int and len(decoded) == entry['size']
                and len(decoded) <= 2 * 1024 * 1024
                and hashlib.sha256(decoded).hexdigest() == entry.get('sha256'),
                'Stored calibration file integrity failed')
        stored_calibration_bytes += len(decoded)
    require(stored_calibration_bytes <= 8 * 1024 * 1024, 'Stored calibration size exceeds limit')
    calibration_manifest = {
        'created': archive.get('created'), 'source': archive['source'],
        'files': [{key: entry.get(key) for key in ['area', 'name', 'size', 'sha256']} for entry in files],
        'skippedFiles': archive.get('skippedFiles'), 'readings': archive.get('readings'),
        'format': archive['format'], 'version': archive['version']
    }
    require(isinstance(archive.get('created'), str) and isinstance(archive.get('skippedFiles'), list),
            'Invalid calibration metadata')
    canonical = json.dumps(calibration_manifest, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf8')
    require(hashlib.sha256(canonical).hexdigest() == archive.get('manifestSha256'),
            'Calibration metadata integrity failed')
    eeprom = roles['eeprom-first']
    require(len(eeprom) == 32768 and eeprom == roles['eeprom-repeat'], 'EEPROM passes differ')
    require(len(roles['emmc-nvm-first']) == 8388608
            and roles['emmc-nvm-first'] == roles['emmc-nvm-repeat'], 'eMMC NVM passes differ')
    readings = archive.get('readings', {})
    white_balance = readings.get('factoryWhiteBalance', {})
    values = []
    for temperature in ['cool', 'medium', 'warm']:
        record = white_balance.get(temperature, {})
        for key in ['redGain', 'greenGain', 'blueGain', 'redOffset', 'greenOffset', 'blueOffset']:
            value = record.get(key)
            require(type(value) is int and 0 <= value <= 255, 'Invalid white-balance reading')
            values.append(value)
    require(eeprom[0x582:0x594] == bytes(values), 'EEPROM white balance does not match getters')
    preservation = read_json(roles['preservation-check'])
    checks = ['all_29_calibration_files_unchanged', 'factory_white_balance_unchanged',
              'oled_tpc_gsr_unchanged', 'all_hdmi_edids_unchanged',
              'installed_code_unchanged', 'picture_and_oled_menu_readback_unchanged']
    require(all(preservation.get(key) is True for key in checks), 'Preservation check incomplete')
    database = read_json(roles['picture-database'])
    require(database.get('complete') is True and database.get('snapshots_match') is True,
            'Picture database snapshot is incomplete')
    inventory, excluded, seen_kinds = [], {'OledTPC', 'OledGSR', 'screenShift', 'logoLuminanceAdjust'}, set()
    expected_kinds = {'com.webos.settings.system:1', 'com.webos.settings.default:1'}
    data = database.get('data')
    require(isinstance(data, list) and len(data) == 2, 'Picture database kinds missing')
    for item in data:
        require(isinstance(item, dict) and item.get('kind') in expected_kinds
                and item['kind'] not in seen_kinds, 'Unexpected database kind')
        seen_kinds.add(item['kind'])
        records = item.get('records')
        require(isinstance(records, list) and 0 < len(records) <= 15000
                and item.get('pagination_complete') is True, 'Invalid database records')
        for record in records:
            require(isinstance(record, dict) and isinstance(record.get('category'), str)
                    and record['category'].split('$')[0] in ['picture', 'aspectRatio', 'aiPicture', 'whiteBalance', 'calibration']
                    and isinstance(record.get('value'), dict)
                    and isinstance(record.get('app_id', ''), str), 'Out-of-scope database record')
            excluded.update(key for key in record['value'] if PROTECTED.fullmatch(key))
        inventory.append({'kind': item['kind'], 'records': len(records),
                          'appSpecificRecords': sum(record.get('app_id', '') not in ['', 'default']
                                                    for record in records)})
    blockers = [
        'Panel identity and panel replacement history are unverified',
        'Reset survival and required restoration fields are unqualified',
        'Original versus effective LUT semantics and enable flags are unqualified',
        'Calibration upload/reload ordering and cache synchronization are unqualified',
        'TV-local interruption recovery and rollback are unqualified',
        'Post-reset access and representative-C9 reset/restore measurements are unqualified',
        'This offline inspector has no restore executor'
    ]
    if source != supplied:
        blockers.insert(0, 'Supplied target identity or firmware differs from the archive')
    return {
        'format': 'glasshouse-calibration-recovery-preview', 'version': 1,
        'artifactIntegrity': 'verified', 'artifacts': len(entries), 'storedBytes': total,
        'suppliedTargetIdentityMatches': source == supplied,
        'eepromBytes': len(eeprom), 'emmcNvmBytes': len(roles['emmc-nvm-first']),
        'storedCalibrationFiles': len(files), 'storedCalibrationBytes': stored_calibration_bytes,
        'factoryWhiteBalanceValuesMatched': len(values), 'pictureDatabase': inventory,
        'protectedSettingsExcludedFromFutureRestore': sorted(excluded),
        'restoreAllowed': False, 'rawNvmWritesAllowed': False, 'actions': [],
        'blockers': blockers,
        'qualificationSequence': [
            'Confirm target panel, firmware and access after reset',
            'Capture independent pre-restore evidence and prepare TV-local recovery',
            'Qualify Dolby Vision configuration before custom Dolby Vision LUTs',
            'Qualify original LUTs, enable flags and range/input associations',
            'Qualify a settings merge that excludes OLED protections and DB record IDs',
            'Verify reload, stored bytes, live modes and measured picture output',
            'Commit only after verification; test interruption recovery on a lab TV'
        ],
        'limitations': ['Checksums detect damage, not authenticity',
                        'Matching supplied identity is not a live TV or panel identity check',
                        'Captured NVM images are evidence, not flashable recovery files']
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', help='Private research-bundle directory')
    parser.add_argument('--target-identity', required=True, help='Local JSON identity from a separate read-only target capture')
    arguments = parser.parse_args()
    path = Path(arguments.target_identity)
    require(path.stat().st_size <= 4096, 'Target identity file is oversized')
    print(json.dumps(inspect_bundle(arguments.bundle, read_json(path.read_bytes())), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        raise SystemExit('Recovery preview refused: ' + str(error))
