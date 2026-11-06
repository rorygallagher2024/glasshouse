/*
 * test/test-iptv-drm.js - reading an HLS playlist for DRM the TV's player
 * cannot use, and finding a master playlist's first variant.
 * Strict ES5: also runs on node 0.10.
 */
var assert = require('assert');
var iptv = require('../server/lib/iptv');

console.log('Running test-iptv-drm.js ...');

var fairplay = '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://df16",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:4,\na.ts\n';
assert.strictEqual(iptv.hlsProtected(fairplay), true, 'FairPlay');
assert.strictEqual(iptv.hlsProtected('#EXTM3U\r\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\r\n'), true, 'Widevine in a master');
assert.strictEqual(iptv.hlsProtected('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'), false, 'AES-128 with a plain key plays');
assert.strictEqual(iptv.hlsProtected('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n'), false);
assert.strictEqual(iptv.hlsProtected('#EXTM3U\n#EXTINF:4,\na.ts\n'), false);
console.log('  ✓ a key the TV cannot use is told from one it can');

var master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchannel1-video=1.m3u8?w=30\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n';
var base = 'https://live.example/live/a/channel1.isml/channel1.m3u8?x=1';
assert.strictEqual(iptv.firstVariant(master, base), 'https://live.example/live/a/channel1.isml/channel1-video=1.m3u8?w=30');
assert.strictEqual(iptv.firstVariant('#EXT-X-STREAM-INF:B=1\n/root/v.m3u8\n', base), 'https://live.example/root/v.m3u8');
assert.strictEqual(iptv.firstVariant('#EXT-X-STREAM-INF:B=1\nhttp://o.example/v.m3u8\n', base), 'http://o.example/v.m3u8');
assert.strictEqual(iptv.firstVariant('#EXTM3U\n#EXTINF:4,\na.ts\n', base), null, 'a media playlist has none');
console.log('  ✓ a master playlist\'s first variant is resolved against its address');

console.log('ALL test-iptv-drm.js assertions passed!\n');
