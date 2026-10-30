/* Host-only offline inspector; the native TV test pass does not run Python 3. */
if (Number(process.versions.node.split('.')[0]) < 8) {
  console.log('test-calibration-recovery-plan.js: skipped on legacy node (host tool)');
} else {
  var child = require('child_process');
  var path = require('path');
  var result = child.spawnSync('python3', ['-B', path.join(__dirname, 'test-calibration-recovery-plan.py')], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(String(result.error || result.stderr || result.stdout));
  console.log(result.stderr.trim());
}
