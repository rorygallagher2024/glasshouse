/**
 * test/test-remotedetect.js - which remotes are in use: the paired remote, the
 * remote_type of presses in the log, and what was seen before
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var detect = require('../server/lib/remotedetect');

console.log('Running test-remotedetect.js ...');

var dir = path.join(os.tmpdir(), 'remotedetect-' + process.pid);
fs.mkdirSync(dir);
var LOG = path.join(dir, 'messages');
var DEVICES = path.join(dir, 'devices');
var SEEN = path.join(dir, 'remotes-seen.json');

function press(time, remote, button) {
  return time + ' [60] user.info lginput2 [] lginput2 NL_BUTTON_CLICK {"remote_type":"' + remote + '","button_type":"' + button + '"} \n';
}
var NOISE = '2026-10-18T11:36:00.000Z [60] user.info lginput2 [] lginput2 NL_SOMETHING_ELSE {"remote_type":"LGE MR99"} \n';

var clock = Date.parse('2026-11-18T12:00:00.000Z');
var paired = null;
function start() {
  detect.init({ pairing: function () { return paired; }, stateDir: dir, messagesPath: LOG, devicesPath: DEVICES, now: function () { return clock; } });
}
function names(r) { return r.remotes.map(function (x) { return x.name; }); }

function steps(list, done) {
  var i = 0;
  (function next() {
    if (i === list.length) return done();
    list[i++](next);
  })();
}

steps([
  // Nothing readable: no remotes, no failure
  function (next) {
    start();
    detect.detect(function (r) {
      assert.deepEqual(r.remotes, []);
      assert.deepEqual(r.devices, []);
      console.log('  ✓ with no pairing file, log or devices there is nothing, and no error');
      next();
    }, true);
  },
  // The paired remote is current and found in the catalogue
  function (next) {
    start();
    paired = { model: 'LGE MR25GA', mac: 'AA:BB:CC:00:11:22' };
    detect.detect(function (r) {
      assert.strictEqual(r.remotes.length, 1);
      var m = r.remotes[0];
      assert.strictEqual(m.name, 'LGE MR25GA');
      assert.strictEqual(m.id, 'MR25GA');
      assert.strictEqual(m.title, 'Magic Remote MR25GA');
      assert.strictEqual(m.image, 'generic.png', 'no picture of its own: the generic outline');
      assert.strictEqual(m.current, true);
      assert.deepEqual(m.sources, ['pairing']);
      console.log('  ✓ the paired remote is current and found in the catalogue');
      next();
    }, true);
  },
  // Only names and times are kept, no address
  function (next) {
    var raw = fs.readFileSync(SEEN, 'utf8');
    assert.ok(raw.indexOf('LGE MR25GA') !== -1);
    assert.ok(raw.toUpperCase().indexOf('AA:BB:CC') === -1, 'no address in what is kept');
    console.log('  ✓ what is kept is the name and the time, not the address');
    next();
  },
  // Presses in the log: a second remote, an unknown name, other lines ignored, the latest press wins
  function (next) {
    fs.writeFileSync(LOG, NOISE +
      press('2026-11-18T11:00:00.000Z', 'LGE MR99', 'KEY_NETFLIX') +
      press('2026-11-18T11:30:00.000Z', 'LGE MR99', 'KEY_AMAZON') +
      press('2026-11-18T11:45:00.000Z', 'LGE MR25GA', 'KEY_NETFLIX') +
      'not a log line\n');
    start();
    detect.detect(function (r) {
      assert.deepEqual(names(r), ['LGE MR25GA', 'LGE MR99'], 'the paired remote first, then by last press');
      var mr26 = r.remotes[0], other = r.remotes[1];
      assert.deepEqual(mr26.sources, ['pairing', 'log']);
      assert.strictEqual(other.id, null, 'a remote the catalogue lacks has no id');
      assert.strictEqual(other.title, 'LGE MR99');
      assert.strictEqual(other.image, 'generic.png');
      assert.strictEqual(other.current, false);
      assert.strictEqual(other.lastSeen, Date.parse('2026-11-18T11:30:00.000Z'), 'its latest press');
      assert.deepEqual(other.sources, ['log']);
      console.log('  ✓ the log finds a second remote and the latest press of each, and an unknown remote has no id');
      next();
    }, true);
  },
  // Remembered when it is no longer pressed or paired
  function (next) {
    fs.writeFileSync(LOG, '');
    paired = null;
    clock += 3 * 24 * 3600 * 1000;
    start();
    detect.detect(function (r) {
      assert.deepEqual(names(r), ['LGE MR25GA', 'LGE MR99'], 'the later sighting first');
      r.remotes.forEach(function (x) {
        assert.deepEqual(x.sources, ['seen']);
        assert.strictEqual(x.current, false);
      });
      console.log('  ✓ a remote seen before still counts when it is neither paired nor pressed now');
      next();
    }, true);
  },
  // Cached for 30 s, read again when asked fresh
  function (next) {
    start();
    fs.writeFileSync(LOG, press('2026-11-21T11:00:00.000Z', 'LGE MR100', 'KEY_HOME'));
    detect.detect(function (first) {
      assert.ok(names(first).indexOf('LGE MR100') !== -1);
      fs.writeFileSync(LOG, press('2026-11-21T11:01:00.000Z', 'LGE MR101', 'KEY_HOME'));
      clock += 5000;
      detect.detect(function (again) {
        assert.strictEqual(again, first, 'the same reading within 30 s');
        clock += detect.CACHE_MS;
        detect.detect(function (later) {
          assert.ok(names(later).indexOf('LGE MR101') !== -1, 'read again after 30 s');
          detect.detect(function (forced) {
            assert.notStrictEqual(forced, later, 'read again when asked fresh');
            console.log('  ✓ a reading is reused for 30 seconds, and read again after that or when asked fresh');
            next();
          }, true);
        });
      });
    });
  },
  // Only the end of a long log is read, from a whole line
  function (next) {
    var filler = '';
    var line = '2026-11-18T10:00:00.000Z [60] user.info other [] something that is not a press, padding the log out\n';
    while (filler.length < 300 * 1024) filler += line;
    fs.writeFileSync(LOG, press('2026-11-18T09:00:00.000Z', 'LGE MROLD', 'KEY_HOME') + filler +
      press('2026-11-18T11:59:00.000Z', 'LGE MRNEW', 'KEY_HOME'));
    start();
    detect.detect(function (r) {
      assert.ok(names(r).indexOf('LGE MRNEW') !== -1, 'a recent press is found');
      assert.ok(names(r).indexOf('LGE MROLD') === -1, 'one beyond the end read is not');
      console.log('  ✓ only the end of a long log is read');
      next();
    }, true);
  },
  // The names kept are limited
  function (next) {
    var text = '';
    for (var i = 0; i < detect.SEEN_MAX + 5; i++) {
      text += press('2026-11-18T11:' + (10 + i) + ':00.000Z', 'LGE MRX' + i, 'KEY_HOME');
    }
    fs.writeFileSync(LOG, text);
    start();
    detect.detect(function () {
      var kept = JSON.parse(fs.readFileSync(SEEN, 'utf8')).remotes;
      assert.ok(Object.keys(kept).length <= detect.SEEN_MAX, 'at most ' + detect.SEEN_MAX + ' names kept');
      console.log('  ✓ the names kept are limited, the oldest going first');
      next();
    }, true);
  },
  // Input devices are only a hint of the family
  function (next) {
    fs.writeFileSync(LOG, '');
    fs.writeFileSync(DEVICES,
      'I: Bus=0003 Vendor=1004\nN: Name="LGE M-RCU - Builtin [0]"\nH: Handlers=event3\n\n' +
      'N: Name="LGE M-RCU - Builtin [1]"\nH: Handlers=event4\n\n' +
      'N: Name="Smart Remote RCU Input"\nH: Handlers=event11\n\n' +
      'N: Name="ClickableMouse"\nH: Handlers=event9\n');
    start();
    detect.detect(function (r) {
      assert.deepEqual(r.devices, ['LGE M-RCU', 'Smart Remote RCU Input'], 'family names once each, other devices left out');
      console.log('  ✓ the remote input devices give a family hint, once each');
      next();
    }, true);
  },
  // Classic syslog timestamps keep their actual time instead of falling back to now
  function (next) {
    var ref = Date.parse('2026-01-10T12:00:00.000Z');
    var parsed = detect.pressesIn('Nov  5 10:15:30 tv user.info lginput2 NL_BUTTON_CLICK {"remote_type":"LGE MR20GA","button_type":"KEY_HOME"}\n', ref);
    var expected = new Date(2025, 10, 5, 10, 15, 30).getTime();
    assert.strictEqual(parsed['LGE MR20GA'], expected);
    console.log('  ✓ classic syslog timestamps keep their date rather than falling back to now');
    next();
  },
  // Automatic selection: paired now or seen in the last 30 days
  function (next) {
    var day = 24 * 3600 * 1000;
    var found = { remotes: [
      { name: 'LGE MR25GA', current: true, lastSeen: clock },
      { name: 'LGE MR99', current: false, lastSeen: clock - 29 * day },
      { name: 'LGE MR98', current: false, lastSeen: clock - 31 * day },
      { name: 'LGE MR97', current: false, lastSeen: null }
    ] };
    var picked = detect.autoSelected(found, clock);
    assert.strictEqual(picked.length, 2, 'the paired one and the one seen 29 days ago');
    assert.strictEqual(picked[0].id, 'MR25GA', 'a catalogued remote is its entry');
    assert.strictEqual(picked[1], null, 'one the catalogue lacks is null');
    assert.deepEqual(detect.autoSelected({ remotes: [] }, clock), []);
    assert.deepEqual(detect.autoSelected(null, clock), []);
    console.log('  ✓ Automatic means the remote paired now and those seen in the last 30 days');
    next();
  }
], function () {
  [LOG, DEVICES, SEEN].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
  try { fs.unlinkSync(SEEN + '.tmp'); } catch (e) {}
  fs.rmdirSync(dir);
  console.log('test-remotedetect.js passed');
});
