'use strict';
/*
 * Tempo, beat, bar and section from a stream of onset frames, for Music
 * highway. Strict ES5 for Node 0.12. No I/O: audiolevels.js feeds it one frame
 * per analysis with the frame's time, and snapshot() says where the music is.
 *
 * A threshold on bass alone found 37% real beats on a 2-minute recording of
 * Spotify on an OLED55A19LA, against 26% by chance, so this follows the
 * tempo instead: autocorrelation of the onset envelope picks the period, a
 * comb over the last seconds picks the phase, and a slow correction keeps the
 * beat clock on it. Dance music is then read the way it is written: four
 * beats to a bar, eight bars to a phrase, a breakdown with the kick gone and
 * a drop when it comes back, usually on a phrase's first bar.
 */

var MIN_BPM = 70;
var MAX_BPM = 180;
// Tempo is estimated from the last HISTORY_S seconds, every ESTIMATE_S.
var HISTORY_S = 8;
var ESTIMATE_S = 0.5;
var MIN_HISTORY_S = 4;
// A new tempo has to win this many estimates in a row (4 s) to replace the
// old. On the recording, a breakdown with the kick gone read as 4/3 of the
// tempo within 2 s.
var SWITCH_AFTER = 8;
// Ratios to the tempo in use that are the same music heard another way.
var RELATED = [2, 0.5, 4 / 3, 0.75, 1.5, 2 / 3];
// Half or double the tempo in use is taken instead after OCTAVE_AFTER
// estimates in a row (2 s) if it sits nearer 120 BPM: a song at 160.7 BPM ran
// at 79.6 for two minutes, the pulses and blocks on every other beat, and
// with 16 (8 s) one at 159 reached it only after 110 s.
var OCTAVE_AFTER = 4;
var BARS_PER_PHRASE = 8;
// Bass under this share of its recent full level is a breakdown; over the
// second it is back.
var BREAKDOWN_BASS = 0.3;
var DROP_BASS = 0.6;
var DROP_BARS = 8;
// A breakdown starts after this many quiet bars in a row, and the bass coming
// back counts as a drop only after one of at least MIN_BREAKDOWN_BARS: a
// song at 159 BPM whose bass came and went counted 11 drops in a few minutes
// when one quiet bar was enough.
var QUIET_BARS = 2;
var MIN_BREAKDOWN_BARS = 4;
// The bass a bar is judged against: this quantile of the last bars outside
// breakdowns, so one loud bar does not make the rest look quiet.
var BASS_REFERENCE_QUANTILE = 0.75;
var BASS_HISTORY_BARS = 16;
// Longer than this, a breakdown or build was a new song with less bass than
// the last, which crossfaded in without a silence: on one, the build lasted
// the whole 2-minute recording with the tempo held 2% slow.
var MAX_BREAKDOWN_BARS = 24;
// How far the beat clock moves toward each phase seen (a fifth as far in a
// breakdown), how much of the error per beat goes into the period, and how
// far the period moves toward each autocorrelation. The autocorrelation
// alone finds the tempo to within a lag, about 2%: at 125 BPM that misplaced
// beats 2.5 s ahead by 43 ms. Over five recordings of three genres, these
// put 67-96% of beats predicted 2.5 s ahead on the half-beat grid, against
// 59-88% with the autocorrelation alone.
var PHASE_GAIN = 0.4;
var PERIOD_GAIN = 0.03;
var PERIOD_SMOOTHING = 0.1;
var HOLD_FACTOR = 0.2;
// The period is left alone through a breakdown, where it wandered 7% on the
// first recording, and kept within this of the tempo the lock began with.
var PERIOD_LEEWAY = 0.04;

/**
 * @param {number} fps analysis frames a second
 */
