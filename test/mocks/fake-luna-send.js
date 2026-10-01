#!/usr/bin/env node
/*
 * Stands in for /usr/bin/luna-send in the start-up test (TVWEB_LUNA_SEND).
 * Answers from mock-env's table, as one line of JSON. With -i it answers once
 * and stays open, as a subscription does, until it is killed.
 *
 * FAKE_LUNA_CHAOS=1 makes the TV unreliable: some calls answer late, never
 * answer, answer with rubbish or an error, or die before answering; some
 * subscriptions drop after a few seconds.
 *
 * FAKE_LUNA_SCRIPT names a JSON file { "<uri>": { steps: [{ delay: ms, out:
 * object | raw: string }], end: "hold" | "exit" | "fail" } }. A call to a
 * listed uri sends those lines in turn, as a streamed subscription does, then
 * holds the stream open, exits 0, or exits 1. FAKE_LUNA_LOG names a file that
 * gets each call's arguments, one JSON array per line.
 *
 * Strict ES5: the test runs on node 0.12.
 */
var mock = require('./mock-env').createMockEnv({ luna: {
  // As an OLED65B8SLC answers.
  'com.webos.service.tv.systemproperty/getSystemProperties': function (p) {
    var all = { modelName: 'OLED65B8SLC', firmwareVersion: '05.50.70', boardType: 'M16P_DVB_EU', sdkVersion: '4.4.3' };
    var out = { returnValue: true };
    ((p && p.keys) || []).forEach(function (k) { if (all[k] !== undefined) out[k] = all[k]; });
    return out;
  }
} });

var args = process.argv.slice(2);
var uri = null, payload = {}, subscribe = false;
for (var i = 0; i < args.length; i++) {
  var a = args[i];
  if (a === '-n' || a === '-w' || a === '-a') { i++; continue; }
  if (a === '-i') { subscribe = true; continue; }
  if (a === '-f') continue;
  if (a.indexOf('luna://') === 0) { uri = a.slice(7); try { payload = JSON.parse(args[i + 1] || '{}'); } catch (e) {} i++; }
}

if (process.env.FAKE_LUNA_LOG) {
  try { require('fs').appendFileSync(process.env.FAKE_LUNA_LOG, JSON.stringify(args) + '\n'); } catch (e) {}
}

var scripted = null;
if (process.env.FAKE_LUNA_SCRIPT) {
  try { scripted = JSON.parse(require('fs').readFileSync(process.env.FAKE_LUNA_SCRIPT, 'utf8'))[uri] || null; } catch (e) {}
}
if (scripted) {
  process.stdin.on('end', function () { process.exit(0); });
  process.stdin.resume();
  var at = 0;
  (scripted.steps || []).forEach(function (step) {
    at += step.delay || 0;
    setTimeout(function () {
      process.stdout.write(step.raw !== undefined ? step.raw : JSON.stringify(step.out) + '\n');
    }, at);
  });
  setTimeout(function () {
    if (scripted.end === 'exit') process.exit(0);
    if (scripted.end === 'fail') process.exit(1);
  }, at + 20);
  if (scripted.end !== 'exit' && scripted.end !== 'fail') setInterval(function () {}, 60000);
  return;
}

var res = mock.luna[uri];
if (typeof res === 'function') res = res(payload);
if (!res) res = { returnValue: false, errorText: 'Unknown method "' + uri + '"' };
if (res.returnValue === undefined) res.returnValue = true;
if (subscribe) res.subscribed = true;

// The real luna-send goes when the server that started it does; its stdin
// closing is the sign here.
process.stdin.on('end', function () { process.exit(0); });
process.stdin.resume();

// A one-shot call ends once it has answered; a subscription stays open.
function answer() {
  process.stdout.write(JSON.stringify(res) + '\n', function () { if (!subscribe) process.exit(0); });
}

if (process.env.FAKE_LUNA_CHAOS) {
  var roll = Math.random();
  if (subscribe) {
    answer();
    // Some subscriptions drop, as a restarting LG service does.
    if (roll < 0.3) setTimeout(function () { process.exit(1); }, 2000 + Math.random() * 4000);
    else setInterval(function () {}, 60000);
  } else if (roll < 0.10) {
    setTimeout(answer, 2000);                                 // late
  } else if (roll < 0.15) {
    setInterval(function () {}, 60000);                       // never answers
  } else if (roll < 0.20) {
    process.stdout.write('{"returnValue": tru', function () { process.exit(0); });   // rubbish
  } else if (roll < 0.25) {
    process.stdout.write(JSON.stringify({ returnValue: false, errorCode: -1, errorText: 'Service busy' }) + '\n',
      function () { process.exit(0); });
  } else if (roll < 0.30) {
    process.kill(process.pid, 'SIGABRT');                     // dies before answering
  } else {
    answer();
  }
} else {
  answer();
  if (subscribe) setInterval(function () {}, 60000);
}
