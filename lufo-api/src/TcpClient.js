// @flow
import * as net from 'net';
import _ from 'lodash';
import Ufo from './Ufo';
import type { UfoOptions } from './UfoOptions';

/** One of the possible built-in function names. */
export type BuiltinFunction =
  'sevenColorCrossFade' |
  'redGradualChange' |
  'greenGradualChange' |
  'blueGradualChange' |
  'yellowGradualChange' |
  'cyanGradualChange' |
  'purpleGradualChange' |
  'whiteGradualChange' |
  'redGreenCrossFade' |
  'redBlueCrossFade' |
  'greenBlueCrossFade' |
  'sevenColorStrobeFlash' |
  'redStrobeFlash' |
  'greenStrobeFlash' |
  'blueStrobeFlash' |
  'yellowStrobeFlash' |
  'cyanStrobeFlash' |
  'purpleStrobeFlash' |
  'whiteStrobeFlash' |
  'sevenColorJumpingChange' |
  'noFunction' |
  'postReset';
/** One of the possible custom function modes. */
export type CustomMode = 'gradual' | 'jumping' | 'strobe';
/**
 * A custom function step definition.
 * @typedef {Object} CustomStep
 * @property {number} red The red value, 0-255 inclusive.
 * @property {number} green The red value, 0-255 inclusive.
 * @property {number} blue The red value, 0-255 inclusive.
 */
export type CustomStep = {
  red: number,
  green: number,
  blue: number
};
/**
 * An object representing the UFO's output status.
 * @typedef {Object} UfoStatus
 * @property {Buffer} raw The raw byte stream containing the status data.
 * @property {boolean} on true if the UFO is on, false if the UFO is off.
 * @property {string} mode one of "static", "custom", "other" or
 * "function:{@link BuiltinFunction}"
 * @property {number} [speed] defined only if mode is "custom" or
 * "function:{@link BuiltinFunction}". If "custom" this value ranges 0-30,
 * inclusive, otherwise it ranges 0-100 inclusive.
 * @property {number} red The red output strength, 0-255 inclusive.
 * @property {number} green The green output strength, 0-255 inclusive.
 * @property {number} blue The blue output strength, 0-255 inclusive.
 * @property {number} white The white output strength, 0-255 inclusive.
 */
export type UfoStatus = {
  raw: Buffer,
  on: boolean,
  mode: string,
  speed?: number,
  red: number,
  green: number,
  blue: number,
  white: number,
}

/* Private types. */
type TcpOptions = {
  localPort: number,
  localAddress: string,
  remotePort: number,
  remoteAddress: string,
  immediate: boolean,
  cache: boolean,
};

/* Private variables. */
const defaultPort = 5577;
const statusHeader = 0x81;
// Do not pass this value to _prepareBytes().
const statusRequest = Buffer.from([statusHeader, 0x8A, 0x8B, 0x96]);
const statusResponseSize = 14;
const emptyBuffer = Buffer.from([]);
// Do not pass this value to _prepareBytes().
const powerOn = Buffer.from([0x71, 0x23, 0x0F, 0xA3]);
// Do not pass this value to _prepareBytes().
const powerOff = Buffer.from([0x71, 0x24, 0x0F, 0xA4]);
const builtinFunctionMap: Map<BuiltinFunction, number> = new Map([
  ['sevenColorCrossFade', 0x25],
  ['redGradualChange', 0x26],
  ['greenGradualChange', 0x27],
  ['blueGradualChange', 0x28],
  ['yellowGradualChange', 0x29],
  ['cyanGradualChange', 0x2A],
  ['purpleGradualChange', 0x2B],
  ['whiteGradualChange', 0x2C],
  ['redGreenCrossFade', 0x2D],
  ['redBlueCrossFade', 0x2E],
  ['greenBlueCrossFade', 0x2F],
  ['sevenColorStrobeFlash', 0x30],
  ['redStrobeFlash', 0x31],
  ['greenStrobeFlash', 0x32],
  ['blueStrobeFlash', 0x33],
  ['yellowStrobeFlash', 0x34],
  ['cyanStrobeFlash', 0x35],
  ['purpleStrobeFlash', 0x36],
  ['whiteStrobeFlash', 0x37],
  ['sevenColorJumpingChange', 0x38],
  ['noFunction', 0x61],
  ['postReset', 0x63],
]);
const builtinFunctionReservedNames: Array<BuiltinFunction> = [
  'noFunction',
  'postReset',
];
const maxBuiltinSpeed = 100;
const maxCustomSteps = 16;
const nullStep: CustomStep = { red: 1, green: 2, blue: 3 };
const maxCustomSpeed = 30;

