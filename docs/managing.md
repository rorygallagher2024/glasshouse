# Updating and uninstalling

```bash
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl status    # start | stop | restart | status
```

## Updating

How depends on the install. One with a **Server** tab in its dashboard updates itself; an older one is updated by deploying again, after which it has the tab.

**With the Server tab.** Opening it looks for a newer release, and **Check now** looks again. **Install** puts it on and restarts the server, and, for installs made with `deploy.sh`, **Roll back** returns to the version it replaced.

Home Assistant can offer the same install while the [daily check](managing.md#checking-automatically) is on.

Over SSH:

```bash
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl update           # install the latest release
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl update --check   # report without installing
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl rollback         # put the previous version back
```

**Installed from the Homebrew Channel or as an `.ipk`.** **Install** on the Server tab, the TV app's Updates tab, Home Assistant's update entity and `tvwebctl update` install the release's `.ipk` with the TV's app installer, check it against the release's sha256, and run the app's installer, which moves the server over and restarts it with its settings. The Glasshouse app closes while its package is replaced. Package updates keep no rollback copy. Glasshouse is not yet in the Homebrew Channel's catalog ([webosbrew/apps-repo#261](https://github.com/webosbrew/apps-repo/pull/261)), so the Homebrew Channel does not offer the update itself; installing the newer `.ipk` from [GitHub releases](https://github.com/rorygallagher2024/glasshouse/releases) by hand (webOS Dev Manager, Homebrew Channel sideload or `ares-install`) works as well. Versions up to 0.121.0 only point to the Homebrew Channel, so a TV on one of those takes the `.ipk` by hand once.

To force an in-place server update over SSH on an IPK install:

```bash
ssh root@<tv-ip> /var/lib/tvweb/tvwebctl update --force
```

**Without it, or for something unreleased,** pull the latest code into the clone from [step 1](install.md#1-get-the-files) and deploy again, with the flags used the first time:

```bash
cd glasshouse/server
git pull
./deploy.sh <tv-ip>
```

Only the server's own files are replaced; settings are kept.

A server deployed from a git clone shows the commit it was built from after its version, as `0.80.1+55e51e5`, with `.dirty` added when files under `server/` had uncommitted changes. A release installed later shows its plain version.

On installs made with `deploy.sh`, previous versions are saved to allow instant rollback via `tvwebctl rollback`.

See [docs/IMPLEMENTATION.md](IMPLEMENTATION.md#in-place-updater-and-binary-probing) for client probing order and manual rollback details.

## Checking automatically

Off by default, because it reaches off the LAN without anyone asking.

**Check for updates daily** in the Server tab switches it on, as does `config.json`:

```json
{ "update": { "check": true, "intervalHours": 24 } }
```

With it on, the server asks GitHub for the latest release once a day, the dashboard footer shows a newer version next to the installed one, and Home Assistant gets the update entity.

The request says nothing about the TV beyond the address any HTTP request reveals.

## Uninstalling

```bash
ssh root@<tv-ip>
/var/lib/tvweb/tvwebctl restore-home
/var/lib/tvweb/tvwebctl restore-keys
/var/lib/tvweb/tvwebctl restore-glasshouse-home
/var/lib/tvweb/tvwebctl stop
rm -rf /var/lib/tvweb /media/developer/temp/glasshouse-install
rm -f /var/lib/webosbrew/init.d/50-tvweb* /var/lib/webosbrew/init.d/20-tvweb-services /var/lib/webosbrew/init.d/20-services.sh
rm -f /var/lib/webosbrew/tvweb-boot.log*
```

`restore-home` puts LG's Home screen back where [Home screen layout](dashboard/home.md#home-screen-layout) changed it, `restore-keys` the remote's keys where [Remote keys](dashboard/apps.md#remote-keys) did, and `restore-glasshouse-home` LG's Home where [Glasshouse Home](dashboard/home.md) replaced it. `stop` also gives LG's Home its place back while the server is stopped. Uninstalling Glasshouse through the Homebrew Channel restores LG Home automatically. Nothing on the TV's read-only rootfs is ever modified. [What the dashboard changes on the TV](TV-CHANGES.md) lists everything else, including the settings that uninstalling leaves as they are.
