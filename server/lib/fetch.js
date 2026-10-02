// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
// HTTP through whichever curl or wget the TV has: node 0.12 cannot speak the
// TLS that GitHub and most catalogs now require.
var msg = require('./say').msg;
var fs = require('fs');
var path = require('path');
var execFile = require('child_process').execFile;

var clientDirs = [
  '/media/developer/bin', '/usr/local/bin', '/opt/bin', '/opt/usr/bin',
  '/var/lib/webosbrew/bin', '/home/root/bin', '/usr/bin', '/bin'
];
var fetchClient = null;
var config = {};
var currentVersion = '';

var MAX_URL = 2048;
// A download that keeps moving may take as long as it needs; this only bounds
// one that never ends.
var DOWNLOAD_CEILING_MS = 30 * 60 * 1000;
var PROGRESS_MS = 500;

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.version) currentVersion = opts.version;
  if (opts.clientDirs) clientDirs = opts.clientDirs;
}

function client() { return fetchClient; }

function execErr(err, stderr) {
  if (err && err.killed) return 'timed out';
  var m = String(stderr || '').split('\n')[0].trim();
  if (!m && err && err.code) return 'exited ' + err.code;
  return m || (err && err.message) || 'failed';
}

/*
 * A failure that says nothing about the client: the name did not resolve,
 * nothing answered, or time ran out. Every client shares the TV's network, so
 * the next would fail the same way, and blaming the client would send someone
 * off installing curl on a TV that is simply offline.
 *   curl      6 unresolved, 7 no connection, 28 timed out
 *   GNU wget  4 network failure
 *   busybox   exits 1 for everything, so only its message tells
 */
function networkFailure(bin, err, stderr) {
  if (!err) return false;
  if (err.killed) return true;
  if (isWget(bin)) {
    return err.code === 4 || /bad address|can't connect|timed out|unreachable/i.test(String(stderr || ''));
  }
  return err.code === 6 || err.code === 7 || err.code === 28;
}

function httpErrorStatus(err, stderr) {
  var text = String(stderr || '');
  var m = /returned error:?\s*(?:HTTP\/[\d.]+\s+)?([1-5]\d\d)/i.exec(text) ||
          /\bERROR\s+([1-5]\d\d)\b/i.exec(text);
  if (m) return parseInt(m[1], 10);
  if (err && (err.code === 22 || err.code === 8)) return -1;
  return 0;
}

function isWget(bin) { return /wget$/.test(bin); }

function hostOf(url) {
  var m = /^https?:\/\/(?:[^\/@]*@)?([^\/:?#]+)/i.exec(String(url));
  return m ? m[1].toLowerCase() : 'the server';
}

function isGithub(url) {
  return /(^|\.)github\.com$/.test(hostOf(url));
}

function githubSaid(status, url) {
  var where = String(url).replace(/^https?:\/\/[^\/]+/, '');
  if (status === 404) {
    return msg('srv.fetch.github404', 'GitHub returned 404 for {where} - no release published yet, or the repository is not visible',
               { where: where });
  }
  if (status === 403 || status === 429) {
    return msg('srv.fetch.githubLimit', '{status} for {where} - either the API rate limit for this address is spent (60 an hour unauthenticated), or something on the network refused the request',
               { status: status, where: where });
  }
  return hostSaid(status, url, 'GitHub');
}

function hostSaid(status, url, name) {
  var host = name || hostOf(url);
  var where = String(url).replace(/^https?:\/\/[^\/]+/, '');
  if (status > 0) {
    return msg('srv.fetch.hostStatus', '{host} returned {status} for {where}', { host: host, status: status, where: where });
  }
  return msg('srv.fetch.hostError', '{host} answered with an error for {where}', { host: host, where: where });
}

/* null when the URL is acceptable to hand to a client, else the reason. */
function validateUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return msg('srv.fetch.badScheme', 'the address must start with http:// or https://');
  }
  if (url.length > MAX_URL) {
    return msg('srv.fetch.tooLong', 'the address is longer than {max} characters', { max: MAX_URL });
  }
  if (/[\u0000- \u007f-\u009f]/.test(url)) {
    return msg('srv.fetch.badChars', 'the address contains spaces or control characters');
  }
  return null;
}

