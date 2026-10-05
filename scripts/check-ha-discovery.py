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
templates in each case of telemetry's volume_control.

Needs the homeassistant package (Python 3.13), which CI installs:

    pip install homeassistant
    ./scripts/check-ha-discovery.py
"""
import asyncio
import importlib
import json
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

    await hass.async_stop(force=True)
    for p in problems:
        print(p)
    print('%d discovery configs checked against Home Assistant %s, %d problem%s'
          % (len(configs), HA_VERSION, len(problems),
             '' if len(problems) == 1 else 's'))
    return 1 if problems else 0


sys.exit(asyncio.run(main()))
