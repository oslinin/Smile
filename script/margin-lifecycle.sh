#!/usr/bin/env bash
# Full MarginVault lifecycle on the ./local.sh Anvil, as real transactions:
#   writer opens + ships a margined put range → taker buys an ATM put (only
#   IM is pulled) → the oracle crashes → anyone flags → 1 h grace → a post-
#   flag round confirms → auction → either a bidder takes over or, after
#   30 min, the backstop absorbs → expiry → permissionless settlement →
#   settlePosition → finalizeSeries → holder redeems.
#
# Needs the stack from ./local.sh (addresses read from frontend/.env.local).
# Time is advanced with Anvil's evm_increaseTime.
#
#   ./script/margin-lifecycle.sh                 # backstop absorbs, settles at $2,000
#   MODE=takeover ./script/margin-lifecycle.sh   # a second writer takes the position over
#   SETTLE_USD=1500 ./script/margin-lifecycle.sh
set -euo pipefail

RPC=${RPC:-http://localhost:8545}
ENV_FILE="$(dirname "$0")/../frontend/.env.local"
get() { grep "^$1=" "$ENV_FILE" | cut -d= -f2; }
MV=${MV:-$(get NEXT_PUBLIC_MARGIN_VAULT)}
BACKSTOP=${BACKSTOP:-$(get NEXT_PUBLIC_MARGIN_BACKSTOP)}
SETTLEMENT=${SETTLEMENT:-$(get NEXT_PUBLIC_MARGIN_SETTLEMENT)}
AQUA=${AQUA:-$(get NEXT_PUBLIC_AQUA)}
USDC=${USDC:-$(get NEXT_PUBLIC_USDC_ADDRESS)}
ORACLE=${ORACLE:-$(get NEXT_PUBLIC_SPOT_ORACLE)}
# Anvil's default accounts: 0 writer, 1 holder, 2 keeper/bidder — local dev keys only.
LP_KEY=${LP_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
HOLDER_KEY=${HOLDER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}
KEEPER_KEY=${KEEPER_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}
LP=$(cast wallet address --private-key "$LP_KEY")
HOLDER=$(cast wallet address --private-key "$HOLDER_KEY")
KEEPER=$(cast wallet address --private-key "$KEEPER_KEY")
MODE=${MODE:-absorb}
CRASH_USD=${CRASH_USD:-2000}
SETTLE_USD=${SETTLE_USD:-2000}
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
K=3000000000000000000000
UNITS=1000000000000000000

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
usdc() { python3 -c "print(f'{int(\"$1\")/1e6:,.2f} USDC')"; }
warp() { cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null 2>&1; cast rpc --rpc-url "$RPC" evm_mine >/dev/null 2>&1; }
post() { send $KEEPER_KEY $ORACLE "setAnswer(int256)" $(( $1 * 100000000 )) >/dev/null; }
ship_args() { python3 -c '
import json,sys
app,strategy,tokens,amounts=json.load(sys.stdin)
print(app); print(strategy); print("["+",".join(tokens)+"]"); print("["+",".join(str(int(a)) for a in amounts)+"]")'; }
locked() { call $MV 'positions(bytes32,address)(uint256,uint256,uint256,uint64,uint64,address)' $SID $1 | sed -n 3p | num; }

# A clean mark: the worst-of-hour window must not still contain a crash
# from a previous run, or the fill would lock IM off that instead of $3,000.
post 3000; warp 3700; post 3000
NOW=$(cast block latest --rpc-url "$RPC" -f timestamp 2>/dev/null)
EXPIRY=$((NOW + 86400))
SID=$(call $MV 'seriesId(uint256,uint256)(bytes32)' $K $EXPIRY)
echo "margin vault $MV  backstop $BACKSTOP  settlement $SETTLEMENT"
echo "writer $LP  holder $HOLDER  keeper/bidder $KEEPER  mode $MODE"
echo "backstop pool $(usdc $(call $BACKSTOP 'totalAssets()(uint256)' | num))  insurance $(usdc $(call $MV 'insuranceFund()(uint256)' | num))  ceiling $(usdc $(call $MV 'effectiveCeiling()(uint256)' | num))"

echo; echo "── 1. writer opens + ships a 2500–3500 put range, 10,000 USDC of margin capacity, expiring in 24h ──"
AUTH=$(call $MV 'nextAuthId()(uint256)' | num)
echo "openRange #$AUTH:    $(send $LP_KEY $MV 'openRange(uint256,uint256,uint256,uint256,uint16,bool,uint16)' 2500000000000000000000 3500000000000000000000 $EXPIRY 10000000000 0 false 0)"
send $LP_KEY $USDC "approve(address,uint256)" $AQUA $MAX >/dev/null
mapfile -t S < <(call $MV 'getShipParams(uint256)(address,bytes,address[],uint256[])' $AUTH --json | ship_args)
echo "aqua.ship:          $(send $LP_KEY $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"

echo; echo "── 2. holder buys 1 ATM put (\$3,000) ──"
Q=$(call $MV 'quote(uint256,uint256,uint256)(uint256,uint256)' $AUTH $K $UNITS | num | tr '\n' ' ')
echo "quote (premium fee): $Q   initial margin: $(usdc $(call $MV 'initialMargin(uint256,uint256,uint256)(uint256)' $AUTH $K $UNITS | num))"
send $HOLDER_KEY $USDC "approve(address,uint256)" $MV $MAX >/dev/null
LP0=$(call $USDC 'balanceOf(address)(uint256)' $LP | num)
echo "buy:                $(send $HOLDER_KEY $MV 'buy(uint256,uint256,uint256,uint256)' $AUTH $K $UNITS $MAX)"
LP1=$(call $USDC 'balanceOf(address)(uint256)' $LP | num)
TOKEN=$(call $MV 'seriesOf(bytes32)(uint256,uint256,address,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint16)' $SID | sed -n 3p)
echo "writer locked $(usdc $(locked $LP)) (wallet moved $(usdc $((LP0 - LP1))) net of premium) — the main vault would have locked 3,000.00 USDC"

echo; echo "── 3. ETH crashes to \$$CRASH_USD: MM > locked, the keeper flags ──"
warp 300; post $CRASH_USD
H=$(call $MV 'health(bytes32,address)(uint256,uint256,uint256)' $SID $LP | num | tr '\n' ' ')
echo "health (locked mm im): $H"
echo "flag:               $(send $KEEPER_KEY $MV 'flag(bytes32,address)' $SID $LP)"

echo; echo "── 4. one hour of grace, a post-flag round still at \$$CRASH_USD, the auction opens ──"
warp 3660; post $CRASH_USD
echo "startAuction:       $(send $KEEPER_KEY $MV 'startAuction(bytes32,address)' $SID $LP)"

if [ "$MODE" = takeover ]; then
  echo; echo "── 5. 15 minutes in (bonus 5.5%), a second writer takes the position over ──"
  warp 900; post $CRASH_USD
  send $KEEPER_KEY $USDC "mint(address,uint256)" $KEEPER 5000000000 >/dev/null   # Anvil mock USDC: fund the bidder
  send $KEEPER_KEY $USDC "approve(address,uint256)" $MV $MAX >/dev/null
  echo "takeOver:           $(send $KEEPER_KEY $MV 'takeOver(bytes32,address)' $SID $LP)"
  NEWWRITER=$KEEPER
  echo "bidder now locked $(usdc $(locked $KEEPER)); old writer locked $(usdc $(locked $LP))"
else
  echo; echo "── 5. nobody bids for 30 minutes: the backstop absorbs, drawing only the shortfall to MM ──"
  warp 1860; post $CRASH_USD
  P0=$(call $BACKSTOP 'totalAssets()(uint256)' | num)
  echo "absorb:             $(send $KEEPER_KEY $MV 'absorb(bytes32,address)' $SID $LP)"
  P1=$(call $BACKSTOP 'totalAssets()(uint256)' | num)
  NEWWRITER=$BACKSTOP
  echo "backstop now locked $(usdc $(locked $BACKSTOP)) after drawing $(usdc $((P0 - P1))); old writer locked $(usdc $(locked $LP))"
fi
echo "holder still holds $(python3 -c "print(int('$(call $TOKEN 'balanceOf(address)(uint256)' $HOLDER | num)')/1e18)") option — untouched throughout"

echo; echo "── 6. expiry at \$$SETTLE_USD: permissionless settlement, waterfall, finalize, redeem ──"
NOW=$(cast block latest --rpc-url "$RPC" -f timestamp 2>/dev/null)
warp $((EXPIRY - NOW + 60)); post $SETTLE_USD
ROUND=$(call $ORACLE 'latestRound()(uint80)' | num)
echo "settleWithChainlinkRound(round $ROUND): $(send $KEEPER_KEY $SETTLEMENT 'settleWithChainlinkRound(bytes32,uint80)' $SID $ROUND)"
echo "settlePosition:     $(send $KEEPER_KEY $MV 'settlePosition(bytes32,address)' $SID $NEWWRITER)"
echo "finalizeSeries:     $(send $KEEPER_KEY $MV 'finalizeSeries(bytes32)' $SID)"
H0=$(call $USDC 'balanceOf(address)(uint256)' $HOLDER | num)
echo "redeem:             $(send $HOLDER_KEY $MV 'redeem(bytes32,uint256)' $SID $UNITS)"
H1=$(call $USDC 'balanceOf(address)(uint256)' $HOLDER | num)
OWED=$(python3 -c "print(max(0, 3000 - $SETTLE_USD) * 1000000)")
echo
echo "holder received  $(usdc $((H1 - H0)))   (intrinsic owed: $(usdc $OWED))"
echo "backstop pool    $(usdc $(call $BACKSTOP 'totalAssets()(uint256)' | num))   insurance $(usdc $(call $MV 'insuranceFund()(uint256)' | num))   naked notional $(usdc $(call $MV 'nakedNotional()(uint256)' | num))"
if [ $((H1 - H0)) -eq "$OWED" ]; then echo "holders whole:   ✓"; else echo "holders took a haircut (see HolderHaircut event)"; fi
