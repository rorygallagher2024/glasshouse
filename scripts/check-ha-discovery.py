#!/usr/bin/env python3
"""
Every discovery config the server can publish must be one Home Assistant
accepts.

Home Assistant rejects a config it cannot validate and creates no entity for
it, logging the reason only on its own side. Since 0.78.0 it rejected Volume,
Mute, Volume Up and Volume Down (#437), which carried an availability list
and the flat availability_topic together, and no check here asked it. This
runs each config from scripts/discovery-configs.js through Home Assistant's
own MQTT discovery schemas, then renders the volume entities' availability
templates in each case of telemetry's volume_control, and every template that
reads telemetry against the stats each fixture TV reported, failing on any
warning Home Assistant logs: a field missing from the payload is logged as a
Template variable warning on every message, tens of thousands an hour with a
few TVs (#761).

Needs the homeassistant package (Python 3.13), which CI installs:

    pip install homeassistant
    ./scripts/check-ha-discovery.py
"""
import asyncio
import importlib
import json
import logging
import pathlib
import subprocess
import sys
import tempfile

try:
    import voluptuous as vol
    from homeassistant import core
    from homeassistant.const import __version__ as HA_VERSION
    from homeassistant.helpers.template import Template
except ImportError:
    sys.exit('needs the homeassistant package: pip install homeassistant')

ROOT = pathlib.Path(__file__).resolve().parent.parent

# What each volume entity's own availability says, by volume_control. None
# is telemetry from a server too old to send it.
VOLUME = {
    'volume':      {'level': 'online', 'steps': 'offline', 'none': 'offline', None: 'online'},
    'mute':        {'level': 'online', 'steps': 'online',  'none': 'offline', None: 'online'},
    'volume_up':   {'level': 'online', 'steps': 'online',  'none': 'offline', None: 'online'},
    'volume_down': {'level': 'online', 'steps': 'online',  'none': 'offline', None: 'online'},
}


def render(hass, template, value):
    try:
        js = json.loads(value)
    except ValueError:
        js = None
    variables = {'value': value}
    if js is not None:
        variables['value_json'] = js
    return str(Template(template, hass).async_render(variables)).strip()


async def main():
    # Template validation runs only inside a running Home Assistant.
    hass = core.HomeAssistant(tempfile.mkdtemp())
    core._hass.hass = hass
    configs = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts' / 'discovery-configs.js')]))
    problems = []

    for c in configs:
        schema = importlib.import_module('homeassistant.components.mqtt.' + c['type']).DISCOVERY_SCHEMA
        try:
            schema(dict(c['conf'], platform='mqtt'))
        except vol.Invalid as e:
            problems.append('%s.%s is rejected: %s' % (c['type'], c['id'], e))

    by_id = {c['id']: c['conf'] for c in configs}
    stats = json.loads((ROOT / 'test' / 'fixtures' / 'stats-g4-webos9.json').read_text(encoding='utf-8'))
    for eid, expect in VOLUME.items():
        own = [a for a in by_id[eid].get('availability', []) if a['topic'] == 'tv/telemetry']
        if len(own) != 1:
            problems.append('%s has no availability of its own from telemetry' % eid)
            continue
        for control, want in expect.items():
            payload = dict(stats)
            payload.pop('volume_control', None)
            if control is not None:
                payload['volume_control'] = control
            got = render(hass, own[0]['value_template'], json.dumps(payload))
            if got != want:
                problems.append('%s with volume_control %s is %s, not %s' % (eid, control, got, want))

    # Every template that reads the telemetry, rendered as each fixture TV
    # reported it: Home Assistant logs each field one reads that is missing.
    logged = []

    class Catch(logging.Handler):
        def emit(self, record):
            logged.append(record.getMessage())

    catch = Catch(logging.WARNING)
    template_log = logging.getLogger('homeassistant.helpers.template')
    template_log.addHandler(catch)
    fixtures = sorted((ROOT / 'test' / 'fixtures').glob('stats-*.json'))
    checked = 0
    for c in configs:
        conf = c['conf']
        reads = []
        if conf.get('state_topic') == 'tv/telemetry' and 'value_template' in conf:
            reads.append(('value_template', conf['value_template']))
        if conf.get('json_attributes_topic') == 'tv/telemetry' and 'json_attributes_template' in conf:
            reads.append(('json_attributes_template', conf['json_attributes_template']))
        reads += [('availability', a['value_template']) for a in conf.get('availability', [])
                  if a.get('topic') == 'tv/telemetry' and 'value_template' in a]
        checked += len(reads)
        for key, template in reads:
            for fixture in fixtures:
                del logged[:]
                try:
                    render(hass, template, fixture.read_text(encoding='utf-8'))
                except Exception as e:  # noqa: BLE001 - any failure is the finding
                    logged.append('%s: %s' % (type(e).__name__, e))
                for message in sorted(set(logged)):
                    problems.append('%s.%s %s with %s: %s' % (c['type'], c['id'], key, fixture.name, message))
    # Hue Sync topics carry settings and sanitized diagnostics, not telemetry.
    # Exercise freshness and missing fields after ha.js's safeFields transform.
    hue_fixture = json.loads((ROOT / 'test' / 'fixtures' / 'huesync-settings.json').read_text())
    hue_checked = 0
    for c in configs:
        conf = c['conf']
        topic = conf.get('state_topic')
        if topic not in ('tv/state/huesync/settings', 'tv/state/huesync/diagnostics'):
            continue
        state = hue_fixture['diagnostics' if topic.endswith('/diagnostics') else 'settings']
        own = [a for a in conf.get('availability', []) if a.get('topic') == topic]
        if len(own) != 1:
            problems.append('%s lacks Hue Sync availability' % c['id'])
            continue
        for label, data, expected in [('fresh', state, 'online'), ('missing', {}, 'offline'),
                                      ('stale', dict(state, _stale=list(state)), 'offline')]:
            del logged[:]
            try:
                got = render(hass, own[0]['value_template'], json.dumps(data))
                if got != expected:
                    problems.append('%s %s availability: %s, expected %s' % (c['id'], label, got, expected))
                render(hass, conf['value_template'], json.dumps(data))
            except Exception as error:
                logged.append(str(error))
            for message in sorted(set(logged)):
                problems.append('%s %s: %s' % (c['id'], label, message))
        if 'command_template' in conf:
            expected_commands = {
                'huesync_intensity': {'Subtle': '0', 'Moderate': '1', 'High': '2', 'Extreme': '3'},
                'huesync_sync_mode': {'Video': '0', 'Game': '1'},
                'huesync_current_ec': {area['name'] + ' (' + area['id'] + ')': area['id']
                                      for area in hue_fixture['settings']['ec_list']},
            }
            for choice, expected in expected_commands.get(c['id'], {}).items():
                got = render(hass, conf['command_template'], choice)
                if got != expected:
                    problems.append('%s command for %s: %s, expected %s' % (c['id'], choice, got, expected))
        hue_checked += 1
    if hue_checked != 12:
        problems.append('expected 12 Hue Sync settings/diagnostics, checked %s' % hue_checked)
    print('%d Hue Sync templates checked with fresh, missing and stale state' % hue_checked)
    template_log.removeHandler(catch)
    print('%d telemetry templates rendered against %d fixture TVs' % (checked, len(fixtures)))

    await hass.async_stop(force=True)
    for p in problems:
        print(p)
    print('%d discovery configs checked against Home Assistant %s, %d problem%s'
          % (len(configs), HA_VERSION, len(problems),
             '' if len(problems) == 1 else 's'))
    return 1 if problems else 0


sys.exit(asyncio.run(main()))
