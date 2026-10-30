"""Host-only synthetic recovery evidence. Never opens a TV or hardware device."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/calibration-recovery-plan.py'
SPEC = importlib.util.spec_from_file_location('recovery_plan', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SOURCE = {'model': 'OLED65C9PUA', 'firmware': '05.50.00', 'board': 'synthetic', 'sdk': '4.10.2', 'binding': 'a' * 64}


class RecoveryPlanTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='glasshouse-recovery-plan-'))
        white_balance = {temperature: dict(zip(['redGain', 'greenGain', 'blueGain', 'redOffset', 'greenOffset', 'blueOffset'], range(6))) for temperature in ['cool', 'medium', 'warm']}
        eeprom = bytearray(32768)
        eeprom[0x582:0x594] = bytes(list(range(6)) * 3)
        calibration_file = {'area': 'external_pqldb', 'name': 'expert1_profile0_BT709_3D_LUT_DATA', 'size': 3, 'sha256': hashlib.sha256(b'abc').hexdigest(), 'data': base64.b64encode(b'abc').decode()}
        self.archive = {'format': 'glasshouse-calibration-archive', 'version': 2, 'created': '2026-01-01T00:00:00Z', 'source': copy.deepcopy(SOURCE), 'files': [calibration_file], 'skippedFiles': [], 'readings': {'factoryWhiteBalance': white_balance, 'pictureContexts': []}}
        calibration_manifest = {key: self.archive[key] for key in ['created', 'source']}
        calibration_manifest.update(files=[{key: calibration_file[key] for key in ['area', 'name', 'size', 'sha256']}], skippedFiles=[], readings=self.archive['readings'], format=self.archive['format'], version=2)
        self.archive['manifestSha256'] = hashlib.sha256(json.dumps(calibration_manifest, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        database = {'complete': True, 'snapshots_match': True, 'data': []}
        for kind in ['com.webos.settings.system:1', 'com.webos.settings.default:1']:
            database['data'].append({'kind': kind, 'pagination_complete': True, 'records': [{'category': 'picture$default.expert1.2d.x', 'app_id': '', 'value': {'contrast': 85, 'logoLuminanceAdjust': 'light'}}]})
        checks = {key: True for key in ['all_29_calibration_files_unchanged', 'factory_white_balance_unchanged', 'oled_tpc_gsr_unchanged', 'all_hdmi_edids_unchanged', 'installed_code_unchanged', 'picture_and_oled_menu_readback_unchanged']}
        contents = {
            'calibration-archive': json.dumps(self.archive).encode(),
            'picture-database': json.dumps(database).encode(),
            'eeprom-first': bytes(eeprom), 'eeprom-repeat': bytes(eeprom),
            'emmc-nvm-first': bytes(8388608), 'emmc-nvm-repeat': bytes(8388608),
            'preservation-check': json.dumps(checks).encode()
        }
        self.manifest = {'format': MODULE.FORMAT, 'version': 1, 'source': copy.deepcopy(SOURCE), 'artifacts': []}
        for role, content in contents.items():
            (self.root / role).write_bytes(content)
            self.manifest['artifacts'].append({'role': role, 'path': role, 'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        self.save_manifest()

    def tearDown(self):
        shutil.rmtree(self.root)

    def save_manifest(self):
        (self.root / 'manifest.json').write_text(json.dumps(self.manifest))

    def replace(self, role, data):
        entry = next(item for item in self.manifest['artifacts'] if item['role'] == role)
        (self.root / entry['path']).write_bytes(data)
        entry.update(size=len(data), sha256=hashlib.sha256(data).hexdigest())
        self.save_manifest()

    def preview(self, target=None):
        return MODULE.inspect_bundle(self.root, SOURCE if target is None else target)

    def test_verified_bundle_has_no_restore_actions(self):
        result = self.preview()
        self.assertEqual(result['artifactIntegrity'], 'verified')
        self.assertFalse(result['restoreAllowed'])
        self.assertFalse(result['rawNvmWritesAllowed'])
        self.assertEqual(result['actions'], [])
        self.assertEqual(result['factoryWhiteBalanceValuesMatched'], 18)
        self.assertIn('logoLuminanceAdjust', result['protectedSettingsExcludedFromFutureRestore'])
        self.assertTrue(result['blockers'])

    def test_claimed_complete_cannot_enable_restoration(self):
        self.manifest.update(complete=True, restoreAllowed=True, panelIdentityVerified=True)
        self.save_manifest()
        result = self.preview()
        self.assertFalse(result['restoreAllowed'])
        self.assertEqual(result['actions'], [])

    def test_other_identity_stays_blocked(self):
        target = dict(SOURCE, binding='b' * 64)
        result = self.preview(target)
        self.assertFalse(result['suppliedTargetIdentityMatches'])
        self.assertIn('differs', result['blockers'][0])

    def test_unqualified_firmware_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'Unqualified'):
            self.preview(dict(SOURCE, firmware='99.99.99'))

    def test_damaged_artifact_is_refused(self):
        (self.root / 'eeprom-first').write_bytes(b'damaged')
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.preview()

    def test_disagreeing_physical_passes_are_refused_even_when_rehashed(self):
        self.replace('eeprom-repeat', bytes(32768))
        with self.assertRaisesRegex(ValueError, 'passes differ'):
            self.preview()

    def test_getter_and_eeprom_disagreement_is_refused(self):
        self.replace('eeprom-first', bytes(32768))
        self.replace('eeprom-repeat', bytes(32768))
        with self.assertRaisesRegex(ValueError, 'white balance'):
            self.preview()

    def test_calibration_metadata_damage_is_refused(self):
        self.archive['readings']['factoryWhiteBalance']['cool']['redGain'] = 99
        self.replace('calibration-archive', json.dumps(self.archive).encode())
        with self.assertRaisesRegex(ValueError, 'metadata integrity'):
            self.preview()

    def test_checksum_significant_json_order_is_preserved(self):
        self.replace('calibration-archive', json.dumps(self.archive, sort_keys=True).encode())
        with self.assertRaisesRegex(ValueError, 'metadata integrity'):
            self.preview()

    def test_disagreeing_emmc_passes_are_refused(self):
        self.replace('emmc-nvm-repeat', bytes(8388607) + b'X')
        with self.assertRaisesRegex(ValueError, 'eMMC NVM passes differ'):
            self.preview()

    def test_oversized_artifacts_are_refused_before_loading(self):
        with (self.root / 'eeprom-first').open('r+b') as handle:
            handle.truncate(MODULE.MAX_FILE + 1)
        with self.assertRaisesRegex(ValueError, 'Unsafe artifact file'):
            self.preview()

    def test_required_evidence_cannot_be_omitted_or_duplicated(self):
        entry = self.manifest['artifacts'].pop()
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.preview()
        self.manifest['artifacts'].extend([entry, dict(entry, path='other')])
        (self.root / 'other').write_bytes((self.root / entry['path']).read_bytes())
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Duplicate required'):
            self.preview()

    def test_traversal_and_symlinks_are_refused(self):
        entry = self.manifest['artifacts'][0]
        original = entry['path']
        entry['path'] = '../outside'
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Unsafe artifact path'):
            self.preview()
        entry['path'] = 'link'
        (self.root / 'link').symlink_to(self.root / original)
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            self.preview()

    def test_hardlinks_and_duplicate_json_keys_are_refused(self):
        os.link(self.root / 'eeprom-first', self.root / 'alias')
        with self.assertRaisesRegex(ValueError, 'Unsafe artifact file'):
            self.preview()
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            MODULE.read_json('{"version":1,"version":2}')

    def test_incomplete_database_is_refused(self):
        data = json.loads((self.root / 'picture-database').read_bytes())
        data['data'][0]['pagination_complete'] = False
        self.replace('picture-database', json.dumps(data).encode())
        with self.assertRaisesRegex(ValueError, 'Invalid database records'):
            self.preview()

    def test_unrelated_database_values_are_refused(self):
        data = json.loads((self.root / 'picture-database').read_bytes())
        data['data'][0]['records'][0]['category'] = 'account'
        self.replace('picture-database', json.dumps(data).encode())
        with self.assertRaisesRegex(ValueError, 'Out-of-scope'):
            self.preview()


if __name__ == '__main__':
    unittest.main()
