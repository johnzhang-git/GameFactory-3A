/**
 * Hardhat config for the card-collector contract.
 *
 * `.cjs` because the rest of the project is ESM and Hardhat's config loader
 * wants CommonJS.
 *
 * Tests run against the built-in in-process EVM, so deploying and calling the
 * contract needs no node, no RPC key, and no network.
 */

require('@nomicfoundation/hardhat-toolbox');

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      /**
       * OpenZeppelin 5.x uses `mcopy`, which is Cancun-only. Every chain we
       * would deploy to (Base, Polygon, Arbitrum) has Cancun enabled, so
       * targeting it is correct rather than merely convenient.
       */
      evmVersion: 'cancun',
    },
  },
  paths: {
    sources: './contracts',
    tests: './contracts/test',
    cache: './.hardhat/cache',
    artifacts: './.hardhat/artifacts',
  },
};
