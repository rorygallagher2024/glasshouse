// Remote visibility must not collect the Apps tab's data or write settings.
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');
var routes = require('../server/lib/routes');
var quickAccess = require('../server/lib/quickaccess');
var remoteKeys = require('../server/lib/remotekeys');

var dir = path.join(os.tmpdir(), 'remote-availability-' + process.pid);
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'keys.js'), 'WebOS.Key_webOS_Netflix');
var calls = [];
var settings = {};
for (var n = 1; n <= 9; n++) settings['magicNum' + n] = { id: '' };
var hasQuickAccess = true;
var remoteChecks = 0;
function luna(uri, params, cb) {
  calls.push(uri);
  assert.strictEqual(uri, 'com.webos.settingsservice/getSystemSettings');
  cb({ returnValue: true, settings: hasQuickAccess ? settings : {} });
}
quickAccess.init({ luna: luna });
remoteKeys.init({ luna: luna, filtersDir: dir, stateDir: dir });
routes.init({ config: { token: '', web: { enabled: true } },
  quickAccess: quickAccess, remoteKeys: {
    isSupported: function (cb) { remoteChecks++; remoteKeys.isSupported(cb); }
  },
  apps: { getApps: function () { assert.fail('must not collect apps'); } }
});

function check(expected) {
  var req = new events.EventEmitter();
  req.method = 'GET';
  req.url = '/api/remote/available';
  req.headers = {};
  req.connection = { remoteAddress: '127.0.0.1' };
  var answered = false;
  routes.handleRequest(req, {
    writeHead: function (status) { assert.strictEqual(status, 200); },
    end: function (body) {
      answered = true;
      assert.deepEqual(JSON.parse(body), { ok: true, available: expected });
    }
  });
  assert.ok(answered);
}

check(true);
assert.strictEqual(calls.length, 1, 'Quick Access alone needs one settings read');
assert.strictEqual(remoteChecks, 0, 'remote keys are not checked when Quick Access is available');
hasQuickAccess = false;
check(true);
assert.strictEqual(calls.length, 2, 'legacy key availability needs no app catalogue');
assert.strictEqual(remoteChecks, 1);
remoteKeys.init({});
check(false);
quickAccess.init({});
check(false);
fs.unlinkSync(path.join(dir, 'keys.js'));
fs.rmdirSync(dir);
console.log('test-remote-availability.js passed');
