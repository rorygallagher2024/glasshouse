/* Custom Home videos are validated, persisted, and exposed to the TV views. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var wallpapers = require('../server/lib/home-wallpapers');
var fetchMod = require('../server/lib/fetch');
var dir = path.join(os.tmpdir(), 'home-videos-' + process.pid);
fs.mkdirSync(dir);
wallpapers.init(dir);

function set(urls, shuffle) {
  var result;
  wallpapers.setVideoSources(urls, shuffle, function (r) { result = r; });
  return result;
}

var ok = set(['https://media.example/one.mp4', 'http://homeassistant:8123/local/two.webm'], true);
assert.strictEqual(ok.ok, true, ok.error);
assert.strictEqual(ok.wallpapers.choice, 'video');
assert.strictEqual(ok.wallpapers.videoShuffle, true);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['https://media.example/one.mp4', 'http://homeassistant:8123/local/two.webm'],
  items: [
    { url: 'https://media.example/one.mp4', title: '', pointsOfInterest: [] },
    { url: 'http://homeassistant:8123/local/two.webm', title: '', pointsOfInterest: [] }
  ], shuffle: true
});
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
  ], shuffle: true
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
  shuffle: false
});

wallpapers.init(dir);
assert.deepEqual(wallpapers.videoSources(), {
  urls: ['http://media.example/coast.mov'],
  items: [{ url: 'http://media.example/coast.mov', title: 'Coastline', pointsOfInterest: [{ at: 0, text: 'Above the bay' }] }],
  shuffle: false
});
var saved = JSON.parse(fs.readFileSync(path.join(dir, 'home-wallpaper.json'), 'utf8'));
assert.strictEqual(saved.choice, 'video');
assert.deepEqual(saved.videoInputs, ['http://media.example/entries.json']);
fs.unlinkSync(path.join(dir, 'home-wallpaper.json'));
fs.rmdirSync(dir);
console.log('ALL test-home-video-sources.js assertions passed!\n');
