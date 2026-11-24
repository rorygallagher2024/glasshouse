/*
 * home-iptv.js - Internet TV stream and MPEG-TS MSE player for Glasshouse Home.
 *
 * Manages one live stream at a time in Home's preview <video>: native TV
 * playback for HLS, timeshift recordings and fallback streams, and mpegts.js
 * (/assets/vendor/mpegts.js) over /api/iptv/relay for MPEG-TS channels.
 *
 * Strict ES5: the TV's browser on webOS 3 and 4 parses nothing newer.
 */
(function (root) {
  var STREAM_START_MS = 12000;
  // The picture not moving this long is a stall, whatever events the <video> sent;
  // sooner with nothing buffered past it: every stall logged on a provider's
  // stream had under a second buffered, so waiting longer only kept it frozen.
  var STALL_MS = 8000;
  var STALL_EMPTY_MS = 3000;
  // A hole in what is buffered is stepped over after this long, before reconnecting.
  var NUDGE_MS = 2500;
  /*
   * The picture stopped with more than KICK_AHEAD_S buffered past it: the
   * decoder, not the network. A G3 (webOS 10) held one still for 9 s on 19.5 s
   * buffered before the stall reconnect; mpegts.js was seen doing the same.
   * Home's own player is stepped on after KICK_MS and reopened after FROZEN_MS;
   * the TV's player keeps the stall rule below.
   */
  var KICK_AHEAD_S = 1;
  var KICK_MS = 1500;
  // Buffered seconds below which Home's player holds for a refill.
  var REFILL_LOW_S = 0.5;
  var KICK_EVERY_MS = 30000;
  var FROZEN_MS = 4000;
  /*
   * Home's own player holds the picture when its buffer runs dry, until it has
   * a cushion again: playing on at the browser's tenth of a second stutters
   * again at the next hiccup. Each time a channel runs dry its cushion grows,
   * over reconnects and, through cushionMemo, the next visit; it halves after
   * CUSHION_CLEAN_MS of clean play. The hold plays on after REFILL_SOME_MS
   * once the base is there, so a grown cushion is no long wait. The numbers,
   * and those of the start below, are TiviBro's (player.js, MIT).
   */
  var REFILL_SOME_MS = 4000;
  var REFILL_MAX_S = 18;
  /*
   * Nothing arriving in a hold for REFILL_DRY_MS: a new connection, which
   * comes with a burst. Longer on a channel seen sending in bursts, a third
   * more than its longest gap, up to REFILL_DRY_MAX_MS, and not in a
   * connection's first REFILL_DRY_MAX_MS: reconnected at 4 s, a stream sent
   * as a 10 s piece every 10 s lost the piece that was about to come.
   */
  var REFILL_DRY_MS = 4000;
  var REFILL_DRY_MAX_MS = 12000;
  var CUSHION_CLEAN_MS = 180000;
  /*
   * Before the picture starts, Home's player buffers this many seconds of the
   * stream (cushionMemo: fewer for a provider whose channels seldom run dry,
   * more for one whose do), and a preview at most PREVIEW_PREBUFFER_S; it
   * starts anyway after START_WAIT_MS and a second for each second asked.
   */
  var PREVIEW_PREBUFFER_S = 1.2;
  var START_WAIT_MS = 4000;
  /*
   * A stream arriving slower than it plays: over TRICKLE_MS its buffered end
   * moved at under TRICKLE_RATE of real time with something every
   * TRICKLE_GAP_MS, and the cushion is nearly gone. Reopened before it runs
   * out, at most once in TRICKLE_EVERY_MS.
   */
  var TRICKLE_MS = 30000;
  var TRICKLE_RATE = 0.5;
  var TRICKLE_GAP_MS = 6000;
  var TRICKLE_EVERY_MS = 120000;
  /*
   * Far more buffered than a live channel sends ahead (a burst of 10 to 40 s,
   * then real time): a placeholder that is a file sent faster than real time,
   * which put minutes of 1080p in memory within seconds (TiviBro issue #76).
   * Reading stops, what is buffered plays, and it is reopened near the end.
   * Less on a TV with 1 GB of memory or less.
   */
  var AHEAD_MAX_S = 180;
  var AHEAD_MAX_SMALL_S = 60;
  var AHEAD_REOPEN_S = 2;

  /*
   * Reconnects in a row before giving up. A live channel reopens at the live
   * point. A provider's CDN was seen sending nothing for 30 to 50 s at a time,
   * so one that has played gets about a minute; one that never has gets two,
   * as a one-stream account can refuse a channel change for a moment.
   */
  var RETRIES_FIRST = 2;
  var RETRIES_PLAYING = 8;
  var RETRY_WAIT_MS = [400, 1500, 3000, 5000, 8000, 10000];
  // Playing this long since the last reconnect, a stream has all its reconnects back.
  var STEADY_MS = 30000;
  // Out of reconnects, a channel that played: every 6 s for 3 minutes, then every 15 s, for 20 minutes.
  var SLOW_FAST_MS = 6000;
  var SLOW_FAST_FOR_MS = 3 * 60000;
  var SLOW_EVERY_MS = 15000;
  var SLOW_FOR_MS = 20 * 60000;
  // The network down: looked at again this often, without using a reconnect.
  var OFFLINE_WAIT_MS = 3000;
  var WATCH_MS = 500;

  var SWAP_DROPS = 2;
  var SWAP_DROPS_MS = 180000;
  var SWAP_MAX = 3;
  var SWAP_MAX_MS = 600000;
  var FREEZES_MS = 600000;

  var CUSHION_KEY = 'gh.iptvCushion';
  var CUSHION_CHANNELS = 300;
  var CUSHION_OLD_MS = 30 * 86400000;
  var CUSHION_HALF_MS = 20 * 3600000;
  // A provider is judged after 3 channel starts and 15 minutes watched; until then, 2 s.
  var CUSHION_STARTS = 3;
  var CUSHION_JUDGE_MS = 15 * 60000;
  var CUSHION_LEARNING_S = 2;
  // Runs dry per hour watched, below max: seconds buffered before the picture starts.
  var CUSHION_LEVELS = [{ max: 0.5, pre: 0.8 }, { max: 3, pre: 2 }, { max: 8, pre: 4 }, { max: Infinity, pre: 6 }];

  var MPEGTS_SRC = '/assets/vendor/mpegts.js';

  function aheadMax() {
    var m = 0;
    try { m = /** @type {any} */ (navigator).deviceMemory || 0; } catch (e) {}
    return m && m <= 1 ? AHEAD_MAX_SMALL_S : AHEAD_MAX_S;
  }

  // Stops mpegts.js reading, keeping what it buffered: its own pause for lazy loading, internal in 1.8.
  function mseStopReading(m) {
    var e = m && m._player_engine;
    if (!e || typeof e._onRequestPauseTransmuxer !== 'function') return false;
    try { e._onRequestPauseTransmuxer(); return true; } catch (x) { return false; }
  }

  // Seconds buffered past the picture, and the start of the next buffered range after a hole.
  function bufferedAhead(v) {
    var b = v.buffered, ct = v.currentTime, out = { ahead: 0, next: -1, end: 0 };
    try {
      for (var i = 0; i < b.length; i++) {
        if (b.end(i) > out.end) out.end = b.end(i);
        if (b.start(i) <= ct + 0.05 && b.end(i) > ct) out.ahead = b.end(i) - ct;
        else if (b.start(i) > ct && out.next < 0) out.next = b.start(i);
      }
    } catch (e) {}
    return out;
  }

  /*
   * What Home's player learns, kept in this page's storage (TiviBro's
   * playmemo.js): per channel, the extra cushion it earned by running dry,
   * and the kind of stream (HLS or MPEG-TS) it last played as where that was
   * not its own;
   * per playlist, how often its channels run dry for each hour watched, which
   * sets the seconds buffered before the picture starts and the refill's base.
   * The counts halve every 20 hours watched, so it follows a provider that
   * changes; a channel not played for 30 days is forgotten.
   */
  function createCushionMemo(storage, opts) {
    var data = null, timer = null;
    var saveDelayMs = opts && typeof opts.saveDelayMs === 'number' ? opts.saveDelayMs : 3000;
    function getStore() {
      if (storage !== undefined) return storage;
      try { return typeof window !== 'undefined' ? window.localStorage : null; } catch (e) { return null; }
    }
    function load() {
      if (data) return data;
      try {
        var st = getStore();
        data = JSON.parse((st && st.getItem(CUSHION_KEY)) || 'null');
      } catch (e) { data = null; }
      if (!data || typeof data !== 'object' || !data.ch || !data.pl) data = { ch: {}, pl: {} };
      return data;
    }
    function save() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        var d = load(), now = Date.now();
        var keys = Object.keys(d.ch).filter(function (k) { return now - d.ch[k].t < CUSHION_OLD_MS; });
        keys.sort(function (a, b) { return d.ch[b].t - d.ch[a].t; });
        var kept = {};
        keys.slice(0, CUSHION_CHANNELS).forEach(function (k) { kept[k] = d.ch[k]; });
        d.ch = kept;
        try {
          var st = getStore();
          if (st) st.setItem(CUSHION_KEY, JSON.stringify(d));
        } catch (e) {}
      }, saveDelayMs);
    }
    // A channel's entry, { b: extra cushion, f: 'hls' or 'ts', t: last changed }; kept while it says anything.
    function channel(id, b, f) {
      var d = load(), e = d.ch[id] || { b: 0, f: '', t: 0 };
      if (e.b === b && e.f === f) return;
      e.b = b;
      e.f = f;
      e.t = Date.now();
      if (b > 0 || f) d.ch[id] = e;
      else if (d.ch[id]) delete d.ch[id];
      save();
    }
    function entry(id) {
      var e = load().ch[id];
      return e && Date.now() - e.t < CUSHION_OLD_MS ? e : null;
    }
    function provider(pl) {
      var d = load();
      return d.pl[pl] || (d.pl[pl] = { n: 0, dry: 0, ms: 0 });
    }
    return {
      // Seconds buffered before the picture starts, for a playlist's channels.
      prebuffer: function (pl) {
        var x = load().pl[pl];
        if (!x || x.n < CUSHION_STARTS || x.ms < CUSHION_JUDGE_MS) return CUSHION_LEARNING_S;
        var rate = x.dry / (x.ms / 3600000);
        for (var i = 0; i < CUSHION_LEVELS.length; i++) if (rate < CUSHION_LEVELS[i].max) return CUSHION_LEVELS[i].pre;
        return CUSHION_LEARNING_S;
      },
      boost: function (id) { var e = entry(id); return e ? +e.b || 0 : 0; },
      setBoost: function (id, s) { var e = entry(id); channel(id, Math.round(s * 10) / 10, e ? e.f : ''); },
      format: function (id) { var e = entry(id); return e && (e.f === 'hls' || e.f === 'ts') ? e.f : ''; },
      setFormat: function (id, f) { var e = entry(id); channel(id, e ? e.b : 0, f || ''); },
      started: function (pl) { provider(pl).n++; save(); },
      ranDry: function (pl) { provider(pl).dry++; save(); },
      watched: function (pl, ms) {
        var x = provider(pl);
        x.ms += ms;
        if (x.ms > CUSHION_HALF_MS) {
          x.ms /= 2;
          x.dry /= 2;
          x.n = Math.max(Math.min(x.n, CUSHION_STARTS), Math.ceil(x.n / 2));
        }
        save();
      }
    };
  }

  function createHomeIptvPlayer(deps) {
    deps = deps || {};
    var cushionMemo = createCushionMemo(deps.storage);

    /*
     * One stream at a time, through the preview's <video>. Each start bumps the
     * generation, which strands any reply, timer or retry from the last; the
     * last is torn down completely before the next opens.
     */
    // muted: the stream's own, kept here so a recovery reopens it as it is shown now.
    // timeshift: played from the server's recording, which can pause (lib/iptv-timeshift);
    // behindMs: time spent paused since the live point; left: seconds the recording can still hold the pause.
    var tvStream = { gen: 0, claim: -1, item: null, format: '', playing: false, watch: null, onState: null, leaseTimer: null,
      muted: true, retryTimer: null, tries: 0, everPlayed: false, lostAt: 0, openedAt: 0, full: false,
      timeshift: false, paused: false, pausedAt: 0, behindMs: 0, capacity: null, tsTimer: null, tsUrl: '', noPauseAt: 0,
      // seekTo: seconds behind live the next open starts at; seekTarget: where left and right are heading; kept: seconds the stick holds.
      seekTo: null, seekTarget: null, seekTimer: null, kept: null,
      // engine: 'mse' (Home's own player, mpegts.js) or 'native' (the TV's); mse: the mpegts.js player.
      engine: '', mse: null,
      pastCache: false, account: false, switchable: false, boost: 0, boostAt: 0, starved: false, trickleAt: 0,
      slowSince: 0, gapMax: 0, as: '', drops: [], swaps: [], swapFrom: '', noSwap: false, halfSwitched: false };

    /*
     * Home's own player for MPEG-TS (mpegts.js, assets/vendor): it reads the
     * stream through the server's relay and feeds the TV's decoder through Media
     * Source Extensions, so starting, stalls and freezes are Home's to handle
     * rather than the TV player's. Loaded on the first channel that can use it.
     * A channel it cannot play goes to the TV's player for the rest of the visit.
     */
    var mpegtsLoad = { state: 0, waiting: [] };
    var nativeOnly = {};
    function withMpegts(cb) {
      if (mpegtsLoad.state === 2) return cb(true);
      if (mpegtsLoad.state < 0) return cb(false);
      mpegtsLoad.waiting.push(cb);
      if (mpegtsLoad.state === 1) return;
      mpegtsLoad.state = 1;
      var el = document.createElement('script');
      var done = function (ok) {
        mpegtsLoad.state = ok ? 2 : -1;
        var w = mpegtsLoad.waiting;
        mpegtsLoad.waiting = [];
        w.forEach(function (f) { f(ok); });
      };
      el.onload = function () { done(true); };
      el.onerror = function () { done(false); };
      el.src = MPEGTS_SRC;
      document.head.appendChild(el);
    }
    function mseUsable() {
      var m = typeof window !== 'undefined' ? /** @type {any} */ (window).mpegts : null;
      try { return !!(window.MediaSource && m && m.getFeatureList().mseLivePlayback); } catch (e) { return false; }
    }
    // True when a channel's decoding failures in Home's player reach two, which sends it to the TV's.
    var mseFailures = {};
    function mseRefusedOnce(it, detail) {
      var id = it.pl + ':' + it.key;
      mseFailures[id] = (mseFailures[id] || 0) + 1;
      if (mseFailures[id] < 2) return false;
      nativeOnly[id] = true;
      streamEvent('native', { detail: detail });
      return true;
    }
    function releaseMse() {
      var m = tvStream.mse;
      tvStream.mse = null;
      if (!m) return;
      try { m.destroy(); } catch (e) {}
    }

    /*
     * The last picture, held while a live channel reconnects, rather than a
     * black screen (TiviBro's): copied to a canvas over the video until the
     * picture is back. Only where the frame can be read: one the TV draws on a
     * plane of its own comes out black, and another site's cannot be copied.
     */
    function holdFrame() {
      var v = deps.videoEl(), c = deps.holdEl ? deps.holdEl() : null;
      if (!v || !c || !v.videoWidth || v.readyState < 2) return false;
      try {
        var sc = Math.min(1, 960 / v.videoWidth), w = Math.max(2, Math.round(v.videoWidth * sc)), h = Math.max(2, Math.round(v.videoHeight * sc));
        c.width = w;
        c.height = h;
        var g = c.getContext('2d');
        g.drawImage(v, 0, 0, w, h);
        var d = g.getImageData(0, 0, w, h).data, lit = 0, step = Math.max(4, Math.floor(d.length / 4 / 400)) * 4;
        for (var i = 0; i < d.length && lit <= 8; i += step) if (d[i] + d[i + 1] + d[i + 2] > 48) lit++;
        if (lit <= 8) return false;
        c.className = 'on';
        return true;
      } catch (e) { return false; }
    }
    function releaseHold() {
      var c = deps.holdEl ? deps.holdEl() : null;
      if (c) c.className = '';
    }

    function stopTvStream() {
      releaseHold();
      tvStream.gen++;
      clearTimeout(tvStream.retryTimer);
      tvStream.retryTimer = null;
      clearInterval(tvStream.watch);
      tvStream.watch = null;
      tvStream.item = null;
      tvStream.playing = false;
      tvStream.onState = null;
      tvStream.lostAt = 0;
      tsReset();
      deps.releaseVideo();
      lease(false);
    }

    function tsReset() {
      clearTimeout(tvStream.tsTimer);
      tvStream.tsTimer = null;
      tvStream.timeshift = false;
      tvStream.paused = false;
      tvStream.behindMs = 0;
      tvStream.capacity = null;
      tvStream.tsUrl = '';
      clearTimeout(tvStream.seekTimer);
      tvStream.seekTimer = null;
      tvStream.seekTo = tvStream.seekTarget = tvStream.kept = null;
    }

    /*
     * Background refreshes wait while this lasts (lib/iptv), and while it says
     * full screen, LG's idle screen saver stays held off (lib/idlesaver): the
     * TV's media state does not see a stream in this page's <video>. Paused,
     * it is not: a still picture is what the screen saver is for.
     */
    function lease(on) {
      clearInterval(tvStream.leaseTimer);
      tvStream.leaseTimer = null;
      var send = function () { deps.postJson('/api/iptv/lease', { on: on, full: on && deps.isFullOpen() && !tvStream.paused, open: on && deps.isFullOpen() }); };
      send();
      if (on) tvStream.leaseTimer = setInterval(send, 60000);
    }

    // Into the server's log: what a drop was and whether it came back.
    function streamEvent(event, detail) {
      var it = tvStream.item;
      if (!it) return;
      var v = deps.videoEl(), q = null;
      if (v) try { q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; } catch (e) {}
      var body = { event: event, pl: it.pl, key: it.key, format: tvStream.format, full: !!deps.isFullOpen(), tries: tvStream.tries };
      if (v && v.videoWidth) body.size = v.videoWidth + 'x' + v.videoHeight;
      if (q) body.dropped = q.droppedVideoFrames;
      if (tvStream.engine) body.engine = tvStream.engine;
      for (var k in detail) if (detail.hasOwnProperty(k)) body[k] = detail[k];
      deps.postJson('/api/iptv/event', body);
    }

    /*
     * Plays it in the <video>; onState(state, detail) hears 'playing',
     * 'reconnecting', 'nopicture' (no frame in time), 'stopped' (reconnecting
     * gave up) and 'failed'.
     * The URL is asked for fresh each time: an Xtream live link redirects to a
     * token that expires.
     */
    function playTvStream(it, muted, onState) {
      stopTvStream();
      var gen = tvStream.gen;
      tvStream.item = it;
      tvStream.tries = 0;
      tvStream.everPlayed = false;
      tvStream.pastCache = false;
      tvStream.account = false;
      tvStream.switchable = false;
      // The cushion this channel earned (cushionMemo), kept over its reconnects.
      tvStream.boost = cushionMemo.boost(it.pl + ':' + it.key);
      tvStream.boostAt = Date.now();
      // starved: the last reconnect was for want of data, so the next start waits for more.
      tvStream.starved = false;
      tvStream.trickleAt = 0;
      tvStream.slowSince = 0;
      // The longest wait between two arrivals seen on the channel in this visit.
      tvStream.gapMax = 0;
      /*
       * as: the channel's other kind of stream (HLS or MPEG-TS), asked for in
       * place of its own, from what played it last time (cushionMemo) or a
       * switch in this visit. swapFrom: the kind switched from, until the new one
       * has played; noSwap: no more switching on this visit.
       */
      tvStream.as = cushionMemo.format(it.pl + ':' + it.key);
      tvStream.drops = [];
      tvStream.swaps = [];
      tvStream.swapFrom = '';
      tvStream.noSwap = false;
      tvStream.halfSwitched = false;
      tvStream.onState = onState;
      tvStream.muted = !!muted;
      // The full-screen player, which the server may give a recording it can pause.
      tvStream.full = !muted;
      lease(true);
      openTvStream(gen);
    }

    function openTvStream(gen) {
      var it = tvStream.item;
      var say = function (s, d) { if (gen === tvStream.gen && tvStream.onState) tvStream.onState(s, d); };
      deps.getJson('/api/iptv/stream?pl=' + encodeURIComponent(it.pl) + '&key=' + encodeURIComponent(it.key) + (tvStream.full ? '&full=1' : '') + (tvStream.as ? '&as=' + tvStream.as : ''), function (r) {
        if (gen !== tvStream.gen) return;
        if (!r || !r.ok || !r.url) return say('failed', r && r.error);
        tvStream.account = !!r.account;
        tvStream.switchable = !!r.switchable;
        tvStream.timeshift = r.timeshift === true;
        // A new recording starts at the live point.
        if (!tvStream.timeshift || r.url !== tvStream.tsUrl) tvStream.behindMs = 0;
        tvStream.tsUrl = tvStream.timeshift ? r.url : '';
        var v = deps.videoEl();
        tvStream.format = r.format === 'hls' ? 'HLS' : r.format === 'ts' ? 'MPEG-TS' : '';
        // As shown now: the preview may have become the player while this was asked for.
        v.muted = tvStream.muted;
        v.defaultMuted = tvStream.muted;
        var startedAt = Date.now(), lastTime = -1, lastMove = 0, steadyFrom = 0, nudged = false, kickedAt = 0, skippedTo = -1;
        var aheadHeld = false, refillSince = 0, startAsked = false, startAhead = 0, startNeed = 0, grewEnd = 0, grewAt = startedAt, cleanFrom = 0, watchAt = 0, arrivals = [], unpausedAt = 0;
        var chId = it.pl + ':' + it.key;
        // The provider's numbers (cushionMemo): seconds buffered before the start, the refill's base and its most.
        var pre = cushionMemo.prebuffer(it.pl), base = Math.max(2, pre * 1.5), most = Math.max(base, REFILL_MAX_S);
        var goal = function () { return Math.min(most, base + tvStream.boost); };
        var round1 = function (n) { return Math.round(n * 10) / 10; };
        // Ran dry, in the full-screen player: the provider's count, and a bigger cushion for this channel.
        var ranDry = function () {
          if (!deps.isFullOpen()) return;
          cushionMemo.ranDry(it.pl);
          var before = tvStream.boost;
          tvStream.boost = Math.min(most - base, before + Math.max(1.5, base * 0.75));
          tvStream.boostAt = Date.now();
          if (tvStream.boost !== before) cushionMemo.setBoost(chId, tvStream.boost);
        };
        /*
         * Arriving at under half of real time for 30 s, with something every few
         * seconds and the cushion nearly gone, or held for a refill: the rate, else 0.
         * A stall, or a slow patch that catches up, is the refill's, which keeps the
         * burst that follows. Measured over holds too: at 40% of real time, a channel
         * played 14 s and was held 22 s, and no 30 s of playing came to judge.
         */
        var trickling = function (now, end, ahead, holding) {
          if (now - arrivals[0][0] < TRICKLE_MS || now - startedAt < TRICKLE_MS || now - tvStream.trickleAt < TRICKLE_EVERY_MS) return 0;
          var rate = (end - arrivals[0][1]) / ((now - arrivals[0][0]) / 1000);
          if (rate >= TRICKLE_RATE || rate < 0.05 || (!holding && (ahead > Math.max(2.5, base) || ahead < 0.8))) return 0;
          for (var i = 1, since = arrivals[0][0]; i < arrivals.length; i++) {
            if (arrivals[i][1] > arrivals[i - 1][1] + 0.01) since = arrivals[i][0];
            else if (arrivals[i][0] - since > TRICKLE_GAP_MS) return 0;
          }
          tvStream.trickleAt = now;
          arrivals = [];
          return rate;
        };
        v.onplaying = function () {
          if (gen !== tvStream.gen || tvStream.playing) return;
          tvStream.playing = true;
          steadyFrom = lastMove = cleanFrom = Date.now();
          if (tvStream.engine === 'mse' && deps.isFullOpen()) cushionMemo.started(it.pl);
          tvStream.starved = false;
          releaseHold();
          // A kind of stream switched to that plays is where the channel starts next time.
          if (tvStream.swapFrom) {
            tvStream.swapFrom = '';
            cushionMemo.setFormat(chId, tvStream.as);
          }
          if (tvStream.lostAt) {
            streamEvent('recovered', { after: Date.now() - tvStream.lostAt, ahead: round1(startAhead) });
            tvStream.lostAt = 0;
          } else if (!tvStream.everPlayed && deps.isFullOpen()) streamEvent('started', { after: Date.now() - startedAt, ahead: round1(startAhead), to: startNeed });
          tvStream.everPlayed = true;
          say('playing');
        };
        v.onloadedmetadata = function () { if (gen === tvStream.gen) say('format'); };
        // A live stream has no end: one that ends was closed by the provider.
        v.onended = function () { if (gen === tvStream.gen) lost(gen, 'ended', {}); };
        // An error rather than a stall: some providers' CDNs keep a bad copy of a
        // playlist (one seen gzipped, for a player that cannot read it), so a
        // reconnect asks past it.
        v.onerror = function () {
          if (gen !== tvStream.gen) return;
          // Home's own player failing in the <video> itself: as its decoding errors.
          if (tvStream.engine === 'mse') mseRefusedOnce(it, 'video-' + (v.error ? v.error.code : 0));
          tvStream.pastCache = true;
          lost(gen, 'error', { code: v.error ? v.error.code : 0 });
        };
        // A recording goes on from where it was, which a reconnect keeps;
        // live=1 starts it at the live point, behind= that many seconds before it.
        var extra = [];
        if (tvStream.pastCache) extra.push('gh=' + Date.now());
        if (tvStream.timeshift && tvStream.seekTo !== null) extra.push(tvStream.seekTo > 0 ? 'behind=' + tvStream.seekTo : 'live=1');
        tvStream.seekTo = null;
        // Before either player: the background video may hold the TV's decoder, which Home's player uses too.
        deps.wallVideoYield();
        // And it stays away until the visit ends, also while Home's player loads or reconnects with no source.
        tvStream.claim = gen;
        var src = extra.length ? r.url + (r.url.indexOf('?') === -1 ? '?' : '&') + extra.join('&') : r.url;
        var playNow = function () {
          var played = v.play();
          if (played && played.then) played.then(null, function () {});
        };
        var openNative = function () {
          tvStream.engine = 'native';
          v.src = src;
          v.load();
          playNow();
        };
        var openMse = function () {
          tvStream.engine = 'mse';
          var gotData = false;
          var mpegts = /** @type {any} */ (window).mpegts;
          var m = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: location.protocol + '//' + location.host + r.relay }, {
            /*
             * Read on the page, not in a worker: on a G3 (webOS 10.3.0), 3 minutes of a
             * 720p channel held Home's page at 152 to 217 MB (178 on average), and 183
             * to 255 MB (212) with the worker, with no dropped frames either way.
             */
            enableWorker: false, enableStashBuffer: true,
            /*
             * Passed on almost at once (TiviBro's): mpegts.js holds the first bytes until its
             * stash fills, seconds of a light channel, and sizes it from the speed after the
             * first half second anyway. The start's own prebuffer keeps the cushion.
             */
            stashInitialSize: 64 * 1024, lazyLoad: false,
            /*
             * A browser removes video up to the next keyframe after the end it is given:
             * with 4 s kept and keyframes 10 s apart (an HEVC channel), every cleanup took the
             * seconds just ahead of the picture too, a 0.6 s hole every 10 s.
             */
            autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 24, autoCleanupMinBackwardDuration: 12,
            liveBufferLatencyChasing: false, fixAudioTimestampGap: true
          });
          tvStream.mse = m;
          var toNative = function (why) {
            nativeOnly[it.pl + ':' + it.key] = true;
            streamEvent('native', { detail: why });
            releaseMse();
            openNative();
          };
          m.on(mpegts.Events.MEDIA_INFO, function (info) {
            gotData = true;
            // mpegts.js reads H.264 and HEVC only: MPEG-2 video (DVB SD channels) is passed over without an error.
            if (gen === tvStream.gen && tvStream.mse === m && info && info.hasVideo === false) toNative('novideo');
            /*
             * MPEG sound (MP2 on DVB channels, read as mp3): a G3 (webOS 10.3) took the
             * sound's SourceBuffer and then showed no picture, so the TV's player plays it.
             */
            else if (gen === tvStream.gen && tvStream.mse === m && info && info.audioCodec === 'mp3') toNative('mp3');
          });
          m.on(mpegts.Events.ERROR, function (type, detail, info) {
            if (gen !== tvStream.gen || tvStream.mse !== m) return;
            /*
             * Decoding refused: once, Home's player opens the channel again; twice
             * in a visit, the stream has something Media Source cannot take, and
             * the TV's player plays the channel until Home is opened again.
             */
            if (type === mpegts.ErrorTypes.MEDIA_ERROR && mseRefusedOnce(it, String(detail).slice(0, 20))) {
              if (!gotData) {
                releaseMse();
                return openNative();
              }
            } else if (type !== mpegts.ErrorTypes.MEDIA_ERROR) {
              tvStream.pastCache = true;
            }
            // The log keeps 20 characters of a name: mpegts.js's are longer (UnrecoverableEarlyEof).
            lost(gen, 'error', { detail: String(detail).slice(0, 20), code: info && typeof info.code === 'number' ? info.code : 0 });
          });
          // A live stream has no end: one that ends was closed by the provider.
          m.on(mpegts.Events.LOADING_COMPLETE, function () { if (gen === tvStream.gen && tvStream.mse === m) lost(gen, 'ended', {}); });
          m.attachMediaElement(v);
          m.load();
          // Played by the watch once the start's seconds are buffered.
        };
        if (r.relay && !tvStream.timeshift && !nativeOnly[it.pl + ':' + it.key]) {
          withMpegts(function (ok) {
            if (gen !== tvStream.gen) return;
            if (ok && mseUsable()) openMse();
            else openNative();
          });
        } else openNative();
        clearInterval(tvStream.watch);
        tvStream.watch = setInterval(function () {
          if (gen !== tvStream.gen) return;
          var now = Date.now(), mse = tvStream.engine === 'mse', end = 0;
          // When the end of what is buffered last moved: a hold with nothing arriving is reopened.
          if (mse) {
            end = bufferedAhead(v).end;
            arrivals.push([now, end]);
            while (arrivals.length > 2 && now - arrivals[1][0] >= TRICKLE_MS) arrivals.shift();
            if (end > grewEnd + 0.05 || end < grewEnd - 1) {
              if (end > grewEnd && grewEnd > 0 && !aheadHeld) tvStream.gapMax = Math.max(tvStream.gapMax, Math.min(now - grewAt, REFILL_DRY_MAX_MS));
              grewEnd = end;
              grewAt = now;
            }
          }
          if (!tvStream.playing) {
            /*
             * Home's player starts once the start's seconds are buffered, after a
             * channel ran dry the cushion it earned (at most 2 s more): started at
             * once, it ran dry at the provider's first slow second. A live stream's
             * buffer often begins past 0, where the picture is moved to.
             */
            var need = !deps.isFullOpen() ? Math.min(pre, PREVIEW_PREBUFFER_S)
              : tvStream.boost && tvStream.everPlayed && tvStream.starved ? Math.min(Math.max(pre, goal()), pre + 2) : pre;
            if (mse && !startAsked) {
              var b = v.buffered, first = -1, firstEnd = 0;
              try { if (b.length) { first = b.start(0); firstEnd = b.end(0); } } catch (e) {}
              var have = first >= 0 ? firstEnd - Math.max(first, v.currentTime) : 0;
              if (have >= need || now - startedAt > START_WAIT_MS + need * 1000) {
                startAsked = true;
                startAhead = have;
                startNeed = need;
                if (first > v.currentTime) try { v.currentTime = first + 0.05; } catch (e) {}
                playNow();
              }
            }
            if (now - startedAt > Math.max(STREAM_START_MS, START_WAIT_MS + need * 1000 + 4000)) lost(gen, 'nopicture', {});
            return;
          }
          // Paused on purpose: a picture that does not move is no stall.
          if (tvStream.paused) { lastMove = now; return; }
          var ct = v.currentTime, buf;
          // Held for a refill (Home's own player): played on once the buffer is back, reopened if it never comes.
          if (refillSince) {
            buf = bufferedAhead(v);
            /*
             * A stream that comes back after a silence resumes at the live point, so its
             * picture lands past a hole: stepped over, and the hold goes on from there.
             */
            if (buf.next > ct && buf.ahead < 0.3 && buf.next !== skippedTo) {
              skippedTo = buf.next;
              streamEvent('skipped', { gap: round1(buf.next - ct) });
              try { v.currentTime = buf.next + 0.1; } catch (e) {}
              return;
            }
            var held = now - refillSince, to = goal(), rate;
            var dryMs = Math.min(REFILL_DRY_MAX_MS, Math.max(REFILL_DRY_MS, tvStream.gapMax * 4 / 3));
            var holdMax = Math.max(6000 + to * 1000, dryMs + 2000);
            /*
             * Played on at the cushion, at the base after REFILL_SOME_MS, or with what
             * there is once the hold has run the goal's seconds and more.
             */
            if (buf.ahead >= to || (buf.ahead >= base && held > REFILL_SOME_MS) || (buf.ahead >= REFILL_LOW_S && held > holdMax)) {
              streamEvent('refilled', { held: held, to: round1(to), ahead: round1(buf.ahead) });
              refillSince = 0;
              lastMove = cleanFrom = now;
              playNow();
            } else if (held > 3000 && (rate = trickling(now, end, buf.ahead, true))) {
              refillSince = 0;
              tvStream.starved = true;
              lost(gen, 'slow', { ahead: round1(buf.ahead), held: held, detail: 'rate-' + Math.round(rate * 100) });
            } else if ((held > 3000 && now - grewAt > dryMs && now - startedAt > REFILL_DRY_MAX_MS) || held > holdMax) {
              /*
               * Nothing arriving: the provider stopped sending, and a new connection
               * comes with a burst, so it is reopened rather than waited out.
               */
              refillSince = 0;
              tvStream.starved = true;
              lost(gen, held > holdMax ? 'refill' : 'nodata', { ahead: round1(buf.ahead), held: held, state: v.readyState });
            }
            return;
          }
          // Paused by neither the viewer nor a refill (a play() the TV refused): played again.
          if (mse && v.paused && now - unpausedAt > 1000) {
            unpausedAt = now;
            playNow();
          }
          /*
           * Home's own player at a hole in the stream (11 s of a channel missing, seen
           * on a G3): stepped over before the picture stops. Waiting at the edge froze it
           * while the TV's sound output buzzed on its last samples.
           */
          if (tvStream.engine === 'mse') {
            buf = bufferedAhead(v);
            if (buf.next > ct && buf.ahead < 0.3 && buf.next !== skippedTo) {
              skippedTo = buf.next;
              streamEvent('skipped', { gap: Math.round((buf.next - ct) * 10) / 10 });
              try { v.currentTime = buf.next + 0.1; } catch (e) {}
              return;
            }
            /*
             * About to run dry: held paused for a refill before the buffer empties. Played
             * to the last frame, the TV's sound output buzzed on its last samples.
             */
            if (buf.next < 0 && buf.ahead < REFILL_LOW_S) {
              refillSince = now;
              ranDry();
              try { v.pause(); } catch (e) {}
              return;
            }
            // Sent faster than real time: reading stopped at aheadMax(), reopened near the end.
            if (!aheadHeld && buf.ahead > aheadMax() && mseStopReading(tvStream.mse)) {
              aheadHeld = true;
              streamEvent('ahead-held', { ahead: Math.round(buf.ahead) });
            }
            if (aheadHeld && buf.ahead < AHEAD_REOPEN_S) return lost(gen, 'ahead', { ahead: round1(buf.ahead) });
            // Arriving slower than it plays: reopened while there is still some to show.
            rate = !aheadHeld && !v.paused && trickling(now, end, buf.ahead, false);
            if (rate) {
              ranDry();
              tvStream.starved = true;
              return lost(gen, 'slow', { ahead: round1(buf.ahead), detail: 'rate-' + Math.round(rate * 100) });
            }
          }
          if (ct !== lastTime) {
            lastTime = ct;
            lastMove = now;
            nudged = false;
            if (!cleanFrom) cleanFrom = now;
            if (mse && deps.isFullOpen() && watchAt && now - watchAt < 2000) cushionMemo.watched(it.pl, now - watchAt);
            watchAt = now;
            if (now - steadyFrom > STEADY_MS) {
              if (tvStream.tries) tvStream.tries = 0;
              tvStream.slowSince = 0;
              tvStream.halfSwitched = false;
              if (mse) mseFailures[chId] = 0;
            }
            // Clean for CUSHION_CLEAN_MS: the channel's extra cushion halves.
            if (tvStream.boost && now - cleanFrom > CUSHION_CLEAN_MS && now - tvStream.boostAt > CUSHION_CLEAN_MS) {
              tvStream.boost = Math.round(tvStream.boost * 5) / 10;
              if (tvStream.boost < 0.5) tvStream.boost = 0;
              tvStream.boostAt = now;
              if (deps.isFullOpen()) cushionMemo.setBoost(chId, tvStream.boost);
            }
            return;
          }
          cleanFrom = 0;
          var still = now - lastMove;
          buf = bufferedAhead(v);
          // Stuck at a hole with more buffered after it: step over it rather than reconnect.
          if (still > NUDGE_MS && !nudged && buf.next > ct) {
            nudged = true;
            streamEvent('skipped', { gap: Math.round((buf.next - ct) * 10) / 10 });
            try { v.currentTime = buf.next + 0.1; } catch (e) {}
            return;
          }
          // Frozen with plenty buffered: step the decoder on, then reopen.
          if (buf.ahead > KICK_AHEAD_S) {
            /*
             * Once in KICK_EVERY_MS: the kick's step reads as movement, so kicked again and
             * again a stuck decoder never reached the reopen (an HEVC channel on a G3: kicked
             * every 2 s with 15 s buffered, frozen 54 s a minute).
             */
            if (tvStream.engine === 'mse' && still > KICK_MS && now - kickedAt > KICK_EVERY_MS) {
              kickedAt = now;
              streamEvent('kicked', { ahead: Math.round(buf.ahead * 10) / 10 });
              try { v.currentTime = ct + 0.1; } catch (e) {}
              return;
            }
            if (tvStream.engine === 'mse' && still > FROZEN_MS) return lost(gen, 'frozen', { still: still, ahead: Math.round(buf.ahead * 10) / 10, state: v.readyState });
          }
          if (still > STALL_MS || (still > STALL_EMPTY_MS && buf.ahead < 0.5)) lost(gen, 'stall', { still: still, ahead: Math.round(buf.ahead * 10) / 10, state: v.readyState, net: v.networkState });
        }, WATCH_MS);
      });
    }

    /*
     * The channel's other kind of stream, where the provider serves both
     * (TiviBro's, issue #47 there): HLS comes in short pieces and often rides
     * out a shaky connection better, and some channels are the other way round.
     * A channel that played, in the full-screen player, switches when it drops
     * twice in 3 minutes, arrives too slowly, or freezes twice in 10 minutes
     * with video buffered, and halfway through its reconnects; at most 3
     * switches in 10 minutes. The kind switched to failing before it plays goes
     * back, with no more switching on this visit. Not for a provider's refusal,
     * which is the provider's trouble, not the kind of stream's.
     */
    var freezes = {};
    function swapFormat(it, why, detail) {
      var id = it.pl + ':' + it.key, now = Date.now();
      var kind = tvStream.format === 'HLS' ? 'hls' : tvStream.format === 'MPEG-TS' ? 'ts' : '';
      if (!kind || !tvStream.switchable || tvStream.timeshift || !deps.isFullOpen()) return;
      // The kind switched to failed before playing: back to the one that played.
      if (tvStream.swapFrom && !tvStream.playing && kind !== tvStream.swapFrom) {
        var back = tvStream.swapFrom;
        tvStream.swapFrom = '';
        tvStream.noSwap = true;
        tvStream.as = back;
        cushionMemo.setFormat(id, '');
        tvStream.tries = 0;
        streamEvent('format', { detail: kind + '-to-' + back, why: 'back' });
        return;
      }
      // Neither a provider's refusal nor a stream sent too fast is the kind of stream's doing.
      if (!tvStream.everPlayed || tvStream.noSwap || why === 'nopicture' || why === 'ahead' || detail.code >= 400) return;
      var fl = freezes[id] = (freezes[id] || []).filter(function (x) { return now - x < FREEZES_MS; });
      if (why === 'frozen') fl.push(now);
      tvStream.drops = tvStream.drops.filter(function (x) { return now - x < SWAP_DROPS_MS; });
      tvStream.drops.push(now);
      tvStream.swaps = tvStream.swaps.filter(function (x) { return now - x < SWAP_MAX_MS; });
      var limit = RETRIES_PLAYING, half = Math.max(2, Math.ceil(limit / 2));
      var reason = why === 'slow' ? 'slow' : fl.length >= 2 ? 'freezing' : tvStream.drops.length >= SWAP_DROPS ? 'drops'
        : tvStream.tries + 1 === half && !tvStream.halfSwitched ? 'half' : '';
      if (!reason || tvStream.swaps.length >= SWAP_MAX) return;
      var other = kind === 'ts' ? 'hls' : 'ts';
      if (reason === 'half') tvStream.halfSwitched = true;
      if (reason === 'freezing') freezes[id] = [];
      tvStream.swaps.push(now);
      tvStream.swapFrom = kind;
      tvStream.as = other;
      tvStream.tries = 0;
      tvStream.drops = [];
      streamEvent('format', { detail: kind + '-to-' + other, why: reason });
    }

    /*
     * Torn down and opened again with a fresh URL, at the live point, waiting a
     * little longer each time; left stopped once the reconnects run out.
     */
    function lost(gen, why, detail) {
      if (gen !== tvStream.gen) return;
      clearInterval(tvStream.watch);
      tvStream.watch = null;
      detail.why = why;
      var it = tvStream.item, cb = tvStream.onState;
      /*
       * No picture from Home's player on a first open, with no error to say why
       * (an MP2 channel did this before the mp3 check): the TV's player has the
       * channel for the rest of the visit, and its own first open, before Home
       * gives up.
       */
      if (why === 'nopicture' && !tvStream.everPlayed && tvStream.engine === 'mse' && it && !nativeOnly[it.pl + ':' + it.key]) {
        nativeOnly[it.pl + ':' + it.key] = true;
        streamEvent('native', { detail: 'nopicture' });
        deps.releaseVideo(true);
        var nativeGen = ++tvStream.gen;
        tvStream.item = it;
        tvStream.onState = cb;
        return openTvStream(nativeGen);
      }
      if (it) swapFormat(it, why, detail);
      /*
       * No picture on a first open is a channel this TV cannot show: given up at once.
       * After a reconnect it is the provider's refusal (a 500 seen) leaving the next
       * open short of time: that gets the first open's retries.
       */
      var limit = tvStream.everPlayed ? RETRIES_PLAYING : why === 'nopicture' && !tvStream.tries ? 0 : RETRIES_FIRST;
      /*
       * With the TV's network down, it is waited for without using up the
       * reconnects. A channel that played, in the full-screen player, is asked
       * for again more slowly once they run out, for SLOW_FOR_MS: a provider's
       * outage often ends (TiviBro's).
       */
      var now = Date.now(), offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      var slow = !offline && tvStream.tries >= limit && tvStream.everPlayed && deps.isFullOpen() && now - (tvStream.slowSince || now) < SLOW_FOR_MS;
      if (!offline && !slow && tvStream.tries >= limit) {
        if (tvStream.lostAt) detail.lostFor = Date.now() - tvStream.lostAt;
        streamEvent('gave-up', detail);
        releaseHold();
        tvStream.gen++;
        tvStream.lostAt = 0;
        deps.releaseVideo();
        tvStream.item = it;
        if (cb) cb(why === 'nopicture' && !tvStream.everPlayed ? 'nopicture' : 'stopped');
        deps.checkProtected(it);
        return;
      }
      if (!tvStream.lostAt) tvStream.lostAt = now;
      if (slow && !tvStream.slowSince) tvStream.slowSince = now;
      var wait = offline ? OFFLINE_WAIT_MS : slow ? (now - tvStream.slowSince < SLOW_FAST_FOR_MS ? SLOW_FAST_MS : SLOW_EVERY_MS)
        : RETRY_WAIT_MS[Math.min(tvStream.tries, RETRY_WAIT_MS.length - 1)];
      if (offline) detail.detail = 'offline';
      else if (slow) detail.detail = 'slow';
      else tvStream.tries++;
      detail.wait = wait;
      streamEvent('reconnecting', detail);
      tvStream.playing = false;
      // A reconnect plays on: a pause ends with it.
      if (tvStream.paused) {
        tvStream.behindMs += Date.now() - tvStream.pausedAt;
        tvStream.paused = false;
        clearTimeout(tvStream.tsTimer);
        tvStream.tsTimer = null;
      }
      // Every reconnect asks past a copy of the playlist a CDN may be holding.
      tvStream.pastCache = true;
      // Recovering, a preview is not playing: OK opens the player afresh rather than adopting it.
      if (deps.onReconnect) deps.onReconnect();
      // Its own generation: a stop or another play meanwhile strands it.
      var retryGen = ++tvStream.gen;
      /*
       * The video background stays away until the retry: brought back in the wait,
       * it took the decoder again and every retry failed with code 4 (a G3, webOS 10),
       * leaving a preview over a video background at "No picture".
       */
      if (tvStream.everPlayed && !tvStream.timeshift) holdFrame();
      deps.releaseVideo(true);
      tvStream.item = it;
      tvStream.onState = cb;
      if (cb) cb('reconnecting');
      tvStream.retryTimer = setTimeout(function () {
        tvStream.retryTimer = null;
        if (tvStream.gen === retryGen && tvStream.item === it) openTvStream(retryGen);
      }, wait);
    }

    return {
      state: tvStream,
      play: playTvStream,
      open: openTvStream,
      stop: stopTvStream,
      releaseMse: releaseMse,
      lease: lease,
      streamEvent: streamEvent,
      clearFormatMemo: function (id) { cushionMemo.setFormat(id, ''); }
    };
  }

  var api = {
    create: createHomeIptvPlayer,
    bufferedAhead: bufferedAhead,
    createCushionMemo: createCushionMemo
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  /** @type {any} */ (root).TVWebHomeIptv = api;
})(this);
