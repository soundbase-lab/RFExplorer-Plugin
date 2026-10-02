// Where the serial ports come from: the real ones, or a fake unit.
//
// `RFE_FAKE=1 npm start` runs the plugin against driver/fake-rfe.js, so it can
// be poked at with curl on a machine with no RF Explorer attached. Tests swap
// the backend directly to hold on to the fake they are talking to.

import { createFakeRfExplorer } from './fake-rfe.js';
import { listSerialCandidates, openSerialTransport } from './transport.js';

const FAKE_PATH = 'fake-rf-explorer';

const serialBackend = {
  listPorts: listSerialCandidates,
  openTransport: openSerialTransport,
};

const fakeBackend = {
  listPorts: async () => [{ path: FAKE_PATH, serialNumber: 'FAKE' }],
  // a realistic sweep time, so what is seen by hand resembles the real unit
  openTransport: async () => createFakeRfExplorer({ msPerPoint: 2 }).transport,
};

const defaultBackend = () =>
  process.env.RFE_FAKE === '1' ? fakeBackend : serialBackend;

let backend = defaultBackend();

export const getBackend = () => backend;

/** test seam: pass nothing to restore the default */
export function setBackend(next) {
  backend = next ?? defaultBackend();
}
