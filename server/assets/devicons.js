/*
 * Line icons for HDMI input tiles, chosen from the CEC or input name, for
 * Glasshouse Home and the input bar. Strict ES5: the TV's own browser runs it.
 */
(function (root) {
  var ICONS = {
    handheld: '<rect x="2" y="6" width="20" height="12" rx="3"/><path d="M6.5 6v12M17.5 6v12"/>' +
      '<circle cx="4.3" cy="10" r=".7" fill="currentColor"/><circle cx="19.7" cy="14" r=".7" fill="currentColor"/>',
    console: '<path d="M7 8h10a4 4 0 0 1 4 4l.6 4.2a2.3 2.3 0 0 1-4 1.8L15.5 16h-7l-2.1 2a2.3 2.3 0 0 1-4-1.8L3 12a4 4 0 0 1 4-4z"/>' +
      '<path d="M7.5 10.5v3M6 12h3"/><circle cx="15.5" cy="11" r=".7" fill="currentColor"/><circle cx="17.5" cy="13" r=".7" fill="currentColor"/>',
    stream: '<rect x="4" y="13" width="16" height="6" rx="2"/><path d="M8.5 9.5a5 5 0 0 1 7 0M6 7a8.5 8.5 0 0 1 12 0"/>',
    audio: '<rect x="2" y="10" width="20" height="5" rx="2.5"/><path d="M6 12.5h.01M10 12.5h.01M14 12.5h.01M18 12.5h.01"/>',
    disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/>',
    pc: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
    tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 20h8M9 2l3 3 3-3"/>',
    plug: '<path d="M5 9h14v3l-2 3H7l-2-3z"/><path d="M8 15v3h8v-3"/>'
  };
  // Handheld is tested before console so "Switch2 Game Console" gets the handheld.
  /** @type {Array<[string, RegExp]>} */
  var KINDS = [
    ['handheld', /nintendo|switch ?\d|switch game|steam ?deck/],
    ['console', /xbox|playstation|\bps[345]\b|console|gaming/],
    ['stream', /apple ?tv|roku|chromecast|fire ?tv|firestick|shield|google ?tv|streamer/],
    ['audio', /sonos|sound ?bar|receiver|\bavr\b|denon|yamaha|marantz|onkyo|bose/],
    ['disc', /blu-?ray|dvd/],
    ['pc', /\bpc\b|computer|\bmac\b|macbook|laptop|desktop/],
    ['tv', /cable|satellite|xfinity|directv|\bdish\b|tivo/]
  ];
  function kindOf(d) {
    var s = ((d && d.name) || '') + ' ' + ((d && d.id) || '');
    s = s.toLowerCase();
    for (var k = 0; k < KINDS.length; k++) {
      if (KINDS[k][1].test(s)) return KINDS[k][0];
    }
    return 'plug';
  }
  root.glasshouseDevIcon = function (d) {
    return '<i class="dico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + ICONS[kindOf(d)] + '</svg></i>';
  };
// Untyped for the type check, which does not know the name added to it.
})(/** @type {any} */ (window));
