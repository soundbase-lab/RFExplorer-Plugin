// Contract tests for the adapter, driven through the real shell over real HTTP
// against the fake RF Explorer in driver/fake-rfe.js. Nothing here needs a unit
// attached: the fake speaks the unit's bytes at the transport boundary, so the
// parser, the client and the adapter are all under test.
//
// Nothing hardcodes the plugin's id: everything `npm run rename` could change
// is read from soundbase-plugin.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';
import { PRODUCT } from '../adapter.js';
import { setBackend } from '../driver/backend.js';
import { FAKE_CARRIERS, createFakeRfExplorer } from '../driver/fake-rfe.js';

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const PORT = 'fake-port-a';
const SILENT_PORT = 'fake-port-silent';
const OTHER_MODEL_PORT = 'fake-port-other-model';
const DEVICE_ID = `usb:${PORT}`;
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
const START_HZ = 470_000_000;
const STOP_HZ = 616_000_000;
const POINT_COUNT = 1024;

// every unit a port open has produced, newest last; a fresh one per open, as
// re-plugging a real unit would give
const units = [];
// every path a port open was asked for
const opened = [];
const unit = () => units.at(-1);
setBackend({
  listPorts: async () => [
    { path: PORT, serialNumber: 'A' },
    { path: SILENT_PORT, serialNumber: 'B' },
    { path: OTHER_MODEL_PORT, serialNumber: 'C' },
  ],
  openTransport: async ({ path }) => {
    opened.push(path);
    const fake = createFakeRfExplorer({
      silent: path === SILENT_PORT,
      // 3 is the original WSUB1G, which the driver has not been run against
      model: path === OTHER_MODEL_PORT ? 3 : 10,
    });
    if (path === PORT) units.push(fake);
    return fake.transport;
  },
});

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const configure = (body) =>
  request('POST', `${DEVICE_PATH}/configuration`, body);
const listed = async () => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === DEVICE_ID);
};
const binOf = (hz, { startHz, stopHz, pointCount }) =>
  Math.round(((hz - startHz) / (stopHz - startHz)) * (pointCount - 1));
// a trace taken after `since`, so it cannot predate a configuration change
const nextTrace = async () => {
  const before = await request('GET', `${DEVICE_PATH}/trace`);
  const since = before.status === 200 ? before.body.sweepId : 0;
  return request('GET', `${DEVICE_PATH}/trace?sinceSweepId=${since}`);
};

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is one
// warning line in the plugin log. Catch it here instead.
test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('discovery lists the unit that answers, and only that one', async () => {
  const first = await request('GET', '/devices');
  assert.equal(first.status, 200);
  const device = first.body.devices.find((d) => d.id === DEVICE_ID);
  assert.ok(device, JSON.stringify(first.body.devices));
  assert.equal(device.product, PRODUCT);
  assert.equal(device.discovered, true);
  assert.deepEqual(device.transport, { kind: 'usb', path: PORT });
  // a bridge chip with nothing answering behind it, and an RF Explorer model
  // the driver has not been run against, are both normal and both absent
  assert.deepEqual(
    first.body.devices.map((d) => d.id),
    [DEVICE_ID]
  );

  // identifying a unit asks it one question and changes nothing on it
  assert.deepEqual(units[0].state.received, ['C0']);
  assert.equal(units[0].state.calculator, 4);

  // the verdict is remembered: a second listing does not reopen the port
  const second = await request('GET', '/devices');
  assert.equal(second.body.devices[0].id, DEVICE_ID);
  assert.equal(units.length, 1);
});

// A *discovered* device is not opened until something asks it to do work — an
// idle plugin must not hold a serial port open. So `capabilities` is null in
// the first /devices listing and appears after the first operation on it.
test('open() reports what this unit can do and takes it out of max-hold', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ });

  const device = await listed();
  const caps = device.capabilities;
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.equal(caps.minFrequencyHz, 50_000);
  assert.equal(caps.maxFrequencyHz, 960_000_000);
  // RBW follows the point spacing on this instrument; there is nothing to offer
  assert.equal(caps.rbwHz, undefined);
  assert.equal(caps.minPointCount, 112);
  assert.equal(caps.maxPointCount, 65_528);
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['inputStage', 'dsp']
  );
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);

  // the unit arrives with its own max-hold on; raw sweeps need it off
  assert.equal(unit().state.calculator, 0);
});

