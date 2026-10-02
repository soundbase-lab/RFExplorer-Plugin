// The framer and the command encoder, against bytes captured from a WSUB1G+.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commands,
  createParser,
  parseConfigLine,
  parseModelLine,
} from '../driver/protocol.js';

const EEOT = Buffer.from([0xff, 0xfe, 0xff, 0xfe, 0x00]);
const line = (text) => Buffer.from(`${text}\r\n`, 'latin1');
const collect = () => {
  const messages = [];
  return { messages, parser: createParser((m) => messages.push(m)) };
};

test('commands carry their own length in the second byte', () => {
  assert.equal(commands.requestConfig().toString('hex'), '23044330');
  assert.equal(commands.setSweepPoints(1000).toString('hex'), '2306436a03e8');
  assert.equal(commands.setCalculator(0).toString('hex'), '2305432b00');
  assert.equal(
    commands.setRange(470_000, 616_000).toString('latin1'),
    '# C2-F:0470000,0616000,-010,-120'
  );
});

test('a configuration echo is read field by field', () => {
  const config = parseConfigLine(
    '#C2-F:0470000,0142717,-010,-120,1024,0,000,0000050,0960000,0685410,00170,0000,004'
  );
  assert.deepEqual(config, {
    startHz: 470_000_000,
    stepHz: 142_717,
    pointCount: 1024,
    expansionActive: false,
    mode: 0,
    minFrequencyHz: 50_000,
    maxFrequencyHz: 960_000_000,
    maxSpanHz: 685_410_000,
    rbwHz: 170_000,
    offsetDb: 0,
    calculator: 4,
  });
  assert.equal(parseConfigLine('#C2-M:010,255,03.39'), null);
});

test('five-digit point counts arrive on the lowercase variant', () => {
  const config = parseConfigLine(
    '#C2-f:0431500,0000167,-010,-120,65535,0,000,0000050,0960000,0959440,00002,0000,000'
  );
  assert.equal(config.pointCount, 65_535);
  assert.equal(config.rbwHz, 2_000);
});

test('the model line gives the model code and firmware', () => {
  assert.deepEqual(parseModelLine('#C2-M:010,255,03.39'), {
    mainModel: 10,
    expansionModel: 255,
    firmware: '03.39',
  });
});

test('all three sweep frame kinds decode to dBm', () => {
  const { messages, parser } = collect();
  const legacy = Buffer.alloc(112, 200);
  const ext = Buffer.alloc(32, 100);
  const large = Buffer.alloc(300, 17);
  parser.push(
    Buffer.concat([
      Buffer.from([0x24, 0x53, 112]),
      legacy,
      line(''),
      Buffer.from([0x24, 0x73, 2]),
      ext,
      line(''),
      Buffer.from([0x24, 0x7a, 0x01, 0x2c]),
      large,
      line(''),
    ])
  );
  assert.deepEqual(
    messages.map((m) => [m.type, m.amplitudes.length, m.amplitudes[0]]),
    [
      ['sweep', 112, -100],
      ['sweep', 32, -50],
      ['sweep', 300, -8.5],
    ]
  );
});

test('a frame split across chunks, with CRLF bytes inside it, is one sweep', () => {
  const { messages, parser } = collect();
  const data = Buffer.alloc(112, 180);
  // 0x0d 0x0a as sample values: -6.5 and -5 dBm, legal and not a terminator
  data[40] = 0x0d;
  data[41] = 0x0a;
  const frame = Buffer.concat([Buffer.from([0x24, 0x53, 112]), data, line('')]);
  for (let i = 0; i < frame.length; i += 7) parser.push(frame.subarray(i, i + 7));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].amplitudes.length, 112);
  assert.equal(messages[0].amplitudes[40], -6.5);
});

test('an abandoned sweep is dropped and the line after it survives', () => {
  const { messages, parser } = collect();
  const echo =
    '#C2-F:0470000,0142717,-010,-120,1024,0,000,0000050,0960000,0685410,00170,0000,000';
  for (const partial of [3, 74, 600]) {
    parser.push(
      Buffer.concat([
        Buffer.from([0x24, 0x7a, 0x04, 0x00]),
        Buffer.alloc(partial, 190),
        EEOT,
        line(echo),
      ])
    );
  }
  assert.deepEqual(
    messages.map((m) => m.type),
    ['aborted', 'line', 'aborted', 'line', 'aborted', 'line']
  );
  assert.equal(messages[1].text, echo);
});

test('a sweep abandoned after more bytes than a short frame is long is still dropped', () => {
  // the case a length check alone gets wrong: the abandoned sweep plus the
  // echo that follows it are together longer than the frame was going to be
  const { messages, parser } = collect();
  parser.push(
    Buffer.concat([
      Buffer.from([0x24, 0x53, 112]),
      Buffer.alloc(100, 190),
      EEOT,
      line('#C2-M:010,255,03.39'),
      line('#a0'),
    ])
  );
  assert.deepEqual(
    messages.map((m) => m.type),
    ['aborted', 'line', 'line']
  );
});
