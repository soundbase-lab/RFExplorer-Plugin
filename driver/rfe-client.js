// One RF Explorer on one transport: identify it, configure it, receive sweeps.
//
// The unit sweeps continuously on its own and streams every sweep; there is no
// "give me one sweep" command. So this client never asks for data — it changes
// what the unit is sweeping, waits for the unit to echo the configuration it
// settled on, and hands on the sweeps that follow.

import {
  CALCULATOR_NORMAL,
  DSP_MODES,
  INPUT_STAGES,
  INPUT_STAGE_OFFSET_DB,
  commands,
  createParser,
  parseConfigLine,
  parseModelLine,
} from './protocol.js';

// below this the unit is in its legacy 112-point mode and will not go lower
export const MIN_POINT_COUNT = 112;
// the unit takes up to 65535; the cap is SoundBase's, the most one sweep frame
// can carry to a shared scan
export const MAX_POINT_COUNT = 65_528;
export const DEFAULT_POINT_COUNT = 1024;
export const MIN_SPAN_HZ = 112_000;

const IDENTIFY_TIMEOUT_MS = 3000;
// the unit answers in about a quarter of a second; discovery is on a one-second
// cadence and a port that is something else entirely should not stall it
const PROBE_TIMEOUT_MS = 1200;
const REPLY_TIMEOUT_MS = 1500;

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const nameOf = (table, value) =>
  Object.keys(table).find((key) => table[key] === value);

// Milliseconds the unit spends per point in DSP filter mode, by the RBW it
// chose, measured on a WSUB1G+ (firmware 03.39). Narrow filters settle slower.
const MS_PER_POINT_BY_RBW_KHZ = [
  [10, 4.85],
  [15, 4.68],
  [32, 4.14],
  [48, 3.2],
  [95, 2.18],
];
const LEGACY_MS_PER_POINT = 2.63;

function msPerPoint(rbwKhz) {
  const table = MS_PER_POINT_BY_RBW_KHZ;
  if (rbwKhz <= table[0][0]) return 5;
  for (let i = 1; i < table.length; i += 1) {
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    if (rbwKhz <= x1) return y0 + ((rbwKhz - x0) * (y1 - y0)) / (x1 - x0);
  }
  return table[table.length - 1][1];
}

/**
 * How long one sweep takes, in ms. An estimate from measurement, not a
 * guarantee; it errs a little long.
 *
 * @param {{ pointCount: number, stepHz: number, rbwHz: number, dsp: string }} config
 */
export function estimateSweepMs({ pointCount, stepHz, rbwHz, dsp }) {
  const rbw = rbwHz || stepHz;
  let ms;
  if (pointCount <= MIN_POINT_COUNT) {
    // in the legacy mode the unit steps at its RBW and keeps the peak, so a
    // point wider than the filter costs several dwells
    ms = pointCount * LEGACY_MS_PER_POINT * Math.max(1, stepHz / rbw);
  } else {
    ms = pointCount * msPerPoint(rbw / 1000);
  }
  if (dsp === 'fast') ms /= 2;
  return Math.round(ms * 1.05);
}

export class RfExplorerClient {
  /**
   * @param {object} options
   * @param {string} options.path shown in error messages
   * @param {(options: { path: string }) => Promise<object>} options.openTransport
   */
  constructor({ path, openTransport, identifyTimeoutMs = IDENTIFY_TIMEOUT_MS }) {
    this.path = path;
    this.openTransport = openTransport;
    this.identifyTimeoutMs = identifyTimeoutMs;
    this.transport = null;
    this.parser = createParser((message) => this._onMessage(message));
    this.waiters = new Set();
    this.identity = null;
    /** the unit's last configuration echo */
    this.config = null;
    this.initial = null;
    /** the range last sent, as `start-stop` in kHz; null when the unit's differs */
    this.rangeKhz = null;
    this.inputStage = 'direct';
    this.dsp = 'filter';
    /** what configure() last settled on; null until then */
    this.effective = null;
    this.configuring = false;
    this.closing = false;
    this.onSweep = null;
    /** assigned by the owner; called when the transport dies unprompted */
    this.onFatal = null;
    this.queue = Promise.resolve();
  }

  /**
   * Open the port and ask the unit what it is.
   *
   * @returns {Promise<{ mainModel: number, firmware: string, serialNumber: string|null }>}
   */
  async identify() {
    this.transport = await this.openTransport({ path: this.path });
    this.transport.onData((chunk) => this.parser.push(chunk));
    this.transport.onClose((error) => this._onTransportClosed(error));

    const model = this._waitFor(parseModelLine, this.identifyTimeoutMs);
    const config = this._waitFor(parseConfigLine, this.identifyTimeoutMs);
    this.transport.write(commands.requestConfig());
    try {
      const [identity] = await Promise.all([model, config]);
      this.identity = { ...this.identity, ...identity };
    } catch {
      throw new Error(
        `No RF Explorer answered on ${this.path}. Check that it is switched ` +
          'on and that its baud rate (Config menu) is 500 kbps.'
      );
    }
    this.initial = {
      calculator: this.config.calculator,
      inputStage: this.inputStage,
    };
    return this.identity;
  }

