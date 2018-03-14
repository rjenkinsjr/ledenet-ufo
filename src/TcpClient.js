// @flow
import * as net from 'net';
import TcpBuiltins from './TcpBuiltins';
import TcpCustoms from './TcpCustoms';
import TcpPower from './TcpPower';
import TcpUtils from './TcpUtils';

/* Private variables */
const statusHeader = 0x81;
const statusRequest = Buffer.from([statusHeader, 0x8A, 0x8B, 0x96]);
const statusResponseSize = 14;

/** Provides an API to UFOs for interacting with the UFO's TCP server. */
export default class {
  constructor(ufo: Object, options: Object) {
    // Capture the parent UFO.
    this._ufo = ufo;
    // Capture the options provided by the user.
    this._options = Object.freeze(options);
    // Create the TCP socket and other dependent objects.
    this._createSocket();
  }

  /**
   * Reacts to the "close" event on the TCP socket inside this client.
   * - If the UFO FIN'ed first due to inactivity, silently reconnect.
   * - If the UFO FIN'ed first due to an error, fire the disconnect callback with the error.
   * - Otherwise, fire the disconnect callback with no error.
   * @private
   */
  _closeSocket(): void {
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
      this._ufo.emit('tcpDead', this._error);
    }
  }

  /**
   * Creates/initializes the TCP socket inside this client. Also initializes/
   * resets other variables needed to manage connection status.
   * @private
   */
  _createSocket(): void {
    // UFOs will close TCP connections after a cetain time of not receiving any data.
    // TCP keepalives from Node don't seem to help.
    // This flag is used by the "close" event handler to re-establish a connection
    // that was unknowingly closed by the UFO.
    //
    // If this is true, this UFO instance is unusable and will no longer perform
    // any UFO control methods (e.g. rgbw).
    this._dead = false;
    // Storage/tracking for the status response.
    this._statusArray = new Uint8Array(statusResponseSize);
    this._statusIndex = 0;
    // The TCP socket used to communicate with the UFO.
    this._socket = net.Socket();
    this._error = null;
    // Send all data immediately; no buffering.
    this._socket.setNoDelay(this._options.sendImmediately || true);
    // Capture errors so we can respond appropriately.
    this._socket.on('error', (err) => {
      // Do NOT set the dead flag here! The close handler needs its current status.
      this._error = err;
      // NodeJS automatically emits a "close" event after an "error" event.
    });
    // Both sides have FIN'ed. No more communication is allowed on this socket.
    this._socket.on('close', () => { this._closeSocket(); });
    // Any TCP data received from the UFO is a status update.
    this._socket.on('data', (data: Buffer) => { this._receiveStatus(data); });
    // Initially, ignore all received data.
    this._socket.pause();
  }

  // Wraps the socket.write() method, handling the optional callback.
  //
  // callback is optional and accepts no arguments.
  _write(buffer: Buffer, callback: ?() => mixed): void {
    if (typeof callback === 'function') {
      this._socket.write(buffer, callback);
    } else {
      this._socket.write(buffer);
    }
  }
  // This function appears to set the UFO's time.
  // It is called by the Android app when a UFO is factory reset or has its WiFi configuration is updated.
  // Neither of those functions seem dependent on this function executing, however...correctly or at all.
  //
  // Since this function's purpose isn't fully known, it is marked as private.
  // Its response always seems to be 0x0f 0x10 0x00 0x1f.
  //
  // Callback is optional and accepts no arguments.
  _time(callback: ?() => mixed): void {
    if (this._dead) return;
    // 0x10 yy yy mm dd hh mm ss 0x07 0x00
    // The first "yy" is the first 2 digits of the year.
    // The second "yy" is the last 2 digits of the year.
    // "mm" ranges from decimal "01" to "12".
    // "hh" is 24-hour format.
    // 0x07 0x00 seems to be a constant terminator for the data.
    const buf = Buffer.alloc(10);
    buf.writeUInt8(0x10, 0);
    const now = new Date();
    const first2Year = parseInt(now.getFullYear().toString().substring(0, 2), 10);
    const last2Year = parseInt(now.getFullYear().toString().substring(2), 10);
    buf.writeUInt8(first2Year, 1);
    buf.writeUInt8(last2Year, 2);
    buf.writeUInt8(now.getMonth() + 1, 3);
    buf.writeUInt8(now.getDate(), 4);
    buf.writeUInt8(now.getHours(), 5);
    buf.writeUInt8(now.getMinutes(), 6);
    buf.writeUInt8(now.getSeconds(), 7);
    buf.writeUInt8(0x07, 8);
    buf.writeUInt8(0, 9);
    this._write(TcpUtils.prepareBytes(buf), callback);
  }
  // Handles bytes received as a result of calling the "status" command.
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
        let result = {};
        // Verify the response's integrity.
        if (responseBytes.readUInt8(0) === statusHeader) {
          // Compute the actual checksum.
          const lastIndex = statusResponseSize - 1;
          const expectedChecksum = responseBytes.readUInt8(lastIndex);
          responseBytes.writeUInt8(0, lastIndex);
          let actualChecksum = 0;
          for (const value of responseBytes.values()) {
            actualChecksum += value;
          }
          actualChecksum %= 0x100;
          // Compare.
          responseBytes.writeUInt8(expectedChecksum, lastIndex);
          if (expectedChecksum !== actualChecksum) {
            err = new Error('Status check failed (checksum mismatch).');
          }
        } else {
          err = new Error('Status check failed (header mismatch).');
        }

        /*
        Response format:
        0x81 ???a POWER MODE ???b SPEED RED GREEN BLUE WHITE [UNUSED] CHECKSUM

        ???a is unknown. It always seems to be 0x04.
        ???b is unknown; it always seems to be 0x21.
        [UNUSED] is a 3-byte big-endian field whose purpose is unknown. It always seems to be "0x03 0x00 0x00".
        */

        // Add raw bytes to the response.
        result.raw = responseBytes;
        // ON_OFF is always either 0x23 or 0x24.
        if (!err) {
          const power = responseBytes.readUInt8(2);
          switch (power) {
            case 0x23:
              result.power = 'on';
              break;
            case 0x24:
              result.power = 'off';
              break;
            default:
              err = new Error(`Status check failed (impossible power value ${power}).`);
          }
        }
        // MODE:
        // - 0x62 is disco mode or camera mode (called "other").
        // - 0x61 is static color.
        // - 0x60 is custom steps.
        // - Otherwise, it is a function ID.
        if (!err) {
          const mode = responseBytes.readUInt8(3);
          switch (mode) {
            case 0x62:
              result.mode = 'other';
              break;
            case 0x61:
              result.mode = 'static';
              break;
            case 0x60:
              result.mode = 'custom';
              break;
            default:
              var found = false;
              for (const f in TcpBuiltins.getFunctions().toObject()) {
                if (TcpBuiltins.getFunctionId(f) === mode) {
                  result.mode = `function:${f}`;
                  found = true;
                  break;
                }
              }
              if (!found) err = new Error(`Status check failed (impossible mode ${mode}).`);
              break;
          }
        }
        // SPEED is evaluated based on MODE, and it does not apply to all modes.
        if (!err) {
          const speed = responseBytes.readUInt8(5);
          if (result.mode === 'custom') {
            // The UFO seems to store/report the speed as 1 higher than what it really is.
            result.speed = TcpCustoms.flipSpeed(speed - 1);
          }
          if (result.mode.startsWith('function')) {
            result.speed = TcpBuiltins.flipSpeed(speed);
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
        if (err) result = null;
        this._statusCallback(err, result);
      }
      // Update the status response index.
      this._statusIndex = newIndex;
    }
  }
  // Binds the TCP socket on this machine.
  //
  // Callback is required and accepts no arguments.
  connect(callback: () => mixed): void {
    if (this._dead) return;
    // Define options object.
    const options = {
      host: this._options.host,
      // All UFOs listen on the same port.
      port: 5577,
    };
    if (this._options.tcpPort && this._options.tcpPort > 0) {
      options.localPort = this._options.tcpPort;
    }
    // Connect.
    this._socket.connect(options, callback);
  }
  // Closes the TCP socket on this machine.
  disconnect(): void {
    if (this._dead) return;
    // We're intentionally closing this connection.
    // Don't allow it to be used again.
    this._dead = true;
    this._socket.end();
    this._socket.emit('close');
  }
  // Returns a JSON object describing the status of the UFO.
  //
  // Callback is required and accepts error and data arguments.
  // Either one or the other argument is null, but never both.
  status(callback: (error: ?Error, data: ?Object) => mixed): void {
    if (this._dead) return;
    this._socket.resume();
    this._statusCallback = function (err, data) {
      this._statusCallback = null;
      this._socket.pause();
      callback(err, data);
    }.bind(this);
    this._socket.write(statusRequest);
  }
  // Turns the UFO on.
  //
  // Callback is optional and accepts no arguments.
  on(callback: ?() => mixed): void {
    if (this._dead) return;
    this._write(TcpPower.on(), callback);
  }
  // Turns the UFO off.
  //
  // Callback is optional and accepts no arguments.
  off(callback: ?() => mixed): void {
    if (this._dead) return;
    this._write(TcpPower.off(), callback);
  }
  // Toggles the UFO.
  //
  // Callback is optional and accepts an error argument.
  togglePower(callback: ?(error: ?Error) => mixed): void {
    if (this._dead) return;
    this.status((err, status) => {
      if (err) {
        typeof callback === 'function' && callback(err);
      } else if (status.power === 'on') {
        this.off(callback);
      } else {
        this.on(callback);
      }
    });
  }
  // Sets the RGBW output values of the UFO.
  //
  // Callback is optional and accepts no arguments.
  rgbw(red: number, green: number, blue: number, white: number, callback: ?() => mixed): void {
    if (this._dead) return;
    // 0x31 rr gg bb ww 0x00
    // 0x00 seems to be a constant terminator for the data.
    const buf = Buffer.alloc(6);
    buf.writeUInt8(0x31, 0);
    buf.writeUInt8(TcpUtils.clampRGBW(red), 1);
    buf.writeUInt8(TcpUtils.clampRGBW(green), 2);
    buf.writeUInt8(TcpUtils.clampRGBW(blue), 3);
    buf.writeUInt8(TcpUtils.clampRGBW(white), 4);
    buf.writeUInt8(0, 5);
    this._write(TcpUtils.prepareBytes(buf), callback);
  }
  // Enables one of the UFO's built-in functions.
  // Speed ranges from 0 (slow) to 100 (fast), inclusive.
  //
  // Callback is optional and accepts no arguments.
  builtin(name: string, speed: number, callback: ?() => mixed): void {
    if (this._dead) return;
    // 0x61 id speed
    const buf = Buffer.alloc(3);
    buf.writeUInt8(0x61, 0);
    buf.writeUInt8(TcpBuiltins.getFunctionId(name), 1);
    // This function accepts a speed from 0 (slow) to 100 (fast).
    buf.writeUInt8(TcpBuiltins.flipSpeed(speed), 2);
    this._write(TcpUtils.prepareBytes(buf), callback);
  }
  // Starts a custom function.
  // Speed ranges from 0 (slow) to 30 (fast).
  // Mode is one of 'gradual', 'jumping' or 'strobe'.
  //
  // Steps is an array of objects; each object must define 'red', 'green' and 'blue' attributes whose values range from 0 to 255, inclusive.
  // The array should not be more than 16 objects in size; only the first 16 objects will be used.
  // Step objects defined as { red: 1, green: 2, blue: 3 } are invalid and dropped from the input array.
  //
  // Callback is optional and accepts no arguments.
  custom(mode: 'gradual' | 'jumping' | 'strobe', speed: number, steps: Array<{red: number, green: number, blue: number}>, callback: ?() => mixed): void {
    if (this._dead) return;
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
        typeof callback === 'function' && callback(new Error(`Invalid mode '${mode}'.`));
        return;
    }
    // 0x51 steps(16xUInt8) speed mode 0xFF
    // 0xFF seems to be a constant terminator for the data.
    const buf = Buffer.alloc(68);
    buf.writeUInt8(0x51, 0);
    let index = 1;
    // If there are fewer than 16 steps, "null" steps must be added so we have
    // exactly 16 steps. Additionally, any null steps intermingled with non-null
    // steps must be removed, as they will cause the pattern to stop. Null steps
    // can only exist at the end of the array.
    //
    // While we're doing this, truncate the array to the correct size.
    const nullStep = TcpCustoms.getNullStep();
    const stepCount = TcpCustoms.getStepCount();
    const stepsCopy = steps.filter(s => !(s.red === nullStep.red &&
               s.green === nullStep.green &&
               s.blue === nullStep.blue)).slice(0, stepCount);
    while (stepsCopy.length < stepCount) {
      stepsCopy.push(nullStep);
    }
    // Each step consists of an RGB value and is translated into 4 bytes.
    // The 4th byte is always zero.
    for (const step of stepsCopy) {
      buf.writeUInt8(TcpUtils.clampRGBW(step.red), index);
      index += 1;
      buf.writeUInt8(TcpUtils.clampRGBW(step.green), index);
      index += 1;
      buf.writeUInt8(TcpUtils.clampRGBW(step.blue), index);
      index += 1;
      buf.writeUInt8(0, index);
      index += 1;
    }
    // This function accepts a speed from 0 (slow) to 30 (fast).
    // The UFO seems to store/report the speed as 1 higher than what it really is.
    buf.writeUInt8(TcpCustoms.flipSpeed(speed) + 1, index);
    index += 1;
    // Set the mode.
    buf.writeUInt8(modeId, index);
    index += 1;
    // Add terminator and write.
    buf.writeUInt8(0xFF, index);
    this._write(TcpUtils.prepareBytes(buf), callback);
  }

  /*
  Music, disco and camera modes:
    0x41 ?? ?? ?? ?? ?? 0x0F checksum
  irrelevant mode because it's dependent on the device's audio, microphone or camera; individual transmissions just set the color
  only relevant observation is that 41 is the header
  */
}