/*
 * mode: 'text'  a few kilobytes read from stdout, short limits so an offline
 *               TV says so in seconds
 *       'file'  a small file, longer limit
 *       'big'   a package: a stall ends it, not the total time
 * ipFlag: '-4' or '-6' to pin curl to one address family (busybox wget has no
 * such flag).
 */
function fetchArgs(bin, url, outFile, mode, ipFlag) {
  var ua = 'tvweb/' + currentVersion;
  mode = mode || (outFile ? 'file' : 'text');
  var wget = isWget(bin);
  var ip = !wget && ipFlag ? [ipFlag] : [];
  if (mode === 'big') {
    // curl's speed limit measures the whole transfer; busybox wget's -T is per
    // read, which comes to the same thing for a stalled connection.
    if (wget) return ['-q', '-T', '30', '-U', ua, '-O', outFile, '--', url];
    return ['-fsSL'].concat(ip, ['--proto', '=http,https', '--proto-redir', '=http,https',
            '--connect-timeout', '30', '--speed-limit', '1024', '--speed-time', '30',
            '-A', ua, '-o', outFile, '--', url]);
  }
  var secs = mode === 'file' ? '30' : '10';
  if (wget) return ['-q', '-T', secs, '-U', ua, '-O', outFile || '-', '--', url];
  return ['-fsSL'].concat(ip, ['--proto', '=http,https', '--proto-redir', '=http,https',
          '--connect-timeout', '5', '--max-time', secs, '-A', ua, '-o', outFile || '-', '--', url]);
}

function clientList() {
  var list = [];
  var configured = (config.update && config.update.client) || '';
  if (fetchClient) list.push(fetchClient);
  if (configured) list.push(configured);
  for (var d = 0; d < clientDirs.length; d++) {
    list.push(clientDirs[d] + '/curl');
    list.push(clientDirs[d] + '/wget');
  }
  return list;
}

/*
 * The address families to try with one curl, in order. The TV's curl 7.53.1
 * picks IPv4 or IPv6 at random where both resolve, and on some networks one of
 * them never connects (exit 7), so about half of the requests failed. Naming
 * the family on a retry gets the other one. `fetch.ip` ("4" or "6", file-only)
 * names the first to use.
 */
function ipTries(bin) {
  if (isWget(bin)) return [null];
  var ip = String(config.fetch && config.fetch.ip || '');
  if (ip === '4') return ['-4', '-6'];
  if (ip === '6') return ['-6', '-4'];
  return [null, '-6', '-4'];
}

function fileEmpty(file) {
  try { return fs.statSync(file).size === 0; } catch (e) { return true; }
}

function rmQuiet(file) {
  try { fs.unlinkSync(file); } catch (e) {}
}

/*
 * Tries each client in turn until one reaches the server. Returns a handle
 * whose cancel() kills the running client and ends with err.cancelled.
 */
