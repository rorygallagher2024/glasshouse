/*
 * test/mocks/fake-palmbus.js - stands in for LG's palmbus binding: answers a
 * call by its URI, as test/test-palmbus.js sets out in global.fakeBus.
 * Strict ES5: runs on node 0.10.
 */
var EventEmitter = require('events').EventEmitter;

function Handle() {
  global.fakeBus.handles = (global.fakeBus.handles || 0) + 1;
  this.gone = false;
}
Handle.prototype.unregister = function () { this.gone = true; };
Handle.prototype.call = function (uri, payload) {
  var bus = global.fakeBus, self = this;
  var c = new EventEmitter();
  c.cancel = function () {};
  var name = uri.replace('luna://', '');
  bus.calls.push(name);
  var answer = bus.answers[name];
  if (answer === undefined) answer = { returnValue: true, via: 'palmbus', payload: JSON.parse(payload) };
  if (answer !== null) {
    var wait = (bus.delays && bus.delays[name]) || bus.delay || 0;
    // An unregistered handle hears nothing more.
    setTimeout(function () { if (!self.gone) c.emit('response', { payload: function () { return JSON.stringify(answer); } }); }, wait);
  }
  return c;
};

module.exports = { Handle: Handle };
