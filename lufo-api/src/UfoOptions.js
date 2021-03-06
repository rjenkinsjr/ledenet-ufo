// @flow
/**
 * Available configuration options for the {@link Ufo} object.
 * @typedef {Object} UfoOptions
 * @property {string} host The IP address of the UFO. If you want a fixed IP
 * address, you can either configure static DHCP assignment on your router using
 * the UFO's MAC address or you can use the CLI to configure the UFO's WiFi
 * client settings to use a static IP instead of DHCP.
 * @property {string} [password] the UDP password used to connect to the UFO.
 * If unspecified, the default is used. You can use the CLI to change the UFO's
 * password for greater security, since the default password is well-known and
 * hardcoded into this library.
 * @property {string} [localHost] The local host used for establishing the
 * TCP socket.
 * @property {number} [localUdpPort] the port number that will be bound on this
 * machine for UDP traffic to the  UFO. If unspecified, a random port is used.
 * @property {number} [remoteUdpPort] the UDP port number on the UFO. If
 * unspecified, the default port 48899 is used. You can change this using the
 * CLI.
 * @property {number} [localTcpPort] the port number that will be bound on this
 * machine for UDP traffic to the  UFO. If unspecified, a random port is used.
 * @property {number} [remoteTcpPort] the UDP port number on the UFO. If
 * unspecified, the default port 5577 is used. You can change this using the
 * CLI.
 * @property {boolean} [immediate] if true or unspecified,
 * {@link https://nodejs.org/api/net.html#net_socket_setnodelay_nodelay socket.setNoDelay(true)}
 * is invoked when the TCP socket is created. This prevents TCP data from being
 * buffered by NodeJS before being sent to the UFO. If this causes communication
 * issues, set this to false.
 * @property {boolean} [cache] if true or unspecified, the UFO object will cache
 * the UFO's status internally. This speeds up future calls to methods that
 * return/make use of the UFO's status. This cache is used only when the last
 * known UFO mode is "static"; the cache is invalidated whenever a builtin or
 * custom function is invoked on the UFO.
 */
export type UfoOptions = {
  host: string,
  password?: string,
  localHost?: string,
  localUdpPort?: number,
  remoteUdpPort?: number,
  localTcpPort?: number,
  remoteTcpPort?: number,
  immediate?: boolean,
  cache?: boolean,
};
