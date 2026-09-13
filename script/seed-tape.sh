#!/usr/bin/env bash
# Seeds a trade tape via script/SeedTape.s.sol. On Anvil (31337) the trades
# are split into batches ~6 simulated hours apart with the mock oracle
# random-walking ±1.5% between them, so premiums and implied vol move across
# the tape. On any other chain: one batch, real time, oracle untouched.
#
#   ./script/seed-tape.sh                       # 100 trades, 10 batches
#   SEED_TRADES=30 SEED_BATCHES=3 ./script/seed-tape.sh
#   VAULT=… AQUA=… WETH=… USDC=… RPC_URL=https://… PRIVATE_KEY=… BUYER_KEY=… ./script/seed-tape.sh
set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL=${RPC_URL:-http://localhost:8545}
get() { grep "^$1=" frontend/.env.local 2>/dev/null | cut -d= -f2; }
export VAULT=${VAULT:-$(get NEXT_PUBLIC_AQUA_VAULT)}
export AQUA=${AQUA:-$(get NEXT_PUBLIC_AQUA)}
export WETH=${WETH:-$(get NEXT_PUBLIC_WETH_ADDRESS)}
export USDC=${USDC:-$(get NEXT_PUBLIC_USDC_ADDRESS)}
ORACLE=${ORACLE:-$(get NEXT_PUBLIC_SPOT_ORACLE)}
# Anvil's default accounts 0 (LP) and 1 (buyer) — local dev keys only.
export PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
export BUYER_KEY=${BUYER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}
export SEED_TRADES=${SEED_TRADES:-100}

if [ "$(cast chain-id --rpc-url "$RPC_URL")" = 31337 ]; then
  export SEED_BATCHES=${SEED_BATCHES:-10}
  PRICE=$(cast call --rpc-url "$RPC_URL" "$ORACLE" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" | sed -n 2p | cut -d' ' -f1)
  RANDOM=42  # reproducible walk
else
  export SEED_BATCHES=1
fi

for ((b = 0; b < SEED_BATCHES; b++)); do
  if [ "$b" -gt 0 ]; then
    cast rpc --rpc-url "$RPC_URL" evm_increaseTime $((6 * 3600)) >/dev/null 2>&1
    cast rpc --rpc-url "$RPC_URL" evm_mine >/dev/null 2>&1
    # Posting a round also refreshes updatedAt — without it the vault's 1 h
    # staleness bound would reject every buy after the warp.
    PRICE=$((PRICE + PRICE * (RANDOM % 301 - 150) / 10000))
    cast send --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" "$ORACLE" "setAnswer(int256)" "$PRICE" >/dev/null 2>&1
  fi
  out=$(SEED_BATCH=$b forge script script/SeedTape.s.sol:SeedTape --rpc-url "$RPC_URL" --broadcast --skip-simulation 2>&1) \
    || { echo "$out" | tail -20; exit 1; }
  echo "  batch $((b + 1))/$SEED_BATCHES — $(echo "$out" | grep -o 'seed: .*')"
done
