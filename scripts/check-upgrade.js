#!/usr/bin/env node
/*
 * Has the updater of earlier releases install this tree, as a TV does when it
 * updates in place, and fails if one refuses it.
 *
 * The unit tests run this tree's updater against this tree, a pairing that
 * never happens on a TV: there, the updater already installed checks the
 * release it downloads. 0.82.0 moved TVWEB_VERSION past the first 4096 bytes
 * of tvweb.js, which 0.82.1's updater was the last to read, and every in-place
 * update failed (#586).
 *
 * The earlier updaters come from the release tags (CI fetches them). Their
 * download client is a stand-in curl that answers the release check with this
 * tree's version and the download with an archive of this tree, laid out as
 * GitHub's is, and it is the only client they can find: nothing goes to the
 * network. Uncommitted changes to tracked files are included.
 *
 *   node scripts/check-upgrade.js
 */
'use strict';
const child = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The oldest release still reported in use (a C9 on 0.80.8, #586). The latest
// release is always tested as well; raise this once 0.80 is long gone.
const OLDEST = 'v0.80.8';

const git = args => child.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function version(src) {
  const m = /^var TVWEB_VERSION = '([^']+)';/m.exec(src);
  if (!m) throw new Error('no TVWEB_VERSION in server/tvweb.js');
  return m[1];
}

function releases() {
  const latest = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD']);
  return latest === OLDEST ? [latest] : [OLDEST, latest];
}

// Stand-in curl: the release check gets JSON naming this tree's version, the
// tarball URL gets the archive, anything else a 404. Arguments as fetch.js
// builds them: ... -o <file|-> -- <url>
const FAKE_CURL = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const url = a[a.length - 1];
const out = a[a.indexOf('-o') + 1];
const write = data => { if (out === '-') process.stdout.write(data); else fs.writeFileSync(out, data); };
if (/api\\.github\\.com\\/repos\\/.*\\/releases\\/latest/.test(url)) {
  write(JSON.stringify({ tag_name: 'v' + process.env.UPGRADE_VERSION, html_url: 'https://example.invalid/', body: 'test' }));
} else if (/codeload\\.github\\.com\\/.*\\/tar\\.gz\\/refs\\/tags\\/v/.test(url)) {
  write(fs.readFileSync(process.env.UPGRADE_TARBALL));
} else {
  process.stderr.write('curl: (22) The requested URL returned error: 404\\n');
  process.exit(22);
}
`;

function installWith(tag, work, tarball, ver, want) {
  const dir = path.join(work, tag);
  const installDir = path.join(dir, 'installed');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(bin);
  // The release as a TV has it installed: its updater runs from here.
  child.execSync(`git archive ${tag} server | tar -x -C "${dir}"`, { cwd: ROOT });
  child.execSync(`cp -R "${path.join(dir, 'server')}/." "${installDir}"`);
  fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  // The updater finds tar where it finds curl.
  fs.symlinkSync(child.execSync('command -v tar', { encoding: 'utf8', shell: '/bin/sh' }).trim(), path.join(bin, 'tar'));

  const updater = require(path.join(installDir, 'lib', 'updater.js'));
  const fetch = require(path.join(installDir, 'lib', 'fetch.js'));
  const config = { allowControl: true, update: { check: true, client: path.join(bin, 'curl') } };
  updater.init({ config, version: version(fs.readFileSync(path.join(installDir, 'tvweb.js'), 'utf8')), installDir });
  fetch.init({ config, clientDirs: [bin] });

  return new Promise(resolve => {
    updater.installUpdate({ force: true }, r => {
      if (!r || !r.ok || !r.updated) return resolve(tag + ': refused - ' + ((r && (r.error || r.note)) || 'no answer'));
      const got = fs.readFileSync(path.join(installDir, 'tvweb.js'), 'utf8');
      if (got !== want) return resolve(tag + ': installed a tvweb.js that is not this tree\'s');
      resolve(null);
    });
  });
}

(async () => {
  const want = fs.readFileSync(path.join(ROOT, 'server', 'tvweb.js'), 'utf8');
  const ver = version(want);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-upgrade-'));
  process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

  // As GitHub lays out a tag's tarball: everything under <repo>-<version>/.
  // stash create fails while another git command holds the index lock; the
  // last commit is then the tree, without uncommitted changes.
  let tree = 'HEAD';
  try { tree = git(['stash', 'create']) || 'HEAD'; } catch (e) { console.log('git stash create failed, checking HEAD: ' + e.message.split('\n')[0]); }
  const tarball = path.join(work, 'release.tar.gz');
  child.execFileSync('git', ['archive', '--format=tar.gz', '--prefix=glasshouse-' + ver + '/', '-o', tarball, tree], { cwd: ROOT });
  process.env.UPGRADE_VERSION = ver;
  process.env.UPGRADE_TARBALL = tarball;

  const from = releases();
  const problems = [];
  for (const tag of from) {
    const p = await installWith(tag, work, tarball, ver, want);
    if (p) problems.push(p);
  }
  for (const p of problems) console.log(p);
  console.log(problems.length
    ? 'v' + ver + ' cannot be installed in place by ' + problems.length + ' of ' + from.join(', ')
    : 'v' + ver + ' installs in place from ' + from.join(' and '));
  process.exit(problems.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
