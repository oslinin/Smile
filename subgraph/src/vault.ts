import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  AquaCollateralVault,
  RangeAuthorized,
  AuthorizationRevoked,
  OptionBought,
  OptionClosed,
  CollateralReleased,
  PullFailed,
} from "../generated/AquaCollateralVault/AquaCollateralVault";
import { Authorization, Fill } from "../generated/schema";

// RangeAuthorized doesn't carry collateralToken or a live usedCollateral, and
// the vault's JIT-pull accounting is not something to re-implement in
// AssemblyScript (drift risk). One bound `authorizations(authId)` call per
// relevant event overwrites those fields straight from chain state instead —
// docs/plans/2026-09-09-theGraph.md G2. Tuple layout matches the vault's
// public getter (arrays are omitted from getters, so 17 flat values).
function refreshFromChain(auth: Authorization, vaultAddress: Address): void {
  let vault = AquaCollateralVault.bind(vaultAddress);
  let res = vault.try_authorizations(auth.authId);
  if (res.reverted) return;
  auth.maxCollateral = res.value.value4;
  auth.usedCollateral = res.value.value5;
  auth.collateralToken = res.value.value6;
  auth.active = res.value.value8;
}

export function handleRangeAuthorized(event: RangeAuthorized): void {
  let auth = new Authorization(event.params.authId.toString());
  auth.authId = event.params.authId;
  auth.lp = event.params.lp;
  auth.strikeMin = event.params.strikeMin;
  auth.strikeMax = event.params.strikeMax;
  auth.expiry = event.params.expiry;
  auth.isCall = event.params.isCall;
  auth.maxCollateral = event.params.maxCollateral;
  auth.usedCollateral = BigInt.zero();
  auth.collateralToken = Bytes.empty();
  auth.active = true;
  auth.fillCount = 0;
  auth.createdAtBlock = event.block.number;
  auth.createdAtTimestamp = event.block.timestamp;
  refreshFromChain(auth, event.address);
  auth.save();
}

export function handleAuthorizationRevoked(event: AuthorizationRevoked): void {
  let auth = Authorization.load(event.params.authId.toString());
  if (auth == null) return;
  auth.active = false;
  auth.revokedAtBlock = event.block.number;
  auth.save();
}

export function handleOptionBought(event: OptionBought): void {
  let id = event.params.authId.toString();
  let auth = Authorization.load(id);
  if (auth == null) return;

  let fill = new Fill(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  fill.authorization = id;
  fill.lp = auth.lp;
  fill.buyer = event.params.buyer;
  fill.optionToken = event.params.optionToken;
  fill.strike = event.params.strike;
  fill.amount = event.params.amount;
  fill.premium = event.params.premium;
  fill.isCall = auth.isCall;
  fill.expiry = auth.expiry;
  fill.blockNumber = event.block.number;
  fill.timestamp = event.block.timestamp;
  fill.save();

  auth.fillCount = auth.fillCount + 1;
  refreshFromChain(auth, event.address);
  auth.save();
}

// Sellbacks and post-settlement reclaims change usedCollateral; the events
// carry the series token, and the vault's seriesOf(token) maps it back to
// its authorization.
function refreshBySeries(optionToken: Address, vaultAddress: Address): void {
  let vault = AquaCollateralVault.bind(vaultAddress);
  let ref = vault.try_seriesOf(optionToken);
  if (ref.reverted) return;
  let auth = Authorization.load(ref.value.value0.toString());
  if (auth == null) return;
  refreshFromChain(auth, vaultAddress);
  auth.save();
}

export function handleOptionClosed(event: OptionClosed): void {
  refreshBySeries(event.params.optionToken, event.address);
}

export function handleCollateralReleased(event: CollateralReleased): void {
  refreshBySeries(event.params.optionToken, event.address);
}

// S2: a dishonored JIT pull deactivates the range on-chain — mirror it.
export function handlePullFailed(event: PullFailed): void {
  let auth = Authorization.load(event.params.authId.toString());
  if (auth == null) return;
  refreshFromChain(auth, event.address);
  auth.save();
}
