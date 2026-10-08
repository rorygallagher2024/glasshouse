/*
 * Telemetry in the Prometheus text exposition format, version 0.0.4.
 * Strict ES5 for Node 0.12.2 on webOS 4.
 *
 * The names in STABLE are what dashboards and alerts are built on, so one is
 * never renamed or dropped; test-prometheus.js pins them. Labels hold only what
 * rarely changes, since every new label value starts a new series. Every
 * family is declared on every scrape, and one the TV gives no reading for has
 * no sample rather than a made-up 0.
 */

// /proc/stat counts in USER_HZ ticks, which is 100 on every Linux the TVs run.
var USER_HZ = 100;
// LG's panel counters step in 10-minute units.
var PANEL_UNIT_SECONDS = 600;
var MEBIBYTE = 1024 * 1024;

var names = require('./names');
var snakeCase = names.snakeCase;

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function bool(v) {
  return typeof v === 'boolean' ? (v ? 1 : 0) : null;
}

// A value of 0 that stands for "not known" in the stats, as some OLED readings do.
function positive(v) {
  return num(v) !== null && v > 0 ? v : null;
}

function scaled(v, by) {
  return num(v) === null ? null : v * by;
}

// Divided rather than multiplied by 0.01, which prints 57 as 0.5700000000000001.
function percent(v) {
  return num(v) === null ? null : v / 100;
}

// The precise reading where telemetry gives one, otherwise the rounded one,
// from an older server or a capture made before it had the precise field.
function prefer(precise, rounded) {
  return precise !== null ? precise : rounded;
}

function one(v) {
  return v === null ? [] : [[{}, v]];
}

function path(o, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[keys[i]];
  }
  return o;
}

// Telemetry reports 0 for every memory and swap figure when /proc/meminfo
// cannot be read, and a TV with no swap has a real 0, so MemTotal tells them
// apart.
function memoryRead(s) {
  return positive(path(s, ['mem', 'total'])) !== null;
}

// The JEDEC eMMC PRE_EOL_INFO states, as telemetry names them.
var EMMC_EOL_STATES = ['Normal', 'Warning', 'Urgent'];

function hdmiLinks(s) {
  return Array.isArray(s.hdmi_links) ? s.hdmi_links : [];
}

function hdmiSources(s) {
  return Array.isArray(s.hdmi_sources) ? s.hdmi_sources : [];
}

// The HDMI inputs the TV names, by short id, as the other HDMI families number
// them; AV and other inputs are left out.
function hdmiInputNames(s) {
  var names = s.inputs && typeof s.inputs === 'object' ? s.inputs : {};
  return Object.keys(names).filter(function (k) { return /^hdmi[1-4]$/.test(k); }).sort()
    .map(function (k) { return { input: k, name: names[k] }; });
}

function hdmiInput(link) {
  return { input: 'hdmi' + link.input };
}

function dynamicRange(s) {
  var raw = path(s, ['picture', 'dynamicRange_raw']);
  if (typeof raw !== 'string' || !raw) return null;
  return names.dynamicRange(raw);
}

// 1 when the Pixel Refresher is in the given state, 0 when in another, and
// null without a panel service status, as on an LCD.
function refresherStatus(s, state) {
  var st = path(s, ['oled', 'refresher_status']);
  return typeof st === 'string' ? (st === state ? 1 : 0) : null;
}