function run(url, outFile, mode, opts, cb) {
  var list = clientList();
  var big = mode === 'big';
  var host = hostOf(url);
  var github = isGithub(url);
  var i = 0, last = '', seen = {}, child = null, cancelled = false, finished = false;
  var timer = null;

  function finish(err, body, bin) {
    if (finished) return;
    finished = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (err && big) rmQuiet(outFile);
    cb(err, body, bin);
  }

  if (big && opts.onProgress) {
    timer = setInterval(function () {
      fs.stat(outFile, function (e, st) {
        if (!e && !finished) opts.onProgress(st.size, opts.expectedSize || null);
      });
    }, PROGRESS_MS);
  }

  function next() {
    if (cancelled) return;
    if (i >= list.length) {
      return finish(new Error(msg('srv.fetch.noClient', 'no HTTP client on this TV could reach {host}{detail}. Install a current curl or wget.',
                                  { host: github ? 'GitHub' : host, detail: last ? ' (' + last + ')' : '' })));
    }
    var bin = list[i++];
    if (seen[bin] || !fs.existsSync(bin)) return next();
    seen[bin] = 1;
    attempt(bin, ipTries(bin), 0);
  }

  function attempt(bin, tries, t) {
    if (big) rmQuiet(outFile);
    child = execFile(bin, fetchArgs(bin, url, outFile, mode, tries[t]),
                     { timeout: big ? DOWNLOAD_CEILING_MS : (mode === 'file' ? 180000 : 15000),
                       maxBuffer: opts.maxBuffer || 1024 * 1024 },
                     function (err, stdout, stderr) {
      child = null;
      if (cancelled) return;
      if (err) {
        // Not our own timeout; a download that has already started is not
        // restarted on the other family.
        if (t + 1 < tries.length && !err.killed && (err.code === 7 || err.code === 28) &&
            (!big || fileEmpty(outFile))) {
          return attempt(bin, tries, t + 1);
        }
        var status = httpErrorStatus(err, stderr);
        if (status) {
          fetchClient = bin;
          return finish(new Error(github ? githubSaid(status, url) : hostSaid(status, url)));
        }
        if (big && (err.killed || (err.code === 28 && !isWget(bin)))) {
          fetchClient = bin;
          return finish(new Error(msg('srv.fetch.stalled', 'the download from {host} stalled or ran past {minutes} minutes',
                                      { host: host, minutes: DOWNLOAD_CEILING_MS / 60000 })));
        }
        if (networkFailure(bin, err, stderr)) {
          console.error('fetch: ' + path.basename(bin) + ': ' + execErr(err, stderr));
          /** @type {any} */
          var off = new Error(msg('srv.fetch.offline', 'The TV could not reach {host}. Check it is connected to the internet.',
                                  { host: github ? 'GitHub' : host }));
          off.offline = true;
          return finish(off);
        }
        last = path.basename(bin) + ': ' + execErr(err, stderr);
        return next();
      }
      fetchClient = bin;
      if (big && opts.expectedSize) {
        var size = -1;
        try { size = fs.statSync(outFile).size; } catch (e) {}
        if (size !== opts.expectedSize) {
          return finish(new Error(msg('srv.fetch.wrongSize', 'the download from {host} ended at {size} bytes, expected {expected}',
                                      { host: host, size: size, expected: opts.expectedSize })));
        }
      }
      finish(null, String(stdout || ''), bin);
    });
  }
  next();

  return {
    cancel: function () {
      if (finished || cancelled) return;
      cancelled = true;
      if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
      /** @type {any} */
      var err = new Error('cancelled');
      err.cancelled = true;
      finish(err);
    }
  };
}

/* Small request or file; cb(err, stdout, bin). Callers vouch for the URL. */
function probeFetch(url, outFile, cb) {
  return run(url, outFile, outFile ? 'file' : 'text', {}, cb);
}

/* A package to outFile. opts: onProgress(bytes, expectedSize), expectedSize. */
function download(url, outFile, opts, cb) {
  opts = opts || {};
  var bad = validateUrl(url);
  if (bad) {
    setTimeout(function () { cb(new Error(bad)); }, 0);
    return { cancel: function () {} };
  }
  return run(url, outFile, 'big', opts, cb);
}

/* Small JSON document, https only; cb(err, parsed). */
function getJson(url, cb) {
  var bad = validateUrl(url);
  if (!bad && !/^https:\/\//i.test(url)) {
    bad = msg('srv.fetch.needHttps', 'the address must start with https://');
  }
  if (bad) {
    setTimeout(function () { cb(new Error(bad)); }, 0);
    return;
  }
  run(url, null, 'text', { maxBuffer: 8 * 1024 * 1024 }, function (err, body) {
    if (err) return cb(err);
    var doc;
    try { doc = JSON.parse(body); } catch (e) {
      return cb(new Error(msg('srv.fetch.notJson', '{host} did not return JSON', { host: hostOf(url) })));
    }
    cb(null, doc);
  });
}

module.exports = {
  init: init,
  client: client,
  clientDirs: function () { return clientDirs; },
  probeFetch: probeFetch,
  download: download,
  getJson: getJson,
  validateUrl: validateUrl,
  execErr: execErr,
  hostOf: hostOf,
  _fetchArgs: fetchArgs
};
