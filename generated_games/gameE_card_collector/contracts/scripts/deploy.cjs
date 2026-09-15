/**
 * Deploy `CardCollector` and print the values the server needs.
 *
 * Usage:
 *
 *   npx hardhat run contracts/scripts/deploy.cjs --network <name>
 *
 * The contract's `signer` must be the address whose key the server holds
 * (`CHAIN_SIGNER_KEY`). Supply it as `SIGNER_ADDRESS`, or let the script use
 * the deploying account's address for a single-key local setup.
 *
 * Nothing here is chain-specific: the same script works against the in-process
 * EVM, a testnet, or a mainnet L2. What differs is only which network name is
 * passed and which RPC the config points at.
 */

const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const signerAddress = process.env.SIGNER_ADDRESS ?? deployer.address;
  const baseUri =
    process.env.CARD_BASE_URI ?? 'https://example.com/cards/{id}.json';

  console.log(`network          ${network.name} (chainId ${network.chainId})`);
  console.log(`deployer         ${deployer.address}`);
  console.log(`voucher signer   ${signerAddress}`);
  console.log(`base uri         ${baseUri}`);
  console.log('');

  const Factory = await ethers.getContractFactory('CardCollector');
  const card = await Factory.deploy(signerAddress, baseUri);
  await card.waitForDeployment();

  const address = await card.getAddress();
  const receipt = await card.deploymentTransaction().wait();

  console.log(`CardCollector deployed to ${address}`);
  console.log(`  block      ${receipt.blockNumber}`);
  console.log(`  gas used   ${receipt.gasUsed.toString()}`);
  console.log('');
  console.log('Set these on the server:');
  console.log(`  CHAIN_ID=${network.chainId}`);
  console.log(`  CHAIN_CONTRACT_ADDRESS=${address}`);
  console.log(`  CHAIN_SIGNER_KEY=<the private key for ${signerAddress}>`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
