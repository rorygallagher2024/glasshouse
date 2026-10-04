# Security

This server has **no authentication by default**, and binds to `0.0.0.0` so it
is reachable from anywhere on your network. Anyone who can reach the port can
use every enabled control. On a home LAN that is usually the point; understand
it before exposing it more widely.

- **Set a token.** Put `"token": "something-long"` in `config.json` and every
  `/api/` request must carry `?k=something-long`. Open the dashboard once with
  the token in the URL; the browser remembers it and the page takes it out of
  the address bar, so it stays out of history and shared links. This gates the HTTP API only &mdash; **MQTT and the Home
  Assistant integration are unaffected**, since they use a separate channel.
- **`"allowPower": false`** hides and refuses power off, power on and reboot,
  in the dashboard and in Home Assistant, for a TV that should never be
  switched off over the network. The other controls stay.
- **Turn the dashboard off if you do not use it.** `"web": { "enabled": false }`
  removes the HTTP endpoint altogether, which is stronger than gating it with a
  token. An MQTT-only install has no reason to expose one. The on-TV app runs on
  the same server, so it stops working too; a first install in this state does
  not add it.
- **The upgrade and install endpoints install code.** `allowControl` gates
  them along with everything else, so on a default install anyone who can reach
  the port can move the TV to the current release, and can install any app in
  the Homebrew Channel catalog. The upgrade comes from a fixed repository over
  verified TLS. A catalog install must use https and match the sha256 hash the
  catalog lists, and the package must keep to its own ids: nothing under
  `com.webos.`, `com.palm.` or `com.lge.`, nothing already on the TV's system
  partition, and not the Homebrew Channel or the dashboard's own package. That
  still lets a reachable client choose which catalog app runs on the TV, so
  `token` or `"allowControl": false` closes it.
- **Installing from a URL or an uploaded file is opt-in.** Such a package has
  no catalog behind it, so the routes refuse unless `"apps": {"sideload": true}`
  is set (by the switch on the Apps tab, after a warning, or in `config.json`),
  a `token` is set, or the request comes from the TV itself. The switch answers
  to any client that can reach the port, so on a default install it is a
  speed bump, not a lock; a `token` is what keeps others from turning it on. The package is held
  to the same id rules as a catalog one, and an optional sha256 is checked when
  given, but nothing vouches for what it does. An upload must be sent as
  `application/octet-stream` with a `Content-Length`, because a form post is a
  request a page on another site can send without a preflight. Once sideloading
  is on, a client that can reach the port can run any package on the TV, so
  turn it on only with a token or a closed port. `apps.sideload` without a
  token opens exactly that, and the server logs a warning at start.
- **A catalog app can be given root.** On a default install, a client that can
  reach the port can install an app from the Homebrew Channel catalog and run
  its services as root, as the Homebrew Channel itself would. An app from the
  Homebrew Channel's catalog whose services need root gets it on install
  without a separate prompt, as it would through the Homebrew Channel, and
  gets it again after each update, since a reinstall undoes it. Root needs
  the Homebrew Channel. `token` or
  `"allowControl": false` closes this too. A package from a URL, a file or an
  `apps.repos` catalog is never elevated automatically: the request must name
  the services listed in its preview, and a later update asks again. The TV's
  own dashboard offers root only for the Homebrew Channel's catalog, since the
  remote cannot name services.
- **The install routes check the Host header.** A page on an attacker's domain
  that resolves to the TV's address (DNS rebinding) passes the same-origin
  check on `POST`s and looks like a request from the TV itself. The routes
  therefore answer only to an IP address, `localhost` or a name listed in
  `apps.hosts` in `config.json`, which is file-only. A name such as `lgtv.local`
  has to be added there to install from it.
- **`apps.repos` adds trust.** Each extra catalog listed there can offer
  packages for installation, with their hashes. Its packages are not treated
  as vetted: root for them is confirmed service by service, as for a URL, and
  is never given back on an update. It is file-only and every entry must be
  served over https.
- **Never port-forward this.** It is designed for a trusted LAN.
- **Bind to `127.0.0.1` to keep the on-TV app but close the port.** With
  `"host": "127.0.0.1"` nothing on the network can connect to port 8080, while
  the on-TV app, which connects over the TV's own loopback, keeps working. The
  app's QR codes are hidden in this mode, since they would point a phone at an
  address the server no longer answers on.
- No CORS headers are sent, so other websites cannot read your telemetry from
  your browser. Cross-origin `POST`s are refused, and `/api/control` requires
  `Content-Type: application/json`.
