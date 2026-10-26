/**
 * remotebuttons.js - Remote control button event listener for webOS
 *
 * Reads Linux evdev streams on webOS remote input devices (/dev/input/event*)
 * to detect red, green, yellow, and blue button presses on LG Magic and IR remotes,
 * and the Home button going down and up, for Glasshouse Home's hold-Home gesture.
 *
 * Runs in a dedicated worker child process to avoid blocking the main server's
 * libuv threadpool when waiting on Linux evdev character devices.
 *
 * Strict ES5 for Node 0.12.2 on webOS 4.
 */

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');

// Linux EV_KEY event type and button keycodes
var EV_KEY = 1;
var KEY_PRESS = 1;

var BUTTON_CODES = {
  398: 'red',
  399: 'green',
  400: 'yellow',
  401: 'blue',
  // Streaming buttons, IR_KEY_* in /usr/share/X11/xkb/keycodes/lg less 8.
  1037: 'netflix',
  1038: 'amazon',
  1042: 'disneyplus',
  1043: 'lgchannels',
  1044: 'rakutentv',
  1086: 'alexa',
  18874385: 'red',
  18874386: 'green',
  18874387: 'yellow',
  18874388: 'blue',
  18874408: 'netflix',
  18874409: 'amazon',
  18874396: 'disneyplus',
  18874397: 'lgchannels',
  18874426: 'rakutentv',
  18874416: 'alexa'
};

// IR_KEY_HOME in /usr/share/X11/xkb/keycodes/lg (781) less the 8 xkb adds; the
// same on a G3 (webOS 9.2) and a B4 (webOS 10.3).
var HOME_CODE = 773;

var onButtonFn = null;
var onHomeKeyFn = null;
// Every key going down, for closing a screen saver tvpower does not know of.
var onAnyKeyFn = null;
// Who wants the worker running: MQTT for the coloured buttons, Glasshouse Home
// for the Home button, the screen saver while one it launched shows. It runs
// while any do.
var owners = {};
var workerProc = null;
var activeDevices = [];
var lastPressTime = {};
var DEBOUNCE_MS = 200;
var running = false;

function findRcuDevices() {
  var found = [];
  try {
    if (fs.existsSync('/proc/bus/input/devices')) {
      var content = fs.readFileSync('/proc/bus/input/devices', 'utf8');
      var blocks = content.split('\n\n');
      for (var b = 0; b < blocks.length; b++) {
        var block = blocks[b];
        var nameMatch = /Name="([^"]+)"/.exec(block);
        var name = nameMatch ? nameMatch[1] : '';
        if (/LGE RCU|LGE M-RCU|Smart Remote RCU Input|LGE Simple Premium/i.test(name)) {
          var handlerMatch = /Handlers=[^\n]*?(event\d+)/.exec(block);
          if (handlerMatch && handlerMatch[1]) {
            var dev = '/dev/input/' + handlerMatch[1];
            if (found.indexOf(dev) === -1) {
              found.push(dev);
            }
          }
        }
      }
    }
  } catch (e) {}

  if (!found.length) {
    if (fs.existsSync('/dev/input/event1')) found.push('/dev/input/event1');
    if (fs.existsSync('/dev/input/event2')) found.push('/dev/input/event2');
  }

  return found;
}

function handleParsedEvent(type, code, val) {
  if (type === EV_KEY && val === KEY_PRESS && process.argv.indexOf('--worker') === -1 && onAnyKeyFn) {
    onAnyKeyFn(code);
  }
  if (type === EV_KEY && code === HOME_CODE && (val === 0 || val === 1)) {
    if (process.argv.indexOf('--worker') !== -1) {
      try { process.stdout.write('home ' + val + '\n'); } catch (e) {}
    } else if (onHomeKeyFn) {
      onHomeKeyFn(val === 1);
    }
    return;
  }
  if (type !== EV_KEY || val !== KEY_PRESS) return;
  var color = BUTTON_CODES[code];
  if (!color) {
    if (process.argv.indexOf('--worker') !== -1) {
      try { process.stdout.write('key ' + code + '\n'); } catch (e) {}
    }
    return;
  }

  var now = Date.now();
  if (lastPressTime[color] && (now - lastPressTime[color] < DEBOUNCE_MS)) {
    return;
  }
  lastPressTime[color] = now;

  if (process.argv.indexOf('--worker') !== -1) {
    try {
      process.stdout.write(color + ' ' + code + '\n');
    } catch (e) {}
  } else if (onButtonFn) {
    onButtonFn(color, code);
  }
}

function createDeviceStream(devPath) {
  var stream;
  try {
    stream = fs.createReadStream(devPath, { flags: 'r' });
  } catch (e) {
    return null;
  }

  var remainder = null;
  // 16 bytes for 32-bit (timeval=8, type=2, code=2, value=4)
  // 24 bytes for 64-bit (timeval=16, type=2, code=2, value=4)
  var evSize = (process.arch === 'arm64' || process.arch === 'x64') ? 24 : 16;
  var typeOff = (evSize === 24) ? 16 : 8;
  var codeOff = (evSize === 24) ? 18 : 10;
  var valOff = (evSize === 24) ? 20 : 12;

  stream.on('data', function (chunk) {
    if (!chunk || !Buffer.isBuffer(chunk)) return;
    var buf = chunk;
    if (remainder && remainder.length) {
      buf = Buffer.concat ? Buffer.concat([remainder, buf]) : buf;
      remainder = null;
    }

    var i = 0;
    while (i + evSize <= buf.length) {
      var type = buf.readUInt16LE(i + typeOff);
      var code = buf.readUInt16LE(i + codeOff);
      var val = buf.readInt32LE(i + valOff);
      handleParsedEvent(type, code, val);
      i += evSize;
    }

    if (i < buf.length) {
      remainder = buf.slice(i);
    }
  });

  stream.on('error', function (err) {});
  return stream;
}

