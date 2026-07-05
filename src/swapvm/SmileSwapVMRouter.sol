// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";

import { OptionPremiumInstruction } from "./OptionPremiumInstruction.sol";

/// @title SmileSwapVMRouter — custom Aqua app powered by the official SwapVM
/// @notice Extends the official 1inch `SwapVM` + `AquaOpcodes` instruction set
/// with one custom instruction: `_optionPremiumXD` (opcode 33), which prices
/// covered-call options with a parametric volatility smile.
///
/// This contract IS the Aqua app: LPs `Aqua.ship()` their option strategies to
/// this address, and during `swap()` the inherited SwapVM core performs the
/// just-in-time `Aqua.pull()` of collateral from the maker wallet and the
/// `Aqua.push()` of the taker's premium — no pre-deposited liquidity anywhere.
contract SmileSwapVMRouter is Simulator, SwapVM, AquaOpcodes, OptionPremiumInstruction {
    /// @notice Opcode index of the custom option-premium instruction.
    /// Official AquaOpcodes occupy indices 0–32; custom instructions start at 33.
    uint256 public constant OPCODE_OPTION_PREMIUM = 33;

    constructor(
        address aqua,
        address weth,
        address owner
    ) SwapVM(aqua, weth, owner, "SmileSwapVM", "1") AquaOpcodes(aqua) {}

    /// @dev Dispatch custom opcodes first, then fall through to the official set.
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == OPCODE_OPTION_PREMIUM) {
            OptionPremiumInstruction._optionPremiumXD(ctx, args);
        } else {
            AquaOpcodes._runOpcode(ctx, opcode, args);
        }
    }
}
