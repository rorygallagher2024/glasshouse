#!/usr/bin/env node
/*
 * scripts/gen-remote-keys-doc.js - docs/remote-keys.md, how each Remote tab key
 * is known at each layer of the TV, made from the KEYS list in
 * server/lib/remotekeys.js, LG's key table as read on a TV
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
var OUT = path.join(ROOT, 'docs', 'remote-keys.md');
var KEY_TABLE = path.join(ROOT, 'test', 'fixtures', 'lg-keytable-oled48c56lb-webos10.txt');
var KEY_TABLE_TV = 'an OLED48C56LB (webOS 10.3.0)';

function render() {
  var rk = require('../server/lib/remotekeys');
  var remotes = require('../server/lib/remotes');
  var table = rk.readKeyTable(KEY_TABLE);
  var reported = rk.reportedButtons();
  var catalogue = remotes.all();
  var lines = [];
  var w = function (s) { lines.push(s); };
  var none = '–';
  var code = function (s) { return s ? '`' + s + '`' : none; };

  w('# Remote keys');
  w('');
  w('<!-- Made by scripts/gen-remote-keys-doc.js from server/lib/remotekeys.js; edit those, not this page. -->');
  w('');
  w('How each key on the Remote tab is known at each layer of the TV, from the button on the remote to the dashboard.');
  w('');
  w('## The layers');
  w('');
  w('1. **The button** on the remote.');
  w('2. **Linux input**: the code a reader of `/dev/input/event*` sees. It is LG\'s code minus 8.');
  w('3. **LG\'s key table**, `/usr/share/X11/xkb/keycodes/lg`: the button\'s name, LG\'s code and the Qt key it becomes.');
  w('   The same Qt key can stand for different buttons on different firmware.');
  w('4. **The key filters**: on webOS 10 and earlier, surface-manager\'s JavaScript filters match the Qt key. Glasshouse\'s');
  w('   filter is first in the chain, so a key set on the Remote tab never reaches LG\'s.');
  w('5. **webOS 11**: LG\'s native key handling, changed through its own settings instead of a filter.');
  w('6. **lginput2\'s log**: the `button_type` of each press in `/var/log/messages` (`NL_BUTTON_CLICK`).');
  w('7. **The dashboard**: the key\'s id and its name on the Remote tab.');
  w('8. **Home Assistant**: a Remote Button event for each press, where the key has one.');
  w('');
  w('## How a key is offered');
  w('');
  w('* **webOS 10 and earlier:** where one of LG\'s filters names the key\'s Qt key; the channel keys also where the');
  w('  WebOS module defines them, as on webOS 4, whose filters do not name them. A key marked "checked" below is');
  w('  also offered only where the TV\'s key table gives that Qt key to the key\'s button: its Qt key is a plain one,');
  w('  not made for webOS, that another firmware could give another button.');
  w('* **webOS 11:** where LG\'s native handling has the key, through what the webOS 11 column names.');
  w('');
  w('The **Remotes** column lists the [remote catalogue](remotes.md) entries known to have the key, by their id; "' +
    none + '" is none of them, which does not mean the key does not exist, only that the catalogue has not found it on a listed remote yet.');
  w('');
  w('## The keys');
  w('');
  w('LG\'s codes and the Qt keys are as read on ' + KEY_TABLE_TV + '. "' + none + '" is not known, or does not apply.');
  w('');
  w('| Remote tab key | LG button | LG code (Linux) | Qt key | webOS 10 filter | webOS 11 | Logged as | Home Assistant | Remotes |');
  w('| :------------- | :-------- | --------------: | :----- | :-------------- | :------- | :-------- | :------------- | :------ |');
  rk.KEYS.forEach(function (k) {
    var entry = k.lg ? table[k.lg] : null;
    var filter = k.nativeOnly || k.nativeMapping ? none : k.keyTable ? 'yes, checked'
      : k.fromPlugin ? 'yes, or where the WebOS module defines it' : 'yes';
    var haveIt = catalogue.filter(function (r) { return remotes.hasKey(r, k.key); });
    w('| ' + [
      k.title + ' (`' + k.key + '`)',
      code(k.lg),
      entry ? entry.code + ' (' + (entry.code - 8) + ')' : none,
      k.symbol ? code(rk.qtName(k.symbol)) : none,
      filter,
      rk.nativeKind(k) || none,
      code(k.log),
      reported.indexOf(k.key) !== -1 ? 'yes' : none,
      haveIt.length ? haveIt.map(function (r) { return r.id; }).join(', ') : none
    ].join(' | ') + ' |');
  });
  w('');
  w('## Adding to this page');
  w('');
  w('A key\'s facts are fields of its entry in `KEYS` in `server/lib/remotekeys.js`: `lg`, LG\'s button name from the');
  w('key table; `log`, the `button_type` lginput2 logs for a press; `keyTable` for a plain Qt key that is offered only');
  w('where the key table gives it to that button. Read the key table on the TV with');
  w('`grep \'<IR_KEY_NETFLIX>\' /usr/share/X11/xkb/keycodes/lg`, and a press\'s name from `/var/log/messages`. Then run');
  w('`node scripts/gen-remote-keys-doc.js`. The test checks that each `lg` name has the Qt key of its symbol in the');
  w('key table above, so a key table from another firmware goes in `test/fixtures/` beside it.');
  w('');
  return lines.join('\n');
}

if (require.main === module) {
  var text = render();
  if (process.argv.indexOf('--check') !== -1) {
    var now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== text) {
      console.error('docs/remote-keys.md is out of date: run node scripts/gen-remote-keys-doc.js');
      process.exit(1);
    }
    console.log('docs/remote-keys.md is up to date');
  } else {
    fs.writeFileSync(OUT, text);
    console.log('wrote docs/remote-keys.md');
  }
}

module.exports = { render: render, OUT: OUT, KEY_TABLE: KEY_TABLE };
