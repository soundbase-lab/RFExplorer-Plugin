// RF Explorer spectrum-analyzer adapter: bridges the shell's adapter contract
// to the client in driver/. Everything RF Explorer-specific lives here, in
// discovery.js and in driver/.

import { USB_ID_PREFIX, createDiscovery } from './discovery.js';
import { getBackend } from './driver/backend.js';
import { MODEL_NAMES } from './driver/protocol.js';
import {
  DEFAULT_POINT_COUNT,
  MAX_POINT_COUNT,
  MIN_POINT_COUNT,
  RfExplorerClient,
  probeIdentity,
} from './driver/rfe-client.js';

// The product this adapter announces its devices as. It MUST be one of the
// `deviceTypeId`s declared in soundbase-plugin.json — the shell warns and the
// host ignores a device naming a product the manifest never declared.
// `npm run rename` keeps them in step; a test asserts they agree.
export const PRODUCT = 'plugin:rf-explorer-wsub1g-plus/wsub1g-plus';

// `<Main_Model>` 10 is the WSUB1G+, the one model the driver has been run on
const productFor = (mainModel) => (mainModel === 10 ? PRODUCT : null);

const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;

const INPUT_STAGES = ['direct', 'attenuator', 'lna'];
const DSP_MODES = ['filter', 'fast'];
const DEFAULT_CONTROLS = { inputStage: 'direct', dsp: 'filter' };

// Knobs SoundBase has never heard of; it renders them beside the point count
// and hands the values back in cfg.controls, keyed by these ids.
const CONTROL_FIELDS = [
  {
    id: 'inputStage',
    type: 'dropdown',
    label: 'Input stage',
    default: DEFAULT_CONTROLS.inputStage,
    choices: [
      { id: 'direct', label: 'Direct' },
      { id: 'attenuator', label: 'Attenuator 30 dB' },
      { id: 'lna', label: 'LNA 25 dB' },
    ],
    help: 'Attenuator near strong transmitters; LNA for weak signals only.',
  },
  {
    id: 'dsp',
    type: 'dropdown',
    label: 'DSP mode',
    default: DEFAULT_CONTROLS.dsp,
    choices: [
      { id: 'filter', label: 'Filter' },
      { id: 'fast', label: 'Fast' },
    ],
    help: 'Fast must use 112 points per sweep. Set Points to 112.',
  },
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * `device.config.serialPath` when the project carries one, else the path
 * encoded in a discovered device's id (`usb:<path>`).
 */
function resolveSerialPath(device) {
  const config = device?.config ?? {};
  if (typeof config.serialPath === 'string' && config.serialPath) {
    return config.serialPath;
  }
  const id = typeof device?.id === 'string' ? device.id : '';
  if (id.startsWith(USB_ID_PREFIX)) return id.slice(USB_ID_PREFIX.length);
  throw new Error(
    `device ${device?.id} has no serial port: set "serialPath" in its configuration`
  );
}

// ports held by open sessions; discovery never probes these
const openPaths = new Set();

class RfExplorerAdapter {
  constructor(device) {
    this.device = device;
    this.client = null;
    this.path = null;
    this.effective = null;
    /** assigned by the shell; called when the transport dies unprompted */
    this.onFatal = null;
  }

  async open() {
    const path = resolveSerialPath(this.device);
    const client = new RfExplorerClient({
      path,
      openTransport: (options) => getBackend().openTransport(options),
    });
    client.onFatal = (error) => this.onFatal?.(error);
    // reserved before the port is touched, so a discovery poll cannot probe it
    openPaths.add(path);
    this.path = path;
    this.client = client;
    try {
      const identity = await client.identify();
      const model = MODEL_NAMES[identity.mainModel];
      if (!model) {
        throw new Error(
          `${path} is an RF Explorer model ${identity.mainModel}, which this plugin does not drive`
        );
      }
      await client.prepare();
      return {
        capabilities: {
          // read from the unit: the range is what this one reports, not what
          // the product line can do. RBW is absent on purpose — the unit
          // couples it to the point spacing and offers no way to set it.
          ...client.limits,
          minPointCount: MIN_POINT_COUNT,
          maxPointCount: MAX_POINT_COUNT,
          controls: CONTROL_FIELDS,
        },
        identity: {
          manufacturer: 'RF Explorer',
          model,
          firmware: identity.firmware,
          serialNumber: identity.serialNumber ?? null,
        },
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /**
   * `cfg` is a patch: anything absent stays as it was. The return value is
   * what the unit settled on, which is not always what was asked for —
   * frequencies are whole kHz, there are never fewer than 112 points, and a
   * span too wide for the point count gets more points rather than gaps.
   */
  async applyConfig(cfg = {}) {
    const previous = this.effective ?? {
      startHz: DEFAULT_START_HZ,
      stopHz: DEFAULT_STOP_HZ,
      pointCount: DEFAULT_POINT_COUNT,
      controls: DEFAULT_CONTROLS,
    };
    const startHz = isNum(cfg.startHz) ? cfg.startHz : previous.startHz;
    const stopHz = isNum(cfg.stopHz) ? cfg.stopHz : previous.stopHz;

    let pointCount = previous.pointCount;
    if (isNum(cfg.pointCount)) pointCount = cfg.pointCount;
    else if (isNum(cfg.stepHz) && cfg.stepHz > 0)
      pointCount = Math.round(Math.max(0, stopHz - startHz) / cfg.stepHz) + 1;

    // merged by id; a value the unit has no such setting for changes nothing
    const controls = { ...previous.controls };
    const requested = cfg.controls ?? {};
    if (INPUT_STAGES.includes(requested.inputStage))
      controls.inputStage = requested.inputStage;
    if (DSP_MODES.includes(requested.dsp)) controls.dsp = requested.dsp;

    const applied = await this.client.configure({
      startHz,
      stopHz,
      pointCount,
      ...controls,
    });

    this.effective = {
      startHz: applied.startHz,
      stopHz: applied.stopHz,
      pointCount: applied.pointCount,
      controls: { inputStage: applied.inputStage, dsp: applied.dsp },
    };
    return {
      ...this.effective,
      controls: { ...this.effective.controls },
      // RBW is always the unit's choice, so it is reported as what "auto"
      // resolved to rather than echoed as a setting
      resolved: { rbwHz: applied.rbwHz, sweepTimeMs: applied.sweepTimeMs },
    };
  }

  async startSweep(onTrace) {
    // the unit sweeps continuously whether asked to or not; starting is
    // nothing more than listening
    this.client.startSweep(onTrace);
  }

  async stopSweep() {
    this.client?.stopSweep();
  }

  async close() {
    const { client, path } = this;
    this.client = null;
    this.effective = null;
    // the path stays reserved until the port is really released, so discovery
    // cannot probe a handle the client still holds
    try {
      await client?.close();
    } finally {
      if (path) openPaths.delete(path);
    }
  }
}

export function createSpectrumAnalyzerAdapter(device) {
  return new RfExplorerAdapter(device);
}

const discover = createDiscovery({
  productFor,
  listPorts: () => getBackend().listPorts(),
  probe: ({ path }) =>
    probeIdentity({
      path,
      openTransport: (options) => getBackend().openTransport(options),
    }),
  isOpen: (path) => openPaths.has(path),
});

export function discoverDevices() {
  return discover();
}
