// Browser rendering keeps CEC detection separate from negotiated transport.
var fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
if (Number(process.versions.node.split('.')[0]) < 8) {
  console.log('test-audio-detection-ui.js: browser script skipped on legacy node');
} else {
  var elements = {};
  function q(id) { return elements[id] || (elements[id] = { textContent: '', innerHTML: '' }); }
  var state = {
    identity: { model: 'Synthetic C9', firmware: 'test' },
    tv: { dtsDecoder: true, input: 1, playbackDeclarations: null, formats: [
      { id: 'dts', name: 'DTS', advertised: true, receiver: null }
    ] },
    receiver: { detected: true, name: 'Synthetic <soundbar>', port: 2, link: 'unknown', formatsKnown: false },
    live: { input: null, hdmi: { channels: 6, sampleRate: null }, output: null }, outputName: 'HDMI ARC'
  };
  var context = { q: q, currentState: state,
    t: function (key, text, values) { return text.replace(/\{(\w+)\}/g, function (match, key) { return values && values[key] !== undefined ? values[key] : match; }); },
    esc: function (text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../server/assets/ui/audio.js'), 'utf8'), context);
  function render() { vm.runInContext('audioState = currentState; renderAudio();', context); }
  render();
  assert(q('audio-path').innerHTML.indexOf('HDMI audio device detected') !== -1);
  assert(q('audio-path').innerHTML.indexOf('Synthetic &lt;soundbar&gt; · HDMI 2') !== -1);
  assert(q('audio-path').innerHTML.indexOf('Live audio status unavailable') !== -1);
  assert(q('audio-link-note').textContent.indexOf('does not report its ARC/eARC link type') !== -1);
  assert(q('audio-formats').innerHTML.indexOf('Unknown') !== -1);
  state.receiver.link = 'inactive'; render();
  assert(q('audio-path').innerHTML.indexOf('No active ARC link') !== -1);
  state.receiver.detected = null; state.receiver.name = null; state.receiver.port = null; state.receiver.link = 'unknown'; render();
  assert(q('audio-path').innerHTML.indexOf('Link unknown') !== -1);
  assert(q('audio-path').innerHTML.indexOf('HDMI audio device detected') === -1);
  console.log('test-audio-detection-ui.js passed');
}
