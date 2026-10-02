// A fake RF Explorer WSUB1G+, at the transport boundary.
//
// It speaks the same bytes as the real unit — the `#<size>` command frames in,
// text lines and binary sweep frames out — so the parser, the client and the
// adapter all run against it with nothing attached. Its quirks are the real
// unit's, as observed on firmware 03.39:
//
//   - it sweeps continuously from the moment it is asked for its config
//   - a command that changes the sweep abandons the one in flight with an
//     EEOT marker, then echoes the new configuration
//   - changing the point count resets the frequency range to the one stored
//     in the unit, so the range has to be sent after it
//   - a range it is already sweeping is answered with silence, not an echo
//   - RBW is not settable: it follows the point spacing
//   - samples are what the detector saw after the input stage; the attenuator
//     and LNA are compensated on the PC, not in the unit
//
// `RFE_FAKE=1 npm start` runs the whole plugin against one of these.

const MIN_KHZ = 50;
const MAX_KHZ = 960_000;
const MIN_POINTS = 112;
const MAX_POINTS = 65_535;
const STORED_START_KHZ = 431_500;
const STORED_SPAN_KHZ = 11_000;
const INPUT_STAGE_GAIN_DB = [0, -30, 25];
const NOISE_FLOOR_DBM = -105;
// carriers at fixed frequencies, so a test can check where one lands in a trace
export const FAKE_CARRIERS = [
  { hz: 200_000_000, dbm: -60 },
  { hz: 518_100_000, dbm: -45 },
  { hz: 542_350_000, dbm: -62 },
];
const EEOT = Buffer.from([0xff, 0xfe, 0xff, 0xfe, 0x00]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (value, width) => String(Math.round(value)).padStart(width, '0');

/**
 * @param {object} [options]
 * @param {number} [options.msPerPoint] sweep time per point; the real unit
 *   takes 1–5 ms, the default here is fast enough for a test suite
 * @param {boolean} [options.silent] never answer, like a unit that is switched
 *   off behind a bridge chip that is still powered by USB
 * @param {number} [options.model] the `<Main_Model>` code to identify as
 */
export function createFakeRfExplorer({
  msPerPoint = 0.01,
  silent = false,
  model = 10,
} = {}) {
  const state = {
    startKhz: STORED_START_KHZ,
    stopKhz: STORED_START_KHZ + STORED_SPAN_KHZ,
    points: MIN_POINTS,
    dsp: 0,
    inputStage: 0,
    // the unit keeps whatever calculator was last chosen on its keypad
    calculator: 4,
    // quiet until first spoken to, so a test sees a deterministic stream
    holding: true,
    /** every command body received, for assertions */
    received: [],
  };

  let dataHandler = null;
  let closeHandler = null;
  let open = true;
  let timer = null;
  let pending = Buffer.alloc(0);

  const emit = (buffer) => {
    if (!open || silent) return;
    // delivered on a later tick, as a serial port would
    setImmediate(() => open && dataHandler?.(buffer));
  };
  const emitLine = (text) =>
    emit(Buffer.concat([Buffer.from(text, 'latin1'), Buffer.from('\r\n')]));

  const stepHz = () =>
    Math.floor(((state.stopKhz - state.startKhz) * 1000) / (state.points - 1));
  const rbwKhz = () => clamp(Math.round((stepHz() * 1.2) / 1000), 3, 600);
  const maxSpanKhz = () =>
    state.points <= MIN_POINTS
      ? 959_950
      : Math.min(959_440, Math.round(state.points * 669.33));

  const configLine = () => {
    const long = state.points > 9999;
    return [
      `#C2-${long ? 'f' : 'F'}:${pad(state.startKhz, 7)}`,
      pad(stepHz(), 7),
      '-010',
      '-120',
      pad(state.points, long ? 5 : 4),
      '0',
      '000',
      pad(MIN_KHZ, 7),
      pad(MAX_KHZ, 7),
      pad(maxSpanKhz(), 7),
      pad(rbwKhz(), 5),
      '0000',
      pad(state.calculator, 3),
    ].join(',');
  };

  const sample = (index) => {
    const hz = state.startKhz * 1000 + index * stepHz();
    let dbm = NOISE_FLOOR_DBM + Math.random() * 4;
    const width = Math.max(stepHz(), rbwKhz() * 1000);
    for (const carrier of FAKE_CARRIERS) {
      if (Math.abs(hz - carrier.hz) <= width / 2) dbm = carrier.dbm;
    }
    dbm += INPUT_STAGE_GAIN_DB[state.inputStage];
    return clamp(Math.round(-dbm * 2), 0, 255);
  };

  const sweepFrame = () => {
    const n = state.points;
    let header;
    if (n === MIN_POINTS) header = Buffer.from([0x24, 0x53, n]);
    else if (n % 16 === 0 && n <= 4096)
      header = Buffer.from([0x24, 0x73, (n / 16) & 0xff]);
    else header = Buffer.from([0x24, 0x7a, n >> 8, n & 0xff]);
    const data = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) data[i] = sample(i);
    return Buffer.concat([header, data, Buffer.from('\r\n')]);
  };

  const stopTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    stopTimer();
    if (state.holding || !open) return;
    timer = setTimeout(
      () => {
        emit(sweepFrame());
        schedule();
      },
      Math.max(2, state.points * msPerPoint)
    );
    timer.unref?.();
  };

  /** the sweep in flight is cut short: half a frame, then the marker */
  const abandonSweep = () => {
    if (state.holding) return;
    const frame = sweepFrame();
    emit(
      Buffer.concat([frame.subarray(0, Math.floor(frame.length / 2)), EEOT])
    );
  };

  const reconfigure = (change) => {
    abandonSweep();
    change();
    state.holding = false;
    emitLine(configLine());
    schedule();
  };

  const handle = (body) => {
    state.received.push(body.toString('latin1'));
    const text = body.toString('latin1');
    if (text === 'C0') {
      abandonSweep();
      state.holding = false;
      emitLine('RF Explorer 03.39 21-Jun-22 05.01.08');
      emitLine('#SnFAKE0000000000001');
      emitLine(`#C2-M:${pad(model, 3)},255,03.39`);
      emitLine(configLine());
      emitLine(`#a${state.inputStage}`);
      schedule();
    } else if (text.startsWith('Cj') && body.length === 4) {
      reconfigure(() => {
        state.points = clamp(body[2] * 256 + body[3], MIN_POINTS, MAX_POINTS);
        state.startKhz = STORED_START_KHZ;
        state.stopKhz = STORED_START_KHZ + STORED_SPAN_KHZ;
      });
    } else if (text.startsWith('C2-F:')) {
      const [start, stop] = text.slice(5).split(',').map(Number);
      const startKhz = clamp(start, MIN_KHZ, MAX_KHZ - MIN_POINTS);
      const stopKhz = clamp(stop, startKhz + MIN_POINTS, MAX_KHZ);
      // a range it already has gets no echo at all
      if (startKhz === state.startKhz && stopKhz === state.stopKhz) return;
      reconfigure(() => {
        state.startKhz = startKhz;
        state.stopKhz = stopKhz;
      });
    } else if (text.startsWith('C+') && body.length === 3) {
      state.calculator = body[2];
      emit(
        Buffer.concat([
          Buffer.from('#C+'),
          body.subarray(2),
          Buffer.from('\r\n'),
        ])
      );
    } else if (text.startsWith('Cp')) {
      state.dsp = clamp(Number(text[2]), 0, 2);
      emitLine(`DSP:${state.dsp}`);
    } else if (/^a\d$/.test(text)) {
      abandonSweep();
      state.inputStage = clamp(Number(text[1]), 0, 2);
      emitLine(`#a${state.inputStage}`);
      emitLine(configLine());
      schedule();
    }
  };

  const transport = {
    write(buffer) {
      if (!open) return;
      pending = Buffer.concat([pending, buffer]);
      while (pending.length >= 2 && pending[0] === 0x23) {
        const size = pending[1];
        if (pending.length < size) return;
        handle(pending.subarray(2, size));
        pending = pending.subarray(size);
      }
    },
    onData(cb) {
      dataHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    async close() {
      open = false;
      stopTimer();
    },
  };

  return {
    transport,
    state,
    /** the cable comes out: the transport dies without close() being asked for */
    unplug() {
      if (!open) return;
      open = false;
      stopTimer();
      closeHandler?.(new Error('fake RF Explorer unplugged'));
    },
  };
}