function runWorker() {
  process.stdout.on('error', function (err) {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
  if (process.stdin) {
    process.stdin.resume();
    process.stdin.on('end', function () {
      process.exit(0);
    });
    process.stdin.on('close', function () {
      process.exit(0);
    });
  }
  var devs = findRcuDevices();
  var streams = [];
  for (var i = 0; i < devs.length; i++) {
    var s = createDeviceStream(devs[i]);
    if (s) streams.push(s);
  }
  process.on('SIGTERM', function () {
    for (var j = 0; j < streams.length; j++) {
      try {
        if (streams[j].destroy) streams[j].destroy();
        else if (streams[j].close) streams[j].close();
      } catch (e) {}
    }
    process.exit(0);
  });
  setInterval(function () {}, 60000);
}

function stop() {
  running = false;
  if (workerProc) {
    try {
      workerProc.kill('SIGTERM');
    } catch (e) {}
    workerProc = null;
  }
  activeDevices = [];
}

function getPythonBin() {
  if (fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
  if (fs.existsSync('/usr/bin/python')) return '/usr/bin/python';
  return null;
}

function isSupported() {
  var devs = findRcuDevices();
  return devs.length > 0 || fs.existsSync('/tmp/var/log/inputcommon');
}

function start() {
  stop();
  running = true;
  if (!isSupported()) return;
  activeDevices = findRcuDevices();

  var pyBin = getPythonBin();
  var pyScript = path.join(__dirname, 'remotebuttons.py');
  var child;

  try {
    if (pyBin && fs.existsSync(pyScript)) {
      child = child_process.spawn(pyBin, [pyScript], {
        stdio: ['pipe', 'pipe', 'inherit']
      });
    } else {
      /** @type {any} */
      var env = {};
      for (var k in process.env) env[k] = process.env[k];
      env.UV_THREADPOOL_SIZE = '16';
      child = child_process.spawn(process.execPath, [__filename, '--worker'], {
        env: env,
        stdio: ['pipe', 'pipe', 'inherit']
      });
    }
  } catch (e) {
    console.error('remotebuttons: failed to spawn worker: ' + e.message);
    return;
  }

  workerProc = child;
  var remainder = '';

  if (child.stdout) {
    child.stdout.on('error', function () {});
    child.stdout.on('data', function (chunk) {
      if (!chunk) return;
      var str = remainder + chunk.toString('utf8');
      var lines = str.split('\n');
      remainder = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var parts = line.split(' ');
        if (parts[0] === 'home') {
          if (parts[1] === '1' && onAnyKeyFn) onAnyKeyFn(HOME_CODE);
          if (onHomeKeyFn) onHomeKeyFn(parts[1] === '1');
          continue;
        }
        if (parts[0] === 'key') {
          if (onAnyKeyFn) onAnyKeyFn(parseInt(parts[1], 10));
          continue;
        }
        var color = parts[0];
        var code = parseInt(parts[1], 10);
        if (BUTTON_CODES[code]) {
          if (onAnyKeyFn) onAnyKeyFn(code);
          if (onButtonFn) onButtonFn(color, code);
        }
      }
    });
  }

  child.on('error', function (err) {
    console.error('remotebuttons: worker process error: ' + (err ? err.message : err));
  });

  child.on('exit', function () {
    if (workerProc === child) {
      workerProc = null;
      if (running) {
        console.log('remotebuttons: worker exited, restarting in 1s...');
        setTimeout(function () {
          if (running) start();
        }, 1000);
      }
    }
  });

  var devDesc = activeDevices.length > 2
    ? activeDevices.length + ' input devices'
    : (activeDevices.length ? activeDevices.join(', ') : 'inputcommon');
  console.log('remotebuttons: listening for colored button events on ' + devDesc + ' (worker pid ' + child.pid + ')');
}

function init(opts) {
  opts = opts || {};
  onButtonFn = opts.onButton;
  onHomeKeyFn = opts.onHomeKey || null;
  onAnyKeyFn = opts.onAnyKey || null;
}

// Starts the worker for the first owner to want it, stops it after the last.
function want(owner, on) {
  if (on) owners[owner] = true;
  else delete owners[owner];
  var wanted = Object.keys(owners).length > 0;
  if (wanted && !running) start();
  else if (!wanted && running) stop();
}

function isRunning() {
  return running && !!workerProc;
}

function status() {
  return {
    running: isRunning(),
    supported: isSupported(),
    devices: activeDevices.slice(),
    workerPid: workerProc ? workerProc.pid : null
  };
}

if (process.argv.indexOf('--worker') !== -1) {
  runWorker();
}

module.exports = {
  BUTTON_CODES: BUTTON_CODES,
  findRcuDevices: findRcuDevices,
  handleParsedEvent: handleParsedEvent,
  HOME_CODE: HOME_CODE,
  init: init,
  want: want,
  start: start,
  stop: stop,
  isSupported: isSupported,
  isRunning: isRunning,
  status: status
};
