#!/usr/bin/env bash
# R6 hybrid RFQ on the ./local.sh Anvil, as real transactions plus one
# off-chain signature:
#   LP opens + ships a call range → LP signs an EIP-712 quote 1% inside the
#   formula Ask (cast wallet sign, no gas) → taker fills it → 1 WETH is pulled
#   JIT from the LP wallet through Aqua at the fill → the same nonce cannot
#   be filled twice.
#
#   ./script/rfq-lifecycle.sh
#   IMPROVE_BPS=250 ./script/rfq-lifecycle.sh
set -euo pipefail

RPC=${RPC:-http://localhost:8545}
ENV_FILE="$(dirname "$0")/../frontend/.env.local"
get() { grep "^$1=" "$ENV_FILE" | cut -d= -f2; }
RFQ=${RFQ:-$(get NEXT_PUBLIC_RFQ_VAULT)}
AQUA=${AQUA:-$(get NEXT_PUBLIC_AQUA)}
WETH=${WETH:-$(get NEXT_PUBLIC_WETH_ADDRESS)}
USDC=${USDC:-$(get NEXT_PUBLIC_USDC_ADDRESS)}
CHAIN_ID=${CHAIN_ID:-$(get NEXT_PUBLIC_CHAIN_ID)}
# Anvil's default accounts 0 (LP) and 1 (taker) — local dev keys only.
LP_KEY=${LP_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
TAKER_KEY=${TAKER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}
LP=$(cast wallet address --private-key "$LP_KEY")
TAKER=$(cast wallet address --private-key "$TAKER_KEY")
IMPROVE_BPS=${IMPROVE_BPS:-100}
K=3000000000000000000000
UNITS=1000000000000000000
MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935

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
usdc() { python3 -c "print(f'{int(\"$1\")/1e6:,.4f} USDC')"; }
ship_args() { python3 -c '
import json,sys
app,strategy,tokens,amounts=json.load(sys.stdin)
print(app); print(strategy); print("["+",".join(tokens)+"]"); print("["+",".join(str(int(a)) for a in amounts)+"]")'; }

NOW=$(cast block latest --rpc-url "$RPC" -f timestamp 2>/dev/null)
EXPIRY=$((NOW + 30 * 86400))
echo "rfq vault $RFQ  chain $CHAIN_ID  LP $LP  taker $TAKER"

echo; echo "── 1. LP opens + ships a 2500–3500 call range, 1 WETH capacity ──"
AUTH=$(call $RFQ 'nextAuthId()(uint256)' | num)
echo "openRange #$AUTH:   $(send $LP_KEY $RFQ 'openRange(uint256,uint256,uint256,uint256,bool)' 2500000000000000000000 3500000000000000000000 $EXPIRY $UNITS true)"
send $LP_KEY $WETH "approve(address,uint256)" $AQUA $MAX >/dev/null
mapfile -t S < <(call $RFQ 'getShipParams(uint256)(address,bytes,address[],uint256[])' $AUTH --json | ship_args)
echo "aqua.ship:        $(send $LP_KEY $AQUA 'ship(address,bytes,address[],uint256[])' "${S[0]}" "${S[1]}" "${S[2]}" "${S[3]}")"

echo; echo "── 2. LP signs a quote $IMPROVE_BPS bps inside the formula Ask — off-chain, no gas ──"
FORMULA=$(call $RFQ 'formulaQuote(uint256,uint256,uint256)(uint256,uint256)' $AUTH $K $UNITS | head -1 | num)
PPU=$(python3 -c "print(int('$FORMULA') * (10000 - $IMPROVE_BPS) // 10000 * 10**18 // int('$UNITS'))")
TTL=$((NOW + 600)); NONCE=$(date +%s%N)
TYPED=$(python3 -c "
import json
print(json.dumps({
 'types': {'EIP712Domain':[{'name':'name','type':'string'},{'name':'version','type':'string'},{'name':'chainId','type':'uint256'},{'name':'verifyingContract','type':'address'}],
           'Quote':[{'name':'authId','type':'uint256'},{'name':'strike','type':'uint256'},{'name':'maxAmount','type':'uint256'},{'name':'premiumPerUnit','type':'uint256'},{'name':'ttl','type':'uint256'},{'name':'nonce','type':'uint256'}]},
 'primaryType':'Quote',
 'domain': {'name':'Smile RFQ','version':'1','chainId': '$CHAIN_ID','verifyingContract':'$RFQ'},
 'message': {'authId': '$AUTH','strike': '$K','maxAmount': '$UNITS','premiumPerUnit': '$PPU','ttl': '$TTL','nonce': '$NONCE'}}))")
SIG=$(cast wallet sign --private-key "$LP_KEY" --data "$TYPED")
Q="($AUTH,$K,$UNITS,$PPU,$TTL,$NONCE)"
echo "formula Ask     $(usdc $FORMULA)"
echo "signed quote    $(usdc $(call $RFQ 'fillCost((uint256,uint256,uint256,uint256,uint256,uint256),uint256)(uint256,uint256)' "$Q" $UNITS | head -1 | num))   ttl +10min  nonce $NONCE"
echo "signature       ${SIG:0:20}…  (EIP-712, domain 'Smile RFQ' v1, chain $CHAIN_ID, vault $RFQ)"

echo; echo "── 3. taker fills the quote ──"
send $TAKER_KEY $USDC "approve(address,uint256)" $RFQ $MAX >/dev/null
LP0=$(call $WETH 'balanceOf(address)(uint256)' $LP | num); T0=$(call $USDC 'balanceOf(address)(uint256)' $TAKER | num)
echo "fill:             $(send $TAKER_KEY $RFQ 'fill((uint256,uint256,uint256,uint256,uint256,uint256),bytes,uint256,uint256)' "$Q" "$SIG" $UNITS $MAX)"
LP1=$(call $WETH 'balanceOf(address)(uint256)' $LP | num); T1=$(call $USDC 'balanceOf(address)(uint256)' $TAKER | num)
TOKEN=$(call $RFQ 'optionTokens(uint256,uint256)(address)' $AUTH $K)
echo "taker paid      $(usdc $((T0 - T1))) (quote + 1% fee)   vs formula + fee $(usdc $(python3 -c "f=int('$FORMULA'); print(f + (f*10000000 + 990000000 - 1)//990000000)"))"
echo "LP wallet       -$(python3 -c "print(($LP0 - $LP1)/1e18)") WETH pulled JIT through Aqua at the fill"
echo "taker holds     $(python3 -c "print(int('$(call $TOKEN 'balanceOf(address)(uint256)' $TAKER | num)')/1e18)") CALL-3000 ($TOKEN)"

echo; echo "── 4. the same quote cannot be filled twice ──"
if OUT=$(send $TAKER_KEY $RFQ 'fill((uint256,uint256,uint256,uint256,uint256,uint256),bytes,uint256,uint256)' "$Q" "$SIG" $UNITS $MAX); then echo "second fill:      $OUT  (UNEXPECTED)"; exit 1; else echo "second fill:      $OUT"; fi
echo "nonce used:     $(call $RFQ 'nonceUsed(address,uint256)(bool)' $LP $NONCE)"
