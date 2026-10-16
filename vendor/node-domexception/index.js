'use strict';
// Stand-in for node-domexception@1.0.0 (deprecated: "Use your platform's native DOMException instead").
// That package only returned globalThis.DOMException, polyfilling it on Node < 17; the project needs
// Node >= 20, where it is always defined. See README.md.
module.exports = globalThis.DOMException;
