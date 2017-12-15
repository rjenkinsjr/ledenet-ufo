const events = require('events');
const UFO_TCP = require('./tcp/UFO_TCP.js');
const UFO_UDP = require('./udp/UFO_UDP.js');
const UFOError = require('./UFOError.js');

/*
 * Constructor
 */
var UFO = module.exports = function(options, callback) {
  // Flag that tracks the state of this UFO object.
  this._dead = false;
  // Capture the options provided by the user.
  this._options = Object.freeze(options);
  // Create the TCP and UDP sockets.
  this._tcpSocket = new UFO_TCP(this, options);
  this._udpSocket = new UFO_UDP(this, options);
  // Define the socket close event handlers.
  this._tcpError = null;
  this.on('tcpDead', function(err) {
    this._tcpError = err;
    if (this._udpSocket._dead) {
      this.emit('dead');
    } else {
      this._udpSocket.disconnect();
    }
  }.bind(this));
  this._udpError = null;
  this.on('udpDead', function(err) {
    this._udpError = err;
    if (this._tcpSocket._dead) {
      this.emit('dead');
    } else {
      this._tcpSocket.disconnect();
    }
  }.bind(this))
  // Define the "UFO is dead" event handler, invoked once both sockets are closed.
  this.on('dead', function() {
    // Invoke the disconnect callback, if one is defined.
    var error = null;
    if (this._udpError || this._tcpError) {
      error = new UFOError("UFO disconnected due to an error.", this._udpError, this._tcpError);
    }
    var callback = this._options.disconnectCallback;
    typeof callback === 'function' && callback(error);
  }.bind(this));
  // Connect now, if a callback was requested.
  typeof callback === 'function' && this.connect(callback);
};
UFO.prototype = new events.EventEmitter;

/*
 * Query methods
 */
UFO.discover = UFO_UDP.discover;
UFO.prototype.getHost = function() {
  return this._options.host;
}
/*
 * Connect/disconnect methods
 */
UFO.prototype.connect = function(callback) {
  this._udpSocket.hello(function() {
    this._tcpSocket.connect(callback);
  }.bind(this));
}
UFO.prototype.disconnect = function() {
  this._dead = true;
  this._tcpSocket.disconnect();
  this._udpSocket.disconnect();
}
/*
 * Status/power methods
 */
UFO.prototype.getStatus = function(callback) {
  this._tcpSocket.status(callback);
}
UFO.prototype.setPower = function(onOff, callback) {
  onOff ? this.turnOn(callback) : this.turnOff(callback);
}
/*
 * RGBW control methods
 */
UFO.prototype.turnOn = function(callback) {
  this._tcpSocket.on(callback);
}
UFO.prototype.turnOff = function(callback) {
  this._tcpSocket.off(callback);
}
UFO.prototype.setColor = function(red, green, blue, white, callback) {
  this._tcpSocket.rgbw(red, green, blue, white, callback);
}
UFO.prototype.setBuiltin = function(name, speed, callback) {
  this._tcpSocket.builtin(name, speed, callback);
}
UFO.prototype.setCustom = function(speed, mode, steps, callback) {
  this._tcpSocket.custom(speed, mode, steps, callback);
}
UFO.prototype.freezeOutput = function(callback) {
  this.setBuiltin('noFunction', 0, callback);
}
UFO.prototype.zeroOutput = function(callback) {
  this.setColor(0, 0, 0, 0, callback);
}
