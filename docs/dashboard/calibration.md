# Calibration archives (C9 preview)

**This preview captures calibration data; it does not yet restore a professional
calibration after a factory reset. Do not reset the TV relying on this archive
alone.** Keep the calibrator's original files and an independent backup.

The Server tab's **Calibration archive** is separate from **Settings backup**.
Settings backups, including daily backups, do not contain picture calibration.
The audio EDID helper is a separate project and has no role in this feature.

## Download and check

**Download calibration archive** reads the TV without changing its picture,
input, calibration mode or OLED protections. It downloads a private JSON file
containing stored calibration-file bytes, checksums, factory white-balance
readings and requested picture-context readings. **Check archive** checks its
file and metadata integrity and compares its TV identity and firmware with the
current TV. It never applies the archive.

The initial capture profile accepts C9 TVs reporting firmware 05.50.00. It is
based on the storage observed on an OLED65C9PUA (webOS 4.10.2); an isolated read-only capture has now been tried on that TV, with 29 stored
files and all 30 requested mode/input contexts confirmed using the described
settings-service identifiers. Dashboard installation and complete
coverage remain unqualified. Other models and firmware are refused.
A readable hardware identity is required. The buttons require dashboard
controls to be allowed and use the existing authentication and origin guards.

Capture runs only on request. It reads the files and calibration readings twice
and refuses a changing snapshot. Do not change picture settings while it reads.
One capture runs at a time, with a 40-second limit. The archive downloads to
the browser; it is not saved on the TV or included in daily settings backups.
Keep it privately off the TV. A TV-only copy can be lost along with the TV's
settings. Do not post calibration archives in public issues.

## Coverage

The archive's coverage is always marked **partial**, with restoration disabled.
It currently includes allowlisted stored files from
`/mnt/lg/cmn_data/external_pqldb` and the Dolby Vision user-display configuration.
It requests cool, medium and warm factory white balance, plus selected SDR
Expert, HDR Cinema/Home and Dolby Vision Cinema/Home settings for apps/default
and HDMI 1–4. Unknown files are listed as skipped and not read.

Each requested context records what the TV actually reports. Version 2 archives use LG settings-service mode names such as `hdrCinema` and
`dolbyHdrCinema`; these differ from the underscore calibration-file names.
Version 1 preview archives can still be checked. The C9 stores adjustments by input, picture mode and `_3dStatus: 2d`; its
picture-mode selector uses input, dynamic range and `_3dStatus` instead. The
archive records the human-readable range/mode context separately from that
native query. A reply must match its native dimensions; an additional returned
dynamic range must agree with the requested range. Otherwise it is not counted
as a confirmed context. A confirmed context does not establish
that every calibration setting was returned. Missing values and absent factory
white-balance replies remain gaps; no input or picture mode is switched to fill
them in. Alternate modes, application-specific settings, enable-state semantics
and unsupported settings may still be missing.

The C9 allowlist also captures available external-PQ selection, white-balance
activation/application and 10/22-point declaration fields. On the tested C9,
nine additional fields were returned, giving 53 fields per requested context.
Capturing a selection flag does not qualify replaying it during restoration.

EEPROM contents are not captured. There is no probing of I2C buses or raw
hardware access. The archive's identity binds it to the mainboard/network
hardware; it cannot establish that the panel has not been replaced. A matching
identity is therefore necessary evidence for a future restore, not proof that
restoration is safe.

File and manifest hashes detect accidental damage, not authenticity. A person
who edits an archive can also replace its hashes. Imported claims such as
`complete: true` cannot enable restoration: coverage is recomputed by the
server, and no calibration-restore endpoint exists.

## Work needed for factory-reset recovery

A supported restore needs a model/firmware-specific implementation and evidence:

1. Establish which stored files, menu settings, flags and EEPROM regions
   determine each calibrated profile, including their input/range association.
   Read-only capture must prove coverage without silently using another mode.
2. Establish whether captured LUT data is the uploaded data or an effective,
   post-processed result. Calibration getters can behave differently between
   models and firmware; an effective readback must not be uploaded as though
   it were the original.
3. Qualify the restore API, reload behavior, ordering, ownership and rollback
   on a test TV. File replacement alone is not evidence that the running
   picture pipeline has adopted the data.
4. Require a matching TV/panel/firmware, a preview of exactly what will change,
   an independent pre-restore archive and TV-local interruption recovery.
   Other panels' calibration and raw whole-EEPROM writes must remain excluded.
5. Verify stored bytes, mode associations, white balance and measured picture
   output after restoration. Do not factory-reset a professionally calibrated
   owner's TV merely to qualify this preview.

The upstream [bscpylgtv calibration documentation](https://github.com/chros73/bscpylgtv#calibration-functionality-in-full-version)
describes model-dependent getters and calibration uploads. It is research for
future qualification, not a runtime dependency or an enabled restore path.

## Offline research-bundle preview

Separate hardware research has preserved a C9's declared 32 KiB physical NVM
space, its mapped 8 MiB eMMC NVM partition and logical picture database
snapshots. These are private research artifacts; the dashboard archive does
not collect them. The physical chip package was not inspected, and neither
raw image is an approved restore payload.

`scripts/calibration-recovery-plan.py` runs on a computer with Python 3. It
checks an explicitly indexed research bundle and a separately supplied target
identity, verifies matching NVM passes and factory white balance, and lists
remaining restore qualifications. It opens local files only. Its output always
has `restoreAllowed: false`, `rawNvmWritesAllowed: false` and an empty action
list; uploaded claims cannot enable a restore.

```sh
python3 scripts/calibration-recovery-plan.py /path/to/private-bundle \
  --target-identity /path/to/independent-target-identity.json
```

The bundle manifest uses format `glasshouse-calibration-research-bundle`,
version 1, a calibration `source` identity and `artifacts` entries with
`role`, relative `path`, byte `size` and `sha256`. Required roles are
`calibration-archive`, `picture-database`, `eeprom-first`, `eeprom-repeat`,
`emmc-nvm-first`, `emmc-nvm-repeat` and `preservation-check`. Supporting
artifacts use `evidence` or `calibration-report`. It accepts C9/05.50.00
research and version 2 calibration archives only. The synthetic host test
contains an example bundle; it contains no real calibration data.

An identity JSON supplied to an offline command cannot prove the identity of
a connected TV or its panel. Artifact checksums detect damage, not forged
evidence. A successful preview is therefore a preservation check, with
restoration still disabled. A qualified implementation additionally needs
TV-local interruption recovery, post-reset access, model-specific reload and
cache handling, and measured reset/restore tests on a lab TV using that TV's
own calibration. OLED protections and raw DB record IDs must be excluded from
any future settings merge. The audio helper remains independent.
