/* Custom Home videos are validated, persisted, and exposed to the TV views. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var wallpapers = require('../server/lib/home-wallpapers');
var fetchMod = require('../server/lib/fetch');
var videoOrder = require('../server/assets/video-order');
var dir = path.join(os.tmpdir(), 'home-videos-' + process.pid);
fs.mkdirSync(dir);
wallpapers.init(dir);

var defaultStyle = { showClock: true, showDate: true, showWeather: true, showCaptions: true,
  infoPosition: 'top-right', captionPosition: 'top-left', clockFont: 'Outfit', textFont: 'Manrope', captionFont: 'Manrope',
  textColor: '#ece7df', infoSize: 100, captionSize: 32 };
var style = { showClock: false, showWeather: true, infoPosition: 'bottom-right', captionPosition: 'bottom-left',
  clockFont: 'Manrope', textFont: 'Outfit', textColor: '#ffcc88', infoSize: 118, captionSize: 40 };

// Object.assign is not in Node 0.10 and 0.12, which this runs on as the TVs do.
function merged() {
  var out = {};
  for (var i = 0; i < arguments.length; i++) {
    for (var k in arguments[i]) if (Object.prototype.hasOwnProperty.call(arguments[i], k)) out[k] = arguments[i][k];
  }
  return out;
}

function set(urls, shuffle, videoStyle) {
  var result;
  wallpapers.setVideoSources(urls, shuffle, function (r) { result = r; }, videoStyle);
  return result;
}

var ok = set(['https://media.example/one.mp4', 'http://homeassistant:8123/local/two.webm'], true, style);
assert.strictEqual(ok.ok, true, ok.error);
assert.strictEqual(ok.wallpapers.choice, 'video');
assert.strictEqual(ok.wallpapers.videoShuffle, true);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['https://media.example/one.mp4', 'http://homeassistant:8123/local/two.webm'],
  items: [
    { url: 'https://media.example/one.mp4', title: '', pointsOfInterest: [] },
    { url: 'http://homeassistant:8123/local/two.webm', title: '', pointsOfInterest: [] }
  ], shuffle: true, style: merged({}, defaultStyle, style)
});
// The pictures' revision goes into their addresses: with the videos in it,
// a long list made them too long to load, and a picture background stayed black.
assert.strictEqual(ok.wallpapers.revision.indexOf('media.example'), -1);
assert.strictEqual(set(['file:///etc/passwd'], false).ok, false);
assert.strictEqual(set(['https://user:password@media.example/a.mp4'], false).ok, false);
var tooMany = [];
for (var i = 0; i <= wallpapers.MAX_VIDEO_SOURCES; i++) tooMany.push('https://media.example/a.mp4');
assert.strictEqual(set(tooMany, false).ok, false);

wallpapers.init(dir);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['https://media.example/one.mp4', 'http://homeassistant:8123/local/two.webm'],
  items: [
    { url: 'https://media.example/one.mp4', title: '', pointsOfInterest: [] },
    { url: 'http://homeassistant:8123/local/two.webm', title: '', pointsOfInterest: [] }
  ], shuffle: true, style: merged({}, defaultStyle, style)
});
var aerial = wallpapers.parseVideoEntries({ assets: [
  { accessibilityLabel: 'Coastline', 'url-4K-HDR': 'http://media.example/coast.mov', pointsOfInterest: { '0': 'Above the bay', '12': 'Passing the headland' } },
  { accessibilityLabel: 'Fallback', 'url-1080-H264': 'https://media.example/fallback.mp4', pointsOfInterest: {} }
] });
assert.deepEqual(aerial, [
  { url: 'http://media.example/coast.mov', title: 'Coastline', pointsOfInterest: [{ at: 0, text: 'Above the bay' }, { at: 12, text: 'Passing the headland' }] },
  { url: 'https://media.example/fallback.mp4', title: 'Fallback', pointsOfInterest: [] }
]);
fetchMod.probeFetch = function (url, outFile, cb) {
  assert.strictEqual(url, 'http://media.example/entries.json');
  cb(null, JSON.stringify({ assets: [
    { accessibilityLabel: 'Coastline', 'url-4K-HDR': 'http://media.example/coast.mov', pointsOfInterest: { '0': 'Above the bay' } }
  ] }));
};
var feedResult;
wallpapers.setVideoSources(['http://media.example/entries.json'], false, function (r) { feedResult = r; });
assert.strictEqual(feedResult.ok, true, feedResult.error);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['http://media.example/coast.mov'],
  items: [{ url: 'http://media.example/coast.mov', title: 'Coastline', pointsOfInterest: [{ at: 0, text: 'Above the bay' }] }],
  shuffle: false, style: merged({}, defaultStyle, style)
});

wallpapers.init(dir);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['http://media.example/coast.mov'],
  items: [{ url: 'http://media.example/coast.mov', title: 'Coastline', pointsOfInterest: [{ at: 0, text: 'Above the bay' }] }],
  shuffle: false, style: merged({}, defaultStyle, style)
});
var saved = JSON.parse(fs.readFileSync(path.join(dir, 'home-wallpaper.json'), 'utf8'));
assert.strictEqual(saved.choice, 'video');
assert.deepEqual(saved.videoInputs, ['http://media.example/entries.json']);
assert.deepEqual(saved.videoStyle, merged({}, defaultStyle, style));

// Shuffle and one detail at a time, as the dashboard saves them: the playlist stays, a bad value is ignored.
var optionsResult;
wallpapers.setVideoOptions({ shuffle: true, style: { showCaptions: false, captionSize: 400, infoPosition: 'middle' } }, function (r) { optionsResult = r; });
assert.strictEqual(optionsResult.ok, true, optionsResult.error);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['http://media.example/coast.mov'],
  items: [{ url: 'http://media.example/coast.mov', title: 'Coastline', pointsOfInterest: [{ at: 0, text: 'Above the bay' }] }],
  shuffle: true, style: merged({}, defaultStyle, style, { showCaptions: false, captionSize: 56 })
});
wallpapers.init(dir);
assert.strictEqual(wallpapers.videoSources().shuffle, true);
assert.strictEqual(wallpapers.videoSources().style.showCaptions, false);

var deterministic = function () { return 0; };
var firstOrder = videoOrder.shuffled(8, deterministic, -1), nextOrder = videoOrder.shuffled(8, deterministic, firstOrder[firstOrder.length - 1]);
assert.deepEqual(firstOrder.slice().sort(function (a, b) { return a - b; }), [0, 1, 2, 3, 4, 5, 6, 7]);
assert.deepEqual(nextOrder.slice().sort(function (a, b) { return a - b; }), [0, 1, 2, 3, 4, 5, 6, 7]);
assert.notStrictEqual(nextOrder[0], firstOrder[firstOrder.length - 1], 'the next cycle does not start with the previous cycle\'s last video');
fs.unlinkSync(path.join(dir, 'home-wallpaper.json'));
fs.rmdirSync(dir);
console.log('ALL test-home-video-sources.js assertions passed!\n');