test('config, start and trace put a carrier at the frequency it is on', async (t) => {
  const applied = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  assert.equal(applied.body.stopHz, STOP_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);
  // RBW is the unit's choice: reported as what auto resolved to, not as a setting
  assert.equal(applied.body.rbwHz, undefined);
  assert.ok(applied.body.resolved.rbwHz > 0);
  assert.ok(applied.body.resolved.sweepTimeMs > 0);

  const read = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.equal(read.body.pointCount, POINT_COUNT);
  assert.deepEqual(read.body.controls, applied.body.controls);

  const started = await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(started.status, 200);
  assert.equal(started.body.sweeping, true);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const trace = await nextTrace();
  assert.equal(trace.status, 200);
  assert.equal(trace.body.pointCount, POINT_COUNT);
  assert.equal(trace.body.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.body.startHz, START_HZ);
  assert.equal(trace.body.stopHz, STOP_HZ);
  assert.equal(trace.body.unit, 'dBm');

  // trace geometry: the strongest point is the fake's 518.1 MHz carrier, in
  // the bin that frequency falls in. Off by one here shifts every frequency
  // on the plot and still looks fine.
  const amps = trace.body.amplitudesDbm;
  const carrier = FAKE_CARRIERS[1];
  const peak = amps.indexOf(Math.max(...amps));
  assert.ok(
    Math.abs(peak - binOf(carrier.hz, trace.body)) <= 1,
    `carrier at bin ${peak}, expected ${binOf(carrier.hz, trace.body)}`
  );
  assert.equal(amps[peak], carrier.dbm);
  const floor = [...amps].sort((a, b) => a - b)[Math.floor(amps.length / 2)];
  assert.ok(floor < -95, `noise floor at ${floor}`);
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const caps = (await listed()).capabilities;

  const wide = await configure({
    startHz: 0,
    stopHz: caps.maxFrequencyHz * 10,
    pointCount: 451,
  });
  assert.equal(wide.status, 200, 'a request outside the range is still a 200');
  assert.equal(wide.body.startHz, caps.minFrequencyHz);
  assert.equal(wide.body.stopHz, caps.maxFrequencyHz);
  // 451 points cannot cover 960 MHz without gaps between them, so the unit
  // gets more points rather than less span or a trace with holes in it
  assert.ok(wide.body.pointCount > 451, `${wide.body.pointCount} points`);
  assert.ok(
    wide.body.stepHz <= 700_000,
    `points are ${wide.body.stepHz} Hz apart`
  );

  const few = await configure({
    startHz: START_HZ,
    stopHz: START_HZ + 20_000_000,
    pointCount: 2,
  });
  assert.equal(few.status, 200);
  assert.equal(few.body.pointCount, 112, 'the unit never sweeps fewer');

  const many = await configure({ pointCount: 1_000_000 });
  assert.equal(many.status, 200);
  assert.equal(many.body.pointCount, 65_528);

  // the unit takes whole kHz
  const fractional = await configure({
    startHz: 470_000_400,
    stopHz: 480_000_600,
    pointCount: 200,
  });
  assert.equal(fractional.body.startHz, 470_000_000);
  assert.equal(fractional.body.stopHz, 480_001_000);
});

test('a partial configuration leaves everything it does not name alone', async () => {
  await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 800,
    controls: { inputStage: 'attenuator' },
  });
  const retuned = await configure({ startHz: 500_000_000, stopHz: 550_000_000 });
  assert.equal(retuned.body.startHz, 500_000_000);
  assert.equal(retuned.body.stopHz, 550_000_000);
  assert.equal(retuned.body.pointCount, 800);
  assert.equal(retuned.body.controls.inputStage, 'attenuator');

  // a spacing is honoured when no point count comes with it
  const spaced = await configure({ stepHz: 100_000 });
  assert.equal(spaced.body.pointCount, 501);
});