/* Private functions. */
/**
 * Clamps the input to 0-255 inclusive, for use as an RGBW value.
 * @private
 */
const _clampRGBW = function (value: number): number {
  return _.clamp(value, 0, 255);
};
/**
 * Given a buffer of data destined for the TCP socket, expands the buffer by 2
 * and inserts the last two bytes (the "local" flag 0x0f and the checksum). A
 * new buffer is returned; the input buffer is not modified.
 * @private
 */
const _prepareBytes = function (buf: Buffer): Buffer {
  const newBuf = Buffer.alloc(buf.length + 2);
  buf.copy(newBuf);
  // Add the "local" flag to the given buffer.
  //
  // For virtually all datagrams sent to UFOs, the second-to-last byte is either
  // 0f (local) or (f0) remote. "Remote" refers to UFOs that are exposed to the
  // Internet via the company's cloud service, which is not supported by this
  // library, so we always use "local".
  newBuf.writeUInt8(0x0f, newBuf.length - 2);
  // Zero out the checksum field for safety.
  const lastIndex = newBuf.length - 1;
  newBuf.writeUInt8(0, lastIndex);
  // Sum up all the values in the buffer, then divide by 256.
  // The checksum is the remainder.
  let checksum = 0;
  Array.from(newBuf.values()).forEach((value) => { checksum += value; });
  checksum %= 0x100;
  newBuf.writeUInt8(checksum, lastIndex);
  // Done.
  return newBuf;
};
/**
 * Converts a built-in function speed value back and forth between the API
 * value and the internal value. Input and output are clamped to 0-100
 * inclusive.
 * @private
 */
const _builtinFlipSpeed = function (speed: number): number {
  return Math.abs(_.clamp(speed, 0, maxBuiltinSpeed) - maxBuiltinSpeed);
};
/**
 * Converts a custom function speed value back and forth between the API value
 * and the internal value. Input and output are clamped to 0-30 inclusive.
 * @private
 */
const _customFlipSpeed = function (speed: number): number {
  return Math.abs(_.clamp(speed, 0, maxCustomSpeed) - maxCustomSpeed);
};

/**
 * Indicates whether or not the given object is equivalent to a null custom step.
 * @private
 */
const _isNullStep = function (step: CustomStep) {
  return step != null &&
    step.red != null && step.red === nullStep.red &&
    step.green != null && step.green === nullStep.green &&
    step.blue != null && step.blue === nullStep.blue;
};

/**
 * Provides an API to UFOs for interacting with the UFO's TCP server.
 * @private
 */
