'use strict';
/*
 * lib/dlna.js - Pictures on the home network's media servers (DLNA / UPnP
 * AV), for the Art screen saver: finding the servers, browsing their folders
 * and reading which pictures a folder holds. Strict ES5 for Node 0.12.2.
 *
 * A server answers an SSDP search with the address of its description, which
 * names its ContentDirectory service; Browse on that lists a folder's
 * subfolders and items as DIDL-Lite. Only servers on the local network are
 * spoken to, over plain HTTP, as DLNA has no other.
 */
var dgram = require('dgram');
var http = require('http');
var url = require('url');

var SSDP_ADDR = '239.255.255.250', SSDP_PORT = 1900;
var MEDIA_SERVER = 'urn:schemas-upnp-org:device:MediaServer:1';
var CONTENT_DIRECTORY = /urn:schemas-upnp-org:service:ContentDirectory:\d/;
var SEARCH_MS = 3000;
var HTTP_MS = 10000;
var MAX_XML = 4 * 1024 * 1024;
var BROWSE_COUNT = 1000;
// LG's own phone apps answer as media servers with nothing to show, and a
// Sonos speaker with its music library only.
var SKIP_MODELS = /LG TV Plus|LG ThinQ|Sonos/i;

var socketFn = function () { return dgram.createSocket('udp4'); };
var requestFn = http.request;

function init(opts) {
  opts = opts || {};
  if (opts.socket) socketFn = opts.socket;
  if (opts.request) requestFn = opts.request;
}

/**
 * Whether an address is on the local network: private IPv4 or link-local.
 * @param {string} host
 */
function local(host) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''));
  if (!m) return false;
  var a = +m[1], b = +m[2];
  if ([+m[1], +m[2], +m[3], +m[4]].some(function (n) { return n > 255; })) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// An address on the local network over HTTP, or null.
function localUrl(u) {
  var p;
  try { p = url.parse(String(u || '')); } catch (e) { return null; }
  if (!p || p.protocol !== 'http:' || !local(p.hostname)) return null;
  return p;
}

/*
 * cb(err, body) for a GET or a POST to a local address, up to max bytes.
 */
function fetchText(u, opts, cb) {
  var p = localUrl(u);
  if (!p) return setTimeout(function () { cb(new Error('not an address on the local network')); }, 0);
  var done = false;
  function finish(err, body) { if (!done) { done = true; cb(err, body); } }
  var req = requestFn({
    hostname: p.hostname, port: p.port || 80, path: p.path, method: opts.body ? 'POST' : 'GET',
    headers: opts.headers || {}
  }, function (res) {
    if (res.statusCode !== 200) { res.resume(); return finish(new Error('the server answered ' + res.statusCode)); }
    var chunks = [], got = 0, max = opts.max || MAX_XML;
    res.on('data', function (c) {
      got += c.length;
      if (got > max) { req.abort(); return finish(new Error('the answer was too large')); }
      chunks.push(c);
    });
    res.on('end', function () { finish(null, Buffer.concat(chunks)); });
    res.on('error', function (e) { finish(e); });
  });
  req.setTimeout(opts.timeout || HTTP_MS, function () { req.abort(); finish(new Error('timed out')); });
  req.on('error', function (e) { finish(e); });
  if (opts.body) req.write(opts.body);
  req.end();
}

/*
 * A file from a local address to a buffer, refused over max bytes.
 * cb(err, buf).
 */
function fetchFile(u, max, cb) {
  fetchText(u, { max: max, timeout: 60000 }, cb);
}

function unescapeXml(s) {
  return String(s || '').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, function (m, e) {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return '\'';
    if (e === 'amp') return '&';
    var code = e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCharCode(code) : '';
  });
}

// The text of the first element of a name, any prefix, or ''.
function tag(xml, name) {
  var m = new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '>').exec(xml);
  return m ? unescapeXml(m[1]).trim() : '';
}

function attrs(open) {
  var out = {}, re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
  while ((m = re.exec(open)) !== null) out[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
  return out;
}

/*
 * A device description: its name, unique id and ContentDirectory's control
 * address, made whole against the description's own.
 */
function readDescription(xml, location) {
  xml = String(xml || '');
  var udn = tag(xml, 'UDN');
  var name = tag(xml, 'friendlyName') || tag(xml, 'modelName');
  var model = tag(xml, 'modelName') + ' ' + tag(xml, 'modelDescription') + ' ' + tag(xml, 'manufacturer');
  var base = tag(xml, 'URLBase') || location;
  var services = xml.split(/<(?:[\w-]+:)?service>/).slice(1);
  var control = null;
  for (var i = 0; i < services.length; i++) {
    if (CONTENT_DIRECTORY.test(tag(services[i], 'serviceType'))) {
      control = tag(services[i], 'controlURL');
      break;
    }
  }
  if (!udn || !control) return null;
  var full = url.resolve(base, control);
  if (!localUrl(full)) return null;
  return { udn: udn, name: name.slice(0, 120) || udn, control: full, skip: SKIP_MODELS.test(model) };
}

/**
 * The media servers that answer within a few seconds, with the
 * ContentDirectory service: [{ udn, name, location, control }].
 * @param {function(Error|null, Array): void} cb
 */
function discover(cb) {
  var found = {}, order = [], sock;
  try { sock = socketFn(); } catch (e) { return cb(e, []); }
  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    try { sock.close(); } catch (e) {}
    var pending = order.length, out = [];
    if (!pending) return cb(null, []);
    order.forEach(function (loc) {
      fetchText(loc, {}, function (err, body) {
        var d = err ? null : readDescription(body && body.toString('utf8'), loc);
        if (d && !d.skip && !out.some(function (o) { return o.udn === d.udn; })) {
          out.push({ udn: d.udn, name: d.name, location: loc, control: d.control });
        }
        if (--pending === 0) {
          out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
          cb(null, out);
        }
      });
    });
  }
  sock.on('message', function (msg) {
    var m = /^location:\s*(\S+)/im.exec(String(msg));
    if (!m || found[m[1]] || !localUrl(m[1])) return;
    found[m[1]] = true;
    order.push(m[1]);
  });
  sock.on('error', function () { finish(); });
  var search = new Buffer([
    'M-SEARCH * HTTP/1.1', 'HOST: ' + SSDP_ADDR + ':' + SSDP_PORT, 'MAN: "ssdp:discover"', 'MX: 2',
    'ST: ' + MEDIA_SERVER, '', ''].join('\r\n'));
  sock.bind(function () {
    sock.send(search, 0, search.length, SSDP_PORT, SSDP_ADDR, function () {});
    // Once more: UDP is lost now and then.
    setTimeout(function () { if (!finished) sock.send(search, 0, search.length, SSDP_PORT, SSDP_ADDR, function () {}); }, 600);
  });
  setTimeout(finish, SEARCH_MS);
}

