// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CardCollector} from "../CardCollector.sol";

/**
 * @title ReentrantClaimer
 * @notice A hostile receiver used only by the tests.
 *
 * `CardCollector.redeem` mints, and `ERC1155._mint` calls `onERC1155Received`
 * when the recipient is a contract — a real external call that happens *after*
 * the state writes. This contract exists to exploit that window, so the tests
 * can demonstrate whether the guards actually hold rather than trusting the
 * comment that says they do.
 *
 * It re-enters with the same voucher, a larger one, or a chain of them,
 * depending on how it is armed. A re-entrant call that reverts is swallowed:
 * the interesting question is what the *outer* call ends up doing, and a
 * propagating revert would abort the outer mint and mask the answer.
 */
contract ReentrantClaimer {
    CardCollector public immutable target;

    CardCollector.Voucher private reentryVoucher;
    bytes private reentrySignature;
    bool private hasReentry;

    CardCollector.Voucher[] private chain;
    bytes[] private chainSignatures;
    uint256 private chainIndex;
    bool private chaining;

    constructor(address target_) {
        target = CardCollector(target_);
    }

    /// @notice Arm a single re-entrant claim.
    function setAttack(
        CardCollector.Voucher calldata voucher,
        bytes calldata signature
    ) external {
        reentryVoucher = voucher;
        reentrySignature = signature;
        hasReentry = true;
    }

    /// @notice Arm a chain of re-entrant claims, submitted one per callback.
    function setChain(
        CardCollector.Voucher[] calldata vouchers,
        bytes[] calldata signatures
    ) external {
        delete chain;
        delete chainSignatures;
        for (uint256 i = 0; i < vouchers.length; i++) {
            chain.push(vouchers[i]);
            chainSignatures.push(signatures[i]);
        }
        chainIndex = 0;
        chaining = true;
    }

    /// @notice Submit a voucher, which will re-enter during the mint callback.
    function attack(
        CardCollector.Voucher calldata voucher,
        bytes calldata signature
    ) external {
        target.redeem(voucher, signature);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external returns (bytes4) {
        if (chaining) {
            if (chainIndex < chain.length) {
                uint256 i = chainIndex;
                chainIndex++;
                try target.redeem(chain[i], chainSignatures[i]) {} catch {}
            }
        } else if (hasReentry) {
            hasReentry = false; // one hop, so the test terminates
            try target.redeem(reentryVoucher, reentrySignature) {} catch {}
        }
        return this.onERC1155Received.selector;
    }
}