  /**
   * Put the unit in the state sweeps are taken in. The calculator is the
   * unit's own max-hold/average; left on, every "sweep" it sends is already an
   * accumulation, and the shell's trace modes would be accumulating those.
   */
  async prepare() {
    if (this.config.calculator !== CALCULATOR_NORMAL) {
      this.transport.write(commands.setCalculator(CALCULATOR_NORMAL));
    }
    // the unit does not say which DSP mode it is in until one is set
    this.transport.write(commands.setDsp(DSP_MODES.filter));
    this.dsp = 'filter';
  }

  get limits() {
    return {
      minFrequencyHz: this.config.minFrequencyHz,
      maxFrequencyHz: this.config.maxFrequencyHz,
    };
  }

  /**
   * Change what the unit sweeps and report what it settled on.
   *
   * @param {{ startHz: number, stopHz: number, pointCount: number, dsp: string, inputStage: string }} request
   */
  configure(request) {
    const run = () => this._configure(request);
    // one at a time: each step waits on an echo from the unit
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async _configure(request) {
    this._assertOpen();
    this.configuring = true;
    try {
      const { minFrequencyHz, maxFrequencyHz } = this.limits;
      // the unit takes frequencies in whole kHz
      const startKhz = Math.round(
        clamp(request.startHz, minFrequencyHz, maxFrequencyHz - MIN_SPAN_HZ) /
          1000
      );
      const stopKhz = Math.round(
        clamp(
          request.stopHz,
          startKhz * 1000 + MIN_SPAN_HZ,
          maxFrequencyHz
        ) / 1000
      );
      const spanHz = (stopKhz - startKhz) * 1000;

      // Point count first: changing it resets the unit's range to the one
      // stored in it, and tells us the widest span it will sweep at that
      // count without leaving gaps between points.
      let points = clamp(
        Math.round(request.pointCount),
        MIN_POINT_COUNT,
        MAX_POINT_COUNT
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (points !== this.config.pointCount) {
          await this._command(commands.setSweepPoints(points), parseConfigLine);
          this.rangeKhz = null;
        }
        points = this.config.pointCount;
        if (spanHz <= this.config.maxSpanHz) break;
        // more points rather than less span: the range is what was asked for
        points = Math.min(
          MAX_POINT_COUNT,
          Math.ceil((points * spanHz) / this.config.maxSpanHz) + 1
        );
      }

      // DSP fast is only real in the 112-point legacy mode. Above it the unit
      // accepts the mode and then streams a flat line, so it is not offered.
      const dsp =
        request.dsp === 'fast' && points <= MIN_POINT_COUNT ? 'fast' : 'filter';
      if (dsp !== this.dsp) {
        await this._command(commands.setDsp(DSP_MODES[dsp]), (line) =>
          line.startsWith('DSP:') ? line : undefined
        );
        this.dsp = dsp;
      }

      const inputStage =
        request.inputStage in INPUT_STAGES ? request.inputStage : 'direct';
      if (inputStage !== this.inputStage) {
        // answered with `#a<n>` and then a configuration echo; waiting for
        // both keeps that echo from being taken for the range's below
        let acknowledged = false;
        await this._command(
          commands.setInputStage(INPUT_STAGES[inputStage]),
          (line) => {
            if (/^#a\d/.test(line)) acknowledged = true;
            return acknowledged ? parseConfigLine(line) : undefined;
          }
        );
      }

      // Range last, so the echo that ends the sequence describes everything.
      // A range the unit already has is not sent: it answers that with
      // silence, and the echo in hand already describes it.
      const range = `${startKhz}-${stopKhz}`;
      if (range !== this.rangeKhz) {
        await this._command(commands.setRange(startKhz, stopKhz), (line) => {
          const echo = parseConfigLine(line);
          return echo?.startHz === startKhz * 1000 ? echo : undefined;
        });
        this.rangeKhz = range;
      }

      const echo = this.config;
      const lastHz = echo.startHz + echo.stepHz * (echo.pointCount - 1);
      // the echoed step is truncated to whole Hz, so the last point computed
      // from it can fall short of the stop that was actually applied
      const stopHz =
        Math.abs(stopKhz * 1000 - lastHz) <= Math.max(echo.pointCount, 1000)
          ? stopKhz * 1000
          : lastHz;

      this.effective = {
        startHz: echo.startHz,
        stopHz,
        pointCount: echo.pointCount,
        rbwHz: echo.rbwHz,
        dsp: this.dsp,
        inputStage: this.inputStage,
        offsetDb: echo.offsetDb + INPUT_STAGE_OFFSET_DB[this.inputStage],
      };
      this.effective.sweepTimeMs = estimateSweepMs({
        ...this.effective,
        stepHz: echo.stepHz,
      });
      return this.effective;
    } finally {
      this.configuring = false;
    }
  }

  /** @param {(amplitudesDbm: number[]) => void} onSweep */
  startSweep(onSweep) {
    this.onSweep = onSweep;
  }

  stopSweep() {
    this.onSweep = null;
  }

  /** Hand the unit back as it was found, then release the port. Never throws. */
  async close() {
    if (this.closing) return;
    this.closing = true;
    this.onSweep = null;
    for (const waiter of this.waiters) waiter.reject(new Error('closed'));
    const transport = this.transport;
    this.transport = null;
    if (!transport) return;
    try {
      if (this.initial) {
        // 112 points is what the unit's own screen and keypad expect, and
        // setting it also returns the range to the one stored in the unit
        transport.write(commands.setSweepPoints(MIN_POINT_COUNT));
        transport.write(commands.setDsp(DSP_MODES.auto));
        transport.write(
          commands.setInputStage(INPUT_STAGES[this.initial.inputStage])
        );
        if (this.initial.calculator != null) {
          transport.write(commands.setCalculator(this.initial.calculator));
        }
      }
    } catch {
      // already gone
    }
    try {
      await transport.close();
    } catch {
      // already gone
    }
  }

  _assertOpen() {
    if (!this.transport || !this.config) {
      throw new Error(`RF Explorer on ${this.path} is not open`);
    }
  }

  /**
   * Send a command and wait for the line that acknowledges it. The unit does
   * not always echo a configuration it considers unchanged, so a silent
   * command is followed by an explicit request for the configuration.
   */
  async _command(frame, match) {
    this.transport.write(frame);
    try {
      return await this._waitFor(match, REPLY_TIMEOUT_MS);
    } catch (error) {
      if (this.closing || !this.transport) throw error;
    }
    this.transport.write(commands.requestConfig());
    try {
      return await this._waitFor(parseConfigLine, REPLY_TIMEOUT_MS);
    } catch {
      throw new Error(
        `RF Explorer on ${this.path} stopped answering. Check that it is still switched on.`
      );
    }
  }

  _waitFor(match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (value) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          reject(error);
        },
      };
      const timer = setTimeout(
        () => waiter.reject(new Error('timed out')),
        timeoutMs
      );
      this.waiters.add(waiter);
    });
  }

  _onMessage(message) {
    if (message.type === 'sweep') {
      const effective = this.effective;
      if (this.configuring || !effective || !this.onSweep) return;
      // a frame of any other length belongs to a configuration that has
      // since been replaced
      if (message.amplitudes.length !== effective.pointCount) return;
      const { offsetDb } = effective;
      this.onSweep(
        offsetDb
          ? message.amplitudes.map((dbm) => dbm + offsetDb)
          : message.amplitudes
      );
      return;
    }
    if (message.type !== 'line') return;

    const { text } = message;
    const config = parseConfigLine(text);
    if (config) this.config = config;
    const stage = /^#a(\d)/.exec(text);
    if (stage) {
      this.inputStage = nameOf(INPUT_STAGES, Number(stage[1])) ?? 'direct';
    }
    const serial = /^#Sn(\w+)/.exec(text);
    if (serial) {
      this.identity = { ...this.identity, serialNumber: serial[1] };
    }

    for (const waiter of [...this.waiters]) {
      const value = waiter.match(text);
      if (value != null) waiter.resolve(value);
    }
  }

  _onTransportClosed(error) {
    if (this.closing) return;
    this.transport = null;
    for (const waiter of this.waiters) {
      waiter.reject(new Error('transport closed'));
    }
    this.onFatal?.(
      new Error(
        `Serial port ${this.path} is no longer present` +
          (error?.message ? ` (${error.message})` : '')
      )
    );
  }
}

/**
 * Open a port, ask what is on it, close it. Resolves the identity, or rejects
 * when the port cannot be opened or nothing answers as an RF Explorer.
 *
 * @param {{ path: string, openTransport: Function }} options
 */
export async function probeIdentity({ path, openTransport }) {
  const client = new RfExplorerClient({
    path,
    openTransport,
    identifyTimeoutMs: PROBE_TIMEOUT_MS,
  });
  // nothing was changed on the unit, so there is nothing to hand back
  const release = async () => {
    client.initial = null;
    await client.close();
  };
  try {
    const identity = await client.identify();
    return { ...identity };
  } finally {
    await release();
  }
}
