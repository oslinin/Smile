# Build Notes & Failures

Engineering war stories from the build, kept out of the README for brevity.


1. **HookMiner Latency**: Finding a Uniswap v4 Hook address with the required flag prefix took significantly longer than expected, delaying `OptionPricingHook` deployment.
2. **SwapVM Instruction Set**: The first iteration modeled SwapVM with a stand-in Solidity engine. It has since been replaced by a real custom instruction (opcode 33) on the official `SwapVM` + `AquaOpcodes` base — the maker strategy is genuine VM bytecode (`salt → deadline → optionPremium`) shipped through the official `Aqua.ship()`. Packing the option terms into the 255-byte instruction-args budget required a hand-packed 126-byte layout. Stack-too-deep errors were resolved by enabling `via_ir = true` in `foundry.toml`.
3. **Chainlink CRE Price Source**: An initial design fetched ETH/USD from CEX REST APIs per node, which hit Binance V3 rate limits and risked cross-node divergence during simulation. Resolved by reading the canonical Chainlink ETH/USD aggregator on-chain at the last finalized block — every DON node observes the same value, so settlement consensus is deterministic and matches the price the app displays.
4. **GitHub Pages SPA Routing**: Next.js static export broke on refresh. Fixed with `.nojekyll` and static export config.

---