test('controls merge by id and echo what the unit settled on', async () => {
  const first = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    controls: { inputStage: 'lna', dsp: 'filter' },
  });
  assert.deepEqual(first.body.controls, { inputStage: 'lna', dsp: 'filter' });
  assert.equal(unit().state.inputStage, 2);

  // DSP fast is only real at 112 points; asked for above that, filter is what
  // the unit is put in and what comes back
  const fastAtManyPoints = await configure({ controls: { dsp: 'fast' } });
  assert.equal(fastAtManyPoints.status, 200);
  assert.equal(fastAtManyPoints.body.controls.dsp, 'filter');
  assert.equal(
    fastAtManyPoints.body.controls.inputStage,
    'lna',
    'the untouched control survived'
  );
  assert.equal(unit().state.dsp, 1);

  const fast = await configure({ pointCount: 112, controls: { dsp: 'fast' } });
  assert.equal(fast.body.controls.dsp, 'fast');
  assert.equal(unit().state.dsp, 2);
  const filtered = await configure({ controls: { dsp: 'filter' } });
  assert.ok(
    fast.body.resolved.sweepTimeMs < filtered.body.resolved.sweepTimeMs,
    'fast is reported as the quicker sweep'
  );

  // a value the unit has no setting for changes nothing
  const unknown = await configure({ controls: { inputStage: 'preamp-9000' } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.controls.inputStage, 'lna');
});

test('levels are referred to the connector whatever the input stage', async (t) => {
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  const carrier = FAKE_CARRIERS[1];

  // the unit reports the level after the stage: 30 dB low through the
  // attenuator, 25 dB high through the LNA. The trace must not move.
  for (const inputStage of ['direct', 'attenuator', 'lna']) {
    await configure({
      startHz: START_HZ,
      stopHz: STOP_HZ,
      pointCount: POINT_COUNT,
      controls: { inputStage },
    });
    const trace = await nextTrace();
    assert.equal(
      Math.max(...trace.body.amplitudesDbm),
      carrier.dbm,
      `through ${inputStage}`
    );
  }
});

test('successive polls see successive sweeps of the current configuration', async (t) => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, pointCount: 300 });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));

  const first = await nextTrace();
  const startedAt = Date.now();
  const second = await request('GET', `${DEVICE_PATH}/trace`);
  const elapsed = Date.now() - startedAt;
  assert.ok(second.body.sweepId > first.body.sweepId);
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);

  // retune mid-stream: the sweep the unit abandons never becomes a trace, and
  // every trace after the change has the new geometry
  await configure({ startHz: 180_000_000, stopHz: 220_000_000, pointCount: 500 });
  const retuned = await nextTrace();
  assert.equal(retuned.body.amplitudesDbm.length, 500);
  assert.equal(retuned.body.startHz, 180_000_000);
  const amps = retuned.body.amplitudesDbm;
  const peak = amps.indexOf(Math.max(...amps));
  assert.ok(Math.abs(peak - binOf(FAKE_CARRIERS[0].hz, retuned.body)) <= 1);
});

test('a unit added by hand is addressed by the serial port in its configuration', async (t) => {
  // the id is the host's to choose here; the address travels in the project
  const id = 'rack-b-analyzer';
  const path = `/devices/${id}`;
  const added = await request('POST', '/devices', {
    id,
    product: PRODUCT,
    config: { serialPath: 'fake-port-manual' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  t.after(() => request('DELETE', path));

  const applied = await request('POST', `${path}/configuration`, {
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 300,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.pointCount, 300);
  assert.deepEqual(opened.at(-1), 'fake-port-manual');
});

test('removing the device hands the unit back as it was found', async () => {
  const held = unit();
  const removed = await request('DELETE', DEVICE_PATH);
  assert.equal(removed.status, 204);
  assert.equal(held.state.points, 112, "the unit's own screen expects 112");
  assert.equal(held.state.calculator, 4, 'its max-hold is back on');
  assert.equal(held.state.inputStage, 0);
  assert.equal(held.state.dsp, 0);
});

test('a unit unplugged mid-sweep is failed, not healthy, and reopens', async () => {
  // discovery finds it again after the removal above
  assert.ok(await listed());
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, pointCount: 300 });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  await nextTrace();
  const opens = units.length;

  unit().unplug();

  const deadline = Date.now() + 5_000;
  let status = null;
  while (Date.now() < deadline) {
    status = (await listed())?.status;
    if (status?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status?.status, 'failed');
  assert.match(status.message, /no longer present/);

  // plugged back in: the next operation opens it again
  const again = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: 300,
  });
  assert.equal(again.status, 200);
  assert.equal(units.length, opens + 1);
  assert.equal((await listed()).status.status, 'ok');
});
