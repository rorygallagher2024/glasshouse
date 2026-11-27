#!/usr/bin/env node
/*
 * scripts/gen-remote-keys-doc.js - docs/development/remote-keys.md, how each
 * Remote tab key is offered and known at each layer of the TV, made from
 * KEYS in server/lib/remotekeys.js and a TV's LG key table fixture
 * (test/fixtures/lg-keytable-*.txt).
 *
 *   node scripts/gen-remote-keys-doc.js           write the page
 *   node scripts/gen-remote-keys-doc.js --check   exit 1 where the page is out of date
 *
 * test/test-remote-keys-doc.js requires this file directly and runs under
 * node 0.10 and 0.12 in CI, so it is strict ES5 like the server, even though
 * nothing here ever runs on a TV.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'docs', 'development', 'remote-keys.md');
var KEY_TABLE = path.join(ROOT, 'test', 'fixtures', 'lg-keytable-oled48c56lb-webos10.txt');
var KEY_TABLE_TV = 'an OLED48C56LB (webOS 10.3.0)';

function webos10Summary(def, none) {
  if (def.nativeOnly || def.nativeMapping) return none;
  if (def.keyTable) return 'yes (key table checked)';
  if (def.fromPlugin) return 'yes (incl. webOS 4)';
  return 'yes';
}

function webos11Summary(rk, def, none) {
  if (def.blockCode && rk.CHANNEL_EVDEV_CODES[def.key]) return 'yes (key handler patch, or observes presses)';
  if (def.key === 'input' || def.blockCode) return 'yes (key handler patch)';
  if (rk.COLOR_CODES[def.key]) return 'yes (observes presses)';
  if (rk.NATIVE_BLOCK_KEYS[def.key]) return 'yes (blocks Alexa)';
  if (rk.NATIVE_SERVICE_KEYS[def.key]) return 'yes (turns off voice)';
  if (rk.NATIVE_ACTIONS[def.key] || rk.NATIVE_SETTINGS[def.key]) return 'yes';
  if (def.nativeMapping || !(def.nativeOnly || def.filterOnly || def.color)) return 'yes (where listed)';
  return none;
}

function webos11Mechanism(rk, def, none) {
  if (def.blockCode && rk.CHANNEL_EVDEV_CODES[def.key]) return 'key handler (`lib/guidepatch`), or observed evdev press';
  if (def.key === 'input' || def.blockCode) return 'key handler (`lib/guidepatch`)';
  if (rk.COLOR_CODES[def.key]) return 'observed evdev press';
  if (rk.NATIVE_ACTIONS[def.key]) return 'key action `' + rk.NATIVE_ACTIONS[def.key] + '`';
  if (rk.NATIVE_SETTINGS[def.key]) return 'setting `' + rk.NATIVE_SETTINGS[def.key] + '`';
  if (rk.NATIVE_SERVICE_KEYS[def.key]) return 'LG service (`' + rk.NATIVE_SERVICE_KEYS[def.key] + '`)';
  if (rk.NATIVE_BLOCK_KEYS[def.key]) return 'blocking `' + rk.NATIVE_BLOCK_KEYS[def.key] + '`';
  if (def.nativeMapping || !(def.nativeOnly || def.filterOnly || def.color)) return '`mapping_info`';
  return none;
}

function render() {
  var rk = require('../server/lib/remotekeys');
  var remotes = require('../server/lib/remotes');
  var reported = require('../server/lib/remotebuttons').buttonNames();
  var table = rk.readKeyTable(KEY_TABLE);
  var catalogue = remotes.all();
  var lines = [];
  var w = function (s) { lines.push(s); };
  var none = '–';
  var code = function (s) { return s ? '`' + s + '`' : none; };

  w('# Remote keys');
  w('');
  w('<!-- Made by scripts/gen-remote-keys-doc.js from server/lib/remotekeys.js; edit those, not this page. -->');
  w('');
  w('Developer reference for the keys on the Remote tab: where each key is available, and how it maps through LG\'s layers on the TV.');
  w('');
  w('## Key availability');
  w('');
  w('The **Remotes** column lists entries in the [remote catalogue](remotes.md) known to have each key; "' +
    none + '" means it has not been recorded on a listed remote yet, not that it does not exist.');
  w('');
  w('| Remote tab key | webOS 4–10 | webOS 11 | Home Assistant | Remotes |');
  w('| :------------- | :--------- | :------- | :------------- | :------ |');
  rk.KEYS.forEach(function (k) {
    var haveIt = catalogue.filter(function (r) { return remotes.hasKey(r, k.key); });
    w('| ' + [
      k.title,
      webos10Summary(k, none),
      webos11Summary(rk, k, none),
      reported.indexOf(k.key) !== -1 ? 'yes' : none,
      haveIt.length ? haveIt.map(function (r) { return r.id; }).join(', ') : none
    ].join(' | ') + ' |');
  });
  w('');
  w('## Technical reference');
  w('');
  w('### The layers');
  w('');
  w('1. **The button** on the remote.');
  w('2. **Linux input**: the code a reader of `/dev/input/event*` sees. It is LG\'s code minus 8.');
  w('3. **LG\'s key table**, `/usr/share/X11/xkb/keycodes/lg`: the button\'s name, LG\'s code and the Qt key it becomes.');
  w('   The same Qt key can stand for different buttons on different firmware; keys marked `keyTable` in `server/lib/remotekeys.js` are only offered where the key table agrees.');
  w('4. **The key filters**: on webOS 10 and earlier, surface-manager\'s JavaScript filters match the Qt key (or the WebOS plugin symbol for channel keys on webOS 4). Glasshouse\'s');
  w('   filter sits first in the chain, so a key set on the Remote tab never reaches LG\'s.');
  w('5. **webOS 11**: LG\'s native key handling (`mapping_info`, configd actions/settings, app blocking, `lib/guidepatch`, or observed evdev color presses).');
  w('6. **lginput2\'s log**: the `button_type` of each press in `/var/log/messages` (`NL_BUTTON_CLICK`).');
  w('7. **The dashboard**: the key id in `KEYS` (`server/lib/remotekeys.js`).');
  w('8. **Home Assistant**: a Remote Button event for each press, where supported.');
  w('');
  w('LG\'s codes and Qt keys below are as read on ' + KEY_TABLE_TV + '. "' + none + '" is not known, or does not apply.');
  w('');
  w('| Key id | LG button | LG code (Linux) | Qt key | Logged as | webOS 11 mechanism |');
  w('| :----- | :-------- | --------------: | :----- | :-------- | :----------------- |');
  rk.KEYS.forEach(function (k) {
    var entry = k.lg ? table[k.lg] : null;
    w('| ' + [
      code(k.key),
      code(k.lg),
      entry ? entry.code + ' (' + (entry.code - 8) + ')' : none,
      k.symbol ? code(rk.qtName(k.symbol)) : none,
      code(k.log),
      webos11Mechanism(rk, k, none)
    ].join(' | ') + ' |');
  });
  w('');
  w('## Reading keys on a rooted TV');
  w('');
  w('To add a key to `KEYS` in `server/lib/remotekeys.js` or fill in an entry in `server/lib/remotes.json`:');
  w('');
  w('* **Key table (`lg`):** `grep \'<IR_KEY_NETFLIX>\' /usr/share/X11/xkb/keycodes/lg` (the test checks each `lg` entry against the key table fixture, so a key table from another firmware goes in `test/fixtures/`).');
  w('* **Button presses (`log` and `remote_type`):** `ssh` into the TV, run `tail -f /var/log/messages`, press each button, and read `remote_type` and `button_type` on the `NL_BUTTON_CLICK` lines. See [TV-RESEARCH.md](TV-RESEARCH.md) for worked examples.');
  w('* **Regenerate this page:** run `node scripts/gen-remote-keys-doc.js` after updating `KEYS` in `server/lib/remotekeys.js`.');
  w('');
  return lines.join('\n');
}

if (require.main === module) {
  var text = render();
  if (process.argv.indexOf('--check') !== -1) {
    var now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== text) {
      console.error('docs/development/remote-keys.md is out of date: run node scripts/gen-remote-keys-doc.js');
      process.exit(1);
    }
    console.log('docs/development/remote-keys.md is up to date');
  } else {
    fs.writeFileSync(OUT, text);
    console.log('wrote docs/development/remote-keys.md');
  }
}

module.exports = { render: render, OUT: OUT, KEY_TABLE: KEY_TABLE };
