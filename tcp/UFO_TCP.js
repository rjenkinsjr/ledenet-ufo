const net = require('net');
const Builtins = require('./Builtins.js');
const Customs = require('./Customs.js');
const Power = require('./Power.js');
const Status = require('./Status.js');
const TCPUtils = require('./TCPUtils.js');
const Utils = require('../Utils.js');

// TCP socket creation method. Must be bound to a UFO_TCP instance.
const createSocket = function() {
  // UFOs will close TCP connections after a cetain time of not receiving any data.
  // TCP keepalives from Node don't seem to help.
  // This flag is used by the "close" event handler to re-establish a connection
  // that was unknowingly closed by the UFO.
  //
  // If this is true, this UFO instance is unusable and will no longer perform
  // any UFO control methods (e.g. rgbw).
  this._dead = false;
  // Storage/tracking for the status response.
  this._statusArray = new Uint8Array(Status.responseSize());
  this._statusIndex = 0;
  // The TCP socket used to communicate with the UFO.
  this._socket = net.Socket();
  // Send all data immediately; no buffering.
  this._socket.setNoDelay(this._options.sendImmediately || true);
  // Capture errors so we can respond appropriately.
  this._error = null;
  this._socket.on('error', function(err) { this._error = err; }.bind(this));
  // Both sides have FIN'ed. No more communication is allowed on this socket.
  this._socket.on('close', closeSocket.bind(this));
  // Any data received by the UFO is a status update.
  this._socket.on('data', Status.responseHandler(this));
  // Initially, ignore all received data.
  this._socket.pause();
}

// TCP socket close event handler. Must be bound to a UFO_TCP instance.
//
// If the UFO FIN'ed first due to inactivity, silently reconnect.
// If the UFO FIN'ed first due to an error, fire the disconnect callback with the error.
// Otherwise, fire the disconnect callback with no error.
const closeSocket = function() {
  // Assume the UFO closed on its own.
  // Otherwise, the socket closed intentionally and no error has occurred.
  var reconnect = !this._dead;
  var err = null;
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
    createSocket.call(this);
    this.connect();
  } else {
    var callback = this._options.disconnectCallback;
    typeof callback === 'function' && callback(err);
  }
}

// Dead enforcement method.
// Callback is invoked only if the socket is dead.
const isDead = function(ufoTcp, callback) {
  if (ufoTcp._dead) {
    typeof callback === 'function' && callback(new Error(`UFO has been disconnected.`));
  }
  return ufoTcp._dead;
}

/*
 * Exports
 */

var UFO_TCP = module.exports = function(options) {
  // Capture the options provided by the user.
  this._options = Object.freeze(options);
  // Create the TCP socket and other dependent objects.
  createSocket.call(this);
};

/*
 * Core methods
 */
UFO_TCP.prototype.connect = function(callback) {
  if (isDead(this, callback)) return;
  // All UFOs listen on the same port.
  const port = 5577;
  this._socket.connect({
    host: this._options.host,
    port: port
  }, function() {
    typeof callback === 'function' && callback();
  });
}
UFO_TCP.prototype.disconnect = function() {
  // If already dead, stop now with no callback.
  if (isDead(this)) return;
  // We're intentionally closing this connection.
  // Don't allow it to be used again.
  this._dead = true;
  this._socket.end();
}
UFO_TCP.prototype.status = function(callback) {
  if (isDead(this, callback)) return;
  this._socket.resume();
  this._statusCallback = function(err, data) {
    typeof callback === 'function' && callback(err, data);
    this._statusCallback = null;
    this._socket.pause();
  }.bind(this);
  this._socket.write(Status.request());
}
UFO_TCP.prototype.on = function(callback) {
  if (isDead(this, callback)) return;
  this._socket.write(Power.on(), callback);
}
UFO_TCP.prototype.off = function(callback) {
  if (isDead(this, callback)) return;
  this._socket.write(Power.off(), callback);
}

/*
 * Standard control methods
 */
UFO_TCP.prototype.rgbw = function(red, green, blue, white, callback) {
  if (isDead(this, callback)) return;
  // 0x31 rr gg bb ww 0x00
  // 0x00 seems to be a constant terminator for the data.
  var buf = Buffer.alloc(6);
  buf.writeUInt8(0x31, 0);
  buf.writeUInt8(Utils.clampRGBW(red), 1);
  buf.writeUInt8(Utils.clampRGBW(green), 2);
  buf.writeUInt8(Utils.clampRGBW(blue), 3);
  buf.writeUInt8(Utils.clampRGBW(white), 4);
  buf.writeUInt8(0, 5);
  this._socket.write(TCPUtils.prepareBytes(buf), callback);
}
UFO_TCP.prototype.builtin = function(name, speed, callback) {
  if (isDead(this, callback)) return;
  // 0x61 id speed
  var buf = Buffer.alloc(3);
  buf.writeUInt8(0x61, 0);
  buf.writeUInt8(Builtins.getFunctionId(name), 1);
  // This function accepts a speed from 0 (slow) to 100 (fast).
  buf.writeUInt8(Builtins.flipSpeed(speed), 2);
  this._socket.write(TCPUtils.prepareBytes(buf), callback);
}
UFO_TCP.prototype.custom = function(speed, mode, steps, callback) {
  if (isDead(this, callback)) return;
  // Validate the mode.
  var modeId;
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
      break;
  }
  // 0x51 steps(16xUInt8) speed mode 0xFF
  // 0xFF seems to be a constant terminator for the data.
  var buf = Buffer.alloc(68);
  buf.writeUInt8(0x51, 0);
  var index = 1;
  // If there are fewer than 16 steps, "null" steps must be added so we have
  // exactly 16 steps. Additionally, any null steps intermingled with non-null
  // steps must be removed, as they will cause the pattern to stop. Null steps
  // can only exist at the end of the array.
  //
  // While we're doing this, truncate the array to the correct size.
  var stepsCopy = steps.filter(function(s) {
    return !(s.red === Customs.nullStep.red &&
             s.green === Customs.nullStep.green &&
             s.blue === Customs.nullStep.blue);
  }).slice(0, Customs.stepCount);
  while (stepsCopy.length < Customs.stepCount) {
    stepsCopy.push(Customs.nullStep);
  }
  // Each step consists of an RGB value and is translated into 4 bytes.
  // The 4th byte is always zero.
  for (const step of stepsCopy) {
    buf.writeUInt8(Utils.clampRGBW(step.red), index);
    index++;
    buf.writeUInt8(Utils.clampRGBW(step.green), index);
    index++;
    buf.writeUInt8(Utils.clampRGBW(step.blue), index);
    index++;
    buf.writeUInt8(0, index);
    index++;
  }
  // This function accepts a speed from 0 (slow) to 30 (fast).
  // The UFO seems to store/report the speed as 1 higher than what it really is.
  buf.writeUInt8(Customs.flipSpeed(speed) + 1, index);
  index++;
  // Set the mode.
  buf.writeUInt8(modeId, index);
  index++;
  // Add terminator and write.
  buf.writeUInt8(0xFF, index);
  this._socket.write(TCPUtils.prepareBytes(buf), callback);
}

/*
Disco and camera modes:
  0x41 ?? ?? ?? ?? ?? 0x0F checksum
irrelevant mode because it's dependent on the device's microphone or camera; individual transmissions just set the color
only relevant observation is that 41 is the header
*/