export class TcpClient {
  _ufo: Ufo;
  _options: TcpOptions;
  _dead: boolean;
  _connectFailed: boolean;
  _disconnectCallback: ?Function;
  _statusArray: Uint8Array;
  _statusIndex: number;
  _statusCache: ?UfoStatus;
  _socket: net.Socket;
  _error: ?Error;
  _statusCallback: ?(?Error, ?UfoStatus) => void
  constructor(ufo: Ufo, options: UfoOptions) {
    this._ufo = ufo;
    this._options = {
      localPort: options.localTcpPort || -1,
      localAddress: options.localHost || '',
      remotePort: options.remoteTcpPort || defaultPort,
      remoteAddress: options.host,
      immediate: options.immediate !== undefined ? options.immediate : true,
      cache: options.cache !== undefined ? options.cache : true,
    };
    this._createSocket();
  }
  /**
   * Reacts to the "close" event on the TCP socket inside this client.
   * - If the UFO FIN'ed first due to inactivity, silently reconnect.
   * - If the UFO FIN'ed first due to an error, fire the disconnect callback
   * with the error.
   * - Otherwise, fire the disconnect callback with no error.
   * @private
   */
  _closeSocket(): void {
    // If we're closing the socket due to initial connection failure, there's
    // nothing to do, so no-op.
    if (this._connectFailed) return;
    // Assume the UFO closed on its own.
    // Otherwise, the socket closed intentionally and no error has occurred.
    let reconnect = !this._dead;
    let err = null;
    if (reconnect) {
      // The UFO closed on its own.
      // If it closed due to an error, do not reconnect.
      err = this._error;
      if (err) reconnect = false;
    }
    // Tear down the socket.
    this._socket.unref();
    this._socket.destroy();
    // Reconnect if necessary, or fire the disconnect callback.
    if (reconnect) {
      this._createSocket();
      this.connect();
    } else {
      // Mark this client as dead and notify the UFO object.
      this._dead = true;
      this._ufo._onTcpDead({
        error: this._error,
        callback: this._disconnectCallback,
      });
    }
  }
  /**
   * Creates/initializes the TCP socket inside this client. Also initializes/
   * resets other variables needed to manage connection status.
   * @private
   */
  _createSocket(): void {
    // UFOs will close TCP connections after a cetain time of not receiving any
    // data. TCP keepalives from Node don't seem to help.
    // This flag is used by the "close" event handler to re-establish a
    // connection that was unknowingly closed by the UFO.
    //
    // Once this flag becomes true, this object is unusable and all public
    // methods resort to no-op.
    this._dead = false;
    // This flag tells the close handler that the initial socket connect failed,
    // so the close handler should no-op because it has nothing to do.
    this._connectFailed = false;
    // This property contains the reject callback for the currently active
    // Promise. If an error occurs, this callback is passed up to the enclosing
    // UFO object so it can eventually be invoked after the UFO object is fully
    // disconnected.
    this._disconnectCallback = null;
    // Storage/tracking for the status response.
    this._statusArray = new Uint8Array(statusResponseSize);
    this._statusIndex = 0;
    this._statusCache = null;
    // The TCP socket used to communicate with the UFO.
    this._socket = new net.Socket();
    this._socket.setNoDelay(this._options.immediate);
    // Capture errors so we can respond appropriately.
    this._error = null;
    // Both sides have FIN'ed. No more communication is allowed on this socket.
    this._socket.on('close', () => { this._closeSocket(); });
    // Any TCP data received from the UFO is a status update.
    this._socket.on('data', (data: Buffer) => { this._receiveStatus(data); });
    // Initially, ignore all received data.
    this._socket.pause();
  }
  /**
   * Handles TCP data received as a result of calling the "status" command.
   * @private
   */
  _receiveStatus(data: Buffer): void {
    if (!this._error) {
      // Add the data to what we already have.
      const oldIndex = this._statusIndex;
      let newIndex = oldIndex + data.length;
      this._statusArray.set(data, oldIndex);
      if (newIndex >= statusResponseSize) {
        // We have the full response. Capture it and reset the storage buffer.
        const responseBytes = Buffer.from(this._statusArray);
        this._statusArray.fill(0);
        // Reset the status response index.
        newIndex = 0;
        // Prepare callback variables.
        let err = null;
        const result: UfoStatus = {
          raw: emptyBuffer,
          on: false,
          mode: '',
          red: 0,
          green: 0,
          blue: 0,
          white: 0,
        };
        // The response format is:
        // 0x81 ???a POWER MODE ???b SPEED RED GREEN BLUE WHITE [UNUSED] CHECKSUM
        //
        // ???a is unknown. It always seems to be 0x04.
        // ???b is unknown; it always seems to be 0x21.
        // [UNUSED] is a 3-byte big-endian field whose purpose is unknown. It always seems to be "0x03 0x00 0x00".
        //
        // Verify the response's integrity.
        if (responseBytes.readUInt8(0) === statusHeader) {
          // Add raw bytes to the response.
          result.raw = responseBytes;
          // Compute the actual checksum.
          const lastIndex = statusResponseSize - 1;
          const expectedChecksum = responseBytes.readUInt8(lastIndex);
          responseBytes.writeUInt8(0, lastIndex);
          let actualChecksum = 0;
          Array.from(responseBytes.values()).forEach((value) => {
            actualChecksum += value;
          });
          actualChecksum %= 0x100;
          // Compare.
          responseBytes.writeUInt8(expectedChecksum, lastIndex);
          if (expectedChecksum !== actualChecksum) {
            err = new Error('Status check failed (checksum mismatch).');
          }
        } else {
          err = new Error('Status check failed (header mismatch).');
        }
        // ON_OFF is always either 0x23 or 0x24.
        if (!err) {
          const power = responseBytes.readUInt8(2);
          switch (power) {
            case 0x23:
              result.on = true;
              break;
            case 0x24:
              result.on = false;
              break;
            default:
              err = new Error(`Status check failed (impossible power value ${power}).`);
          }
        }
        // MODE:
        // - 0x62 is music, disco or camera mode (called "other").
        // - 0x61 is static color.
        // - 0x60 is custom steps.
        // - Otherwise, the value maps to a function ID.
        if (!err) {
          const mode = responseBytes.readUInt8(3);
          switch (mode) {
            case 0x62: {
              result.mode = 'other';
              break;
            }
            case 0x61: {
              result.mode = 'static';
              break;
            }
            case 0x60: {
              result.mode = 'custom';
              break;
            }
            default: {
              let name: ?string = null;
              builtinFunctionMap.forEach((v, k) => {
                if (name === null && v === mode) name = k;
              });
              if (name) {
                result.mode = `function:${name}`;
              } else {
                err = new Error(`Status check failed (impossible mode ${mode}).`);
              }
              break;
            }
          }
        }
        // SPEED is evaluated based on MODE, and it does not apply to all modes.
        if (!err) {
          const speed = responseBytes.readUInt8(5);
          if (result.mode === 'custom') {
            // The UFO seems to store/report the speed as 1 higher than what it
            // really is.
            result.speed = _customFlipSpeed(speed - 1);
          }
          if (result.mode.startsWith('function')) {
            result.speed = _builtinFlipSpeed(speed);
          }
        }
        // Capture RGBW values as-is.
        if (!err) {
          result.red = responseBytes.readUInt8(6);
          result.green = responseBytes.readUInt8(7);
          result.blue = responseBytes.readUInt8(8);
          result.white = responseBytes.readUInt8(9);
        }
        // Transfer control to the user's callback.
        let finalResult: ?UfoStatus = null;
        if (!err) finalResult = result;
        if (this._statusCallback) this._statusCallback(err, finalResult);
      }
      // Update the status response index.
      this._statusIndex = newIndex;
    }
  }
  /**
   * Updates an element in the status cache.
   * @private
   */
  _updateStatusCache(path: string, value: mixed): void {
    if (this._statusCache != null) {
      _.set(this._statusCache, path, value);
    }
  }
  /**
   * Deletes an element in the status cache. If no element given, deletes the
   * entire status cache.
   * @private
   */
  _unsetStatusCache(path: ?string): void {
    if (path === undefined) {
      this._statusCache = null;
    } else if (this._statusCache != null) {
      _.unset(this._statusCache, path);
    }
  }
  /**
   * Sends the data in the given buffer to the TCP socket, then invokes the
   * appropriate promise method.
   * @private
   */
  _writePromise(buffer: Buffer, resolve: Function, reject: Function): void {
    this._disconnectCallback = reject;
    this._socket.write(buffer, () => {
      this._disconnectCallback = null;
      resolve();
    });
  }
  /**
   * The TCP command sent by this method appears to set/synchronize time on the
   * UFO. This is based on the construction of the payload, as observed via
   * packet sniffing.
   * - The Android app appears to send this command when a UFO is factory reset
   * or has its WiFi configuration is updated. Neither of these actions seem
   * dependent on this command function executing, however, so this method
   * exists only for completeness and is not used.
   * - It's not clear how this works with the NTP client that is configurable
   * via an AT/UDP command, since all UFOs have an NTP server setting.
   * - The response of this command always seems to be: 0x0f 0x10 0x00 0x1f.
   * @private
   */
  _time(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      // 0x10 yy yy mm dd hh mm ss 0x07 0x00
      // The first "yy" is the first 2 digits of the year.
      // The second "yy" is the last 2 digits of the year.
      // "mm" ranges from decimal "01" to "12".
      // "hh" is 24-hour format.
      // 0x07 0x00 seems to be a constant terminator.
      const buf = Buffer.alloc(10);
      buf.writeUInt8(0x10, 0);
      const now = new Date();
      const yearString = now.getFullYear().toString();
      const first2Year = parseInt(yearString.substring(0, 2), 10);
      const last2Year = parseInt(yearString.substring(2), 10);
      buf.writeUInt8(first2Year, 1);
      buf.writeUInt8(last2Year, 2);
      buf.writeUInt8(now.getMonth() + 1, 3);
      buf.writeUInt8(now.getDate(), 4);
      buf.writeUInt8(now.getHours(), 5);
      buf.writeUInt8(now.getMinutes(), 6);
      buf.writeUInt8(now.getSeconds(), 7);
      buf.writeUInt8(0x07, 8);
      buf.writeUInt8(0, 9);
      this._writePromise(_prepareBytes(buf), resolve, reject);
    });
  }
  /**
   * Opens the TCP socket on this machine and connects to the UFO's TCP server.
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      const options = {};
      options.family = 4;
      options.host = this._options.remoteAddress;
      options.port = this._options.remotePort;
      if (this._options.localAddress.length > 0) {
        options.localAddress = this._options.localAddress;
      }
      if (this._options.localPort > 0) {
        options.localPort = this._options.localPort;
      }
      // Intercept/reject any emitted errors when we attempt to connect.
      const connectFailure = (err) => {
        // _connectFailed tells the close handler to no-op.
        this._connectFailed = true;
        reject(err);
      };
      this._socket.on('error', connectFailure);
      this._socket.connect(options, () => {
        // Remove the intercept listener since we connected successfully.
        this._socket.removeListener('error', connectFailure);
        // Now we can define our true error handler.
        this._socket.on('error', (err) => {
          // Do NOT set the dead flag here!
          // The close handler needs its current status.
          this._error = err;
          // NodeJS automatically emits a "close" event after an "error" event.
        });
        // If status cache is enabled, get status now.
        // Otherwise we're done.
        if (this._options.cache) {
          this.status().then(() => resolve()).catch(reject);
        } else {
          resolve();
        }
      });
    });
  }
  /**
   * Closes the TCP socket on this machine. This object cannot be used after
   * this method is called; invoking any method after this one results in a
   * silent no-op.
   */
  disconnect(): void {
    if (this._dead) return;
    // We're intentionally closing this connection.
    // Don't allow it to be used again.
    this._dead = true;
    this._socket.end();
    this._socket.emit('close');
  }
  /**
   * Gets the UFO's output status. If force is true, status cache is ignored.
   * Result is null iff this UFO object is dead.
   */
  status(force: boolean = false): Promise<?UfoStatus> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(null); return; }
      const cacheIsEnabled = this._options.cache;
      const cacheExists = this._statusCache != null;
      const isStatic = cacheExists && _.get(this._statusCache, 'mode') === 'static';
      if (cacheIsEnabled && !force && cacheExists && isStatic) { resolve(this._statusCache); return; }
      this._socket.resume();
      this._statusCallback = function (err, data) {
        this._statusCallback = null;
        this._socket.pause();
        if (err) {
          this._statusCache = null;
          reject(err);
        } else {
          this._disconnectCallback = null;
          this._statusCache = data;
          resolve(data);
        }
      }.bind(this);
      this._disconnectCallback = reject;
      this._socket.write(statusRequest);
    });
  }
  /** Turns the UFO output on. */
  on(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      this._writePromise(powerOn, () => {
        // Update the status cache before resolving.
        this._updateStatusCache('on', true);
        resolve();
      }, reject);
    });
  }
  /** Turns the UFO output off. */
  off(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      this._writePromise(powerOff, () => {
        // Update the status cache before resolving.
        this._updateStatusCache('on', false);
        resolve();
      }, reject);
    });
  }
  /**
   * Sets the UFO output to the static values specified. The RGBW values are
   * clamped from 0-255 inclusive, where 0 is off and 255 is fully on/100%
   * output.
   */
  rgbw(red: number, green: number, blue: number, white: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      // 0x31 rr gg bb ww 0x00
      // 0x00 seems to be a constant terminator.
      const buf = Buffer.alloc(6);
      buf.writeUInt8(0x31, 0);
      const realRed = _clampRGBW(red);
      const realGreen = _clampRGBW(green);
      const realBlue = _clampRGBW(blue);
      const realWhite = _clampRGBW(white);
      buf.writeUInt8(realRed, 1);
      buf.writeUInt8(realGreen, 2);
      buf.writeUInt8(realBlue, 3);
      buf.writeUInt8(realWhite, 4);
      buf.writeUInt8(0, 5);
      const finalData = _prepareBytes(buf);
      this._writePromise(finalData, () => {
        // Update the status cache before resolving.
        this._updateStatusCache('raw', finalData);
        this._updateStatusCache('mode', 'static');
        this._unsetStatusCache('speed');
        this._updateStatusCache('red', realRed);
        this._updateStatusCache('green', realGreen);
        this._updateStatusCache('blue', realBlue);
        this._updateStatusCache('white', realWhite);
        resolve();
      }, reject);
    });
  }
  /**
   * Starts one of the UFO's built-in functions at the given speed. The promise
   * will be rejected if an invalid function name is given.
   *
   * The speed is clamped from 0-100 inclusive. Speed values do not result in
   * the same durations across all functions (e.g. sevenColorStrobeFlash is
   * much faster at speed 100 than sevenColorJumpingChange); you will need to
   * experiment with different values to get the desired timing for the function
   * you wish to use.
   */
  builtin(name: BuiltinFunction, speed: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      const functionId = builtinFunctionMap.get(name);
      if (functionId === undefined) {
        reject(new Error(`No such built-in function ${name}`));
      } else {
        // 0x61 id speed
        const buf = Buffer.alloc(3);
        buf.writeUInt8(0x61, 0);
        buf.writeUInt8(functionId, 1);
        buf.writeUInt8(_builtinFlipSpeed(speed), 2);
        this._writePromise(_prepareBytes(buf), () => {
          // Update the status cache before resolving.
          this._unsetStatusCache();
          resolve();
        }, reject);
      }
    });
  }
  /**
   * Starts the given custom function. The promise will be rejected if an
   * invalid mode is given.
   * - The speed is clamped from 0-30 inclusive. Below is a list of step
   * durations measured with a stopwatch when using the "jumping" mode. These
   * values should be treated as approximations. Based on this list, it appears
   * decrementing the speed by 1 increases step duration by 0.14 seconds.
   *    - 30 = 0.4 seconds
   *    - 25 = 1.1 seconds
   *    - 20 = 1.8 seconds
   *    - 15 = 2.5 seconds
   *    - 10 = 3.2 seconds
   *    - 5 = 3.9 seconds
   *    - 0 = 4.6 seconds
   * - Only the first 16 steps in the given array are considered. Any additional
   * steps are ignored.
   * - If any null steps are specified in the array, they are dropped *before*
   * the limit of 16 documented above is considered.
   */
  custom(mode: CustomMode, speed: number, steps: Array<CustomStep>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._dead) { resolve(); return; }
      // Validate the mode.
      let modeId;
      switch (mode) {
        case 'gradual':
          modeId = 0x3A;
          break;
        case 'jumping':
          modeId = 0x3B;
          break;
        case 'strobe':
          modeId = 0x3C;
          break;
        default:
          reject(new Error(`Invalid mode '${mode}'.`));
          return;
      }
      // 0x51 steps(16xUInt8) speed mode 0xFF
      // 0xFF seems to be a constant terminator.
      const buf = Buffer.alloc(68);
      buf.writeUInt8(0x51, 0);
      let index = 1;
      // First, remove from the steps array any null steps that were set by the
      // user. The UFO stops playing the function upon the first occurrence of a
      // null step, so we cannot accept them in the steps array argument.
      //
      // Then:
      // - If there are fewer than 16 steps, "null" steps must be added so we have
      // exactly 16 steps.
      // - Otherwise, truncate the array so it has exactly 16 steps.
      const stepsCopy = steps.filter(s => !_isNullStep(s)).slice(0, maxCustomSteps);
      while (stepsCopy.length < maxCustomSteps) {
        stepsCopy.push(nullStep);
      }
      // Each step consists of an RGB value and is translated into 4 bytes.
      // The 4th byte is always zero.
      stepsCopy.forEach((step) => {
        buf.writeUInt8(_clampRGBW(step.red), index);
        index += 1;
        buf.writeUInt8(_clampRGBW(step.green), index);
        index += 1;
        buf.writeUInt8(_clampRGBW(step.blue), index);
        index += 1;
        buf.writeUInt8(0, index);
        index += 1;
      });
      // The UFO seems to store/report the speed as 1 higher than what it really is.
      buf.writeUInt8(_customFlipSpeed(speed) + 1, index);
      index += 1;
      // Set the mode.
      buf.writeUInt8(modeId, index);
      index += 1;
      // Add terminator and write.
      buf.writeUInt8(0xFF, index);
      this._writePromise(_prepareBytes(buf), () => {
        // Update the status cache before resolving.
        this._unsetStatusCache();
        resolve();
      }, reject);
    });
  }
  /** Returns the list of built-in functions usable by the API/CLI. */
  static getBuiltinFunctions(): Array<BuiltinFunction> {
    return Array.from(builtinFunctionMap.keys()).filter(k => !builtinFunctionReservedNames.includes(k)).sort();
  }
  /** Indicates whether or not the given object is equivalent to a null custom step. */
  static isNullStep(step: CustomStep): boolean { return _isNullStep(step); }
}
export default TcpClient;
