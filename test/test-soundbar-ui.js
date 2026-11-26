var assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm');
if (Number(process.versions.node.split('.')[0]) < 16) {
  console.log('test-soundbar-ui.js: browser renderer skipped on legacy Node');
  process.exit(0);
}

var elements = {};
function element(id) {
  if (!elements[id]) elements[id] = {
    classList: { toggle: function () {} }, matches: function () { return false; },
    setAttribute: function (name, value) { this[name] = value; },
    nextElementSibling: {}
  };
  return elements[id];
}
element('soundbar-i_vol').type = 'range';
var context = { q: element, t: function (key, fallback, args) { return args ? fallback.replace('{value}', args.value) : fallback; },
  document: { addEventListener: function () {}, getElementById: element }, window: { addEventListener: function () {} } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui/soundbar.js'), 'utf8'), context);
// The same controls stay mounted throughout the test.
vm.runInContext('soundbarRows = () => {}; soundbarOnline = true; soundbarWritable = true;', context);
function speaker(volume, mute, input) {
  context.soundbarReceiveDevice({ rows: [
    { key: 'i_curr_func', value: input, options: [1, 20] }, { key: 'i_vol', value: volume, min: 0, max: 100, step: 1 },
    { key: 'b_mute', value: mute }, { key: 'b_night_time', value: true }
  ] });
  context.soundbarRender();
}
function television(volume, mute, control, output) {
  context.soundbarTVPlayback({ volume: volume, muted: mute, volume_control: control, audio_output: output,
    sound: { output_raw: 'external_arc' } });
}
function readings(volume, mute, tv) {
  var note = element('soundbar-tv-volume');
  assert.strictEqual(note.hidden, tv === undefined);
  assert.strictEqual(note.textContent, tv === undefined ? '' : 'TV-reported volume: ' + tv);
  assert.strictEqual(element('soundbar-i_vol').value, String(volume));
  assert.strictEqual(element('soundbar-i_vol').nextElementSibling.textContent, String(volume));
  assert.strictEqual(element('soundbar-b_mute')['aria-pressed'], String(mute));
  assert.strictEqual(element('soundbar-b_night_time')['aria-pressed'], 'true');
}
speaker(10, false, 20);
television(14, true, 'level', 'HDMI ARC');
speaker(10, false, 20);
readings(10, false, 14); // A stale Wi-Fi snapshot after a TV remote press.
speaker(12, false, 20);
television(14, true, 'level', 'HDMI ARC');
readings(12, false, 14); // A ThinQ volume change while the TV repeats an old value.
television(0, false, 'level', 'HDMI ARC');
readings(12, false, 0);
television(12, false, 'level', 'HDMI ARC');
readings(12, false);
television(null, true, 'steps', 'HDMI ARC');
readings(12, false);
television(120, false, 'level', 'HDMI ARC');
readings(12, false);
television(6, true, 'level', 'TV Speaker');
readings(12, false); // The live route takes precedence over the cached sound setting.
television(6, true, 'level', 'HDMI ARC');
speaker(9, false, 1);
television(20, true, 'level', 'HDMI ARC');
readings(9, false); // The selected bar is playing Bluetooth.
console.log('test-soundbar-ui.js passed');
