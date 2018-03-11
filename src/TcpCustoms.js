// @flow
const _ = require('lodash');

/* Private variables */
const stepCount = 16;
const nullStep = Object.freeze({ red: 1, green: 2, blue: 3 });
const maxSpeed = 30;

/**
 * This class contains methods for working with UFO custom functions.
 */
class TcpCustoms {
  /**
   * Returns 16, the maximum number of steps allowed in a single custom function command.
   */
  getStepCount(): number { return stepCount; }
  /**
   * Returns the object definition of a null step; these are used to fill in
   * missing steps at the end of the byte stream to produce a valid payload.
   */
  getNullStep(): Object { return nullStep; }
  /**
   * Converts a custom function speed value back and forth between the API value and the internal value.
   * Input and output are clamped to 0-30 inclusive.
   */
  flipSpeed(speed: number): number {
    return Math.abs(_.clamp(speed, 0, maxSpeed) - maxSpeed);
  }
}

module.exports = Object.freeze(new TcpCustoms());
