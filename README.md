# RF Explorer plugin for SoundBase

Drives an **RF Explorer WSUB1G+** handheld spectrum analyzer (50 kHz – 960 MHz)
over USB, as a live-scan source in SoundBase.

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # the contract, against a fake unit — nothing attached
npm run smoke       # boots main.js as the host does; sweeps a real unit if one is plugged in
```

## What it supports

| | |
|---|---|
| Model | **WSUB1G+ only.** The plugin asks each unit what it is; any other RF Explorer is recognised, logged and left alone. |
| Firmware | Developed and measured on **03.39**. Other versions are not refused, and have not been run. |
| Platform | **macOS on Apple silicon.** That is all the manifest declares, so SoundBase Desktop will not install it elsewhere. |

The model is locked on purpose. The things that had to be measured on a real
unit are the things that differ between models: which DSP modes return valid
data, how much each input stage shifts the level and whether the unit or the
PC corrects for it, and how long a sweep takes. A wrong guess at any of them
gives a trace that looks fine and is not.

## Using it

Plug the unit in and switch it on. It appears in SoundBase's device picker as
*RF Explorer WSUB1G+*; nothing needs configuring.

- The unit's baud rate must be **500 kbps** (its default; *Config menu*).
- The unit's USB bridge is a Silicon Labs CP210x. Recent macOS has the driver
  built in. Where it is missing, install
  [Silicon Labs' VCP driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)
  yourself: the plugin ships no drivers and no vendor software, only its own
  code and the npm packages it runs on.
- While SoundBase has the unit, its own calculator (max-hold, average) is
  switched off, so every sweep is a raw one and SoundBase's trace modes do
  the accumulating. When SoundBase lets go, the unit is put back to 112
  points and to the calculator and input stage it was found with.
- SoundBase's **RBW** field only offers *Auto* for this analyzer. That is
  correct: the unit chooses, and the value it chose is shown as resolved.

To run a working copy in SoundBase Desktop, point `SB_PLUGIN_DIRS` at the
*parent* of this folder and start the app; the `plugin-system` feature flag
must be on for your account. [docs/running-in-soundbase.md](docs/running-in-soundbase.md)
has the detail.

## What to expect from the instrument

| | |
|---|---|
| Range | 50 kHz – 960 MHz, read from the unit |
| Points | 112 – 65 528 |
| RBW | Chosen by the unit from the point spacing; not settable. Reported as the resolved value. |
| Amplitude | 0.5 dB steps — the resolution of the unit's protocol |
| Sweep time | About 2.2 ms per point at spacings of 80 kHz and up, rising to about 5 ms per point below 15 kHz |

**Point count is the one control over both speed and resolution.** For
470–616 MHz: 1024 points is 143 kHz spacing and 2.2 s a sweep; 2048 points is
71 kHz and 4.5 s.

A span too wide for the point count is given more points rather than gaps:
the unit will happily step further than its widest filter, and a carrier
between two points would simply not be seen.

### Controls

- **Input stage** — Direct, Attenuator 30 dB, LNA 25 dB. Levels are referred
  to the antenna connector whichever is chosen: the unit reports the level
  after the stage, and the plugin adds 30 dB back for the attenuator and
  takes 25 dB off for the LNA, as the vendor's own software does. The
  attenuator figure was checked on a real unit; **the LNA figure was not**,
  because a strong local signal overloaded the LNA during the check.
- **DSP mode** — Filter (the default, with image rejection) or Fast, which
  doubles the sweep rate. Fast must use 112 points per sweep: on this
  firmware, at any other count, the unit accepts the mode and streams a flat
  line. So Fast asked for at another point count is not applied — the control
  reads back as Filter. Set Points to 112 first.

## Layout

```
soundbase-plugin.json   identity and the one product
main.js                 shell bootstrap — never edited
adapter.js              the adapter contract: open, applyConfig, startSweep, …
discovery.js            which serial ports are RF Explorers
driver/
  protocol.js           command encoding and the receive framer
  rfe-client.js         one unit on one port
  transport.js          the serial port
  fake-rfe.js           a fake unit, speaking the same bytes
  backend.js            real ports, or the fake (RFE_FAKE=1)
  protocol.md           the protocol as used, and what was measured
```

`RFE_FAKE=1 npm start` runs the plugin against the fake unit, for poking at
with `curl` on a machine with no RF Explorer.

## Not yet done

- **Other RF Explorer models.** Adding one is a model code in
  `driver/protocol.js` and `adapter.js`, a product in the manifest, and a run
  against the real unit to check DSP modes, input-stage offsets and sweep
  timing. [driver/protocol.md](driver/protocol.md) is what that looked like
  for the WSUB1G+.
- **A minimum firmware check.** An older WSUB1G+ firmware is accepted as it
  is, and may not take the large point counts.
- **Windows and Intel macOS.** Nothing here is platform-specific, but the
  plugin has only been run on Apple silicon, so that is all `platforms`
  declares.
- **Overload warnings.** The LNA overloads easily and the plugin does not yet
  say so.

The guide set for the plugin model itself is in [docs/](docs/README.md).
