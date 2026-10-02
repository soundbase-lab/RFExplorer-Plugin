# RF Explorer UART protocol, as this driver uses it

The vendor's specification is the
[UART API interface specification](https://github.com/RFExplorer/RFExplorer-for-.NET/wiki/RF-Explorer-UART-API-interface-specification);
the vendor's [Python](https://github.com/RFExplorer/RFExplorer-for-Python) and
.NET libraries are the practical reference for what it leaves out. Everything
below marked *measured* was observed on a WSUB1G+ (model code 10), firmware
03.39, at 500 kbps. Other models will differ.

## Shape

- 500 000 baud, 8N1, over the unit's CP210x USB bridge. (2400 baud is the only
  other rate the vendor calls reliable; it cannot carry a high-resolution sweep.)
- PC → unit: `#<size><body>`, `size` one binary byte counting the whole message.
- Unit → PC: CRLF-terminated text lines, interleaved with length-prefixed
  binary sweep frames.
- **The unit sweeps continuously and streams every sweep.** There is no
  request/response sweep command; you change what it sweeps and listen.

## Commands used

| Body | Meaning | Reply |
|---|---|---|
| `C0` | request configuration | banner, `#Sn…`, `#C2-M:…`, `#C2-F:…`, `#a<n>` |
| `Cj<hi><lo>` | sweep points, 112–65535, any value | `#C2-F:` echo |
| `C2-F:<start>,<stop>,<top>,<bottom>` | range in kHz, 7 digits each | `#C2-F:` echo |
| `C+<byte>` | calculator: 0 normal, 4 max-hold | `#C+<byte>` |
| `Cp<digit>` | DSP: 0 auto, 1 filter, 2 fast | `DSP:<digit>` |
| `a<digit>` | input stage: 0 direct, 1 attenuator 30 dB, 2 LNA 25 dB | `#a<digit>`, then `#C2-F:` echo |

`CJ<byte>` also sets points but only in multiples of 16 up to 4096; `Cj`
supersedes it.

## Messages parsed

- `#C2-M:<main>,<expansion>,<firmware>` — model 10 is the WSUB1G+.
- `#C2-F:<startKHz>,<stepHz>,<top>,<bottom>,<points>,<exp>,<mode>,<minKHz>,<maxKHz>,<maxSpanKHz>,<rbwKHz>,<offsetDb>,<calculator>`
  — `#C2-f:` is the same line with a five-digit point count.
- `$S<n>…`, `$s<n/16>…`, `$z<hi><lo>…` + CRLF — one sweep. Each sample is one
  unsigned byte; dBm = −byte / 2. **Half a dB is the resolution of the
  protocol**, and nothing the PC does can improve on it.
- `FF FE FF FE 00` (EEOT) — the sweep in flight has been abandoned. Sent
  whenever a command changes the sweep.

## What the specification does not say (*measured*)

- **Changing the point count resets the range** to the one stored in the
  unit. Points first, then range.
- **A range the unit already has is answered with silence**, not an echo.
- **RBW cannot be set.** It follows the point spacing, a little wider than one
  step, from about 2 kHz to 600 kHz.
- **`maxSpanKHz` depends on the point count** (about 669 kHz per point above
  112 points). The unit accepts a wider span anyway and then steps further
  than its RBW, leaving gaps between points. The driver raises the point count
  instead.
- At exactly 112 points the unit sub-steps at its RBW and keeps the peak, so
  any span is gap-free there — and costs proportionally more time per point.
- **DSP fast only works at 112 points.** Above that the unit accepts the mode
  and streams a flat line near −70 dBm, at twice the speed.
- The calculator is whatever was last chosen on the keypad. This unit was
  found in max-hold, which makes every sweep it sends an accumulation.
- Samples are the level *after* the input stage. With the attenuator in, a
  signal reads about 30 dB low and the PC adds it back; the vendor library
  does the same, and subtracts 25 dB for the LNA.
- Turning the LCD off (`L0`) does not change the sweep rate.
- `CH` (hold) stops the stream, but configuration commands sent while held
  are applied silently or resume the stream without an echo. The driver never
  holds; it ignores sweeps nobody asked for.

## Sweep time (*measured*, DSP filter)

Time is per point, and depends on the RBW the unit chose, not on the span:

| RBW | ms per point |
|---|---|
| ≥ 95 kHz | 2.2 |
| 48 kHz | 3.2 |
| 32 kHz | 4.1 |
| ≤ 15 kHz | 4.7–4.9 |

So 470–616 MHz takes 2.2 s at 1024 points (143 kHz steps), 4.5 s at 2048
(71 kHz) and 13 s at 4096 (36 kHz). DSP fast halves these, at 112 points only.
The serial link is not the limit: a 4096-point frame is 82 ms on the wire.