function create(fps) {
  var size = Math.round(fps * HISTORY_S);
  var onset = new Float64Array(size);
  var low = new Float64Array(size);
  var mid = new Float64Array(size);
  var high = new Float64Array(size);
  var bass = new Float64Array(size);
  var times = new Float64Array(size);
  var work = new Float64Array(size);
  var frameNo = 0;
  var sinceEstimate = 0;

  var periodFrames = 0;
  var pendingPeriod = 0;
  var pendingCount = 0;
  var confidence = 0;
  var locked = false;
  var beatAt = 0;
  var beatIndex = 0;
  var periodMs = 0;
  var phaseMisses = 0;
  var lastCorrectedBeat = null;
  var lockedPeriodMs = 0;

  // Per-band flux peaks, sinking by about a tenth a second, to judge a
  // slot's strength against.
  var peakLow = 0.01;
  var peakMid = 0.01;
  var peakHigh = 0.01;

  // Eighth-note slots, by global slot index modulo 8 (two per beat): how
  // strongly kick, snare and hat land on each.
  var patternAbs = [];
  for (var p = 0; p < 8; p++) patternAbs.push([0, 0, 0]);
  var nextSlot = null;

  // Per beat position modulo 4 of the global beat index: what lands there.
  var posLow = [0, 0, 0, 0];
  var posMid = [0, 0, 0, 0];
  var posRise = [0, 0, 0, 0];
  var posHigh = [0, 0, 0, 0];
  var downbeatPos = 0;
  var downbeatChallenger = -1;
  var downbeatWins = 0;
  var lastBeatEnergy = 0;

  var barIndex = 0;
  var lastBarBeat = null;
  var barBass = 0;
  var barFrames = 0;
  var barBassHistory = [];
  var quietBars = 0;
  var quietSinceBar = 0;
  var barHighHistory = [];
  var section = 'groove';
  var sectionSinceBar = 0;
  var phraseAnchorBar = 0;
  var drops = 0;
  var lastDropAt = 0;

  function at(arr, absFrame) { return arr[((absFrame % size) + size) % size]; }

  // The onset envelope of the last n frames less its trailing half-second
  // mean, so steady sound counts for nothing and only rises remain.
  function envelope(n) {
    var start = frameNo - n;
    var win = Math.round(fps * 0.5);
    var sum = 0;
    var i;
    for (i = 0; i < n; i++) {
      var v = at(onset, start + i);
      sum += v;
      if (i >= win) sum -= at(onset, start + i - win);
      var mean = sum / Math.min(i + 1, win);
      work[i] = Math.max(0, v - mean);
    }
    // Spread each rise over three frames: a beat period is rarely a whole
    // number of frames, and a one-frame onset only meets itself at one.
    // Five frames found clean synthetic pulses better but put 91% of beats
    // on the grid down to 75% on a recording at 160 BPM.
    var prevV = 0;
    for (i = 0; i < n; i++) {
      var cur = work[i];
      work[i] = 0.25 * prevV + 0.5 * cur + 0.25 * (i + 1 < n ? work[i + 1] : 0);
      prevV = cur;
    }
    return work;
  }

  function prior(bpm) {
    var octaves = Math.log(bpm / 120) / Math.LN2;
    return Math.exp(-0.5 * octaves * octaves);
  }

  function estimatePeriod(e, n) {
    var minLag = Math.floor(fps * 60 / MAX_BPM);
    var maxLag = Math.ceil(fps * 60 / MIN_BPM);
    var ac = [];
    var lag, i;
    for (lag = 0; lag <= Math.min(2 * maxLag + 1, n - 1); lag++) {
      var s = 0;
      for (i = lag; i < n; i++) s += e[i] * e[i - lag];
      ac.push(s / (n - lag));
    }
    function acAt(x) {
      var i0 = Math.floor(x);
      var f = x - i0;
      return (ac[i0] || 0) * (1 - f) + (ac[i0 + 1] || 0) * f;
    }
    var scores = [];
    var best = -1;
    var bestLag = 0;
    var total = 0;
    // Whole frames: quarter frames found clean synthetic pulses better, but
    // fewer beats on five recordings (88% of the earlier score on average).
    for (lag = minLag; lag <= maxLag; lag++) {
      // A beat period also lines up at twice itself. Three eighth notes line
      // up with the eighths too, but so does their third, which a beat's
      // does not in the duple metre of dance music: that gives them away.
      // Rewarding a match at half the period instead favoured half the
      // tempo, which lines up there with the real beat.
      var v = (ac[lag] + 0.5 * (ac[2 * lag] || 0) - 0.5 * acAt(lag / 3)) * prior(60 * fps / lag);
      scores[lag] = v;
      total += v;
      if (v > best) { best = v; bestLag = lag; }
    }
    if (best <= 0 || !ac[0]) return null;
    var refined = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      var a = scores[bestLag - 1];
      var c = scores[bestLag + 1];
      var denom = a - 2 * best + c;
      if (denom < 0) refined = bestLag + 0.5 * (a - c) / denom;
    }
    return { period: refined, confidence: best / (total / (maxLag - minLag + 1)) };
  }

  // Fractional frames back from the newest frame to the most recent beat.
  function estimatePhase(e, n, period) {
    var best = -1;
    var bestPhase = 0;
    for (var phase = 0; phase < period; phase += 0.25) {
      var s = 0;
      var weight = 1;
      for (var k = 0; k < 16; k++) {
        var pos = n - 1 - phase - k * period;
        if (pos < 1) break;
        var i0 = Math.floor(pos);
        var f = pos - i0;
        s += weight * (e[i0] * (1 - f) + e[i0 + 1 < n ? i0 + 1 : i0] * f);
        weight *= 0.85;
      }
      if (s > best) { best = s; bestPhase = phase; }
    }
    return bestPhase;
  }

  function frameTime(absFrame) {
    var i0 = Math.floor(absFrame);
    var f = absFrame - i0;
    var t0 = at(times, i0);
    return t0 + f * (at(times, i0 + 1) - t0 || 1000 / fps);
  }

  // Keeps beatAt the latest beat at or before t, its index with it.
  function anchorTo(t) {
    if (!periodMs) return;
    var steps = Math.floor((t - beatAt) / periodMs);
    beatAt += steps * periodMs;
    beatIndex += steps;
  }

  function estimate() {
    var n = Math.min(frameNo, size);
    if (n < fps * MIN_HISTORY_S) return;
    var e = envelope(n);
    var est = estimatePeriod(e, n);
    if (!est) return;
    confidence = confidence * 0.7 + est.confidence * 0.3;

    // A breakdown or build keeps the tempo of the bars before it: with the
    // kick gone the onsets say little, and dance music does not change
    // tempo there. The beat clock runs on through it.
    var holding = section === 'breakdown' || section === 'build';
    if (!periodFrames) {
      periodFrames = est.period;
    } else {
      var ratio = est.period / periodFrames;
      var related = false;
      for (var r = 0; r < RELATED.length; r++) if (Math.abs(ratio / RELATED[r] - 1) < 0.04) related = true;
      var octave = Math.abs(ratio / 2 - 1) < 0.04 || Math.abs(ratio / 0.5 - 1) < 0.04;
      var octaveBetter = octave && prior(60 * fps / est.period) > prior(60000 / periodMs) * 1.05;
      if (Math.abs(ratio - 1) < 0.05) {
        if (!holding && locked) {
          periodMs += (est.period * 1000 / fps - periodMs) * PERIOD_SMOOTHING;
          periodFrames = periodMs * fps / 1000;
        }
        pendingCount = 0;
      } else if (octaveBetter) {
        if (pendingCount && Math.abs(est.period / pendingPeriod - 1) < 0.05) pendingCount++;
        else { pendingPeriod = est.period; pendingCount = 1; }
        if (pendingCount >= OCTAVE_AFTER) {
          // The same song at another octave: the beat clock keeps its phase,
          // its count scales, and beat 1 and the pattern are learned again.
          var factor = periodFrames / pendingPeriod;
          periodFrames = pendingPeriod;
          periodMs = periodFrames * 1000 / fps;
          lockedPeriodMs = periodMs;
          beatIndex = Math.round(beatIndex * factor);
          lastCorrectedBeat = null;
          nextSlot = null;
          pendingCount = 0;
          for (var q = 0; q < 4; q++) { posLow[q] = 0; posMid[q] = 0; posRise[q] = 0; posHigh[q] = 0; }
          for (q = 0; q < 8; q++) patternAbs[q] = [0, 0, 0];
        }
      } else if (related) {
        pendingCount = 0;
      } else {
        if (pendingCount && Math.abs(est.period / pendingPeriod - 1) < 0.05) pendingCount++;
        else { pendingPeriod = est.period; pendingCount = 1; }
        // In a breakdown a new tempo takes twice as long to believe: dance
        // music keeps its tempo there, but a new song, crossfaded in, does
        // not. One held the last song's 123 BPM against 133 for 41 s.
        if (pendingCount >= (holding ? 2 * SWITCH_AFTER : SWITCH_AFTER)) {
          // A new tempo is a new song: its sections start afresh too.
          periodFrames = pendingPeriod;
          pendingCount = 0;
          locked = false;
          section = 'groove';
          barBassHistory = [];
          quietBars = 0;
        }
      }
    }

    var phase = estimatePhase(e, n, periodFrames);
    var seen = frameTime(frameNo - 1 - phase);
    if (!locked) {
      periodMs = periodFrames * 1000 / fps;
      lockedPeriodMs = periodMs;
      beatAt = seen;
      locked = true;
      phaseMisses = 0;
      lastCorrectedBeat = null;
      nextSlot = null;
      return;
    }
    anchorTo(seen);
    var k = Math.round((seen - beatAt) / periodMs);
    var err = seen - (beatAt + k * periodMs);
    var gain = holding ? HOLD_FACTOR : 1;
    if (Math.abs(err) < periodMs * 0.3) {
      beatAt += err * PHASE_GAIN * gain;
      var beat = beatIndex + k;
      if (!holding && lastCorrectedBeat !== null && beat > lastCorrectedBeat) {
        periodMs += err / (beat - lastCorrectedBeat) * PERIOD_GAIN;
        periodMs = Math.max(lockedPeriodMs * (1 - PERIOD_LEEWAY), Math.min(lockedPeriodMs * (1 + PERIOD_LEEWAY), periodMs));
        periodFrames = periodMs * fps / 1000;
      }
      lastCorrectedBeat = beat;
      phaseMisses = 0;
    } else if (!holding && ++phaseMisses >= 4) {
      beatAt = seen - k * periodMs;
      lastCorrectedBeat = null;
      phaseMisses = 0;
    }
  }

  function slotTime(slot) {
    return beatAt + (slot / 2 - beatIndex) * periodMs;
  }

  // The strongest flux of each band within 45 ms of t, against its mean.
  function strengthsAround(t) {
    var newest = frameNo - 1;
    var back = Math.round((at(times, newest) - t) * fps / 1000);
    var centre = newest - back;
    var l = 0;
    var m = 0;
    var h = 0;
    for (var f = centre - 2; f <= centre + 2; f++) {
      if (f < frameNo - size || f > newest) continue;
      l = Math.max(l, at(low, f));
      m = Math.max(m, at(mid, f));
      h = Math.max(h, at(high, f));
    }
    return [Math.min(1, l / peakLow), Math.min(1, m / peakMid), Math.min(1, h / peakHigh)];
  }

  function mod(a, b) { return ((a % b) + b) % b; }

  function onBeat(beat, strengths, t) {
    var pos = mod(beat, 4);
    var energy = 0;
    var f = frameNo - 1;
    for (var i = 0; i < 4; i++) energy += at(bass, f - i) + at(onset, f - i);
    var rise = Math.max(0, energy - lastBeatEnergy);
    lastBeatEnergy = energy;
    posLow[pos] = posLow[pos] * 0.95 + strengths[0] * 0.05;
    posMid[pos] = posMid[pos] * 0.95 + strengths[1] * 0.05;
    posRise[pos] = posRise[pos] * 0.95 + Math.min(1, rise) * 0.05;
    posHigh[pos] = posHigh[pos] * 0.95 + strengths[2] * 0.05;

    // Beat 1: a clap or snare lands on 2 and 4, a crash and the bar's
    // changes on 1. The clap alone cannot tell 1 from 3.
    var best = 0;
    var bestScore = -1e9;
    for (var d = 0; d < 4; d++) {
      var score = 0.3 * posLow[d] + posMid[(d + 1) % 4] + posMid[(d + 3) % 4]
        - 0.5 * (posMid[d] + posMid[(d + 2) % 4]) + 0.8 * posRise[d]
        + 0.6 * (posHigh[d] - posHigh[(d + 2) % 4]);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (best !== downbeatPos) {
      if (best === downbeatChallenger) downbeatWins++;
      else { downbeatChallenger = best; downbeatWins = 1; }
      if (downbeatWins >= 8) { downbeatPos = best; downbeatWins = 0; }
    } else {
      downbeatWins = 0;
    }

    if (pos === downbeatPos && lastBarBeat !== beat) {
      if (lastBarBeat !== null) endBar(t);
      lastBarBeat = beat;
    }
  }

  function endBar(t) {
    barIndex++;
    var meanBass = barFrames ? barBass / barFrames : 0;
    barBass = 0;
    barFrames = 0;
    var sorted = barBassHistory.slice().sort(function (a, b) { return a - b; });
    var reference = sorted.length ? sorted[Math.floor((sorted.length - 1) * BASS_REFERENCE_QUANTILE)] : meanBass;
    var ratio = reference > 0 ? meanBass / reference : 1;
    if (section !== 'breakdown' && section !== 'build') {
      barBassHistory.push(meanBass);
      if (barBassHistory.length > BASS_HISTORY_BARS) barBassHistory.shift();
    }
    if (ratio < BREAKDOWN_BASS) {
      if (!quietBars) quietSinceBar = barIndex;
      quietBars++;
    } else {
      quietBars = 0;
    }
    var highNow = 0;
    for (var s = 0; s < 8; s++) highNow += patternAbs[s][2];
    barHighHistory.push(highNow);
    if (barHighHistory.length > 3) barHighHistory.shift();
    var rising = barHighHistory.length === 3 && barHighHistory[2] > barHighHistory[1] && barHighHistory[1] >= barHighHistory[0];

    var before = section;
    var startedAt = barIndex;
    if ((section === 'breakdown' || section === 'build') && barIndex - sectionSinceBar >= MAX_BREAKDOWN_BARS) {
      section = 'groove';
      barBassHistory = [];
      quietBars = 0;
    } else if (section === 'groove' || section === 'drop') {
      if (quietBars >= QUIET_BARS) {
        section = 'breakdown';
        startedAt = quietSinceBar;
      } else if (section === 'drop' && barIndex - sectionSinceBar >= DROP_BARS) {
        section = 'groove';
      }
    } else if (ratio > DROP_BASS) {
      if (barIndex - sectionSinceBar >= MIN_BREAKDOWN_BARS) {
        section = 'drop';
        drops++;
        lastDropAt = t;
      } else {
        section = 'groove';
      }
    } else if (section === 'breakdown' && rising) {
      section = 'build';
      startedAt = sectionSinceBar;
    }
    if (section !== before) {
      if (section !== 'build') sectionSinceBar = startedAt;
      // A breakdown, from its first quiet bar, and a drop each start a phrase.
      if (section === 'breakdown' || section === 'drop') phraseAnchorBar = startedAt;
    }
  }

  /**
   * One analysis frame.
   * @param {{time: number, onset: number, low: number, mid: number, high: number, bass: number}} f
   */
  function feed(f) {
    var i = frameNo % size;
    onset[i] = f.onset;
    low[i] = f.low;
    mid[i] = f.mid;
    high[i] = f.high;
    bass[i] = f.bass;
    times[i] = f.time;
    frameNo++;
    peakLow = Math.max(f.low, peakLow * 0.998, 0.01);
    peakMid = Math.max(f.mid, peakMid * 0.998, 0.01);
    peakHigh = Math.max(f.high, peakHigh * 0.998, 0.01);
    barBass += f.bass;
    barFrames++;

    if (++sinceEstimate >= Math.round(fps * ESTIMATE_S)) {
      sinceEstimate = 0;
      estimate();
    }
    if (!locked) return;

    // Score each eighth note once the 45 ms after it have been heard.
    var heard = f.time - 60;
    if (nextSlot === null) nextSlot = Math.ceil((heard - beatAt) / (periodMs / 2)) + 2 * beatIndex;
    var guard = 0;
    while (slotTime(nextSlot) <= heard && guard++ < 16) {
      var t = slotTime(nextSlot);
      var st = strengthsAround(t);
      var cell = patternAbs[mod(nextSlot, 8)];
      for (var b = 0; b < 3; b++) cell[b] = cell[b] * 0.55 + st[b] * 0.45;
      if (mod(nextSlot, 2) === 0) onBeat(nextSlot / 2, st, t);
      nextSlot++;
    }
  }

  /** Forgets the tempo: after silence, the next song starts afresh. */
  function reset() {
    periodFrames = 0;
    pendingCount = 0;
    confidence = 0;
    locked = false;
    frameNo = 0;
    nextSlot = null;
    section = 'groove';
  }

  /**
   * Where the music is at time now.
   * @param {number} now
   */
  function snapshot(now) {
    if (!locked) return { locked: false, confidence: Math.round(confidence * 100) / 100 };
    anchorTo(now);
    var downbeatIndex = beatIndex - mod(beatIndex - downbeatPos, 4);
    var barInPhrase = mod(barIndex - phraseAnchorBar, BARS_PER_PHRASE);
    // Each instrument against its own strongest eighth note, so the bar's
    // shape shows whatever the mix: 1 where it hits hardest.
    var tops = [0, 0, 0];
    var s, b;
    for (s = 0; s < 8; s++) for (b = 0; b < 3; b++) tops[b] = Math.max(tops[b], patternAbs[s][b]);
    var pattern = [];
    for (s = 0; s < 8; s++) {
      var cell = patternAbs[mod(s + 2 * downbeatIndex, 8)];
      var row = [];
      for (b = 0; b < 3; b++) row.push(tops[b] > 0.15 ? Math.round(cell[b] / tops[b] * 100) / 100 : 0);
      pattern.push(row);
    }
    var barsToDrop = null;
    if (section === 'breakdown' || section === 'build') {
      // Drops come on a phrase line: 8 bars after the breakdown began, or 16.
      var into = barIndex - phraseAnchorBar;
      barsToDrop = (into < BARS_PER_PHRASE ? BARS_PER_PHRASE : 2 * BARS_PER_PHRASE) - into;
      if (barsToDrop <= 0) barsToDrop = BARS_PER_PHRASE - mod(into, BARS_PER_PHRASE);
    }
    return {
      locked: true,
      confidence: Math.round(confidence * 100) / 100,
      bpm: Math.round(60000 / periodMs * 10) / 10,
      periodMs: Math.round(periodMs * 10) / 10,
      beatAt: Math.round(beatAt),
      beatIndex: beatIndex,
      downbeatIndex: downbeatIndex,
      barIndex: barIndex,
      barInPhrase: barInPhrase,
      section: section,
      barsToDrop: barsToDrop,
      drops: drops,
      lastDropAt: lastDropAt ? Math.round(lastDropAt) : 0,
      pattern: pattern
    };
  }

  return { feed: feed, reset: reset, snapshot: snapshot };
}

module.exports = { create: create };
