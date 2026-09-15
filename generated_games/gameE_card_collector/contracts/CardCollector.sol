// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title CardCollector
 * @notice On-chain ownership for the card-collector game's cards.
 *
 * Design notes, in order of how much money each one saves:
 *
 * 1. **Lazy minting.** Cards are minted only when a player claims them, and
 *    the player pays the gas. The studio signs an EIP-712 voucher off-chain
 *    and never sends a transaction. Without this, every one of a run's ~670
 *    chest opens would be a transaction on the studio's tab.
 *
 * 2. **ERC-1155, not ERC-721.** A card's identity is its `tokenId` and the
 *    player's holdings are the `balance`. That maps exactly onto the game's
 *    existing "copies" counter, so a duplicate draw is `balance + 1` rather
 *    than a separate NFT per card. Roughly an order of magnitude cheaper.
 *
 * 3. **No level on-chain.** A card's level is derived from its copy count and
 *    changes constantly. Putting it in token metadata would mean a transaction
 *    per level-up; the game reads levels off-chain instead.
 *
 * The contract only ever mints. It holds no funds and has no owner-controlled
 * withdrawal, so the blast radius of a bug is limited to minting the wrong
 * card — not to losing anyone's money.
 */
contract CardCollector is ERC1155, EIP712, Ownable {
    /// @notice Emitted when a card is minted, for indexing and the UI.
    event CardClaimed(
        address indexed player,
        uint256 indexed tokenId,
        uint256 amount,
        uint256 nonce
    );

    /// @notice The address whose vouchers this contract accepts.
    address public immutable signer;

    /**
     * @notice Total amount ever minted per card id.
     *
     * Exposed so the game can show "how many of card 3 exist". Note this is
     * not a supply cap: the cap is a product decision, and the max id is
     * fixed by the card pool rather than enforced here.
     */
    mapping(uint256 => uint256) public totalMinted;

    /// @notice Whether a voucher nonce has been spent.
    mapping(uint256 => bool) public usedNonce;

    /**
     * @notice How much of a card has already been claimed to a player.
     *
     * Claims are cumulative: a player with 3 copies who claims, then draws a
     * 4th, claims again for the difference. Tracking the claimed total (rather
     * than a per-call allowance) makes a replayed or re-issued voucher a
     * no-op instead of a double mint.
     */
    mapping(address => mapping(uint256 => uint256)) public claimedBy;

    /**
     * @param signer_ the backend's voucher-signing address
     * @param baseUri metadata base, conventionally containing `{id}`
     *
     * Note `{id}` is *not* substituted by this contract. OpenZeppelin's
     * `uri()` returns the base verbatim; the `{id}` placeholder is a
     * convention that marketplaces and wallets expand themselves. Anything
     * reading metadata directly must do the same.
     */
    constructor(
        address signer_,
        string memory baseUri
    ) ERC1155(baseUri) EIP712("CardCollector", "1") Ownable(msg.sender) {
        require(signer_ != address(0), "signer required");
        signer = signer_;
    }

    /**
     * @notice The EIP-712 struct the backend signs to authorise a mint.
     *
     * `to` and `nonce` are both load-bearing:
     *
     * - Binding `to` stops anyone from taking a voucher they saw and claiming
     *   it to their own address.
     * - Making `nonce` unique (and single-use) stops the same voucher from
     *   being submitted twice.
     *
     * `deadline` lets a leaked-but-unused voucher expire on its own.
     */
    struct Voucher {
        address to;
        uint256 tokenId;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256(
            "Voucher(address to,uint256 tokenId,uint256 amount,uint256 nonce,uint256 deadline)"
        );

    /**
     * @notice Mint `voucher.amount` of `voucher.tokenId` to the caller.
     *
     * `amount` is the player's *total* holdings of that card as the server
     * knows them, so a claim mints only the difference. A voucher smaller
     * than the player's claimed total is rejected outright rather than
     * silently no-opped, so a desync surfaces instead of hiding.
     *
     * @param voucher the signed authorisation
     * @param signature the backend's signature over the voucher
     */
    function redeem(
        Voucher calldata voucher,
        bytes calldata signature
    ) external {
        require(voucher.to == msg.sender, "voucher issued to another address");
        require(block.timestamp <= voucher.deadline, "voucher expired");
        require(!usedNonce[voucher.nonce], "voucher already used");

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOUCHER_TYPEHASH,
                    voucher.to,
                    voucher.tokenId,
                    voucher.amount,
                    voucher.nonce,
                    voucher.deadline
                )
            )
        );
        require(ECDSA.recover(digest, signature) == signer, "bad signature");

        uint256 already = claimedBy[voucher.to][voucher.tokenId];
        require(voucher.amount > already, "nothing new to claim");
        uint256 delta = voucher.amount - already;

        // Effects before interactions: set the replay guards and the claimed
        // total before any external call, so a reentrant claim cannot observe
        // stale state.
        usedNonce[voucher.nonce] = true;
        claimedBy[voucher.to][voucher.tokenId] = voucher.amount;
        totalMinted[voucher.tokenId] += delta;

        _mint(voucher.to, voucher.tokenId, delta, "");

        emit CardClaimed(voucher.to, voucher.tokenId, delta, voucher.nonce);
    }

    /**
     * @notice The digest the backend must sign for `voucher`.
     *
     * Exposed so the server (and its tests) can produce exactly the bytes this
     * contract verifies, instead of reimplementing EIP-712 hashing and hoping
     * the two agree.
     */
    function hashVoucher(
        Voucher calldata voucher
    ) external view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        VOUCHER_TYPEHASH,
                        voucher.to,
                        voucher.tokenId,
                        voucher.amount,
                        voucher.nonce,
                        voucher.deadline
                    )
                )
            );
    }

    /**
     * @notice Set a new metadata base. Only the owner may call this.
     *
     * This needs an owner even though it moves no money: the URI is what a
     * wallet or marketplace fetches to render a card, so leaving it open
     * would let anyone point every card at a phishing page. Ownership is the
     * smallest thing that closes that, and it is deliberately the *only*
     * privileged action in this contract — there is no mint role, no pause,
     * and no withdrawal.
     *
     * @param baseUri the new base, conventionally containing `{id}`
     */
    function setUri(string calldata baseUri) external onlyOwner {
        _setURI(baseUri);
    }
}
