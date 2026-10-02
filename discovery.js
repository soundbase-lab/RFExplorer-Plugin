// USB discovery with a per-port identity cache.
//
// An RF Explorer enumerates as a bare Silicon Labs CP210x bridge, the same
// usb device on paper as countless other gadgets. The only way to know one is
// an RF Explorer, and which model, is to open the port and ask — so that is
// what discovery does, once per port, remembered by path + serial number and
// never on every poll. A port that cannot be opened or does not answer is
// retried with a growing backoff; a port this plugin has a live session on is
// ours by definition and is never reopened.

import { MODEL_NAMES } from './driver/protocol.js';

export const USB_ID_PREFIX = 'usb:';
export const PROBE_RETRY_MIN_MS = 1_000;
export const PROBE_RETRY_MAX_MS = 30_000;

const portKey = (port) => `${port.path}|${port.serialNumber || ''}`;

const defaultLog = (level, message) => {
  process.stderr.write(`[rf-explorer discovery] [${level}] ${message}\n`);
};

/**
 * @param {object} options
 * @param {(mainModel: number) => string|null} options.productFor the manifest
 *   product for a `<Main_Model>` code, or null for a model that is not driven
 * @param {() => Promise<Array<{ path: string, serialNumber?: string }>>} options.listPorts
 * @param {(options: { path: string }) => Promise<{ mainModel: number }>} options.probe
 * @param {(path: string) => boolean} [options.isOpen] whether this plugin holds the port
 * @param {() => number} [options.now]
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {() => Promise<Array>} a discoverDevices implementation
 */
export function createDiscovery({
  productFor,
  listPorts,
  probe,
  isOpen = () => false,
  now = Date.now,
  log = defaultLog,
}) {
  // key -> { device } once identified ({ device: null } for something that
  // answered but is not driven), { retryAt, failures } while unreachable
  const verdicts = new Map();

  return async function discoverDevices() {
    let ports;
    try {
      ports = await listPorts();
    } catch {
      // no serialport binding on this machine
      return [];
    }
    if (!Array.isArray(ports)) return [];

    const present = new Set();
    const found = [];
    for (const port of ports) {
      if (!port?.path) continue;
      const key = portKey(port);
      present.add(key);

      let verdict = verdicts.get(key);
      const due =
        !verdict || (verdict.retryAt !== undefined && verdict.retryAt <= now());
      if (due && !isOpen(port.path)) {
        try {
          const identity = await probe({ path: port.path });
          const product = productFor(identity.mainModel);
          const name = MODEL_NAMES[identity.mainModel];
          verdict = {
            device: product && {
              id: `${USB_ID_PREFIX}${port.path}`,
              name: `RF Explorer ${name} (${port.path})`,
              product,
              transport: { kind: 'usb', path: port.path },
            },
          };
          log(
            'info',
            product
              ? `${port.path} is an RF Explorer ${name}, firmware ${identity.firmware}`
              : `${port.path} is an RF Explorer model ${identity.mainModel}, which this plugin does not drive`
          );
        } catch (error) {
          const failures = (verdict?.failures ?? 0) + 1;
          const delay = Math.min(
            PROBE_RETRY_MAX_MS,
            PROBE_RETRY_MIN_MS * 2 ** (failures - 1)
          );
          verdict = { retryAt: now() + delay, failures };
          log(
            'debug',
            `${port.path} did not identify, retrying in ${delay}ms: ${error?.message || error}`
          );
        }
        verdicts.set(key, verdict);
      }

      if (verdict?.device) found.push({ ...verdict.device });
    }

    // an unplugged port forgets its verdict so a re-plug is probed afresh
    for (const key of verdicts.keys()) {
      if (!present.has(key)) verdicts.delete(key);
    }
    return found;
  };
}
