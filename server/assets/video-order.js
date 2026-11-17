/* Shared playlist ordering for Home and its Web screen saver. ES5 for webOS. */
(function (root) {
  function shuffled(length, random, previous) {
    var order = [], i, j, value;
    random = typeof random === 'function' ? random : Math.random;
    for (i = 0; i < length; i++) order.push(i);
    for (i = order.length - 1; i > 0; i--) {
      j = Math.floor(random() * (i + 1));
      value = order[i]; order[i] = order[j]; order[j] = value;
    }
    if (order.length > 1 && order[0] === previous) {
      j = 1 + Math.floor(random() * (order.length - 1));
      value = order[0]; order[0] = order[j]; order[j] = value;
    }
    return order;
  }

  var api = { shuffled: shuffled };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TVWebVideoOrder = api;
})(this);
