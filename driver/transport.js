// RF Explorer over its built-in USB-to-UART bridge.

import { BAUD_RATE } from './protocol.js';

// Silicon Labs CP210x. This pair is the bridge chip, not the instrument: any
// number of unrelated devices enumerate identically, so a port matching it is
// only a candidate until it has answered as an RF Explorer (see discovery.js).
export const USB_VENDOR_ID = '10c4';
export const USB_PRODUCT_ID = 'ea60';

// lazy so the tests never load the native binding
async function loadSerialPort() {
  const module = await import('serialport');
  return module.SerialPort;
}

/**
 * The transport shape the client talks to. The fake device implements the
 * same four members.
 *
 * @param {{ path: string }} options
 */
export async function openSerialTransport({ path }) {
  const SerialPort = await loadSerialPort();
  const port = new SerialPort({ path, baudRate: BAUD_RATE, autoOpen: false });

  await new Promise((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()));
  });

  let dataHandler = null;
  let closeHandler = null;
  let settled = false;
  const emitClose = (error) => {
    if (settled) return;
    settled = true;
    closeHandler?.(error);
  };

  port.on('data', (chunk) => dataHandler?.(chunk));
  port.on('error', emitClose);
  port.on('close', () => emitClose());

  return {
    write(buffer) {
      port.write(buffer);
    },
    onData(cb) {
      dataHandler = cb;
    },
    /** called once if the port goes away without close() having been asked for */
    onClose(cb) {
      closeHandler = cb;
    },
    /** resolves once the port is really released, so the next opener can lock it */
    close() {
      settled = true;
      return new Promise((resolve) => {
        if (!port.isOpen) return resolve();
        // let queued commands reach the unit before the port goes away
        port.drain(() => port.close(() => resolve()));
      });
    },
  };
}

/** @param {{ vendorId?: string, productId?: string }} port */
export function isCandidatePort(port) {
  return (
    String(port?.vendorId || '').toLowerCase() === USB_VENDOR_ID &&
    String(port?.productId || '').toLowerCase() === USB_PRODUCT_ID
  );
}

/** USB serial ports that could be an RF Explorer. */
export async function listSerialCandidates() {
  const SerialPort = await loadSerialPort();
  const ports = await SerialPort.list();
  return ports.filter((port) => port?.path && isCandidatePort(port));
}
