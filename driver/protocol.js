// RF Explorer UART protocol: command encoding and the receive-side framer.
//
// Pure functions and one stateful parser, no I/O. The wire format is the
// vendor's "UART API interface specification"; everything here was checked
// against a WSUB1G+ on firmware 03.39. driver/protocol.md is the short version.

export const BAUD_RATE = 500_000;

// `<Main_Model>` codes this driver has been run against. Other RF Explorer
// models speak the same protocol but differ in range, input stages and which
// DSP modes work, so they are not driven until someone has checked them.
export const MODEL_NAMES = {
  10: 'WSUB1G+',
};

export const DSP_MODES = { auto: 0, filter: 1, fast: 2 };
export const INPUT_STAGES = { direct: 0, attenuator: 1, lna: 2 };
// what the PC has to add back to a sample for each input stage: the unit
// reports the level after the stage, not at the connector
export const INPUT_STAGE_OFFSET_DB = { direct: 0, attenuator: 30, lna: -25 };
export const CALCULATOR_NORMAL = 0;

// sent by the unit when it abandons a sweep mid-transmission, which it does
// whenever a command changes what it is sweeping
const EEOT = Buffer.from([0xff, 0xfe, 0xff, 0xfe, 0x00]);
const CRLF = Buffer.from('\r\n');
// a 65535-point sweep is the largest frame; anything past this is noise
const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * `#<Size><body>`, where Size is one binary byte counting the whole message.
 *
 * @param {string|Buffer} body e.g. 'C0', or a Buffer when it carries binary
 */
export function encodeCommand(body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
  return Buffer.concat([Buffer.from([0x23, payload.length + 2]), payload]);
}

const digits = (value, width) =>
  String(Math.max(0, Math.round(value))).padStart(width, '0');

export const commands = {
  requestConfig: () => encodeCommand('C0'),
  /** frequencies in kHz; the amplitude pair only scales the unit's own LCD */
  setRange: (startKhz, stopKhz) =>
    encodeCommand(
      `C2-F:${digits(startKhz, 7)},${digits(stopKhz, 7)},-010,-120`
    ),
  /** any count 112..65535, not just the multiples of 16 `CJ` is limited to */
  setSweepPoints: (points) =>
    encodeCommand(
      Buffer.from([0x43, 0x6a, (points >> 8) & 0xff, points & 0xff])
    ),
  setCalculator: (mode) => encodeCommand(Buffer.from([0x43, 0x2b, mode])),
  setDsp: (mode) => encodeCommand(`Cp${mode}`),
  setInputStage: (stage) => encodeCommand(`a${stage}`),
};

/**
 * `#C2-F:` (or `#C2-f:`, the same line with a five-digit point count).
 *
 * @param {string} line
 * @returns {object|null} null when the line is not a complete analyzer config
 */
export function parseConfigLine(line) {
  if (!/^#C2-[Ff]:/.test(line)) return null;
  const fields = line.slice(6).split(',').map(Number);
  if (fields.length < 10 || fields.slice(0, 10).some(Number.isNaN)) return null;
  const [
    startKhz,
    stepHz,
    ,
    ,
    points,
    expansionActive,
    mode,
    minKhz,
    maxKhz,
    maxSpanKhz,
    rbwKhz,
    offsetDb,
    calculator,
  ] = fields;
  return {
    startHz: startKhz * 1000,
    stepHz,
    pointCount: points,
    expansionActive: expansionActive === 1,
    mode,
    minFrequencyHz: minKhz * 1000,
    maxFrequencyHz: maxKhz * 1000,
    maxSpanHz: maxSpanKhz * 1000,
    rbwHz: Number.isFinite(rbwKhz) ? rbwKhz * 1000 : null,
    offsetDb: Number.isFinite(offsetDb) ? offsetDb : 0,
    calculator: Number.isFinite(calculator) ? calculator : null,
  };
}

/** `#C2-M:<main>,<expansion>,<firmware>` */
export function parseModelLine(line) {
  const match = /^#C2-M:(\d+),(\d+),(.+)$/.exec(line);
  if (!match) return null;
  return {
    mainModel: Number(match[1]),
    expansionModel: Number(match[2]),
    firmware: match[3].trim(),
  };
}

/** the samples of one sweep frame, in dBm before any offset */
function decodeSweep(bytes) {
  const amplitudes = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) amplitudes[i] = bytes[i] / -2;
  return amplitudes;
}

/**
 * Splits the byte stream into messages.
 *
 * The stream interleaves CRLF-terminated text lines with length-prefixed
 * binary sweep frames (`$S`, `$s`, `$z`), and a sweep can be cut short by an
 * EEOT marker when a command interrupts it. `onMessage` receives
 * `{ type: 'sweep', amplitudes }`, `{ type: 'aborted' }` for a sweep the unit
 * abandoned, or `{ type: 'line', text }`.
 *
 * @param {(message: object) => void} onMessage
 */
export function createParser(onMessage) {
  let buffer = Buffer.alloc(0);

  const sweepHeader = () => {
    if (buffer[0] !== 0x24) return null;
    const kind = String.fromCharCode(buffer[1]);
    if (kind === 'S') return { header: 3, length: buffer[2] };
    if (kind === 's')
      return { header: 3, length: (buffer[2] === 0 ? 256 : buffer[2]) * 16 };
    if (kind === 'z')
      return { header: 4, length: buffer[2] * 256 + (buffer[3] ?? 0) };
    return null;
  };

  const drain = () => {
    for (;;) {
      if (buffer.length < 4) return;
      const sweep = sweepHeader();
      if (sweep) {
        const end = sweep.header + sweep.length;
        const complete = buffer.length >= end + 2;
        if (complete && buffer[end] === 0x0d && buffer[end + 1] === 0x0a) {
          onMessage({
            type: 'sweep',
            amplitudes: decodeSweep(buffer.subarray(sweep.header, end)),
          });
          buffer = buffer.subarray(end + 2);
          continue;
        }
        // short, or long enough but not terminated where the header said:
        // either way the unit may have abandoned it
        const eeot = buffer.indexOf(EEOT);
        if (eeot >= 0) {
          onMessage({ type: 'aborted' });
          buffer = buffer.subarray(eeot + EEOT.length);
          continue;
        }
        if (!complete) return;
        // not a sweep after all; step past the '$' and resynchronise
        buffer = buffer.subarray(1);
        continue;
      }
      const eol = buffer.indexOf(CRLF);
      if (eol < 0) return;
      if (eol > 0) {
        onMessage({
          type: 'line',
          text: buffer.subarray(0, eol).toString('latin1'),
        });
      }
      buffer = buffer.subarray(eol + 2);
    }
  };

  return {
    push(chunk) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      drain();
      if (buffer.length > MAX_BUFFER_BYTES) buffer = Buffer.alloc(0);
    },
  };
}