var FAMILIES = [
  {
    name: 'glasshouse_info', type: 'gauge',
    help: 'Always 1, labelled with the TV model, its firmware and webOS versions, and the Glasshouse version.',
    samples: function (s, version) {
      return [[{
        model: path(s, ['device', 'model']),
        firmware: path(s, ['system', 'firmware']),
        webos: path(s, ['system', 'webos']),
        version: version
      }, 1]];
    }
  },
  {
    name: 'glasshouse_boot_time_seconds', type: 'gauge',
    help: 'Time the TV\'s system last booted, in seconds since the Unix epoch.',
    samples: function (s) {
      var t = typeof s.bootTime === 'string' ? Date.parse(s.bootTime) : NaN;
      return one(prefer(positive(s.btime), isNaN(t) ? null : t / 1000));
    }
  },
  {
    name: 'glasshouse_system_on', type: 'gauge',
    help: '1 when the TV is on, including with the screen off; 0 in standby or off.',
    samples: function (s) { return one(bool(path(s, ['powerState', 'systemOn']))); }
  },
  {
    name: 'glasshouse_screen_on', type: 'gauge',
    help: '1 when the screen is on, including a screen saver; 0 otherwise.',
    samples: function (s) { return one(bool(path(s, ['powerState', 'screenOn']))); }
  },
  {
    name: 'glasshouse_soc_temperature_celsius', type: 'gauge',
    help: 'Temperature of the SoC in degrees Celsius.',
    samples: function (s) { return one(prefer(positive(s.tempMillidegrees) === null ? null : s.tempMillidegrees / 1000, num(s.temp))); }
  },
  {
    name: 'glasshouse_cpu_seconds_total', type: 'counter',
    help: 'Time each online core has spent in each mode since boot, in seconds, from /proc/stat.',
    samples: function (s) {
      var out = [], cpus = s.cpuTimes;
      if (!cpus || typeof cpus !== 'object') return out;
      Object.keys(cpus).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (cpu) {
        for (var mode in cpus[cpu]) {
          if (num(cpus[cpu][mode]) !== null) out.push([{ cpu: cpu, mode: mode }, cpus[cpu][mode] / USER_HZ]);
        }
      });
      return out;
    }
  },
  {
    name: 'glasshouse_cpu_frequency_hertz', type: 'gauge',
    help: 'Processor clock frequency in hertz, as the TV\'s power manager reports it.',
    samples: function (s) { return one(prefer(positive(s.cpuHz), scaled(s.mhz, 1e6))); }
  },
  {
    name: 'glasshouse_gpu_frequency_hertz', type: 'gauge',
    help: 'GPU clock frequency in hertz.',
    samples: function (s) { return one(prefer(positive(s.gpuHz), scaled(s.gpuMhz, 1e6))); }
  },
  {
    name: 'glasshouse_memory_total_bytes', type: 'gauge',
    help: 'Memory usable by the system in bytes, MemTotal in /proc/meminfo.',
    samples: function (s) { return one(scaled(positive(path(s, ['mem', 'total'])), 1024)); }
  },
  {
    name: 'glasshouse_memory_available_bytes', type: 'gauge',
    help: 'Memory available for new work without swapping in bytes, MemAvailable in /proc/meminfo.',
    samples: function (s) {
      return one(memoryRead(s) ? scaled(path(s, ['mem', 'avail']), 1024) : null);
    }
  },
  {
    name: 'glasshouse_swap_total_bytes', type: 'gauge',
    help: 'Swap space in bytes, SwapTotal in /proc/meminfo.',
    samples: function (s) { return one(memoryRead(s) ? scaled(path(s, ['swap', 'total']), 1024) : null); }
  },
  {
    name: 'glasshouse_swap_free_bytes', type: 'gauge',
    help: 'Unused swap space in bytes, SwapFree in /proc/meminfo.',
    samples: function (s) { return one(memoryRead(s) ? scaled(path(s, ['swap', 'free']), 1024) : null); }
  },
  {
    name: 'glasshouse_network_receive_bytes_total', type: 'counter',
    help: 'Bytes received on the network interface in use, labelled with its name.',
    samples: function (s) {
      var n = s.netTotal;
      return n && num(n.rx) !== null ? [[{ interface: n.iface }, n.rx]] : [];
    }
  },
  {
    name: 'glasshouse_network_transmit_bytes_total', type: 'counter',
    help: 'Bytes sent on the network interface in use, labelled with its name.',
    samples: function (s) {
      var n = s.netTotal;
      return n && num(n.tx) !== null ? [[{ interface: n.iface }, n.tx]] : [];
    }
  },
  {
    name: 'glasshouse_wifi_signal_dbm', type: 'gauge',
    help: 'Wi-Fi signal level in dBm, from /proc/net/wireless.',
    samples: function (s) { return one(num(path(s, ['wifi', 'level']))); }
  },
  {
    name: 'glasshouse_wifi_link_quality', type: 'gauge',
    help: 'Wi-Fi link quality from /proc/net/wireless, on a scale the Wi-Fi driver sets.',
    samples: function (s) { return one(num(path(s, ['wifi', 'link']))); }
  },
  {
    name: 'glasshouse_emmc_pre_eol_state', type: 'gauge',
    help: 'eMMC pre-end-of-life state from its PRE_EOL_INFO register, 1 for the current one: normal, warning (80% of reserved blocks used) or urgent (90%).',
    samples: function (s) {
      var eol = path(s, ['emmc', 'eol']);
      if (EMMC_EOL_STATES.indexOf(eol) === -1) return [];
      return EMMC_EOL_STATES.map(function (st) {
        return [{ state: st.toLowerCase() }, st === eol ? 1 : 0];
      });
    }
  },
  {
    name: 'glasshouse_emmc_life_used_ratio', type: 'gauge',
    help: 'Share of the eMMC\'s estimated life used, from its DEVICE_LIFE_TIME_EST registers, in steps of 0.1: 0 for under a tenth, 1 for all of it or more. type is a or b, the two kinds of memory the card estimates for.',
    samples: function (s) {
      var out = [];
      ['a', 'b'].forEach(function (t) {
        var v = num(path(s, ['emmc', 'life_est_' + t]));
        if (v !== null && v >= 1 && v <= 11) out.push([{ type: t }, (v - 1) / 10]);
      });
      return out;
    }
  },
  {
    name: 'glasshouse_app_storage_size_bytes', type: 'gauge',
    help: 'Size of the app storage filesystem in bytes.',
    samples: function (s) {
      return one(prefer(scaled(positive(path(s, ['appStorage', 'totalKb'])), 1024),
        scaled(positive(path(s, ['appStorage', 'totalMb'])), MEBIBYTE)));
    }
  },
  {
    name: 'glasshouse_app_storage_available_bytes', type: 'gauge',
    help: 'Space on the app storage filesystem available for new apps in bytes.',
    samples: function (s) {
      if (positive(path(s, ['appStorage', 'totalKb'])) !== null) return one(scaled(path(s, ['appStorage', 'availKb']), 1024));
      return one(positive(path(s, ['appStorage', 'totalMb'])) === null ? null
        : scaled(path(s, ['appStorage', 'freeMb']), MEBIBYTE));
    }
  },
  {
    name: 'glasshouse_remote_battery_ratio', type: 'gauge',
    help: 'Battery charge of the paired Magic Remote, from 0 to 1.',
    samples: function (s) { return one(percent(path(s, ['remote', 'battery']))); }
  },
  {
    name: 'glasshouse_adblock_enabled', type: 'gauge',
    help: '1 when the ad-blocking hosts table is in place over /etc/hosts, 0 otherwise.',
    samples: function (s) { return one(bool(path(s, ['privacy', 'adblock', 'enabled']))); }
  },
  {
    name: 'glasshouse_oled_panel_usage_seconds_total', type: 'counter',
    help: 'Time the OLED panel has been in use, in seconds, counted in steps of 10 minutes.',
    samples: function (s) {
      return one(prefer(scaled(positive(path(s, ['oled', 'panel_usage_units'])), PANEL_UNIT_SECONDS),
        scaled(positive(path(s, ['oled', 'panel_hours_exact'])), 3600)));
    }
  },
  {
    name: 'glasshouse_oled_last_compensation_usage_seconds', type: 'gauge',
    help: 'Panel usage time at the last short compensation cycle, in seconds.',
    samples: function (s) {
      return one(prefer(scaled(positive(path(s, ['oled', 'last_compensation_units'])), PANEL_UNIT_SECONDS),
        scaled(positive(path(s, ['oled', 'last_compensation_hours'])), 3600)));
    }
  },
  {
    name: 'glasshouse_oled_compensation_interval_seconds', type: 'gauge',
    help: 'Panel usage time between short compensation cycles, in seconds.',
    samples: function (s) {
      // oled.js puts an interval outside 0.5 to 24 hours back to 4 hours and
      // leaves the units as read, so the units count only where they agree.
      var units = positive(path(s, ['oled', 'comp_interval_units']));
      var hours = positive(path(s, ['oled', 'comp_interval_hours']));
      if (units !== null && hours !== null && Math.abs(units / 6 - hours) < 0.1) return one(units * PANEL_UNIT_SECONDS);
      return one(scaled(hours, 3600));
    }
  },
  {
    name: 'glasshouse_oled_compensation_running', type: 'gauge',
    help: '1 while a short compensation cycle is running, 0 otherwise.',
    samples: function (s) {
      var st = path(s, ['oled', 'comp_status']);
      return one(typeof st === 'string' ? (st === 'Running' ? 1 : 0) : null);
    }
  },
  {
    name: 'glasshouse_oled_compensation_runs_total', type: 'counter',
    help: 'Short compensation cycles the panel has completed.',
    samples: function (s) { return one(num(path(s, ['oled', 'comp_cycles']))); }
  },
  {
    name: 'glasshouse_oled_last_refresher_usage_seconds', type: 'gauge',
    help: 'Panel usage time at the last Pixel Refresher run, in seconds, to the nearest hour.',
    samples: function (s) { return one(scaled(positive(path(s, ['oled', 'last_refresher_hours'])), 3600)); }
  },
  {
    name: 'glasshouse_oled_refresher_interval_seconds', type: 'gauge',
    help: 'Panel usage time between automatic Pixel Refresher runs, in seconds.',
    samples: function (s) { return one(scaled(positive(path(s, ['oled', 'refresher_interval_hours'])), 3600)); }
  },
  {
    name: 'glasshouse_oled_refresher_runs_total', type: 'counter',
    help: 'Pixel Refresher runs the panel has completed.',
    samples: function (s) { return one(num(path(s, ['oled', 'refresher_cycles']))); }
  },
  {
    name: 'glasshouse_oled_refresher_running', type: 'gauge',
    help: '1 while a Pixel Refresher run is in progress, 0 otherwise.',
    samples: function (s) { return one(refresherStatus(s, 'Running')); }
  },
  {
    name: 'glasshouse_oled_refresher_scheduled', type: 'gauge',
    help: '1 while a Pixel Refresher run is queued for the next standby, 0 otherwise.',
    samples: function (s) { return one(refresherStatus(s, 'Scheduled')); }
  },
  {
    name: 'glasshouse_oled_failure_alerts_total', type: 'counter',
    help: 'Panel maintenance failure alerts the TV has recorded.',
    samples: function (s) { return one(num(path(s, ['oled', 'failure_alerts']))); }
  },
  {
    name: 'glasshouse_oled_gsr_stress_events_total', type: 'counter',
    help: 'Stress events Global Stress Reduction has counted on the panel, as the TV\'s panel service reports them.',
    samples: function (s) { return one(num(path(s, ['oled', 'gsr_stress_count']))); }
  },
  {
    name: 'glasshouse_oled_protection_enabled', type: 'gauge',
    help: '1 when the panel protection is on, 0 when off: asbl is the Automatic Static Brightness Limiter, gsr Global Stress Reduction.',
    samples: function (s) {
      var out = [];
      [['asbl', 'tpc_enabled'], ['gsr', 'gsr_enabled']].forEach(function (p) {
        var v = bool(path(s, ['oled', p[1]]));
        if (v !== null) out.push([{ protection: p[0] }, v]);
      });
      return out;
    }
  },
  {
    name: 'glasshouse_picture_backlight_ratio', type: 'gauge',
    help: 'Backlight setting of the current picture mode from 0 to 1, which on an OLED is OLED light, the pixel brightness.',
    samples: function (s) { return one(percent(path(s, ['picture', 'backlight_raw']))); }
  },
  {
    name: 'glasshouse_foreground_app_info', type: 'gauge',
    help: 'Always 1 for the app in the foreground, whether or not glasshouse_screen_on reports the screen lit, labelled with its id and its name: the name given an input in the TV\'s settings, an app\'s title, or the short id.',
    samples: function (s) {
      return typeof s.app_id === 'string' && s.app_id ? [[{ app_id: s.app_id, app_name: s.app_name }, 1]] : [];
    }
  },
  {
    name: 'glasshouse_signal_info', type: 'gauge',
    help: 'Always 1, labelled with the dynamic range (sdr, hdr, dolby_vision, technicolor) and the picture mode the picture settings are using.',
    samples: function (s) {
      var dr = dynamicRange(s);
      var mode = path(s, ['picture', 'mode_raw']);
      var labels = {
        dynamic_range: dr ? dr.label : '',
        picture_mode: typeof mode === 'string' && mode ? names.pictureMode(mode).label : ''
      };
      return labels.dynamic_range || labels.picture_mode ? [[labels, 1]] : [];
    }
  },
  {
    name: 'glasshouse_signal_low_latency', type: 'gauge',
    help: '1 while the TV\'s picture settings are in their low-latency mode, which an HDMI source requests with the ALLM flag in any format, 0 otherwise.',
    samples: function (s) {
      var dr = dynamicRange(s);
      return one(dr ? (dr.lowLatency ? 1 : 0) : null);
    }
  },
  {
    name: 'glasshouse_signal_vrr', type: 'gauge',
    help: '1 while the HDMI source is using variable refresh rate (VRR, FreeSync, or HDMI Forum VRR), 0 otherwise.',
    samples: function (s) { return one(bool(path(s, ['hdmi_diag', 'vrr']))); }
  },
  {
    name: 'glasshouse_signal_width_pixels', type: 'gauge',
    help: 'Width of the HDMI source\'s picture in pixels.',
    samples: function (s) { return one(positive(path(s, ['signal_timing', 'width']))); }
  },
  {
    name: 'glasshouse_signal_height_pixels', type: 'gauge',
    help: 'Height of the HDMI source\'s picture in pixels.',
    samples: function (s) { return one(positive(path(s, ['signal_timing', 'height']))); }
  },
  {
    name: 'glasshouse_signal_refresh_hertz', type: 'gauge',
    help: 'Refresh rate of the HDMI signal in hertz, as the source sends it rather than the content\'s frame rate.',
    samples: function (s) { return one(positive(path(s, ['signal_timing', 'refresh_hz']))); }
  },
  {
    name: 'glasshouse_signal_frame_rate_hertz', type: 'gauge',
    help: 'Frame rate in hertz: the rate the game is running at while VRR is in use, and the same as the refresh rate otherwise. vrr_type is the kind of VRR, such as gsync, or off.',
    samples: function (s) {
      var hz = positive(path(s, ['source_frame_rate', 'hz']));
      var type = path(s, ['source_frame_rate', 'vrr_type']);
      return hz === null ? [] : [[{ vrr_type: typeof type === 'string' && type ? snakeCase(type) : 'off' }, hz]];
    }
  },
  {
    name: 'glasshouse_signal_format_info', type: 'gauge',
    help: 'Always 1 while a video sink is connected, labelled with the source\'s HDR type, such as sdr or hdr10, the EOTF its HDR metadata names (sdr, hdr, pq, or hlg), its colorimetry, and its pixel encoding (rgb_444, ycbcr_444, ycbcr_422, or ycbcr_420).',
    samples: function (s) {
      var format = s.signal_format;
      if (!format || typeof format !== 'object') return [];
      return [[{
        type: typeof format.type === 'string' ? format.type : '',
        eotf: typeof format.eotf === 'string' ? format.eotf : '',
        colorimetry: typeof format.colorimetry === 'string' ? names.signalColorimetry(format.colorimetry).label : '',
        encoding: typeof format.encoding === 'string' ? names.signalEncoding(format.encoding).label : ''
      }, 1]];
    }
  },
  {
    name: 'glasshouse_signal_hdr_mastering_luminance_max_nits', type: 'gauge',
    help: 'Peak luminance of the display the content was mastered on, in nits, from the source\'s HDR10 static metadata.',
    samples: function (s) { return one(num(path(s, ['signal_format', 'max_luminance']))); }
  },
  {
    name: 'glasshouse_signal_hdr_mastering_luminance_min_nits', type: 'gauge',
    help: 'Black level of the display the content was mastered on, in nits, from the source\'s HDR10 static metadata.',
    samples: function (s) { return one(num(path(s, ['signal_format', 'min_luminance']))); }
  },
  {
    name: 'glasshouse_signal_hdr_content_light_level_max_nits', type: 'gauge',
    help: 'Brightest pixel in the content (MaxCLL) in nits, from the source\'s HDR10 static metadata, while the source gives one.',
    samples: function (s) { return one(positive(path(s, ['signal_format', 'max_cll']))); }
  },
  {
    name: 'glasshouse_signal_hdr_frame_average_light_level_max_nits', type: 'gauge',
    help: 'Brightest frame average in the content (MaxFALL) in nits, from the source\'s HDR10 static metadata, while the source gives one.',
    samples: function (s) { return one(positive(path(s, ['signal_format', 'max_fall']))); }
  },
  {
    name: 'glasshouse_signal_game_mode', type: 'gauge',
    help: '1 while the video output service has the connected source in game mode, 0 otherwise.',
    samples: function (s) { return one(bool(path(s, ['signal_format', 'game_mode']))); }
  },
  {
    name: 'glasshouse_hdmi_input_info', type: 'gauge',
    help: 'Always 1 for each HDMI input, labelled with the input, its app id, and the name given it in the TV\'s settings.',
    samples: function (s) {
      return hdmiInputNames(s).map(function (i) {
        return [{ input: i.input, app_id: 'com.webos.app.' + i.input, name: i.name }, 1];
      });
    }
  },
  {
    name: 'glasshouse_hdmi_link_info', type: 'gauge',
    help: 'Always 1 for each HDMI input with a link, labelled with the input, its PHY mode (frl_48 to frl_9, tmds_6g, or tmds_3g), its chroma format, and its HDCP version.',
    samples: function (s) {
      return hdmiLinks(s).map(function (link) {
        var labels = hdmiInput(link);
        labels.phy_mode = names.hdmiPhyMode(link.phy_mode, link.tmds_clock_khz).label;
        labels.chroma = link.chroma ? names.hdmiChroma(link.chroma).label : '';
        labels.hdcp = link.hdcp ? names.hdmiHdcp(link.hdcp).label : '';
        return [labels, 1];
      });
    }
  },
  {
    name: 'glasshouse_hdmi_link_bits_per_second', type: 'gauge',
    help: 'Rate of each HDMI input\'s link in bits per second: the lane rate times the lanes on FRL, and ten bits a character on each of three channels on TMDS.',
    samples: function (s) {
      var out = [];
      hdmiLinks(s).forEach(function (link) {
        var rate = names.hdmiPhyMode(link.phy_mode, link.tmds_clock_khz).bitsPerSecond;
        if (rate !== null) out.push([hdmiInput(link), rate]);
      });
      return out;
    }
  },
  {
    name: 'glasshouse_hdmi_qms', type: 'gauge',
    help: '1 while Quick Media Switching is active on the HDMI input\'s link, 0 otherwise.',
    samples: function (s) {
      var out = [];
      hdmiLinks(s).forEach(function (link) {
        var v = bool(link.qms);
        if (v !== null) out.push([hdmiInput(link), v]);
      });
      return out;
    }
  },
  {
    name: 'glasshouse_hdmi_source_powered', type: 'gauge',
    help: '1 while a powered source is on the HDMI input\'s cable, whether or not its link is up, 0 otherwise.',
    samples: function (s) {
      return hdmiSources(s).map(function (source) {
        return [hdmiInput(source), source.powered ? 1 : 0];
      });
    }
  },
  {
    name: 'glasshouse_syslog_messages_total', type: 'counter',
    help: 'Log lines sent to the syslog server since the server started, by source: system, glasshouse, or kernel.',
    samples: function (s, version, syslog) {
      if (!syslog) return [];
      return Object.keys(syslog.messages).map(function (source) {
        return [{ source: source }, syslog.messages[source]];
      });
    }
  },
  {
    name: 'glasshouse_syslog_errors_total', type: 'counter',
    help: 'Log lines that could not be sent to the syslog server since the server started. They are dropped, not sent again.',
    samples: function (s, version, syslog) { return syslog ? one(syslog.errors) : []; }
  }
];

var STABLE = FAMILIES.map(function (f) { return f.name; });

// The exposition format escapes backslash, double quote and newline in a
// label value, and nothing else.
function escapeLabel(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function labelSet(labels) {
  var parts = [];
  for (var k in labels) parts.push(k + '="' + escapeLabel(labels[k]) + '"');
  return parts.length ? '{' + parts.join(',') + '}' : '';
}

// stats is telemetry's collectStats result; version is Glasshouse's own;
// syslog is the syslog module's counters, null while forwarding is off.
function render(stats, version, syslog) {
  var s = stats && typeof stats === 'object' ? stats : {};
  var out = '';
  for (var i = 0; i < FAMILIES.length; i++) {
    var f = FAMILIES[i];
    out += '# HELP ' + f.name + ' ' + f.help + '\n# TYPE ' + f.name + ' ' + f.type + '\n';
    var samples = f.samples(s, version, syslog || null);
    for (var j = 0; j < samples.length; j++) {
      out += f.name + labelSet(samples[j][0]) + ' ' + samples[j][1] + '\n';
    }
  }
  return out;
}

module.exports = { render: render, escapeLabel: escapeLabel, STABLE: STABLE };
