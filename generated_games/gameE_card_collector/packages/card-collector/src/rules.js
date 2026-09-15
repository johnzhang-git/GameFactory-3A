/**
 * Headless entry point: the game rules, and nothing else.
 *
 * The package's main entry (`index.js`) boots the browser game and therefore
 * pulls in the three.js runtime and the DOM. A server that only needs to
 * decide what a chest contains should not have to load a renderer to find out.
 *
 * Everything re-exported here is free of three.js and of the DOM — the
 * property the architecture already relied on for headless testing, now
 * exposed as an actual boundary.
 */

export * from './catalog.js';
export * from './economy.js';
export * from './game.js';
