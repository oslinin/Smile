#!/usr/bin/env bash
# Full SpreadVault lifecycle on the ./local.sh Anvil, as real transactions:
#   open (1h expiry) → ship → buy → time passes → oracle posts a post-expiry
#   round → permissionless settleWithChainlinkRound → holder redeems →
#   writer reclaims → conservation check (payout + reclaim == escrow).
#
# This is the 1inch "onchain execution of token transfers during the demo"
# in one command. Needs the Anvil stack from ./local.sh (addresses are read
# from frontend/.env.local); time is advanced with Anvil's evm_increaseTime.
#
#   ./script/spread-lifecycle.sh            # settles at $3,100 (between the strikes)
#   SETTLE_USD=3300 ./script/spread-lifecycle.sh
set -euo pipefail

RPC=${RPC:-http://localhost:8545}
ENV_FILE="$(dirname "$0")/../frontend/.env.local"
get() { grep "^$1=" "$ENV_FILE" | cut -d= -f2; }
SPREAD=${SPREAD:-$(get NEXT_PUBLIC_SPREAD_VAULT)}
AQUA=${AQUA:-$(get NEXT_PUBLIC_AQUA)}
WETH=${WETH:-$(get NEXT_PUBLIC_WETH_ADDRESS)}
USDC=${USDC:-$(get NEXT_PUBLIC_USDC_ADDRESS)}
ORACLE=${ORACLE:-$(get NEXT_PUBLIC_SPOT_ORACLE)}
# Anvil's default accounts 0 (writer) and 1 (holder) — local dev keys only.
LP_KEY=${LP_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
HOLDER_KEY=${HOLDER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}
LP=$(cast wallet address --private-key "$LP_KEY")
HOLDER=$(cast wallet address --private-key "$HOLDER_KEY")
UNITS=${UNITS:-1000000000000000000}
SETTLE_USD=${SETTLE_USD:-3100}
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
K1=3000000000000000000000; K2=3200000000000000000000

# Prints "<hash…> status 0x1" on success; on failure prints the node's error
# and returns non-zero (a revert selector, if any, is in the message).
send() {
  local key=$1; shift
  local out
  if ! out=$(cast send --rpc-url "$RPC" --private-key "$key" --json "$@" 2>&1); then
    echo "FAILED: $(echo "$out" | grep -v no_persistence | tail -1)"; return 1
  fi
  echo "$out" | grep -v no_persistence | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["transactionHash"][:18]+"…", "status", d["status"])'
}
call() { cast call --rpc-url "$RPC" "$@" 2>/dev/null; }
num() { cut -d' ' -f1; }
ship_args() { python3 -c '
import json,sys
app,strategy,tokens,amounts=json.load(sys.stdin)
print(app); print(strategy); print("["+",".join(tokens)+"]"); print("["+",".join(str(int(a)) for a in amounts)+"]")'; }

SETTLEMENT=$(call $SPREAD 'settlement()(address)')
ESCROW=$(python3 -c "u=int('$UNITS'); print((u*200 + 3199)//3200)")   # (K2-K1)/K2 WETH, ceil
NOW=$(cast block latest --rpc-url "$RPC" -f timestamp 2>/dev/null)
EXPIRY=$((NOW + 3600))

echo "spread $SPREAD  settlement $SETTLEMENT  oracle $ORACLE"
echo "writer $LP  holder $HOLDER  units $UNITS  escrow $ESCROW wei"

echo; echo "── 1. writer opens + ships a 3000/3200 call credit spread (expires in 1h) ──"
AUTH=$(call $SPREAD 'nextAuthId()(uint256)' | num)
echo "openStructure #$AUTH: $(send $LP_KEY $SPREAD 'openStructure(uint8,uint256[4],uint256,uint256)' 0 "[0,0,$K1,$K2]" $EXPIRY $ESCROW)"
send $LP_KEY $WETH "approve(address,uint256)" $AQUA $ESCROW >/dev/null
mapfile -t S < <(call $SPREAD 'getShipParams(uint256)(address,bytes,address[],uint256[])' $AUTH --json | ship_args)
echo "aqua.ship:        $(send $LP_KEY $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"

echo; echo "── 2. holder buys $UNITS units ──"
QUOTE=$(call $SPREAD 'quote(uint256,uint256)(uint256,uint256,uint256)' $AUTH $UNITS | num | tr '\n' ' ')
echo "quote (premium fee escrow): $QUOTE"
send $HOLDER_KEY $USDC "approve(address,uint256)" $SPREAD $MAX >/dev/null
LP_WETH_0=$(call $WETH 'balanceOf(address)(uint256)' $LP | num)
echo "buy:              $(send $HOLDER_KEY $SPREAD 'buy(uint256,uint256,uint256)' $AUTH $UNITS $MAX)"
LP_WETH_1=$(call $WETH 'balanceOf(address)(uint256)' $LP | num)
TOKEN=$(call $SPREAD 'spreadTokens(uint256)(address)' $AUTH)
echo "pulled from writer: $((LP_WETH_0 - LP_WETH_1)) wei  (a naked short leg would lock $UNITS)"

echo; echo "── 3. time passes, the oracle posts the first round after expiry, anyone settles ──"
cast rpc --rpc-url "$RPC" evm_increaseTime 3700 >/dev/null 2>&1
cast rpc --rpc-url "$RPC" evm_mine >/dev/null 2>&1
send $LP_KEY $ORACLE "setAnswer(int256)" $((SETTLE_USD * 100000000)) >/dev/null
ROUND=$(call $ORACLE 'latestRound()(uint80)' | num)
SERIES=$(call $SPREAD 'seriesId(uint256)(bytes32)' $AUTH)
echo "settleWithChainlinkRound(round $ROUND, \$$SETTLE_USD): $(send $HOLDER_KEY $SETTLEMENT 'settleWithChainlinkRound(bytes32,uint80)' $SERIES $ROUND)"

echo; echo "── 4. holder redeems, writer reclaims ──"
H0=$(call $WETH 'balanceOf(address)(uint256)' $HOLDER | num)
if OUT=$(send $HOLDER_KEY $SPREAD 'redeem(uint256,uint256)' $AUTH $UNITS); then echo "redeem:           $OUT"; else echo "redeem:           $OUT"; exit 1; fi
H1=$(call $WETH 'balanceOf(address)(uint256)' $HOLDER | num)
L0=$(call $WETH 'balanceOf(address)(uint256)' $LP | num)
if OUT=$(send $LP_KEY $SPREAD 'reclaim(uint256)' $AUTH); then echo "reclaim:          $OUT"; else echo "reclaim:          $OUT  (NothingToReclaim is expected when the holder was owed the entire escrow)"; fi
L1=$(call $WETH 'balanceOf(address)(uint256)' $LP | num)
PAYOUT=$((H1 - H0)); RECLAIMED=$((L1 - L0))
echo
echo "holder payout   $PAYOUT wei"
echo "writer reclaim  $RECLAIMED wei"
echo "escrow          $ESCROW wei"
if [ $((PAYOUT + RECLAIMED)) -eq "$ESCROW" ]; then echo "conservation:   payout + reclaim == escrow  ✓"; else echo "conservation:   MISMATCH"; exit 1; fi
echo "vault WETH left: $(call $WETH 'balanceOf(address)(uint256)' $SPREAD | num) wei   spread token supply: $(call $TOKEN 'totalSupply()(uint256)' | num)"