- Remember the wider context: rooted webOS exposes an **unauthenticated root
  telnet on port 23**. That is a far bigger exposure than this server, and it
  is worth closing off if you have not already.

---

---


## Narrowing access

| Setting                        | Browser on the network                  | App on the TV | MQTT  |
| :----------------------------- | :-------------------------------------- | :------------ | :---- |
| `"token": "your-secret-token"` | with `?k=your-secret-token`             | works         | works |
| `"host": "127.0.0.1"`          | no — port 8080 is closed to the network | works         | works |
| `"web": { "enabled": false }`  | no                                      | does not work | works |

`"host": "127.0.0.1"` is the one to use to keep the on-TV app while closing the port to everything else.

The app runs on the same server, so switching the web server off entirely leaves its tile with nothing to open — remove it from the **Server** tab first; a first install with the web server off does not add it.

## Moving from telnet to SSH

A rooted webOS TV exposes an **unauthenticated root shell on port 23**. Anyone
on your network gets root with no credentials, which makes every other measure
here mitigation rather than a fix &mdash; nothing stored on the TV is secret
while it is open.

The Homebrew Channel ships dropbear, so this needs no extra software. If you
already have your key on the TV and telnet turned off, you are done; there is
nothing here for you.

**The order matters.** The Homebrew Channel sets a placeholder root password
(`alpine`, a publicly known default) *unless* `/home/root/.ssh/authorized_keys`
already exists. Enabling SSH without a key installed therefore gets you
password login as root with a password everybody knows &mdash; no safer than
telnet.

1. In the Homebrew Channel, turn **SSH** on.
2. **Reboot.** The flag is only read at boot.
3. Install your key. The placeholder password `alpine` gets you in this once:
   ```bash
   ssh-copy-id root@<tv-ip>
   ```
   Prefer not to use that password at all? Append your key over telnet instead:
   ```bash
   mkdir -p /home/root/.ssh
   echo 'ssh-ed25519 AAAA...' >> /home/root/.ssh/authorized_keys
   chmod 700 /home/root/.ssh && chmod 600 /home/root/.ssh/authorized_keys
   ```
4. **Reboot again.** With a key present the placeholder password is no longer
   set, and only key auth works.
5. Confirm it: `ssh root@<tv-ip>`
6. Now turn **telnet** off in the Homebrew Channel.

**Do not turn telnet off before step 5.** If SSH does not come up you will have
no root access, and recovery means re-rooting the TV.

`deploy.sh` prefers SSH and falls back to telnet automatically, so it keeps
working throughout. `--telnet` forces the old path if you need it.

---

## Hardening the MQTT bridge

Worth doing properly, because this is the part that reaches beyond the TV. The
broker credentials live in `config.json` **on the TV**, and a rooted webOS set
has an unauthenticated root shell on port 23 &mdash; so treat anything stored
there as readable by anyone on your network. `tvweb` tightens the file to `0600`
at startup, but that is mitigation, not a fix.

The question that matters is not whether the bridge is authenticated (it is),
but **what that credential is allowed to do**. Reuse your main Home Assistant
MQTT user and a compromised TV can publish to any topic on the broker &mdash;
including the ones driving your lights, locks or alarms.

**1. Give the TV its own broker user with a restricted ACL.** With this in
place, a compromised TV can only lie about its own telemetry:

```conf
# /etc/mosquitto/aclfile
user lgtv
topic write  lgtv/#
topic read   lgtv/command/#
topic write  homeassistant/+/lg_tv/#
```

The last line is deliberately narrow: unrestricted write access to
`homeassistant/#` would let a compromised TV register arbitrary new entities
via MQTT Discovery.

**2. Encrypt the connection.** Without TLS the username and password cross your
network in cleartext in every CONNECT packet, and a reconnect loop resends them
every few seconds:

```json
"mqtt": { "tls": true, "port": 8883 }
```

Set `"tlsRejectUnauthorized": false` only if your broker uses a self-signed
certificate &mdash; the traffic stays encrypted, but the broker is no longer
authenticated, so only do it on a network you trust.

**3. Consider network segmentation.** Putting the TV on its own VLAN that can
reach only the broker is sound defence in depth. It does not replace the ACL:
the TV must reach the broker by definition, so a stolen credential still works
from inside the segment. The ACL is what limits the blast radius.

**4. Close the root telnet.** While port 23 is an open root shell, nothing
stored on the TV is secret and every measure above is mitigation around that
fact. Installing openssh via the Homebrew Channel and disabling telnet is the
single biggest improvement you can make.

---