/**
 * A server's description again, from where it was last: its control address.
 * cb(err, { udn, name, control }).
 */
function describe(location, cb) {
  fetchText(location, {}, function (err, body) {
    if (err) return cb(err);
    var d = readDescription(body.toString('utf8'), location);
    if (!d) return cb(new Error('not a media server'));
    cb(null, d);
  });
}

// "1920x1080" as [1920, 1080], or null.
function resolution(s) {
  var m = /^(\d{1,6})x(\d{1,6})$/.exec(String(s || ''));
  return m ? [+m[1], +m[2]] : null;
}

/*
 * The JPEG to fetch of an item's renditions: the smallest that still covers
 * the screen, or the largest there is under maxSide; one without a stated
 * size where none states it.
 */
function bestJpeg(res, maxSide) {
  var jpegs = res.filter(function (r) { return /image\/jpeg/i.test(r.protocolInfo || '') && localUrl(r.url); });
  if (!jpegs.length) return null;
  var sized = jpegs.filter(function (r) { return r.size && Math.max(r.size[0], r.size[1]) <= maxSide; });
  if (!sized.length) {
    var plain = jpegs.filter(function (r) { return !r.size; });
    return plain.length ? plain[0] : null;
  }
  var covering = sized.filter(function (r) { return r.size[0] >= 1920 || r.size[1] >= 1080; });
  var pool = covering.length ? covering : sized;
  pool.sort(function (a, b) { return a.size[0] * a.size[1] - b.size[0] * b.size[1]; });
  return covering.length ? pool[0] : pool[pool.length - 1];
}

/*
 * A Browse result's DIDL-Lite: its folders and its pictures (items of class
 * object.item.imageItem with a JPEG).
 */
function readDidl(didl, maxSide) {
  var folders = [], pictures = [], m;
  var containers = /<container\b([^>]*)>([\s\S]*?)<\/container>/g;
  while ((m = containers.exec(didl)) !== null) {
    var a = attrs(m[1]);
    if (!a.id) continue;
    folders.push({ id: a.id, title: tag(m[2], 'title').slice(0, 200) || a.id, count: a.childCount ? +a.childCount : null });
  }
  var items = /<item\b([^>]*)>([\s\S]*?)<\/item>/g;
  while ((m = items.exec(didl)) !== null) {
    var ia = attrs(m[1]);
    if (!ia.id || !/^object\.item\.imageItem/.test(tag(m[2], 'class'))) continue;
    var res = [], r, resRe = /<res\b([^>]*)>([\s\S]*?)<\/res>/g;
    while ((r = resRe.exec(m[2])) !== null) {
      var ra = attrs(r[1]);
      res.push({ protocolInfo: ra.protocolInfo || '', size: resolution(ra.resolution), url: unescapeXml(r[2]).trim() });
    }
    var best = bestJpeg(res, maxSide);
    if (!best) continue;
    pictures.push({ id: ia.id, title: tag(m[2], 'title').slice(0, 200), date: tag(m[2], 'date').slice(0, 10), url: best.url });
  }
  return { folders: folders, pictures: pictures };
}

function browseBody(objectId, start) {
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">' +
    '<ObjectID>' + esc(objectId) + '</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag>' +
    '<Filter>*</Filter><StartingIndex>' + (start || 0) + '</StartingIndex><RequestedCount>' + BROWSE_COUNT + '</RequestedCount>' +
    '<SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>';
}

/**
 * A folder's subfolders and pictures, its first BROWSE_COUNT entries.
 * cb(err, { folders, pictures, total }).
 */
function browse(control, objectId, maxSide, cb) {
  var body = browseBody(objectId || '0', 0);
  fetchText(control, {
    body: body,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': Buffer.byteLength(body),
      SOAPACTION: '"urn:schemas-upnp-org:service:ContentDirectory:1#Browse"'
    }
  }, function (err, buf) {
    if (err) return cb(err);
    var xml = buf.toString('utf8');
    var result = tag(xml, 'Result');
    if (!result) return cb(new Error('the server did not list the folder'));
    var out = readDidl(result, maxSide);
    out.total = +tag(xml, 'TotalMatches') || out.folders.length + out.pictures.length;
    cb(null, out);
  });
}

module.exports = {
  init: init,
  discover: discover,
  describe: describe,
  browse: browse,
  fetchFile: fetchFile,
  local: local,
  readDescription: readDescription,
  readDidl: readDidl,
  bestJpeg: bestJpeg
};
