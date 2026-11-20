/**
 * test/test-dlna.js - Art's network folders (lib/dlna): a media server's
 * description read for its ContentDirectory, a Browse result's folders and
 * pictures, the JPEG picked of a picture's renditions, and only addresses on
 * the local network spoken to.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var dlna = require('../server/lib/dlna');

console.log('Running test-dlna.js ...');

// Only the local network.
assert.ok(dlna.local('192.168.1.20'));
assert.ok(dlna.local('10.0.0.5'));
assert.ok(dlna.local('172.20.1.1'));
assert.ok(!dlna.local('172.32.1.1'));
assert.ok(!dlna.local('8.8.8.8'));
assert.ok(!dlna.local('example.com'));
assert.ok(!dlna.local('192.168.1.300'));

// A description: the control address made whole, against URLBase where given.
var DESC = '<root><URLBase>http://192.168.1.20:8200/</URLBase><device><friendlyName>NAS &amp; Co</friendlyName>' +
  '<modelName>MiniDLNA</modelName><UDN>uuid:abc</UDN><serviceList>' +
  '<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/cm</controlURL></service>' +
  '<service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><controlURL>ctl/ContentDir</controlURL></service>' +
  '</serviceList></device></root>';
var d = dlna.readDescription(DESC, 'http://192.168.1.20:8200/rootDesc.xml');
assert.deepEqual(d, { udn: 'uuid:abc', name: 'NAS & Co', control: 'http://192.168.1.20:8200/ctl/ContentDir', skip: false });
assert.strictEqual(dlna.readDescription(DESC.replace('ContentDirectory', 'Other'), 'http://192.168.1.20/'), null, 'no ContentDirectory, no server');
assert.strictEqual(dlna.readDescription(DESC.replace('http://192.168.1.20:8200/', 'http://203.0.113.9/'), 'http://192.168.1.20/d.xml'), null, 'a control address off the network is refused');
assert.ok(dlna.readDescription(DESC.replace('MiniDLNA', 'Sonos Era 300'), 'http://192.168.1.20/').skip, 'a Sonos speaker is left out');

// A Browse result: folders, pictures with a JPEG, nothing else.
var DIDL = '<DIDL-Lite xmlns:dc="x" xmlns:upnp="y">' +
  '<container id="64$1" parentID="64" childCount="12"><dc:title>Trips &amp; Days</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>' +
  '<item id="64$2" parentID="64"><dc:title>Beach</dc:title><upnp:class>object.item.imageItem.photo</upnp:class><dc:date>2019-07-01T10:00:00</dc:date>' +
  '<res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_LRG" resolution="6000x4000">http://192.168.1.20:8200/a.jpg</res>' +
  '<res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_LRG" resolution="4096x2731">http://192.168.1.20:8200/a-l.jpg</res>' +
  '<res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_MED" resolution="1920x1280">http://192.168.1.20:8200/a-m.jpg?x=1&amp;y=2</res>' +
  '<res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_SM" resolution="640x427">http://192.168.1.20:8200/a-s.jpg</res></item>' +
  '<item id="64$3"><dc:title>Raw</dc:title><upnp:class>object.item.imageItem.photo</upnp:class>' +
  '<res protocolInfo="http-get:*:image/x-sony-arw:*">http://192.168.1.20:8200/b.arw</res></item>' +
  '<item id="64$4"><dc:title>Film</dc:title><upnp:class>object.item.videoItem</upnp:class>' +
  '<res protocolInfo="http-get:*:video/mp4:*">http://192.168.1.20:8200/c.mp4</res></item>' +
  '<item id="64$5"><dc:title>Old</dc:title><upnp:class>object.item.imageItem</upnp:class>' +
  '<res protocolInfo="http-get:*:image/jpeg:*">http://192.168.1.20:8200/d.jpg</res></item>' +
  '<item id="64$6"><dc:title>Elsewhere</dc:title><upnp:class>object.item.imageItem</upnp:class>' +
  '<res protocolInfo="http-get:*:image/jpeg:*">http://203.0.113.9/e.jpg</res></item>' +
  '</DIDL-Lite>';
var r = dlna.readDidl(DIDL, 8192);
assert.deepEqual(r.folders, [{ id: '64$1', title: 'Trips & Days', count: 12 }]);
assert.deepEqual(r.pictures.map(function (p) { return p.id; }), ['64$2', '64$5'], 'only pictures with a JPEG on the network');
assert.strictEqual(r.pictures[0].url, 'http://192.168.1.20:8200/a-m.jpg?x=1&y=2', 'the smallest that covers the screen');
assert.strictEqual(r.pictures[0].date, '2019-07-01');
assert.strictEqual(r.pictures[1].url, 'http://192.168.1.20:8200/d.jpg', 'one without a size where none says');

// Under the screen, the largest there is; over the limit, none.
function res(w, h, u) { return { protocolInfo: 'http-get:*:image/jpeg:*', size: [w, h], url: 'http://192.168.1.2/' + u }; }
assert.strictEqual(dlna.bestJpeg([res(640, 480, 's'), res(1024, 768, 'm')], 8192).url, 'http://192.168.1.2/m');
assert.strictEqual(dlna.bestJpeg([res(9000, 6000, 'x')], 8192), null);

console.log('ALL test-dlna.js assertions passed!');
