# CRE CLI Simulation — Verified Output

Full transcript of the verified `cre workflow simulate settlement` run
(referenced from the README).

> **Historical note:** this run predates the settlement registry's move to WAD
> (18-dec) prices — the workflow at the time wrote USDC 6-dec, hence the
> `1675280000` result. The current workflow writes `answer * 1e10` (WAD); the
> trigger → feed read → consensus → signed-report path shown here is unchanged.

Verified output (CLI v1.11.0, reading the live Sepolia ETH/USD feed — exit code `0`):

```text
Initializing...
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  HTTP: req=120kb resp=250kb timeout=10s | ConfHTTP: req=125kb resp=500kb timeout=1m30s | Consensus obs=25kb | ChainWrite report=50kb gas=10000000 | WASM binary=100mb compressed=20mb
  Binary hash: 9d57d352ac4d3e6ca2e4540cd52e22875e93e15e96f557c8a6c9bfc35fe24b38
  Config hash: 09b81d8b718c888f7c668324102c18f369f49391a15adee7cbc76e576aea9331
2026-06-14T07:00:26Z [SIMULATION] Simulator Initialized

2026-06-14T07:00:26Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-06-14T07:00:26Z [USER LOG] [CRE] Option settlement workflow triggered
2026-06-14T07:00:26Z [USER LOG] [CRE] Chainlink ETH/USD: $1675.28
2026-06-14T07:00:26Z [USER LOG] [CRE] settleSeries(0x0000…0001, 1675280000) submitted — tx 0x0000…0000

✓ Workflow Simulation Result:
"1675280000"

2026-06-14T07:00:26Z [SIMULATION] Execution finished signal received
2026-06-14T07:00:26Z [SIMULATION] Skipping WorkflowEngineV2
2026-06-14T07:00:26Z [SIMULATION] Failed to cleanup beholder error=BeholderClient has not been started: cannot stop unstarted service

╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
│                                                      │
│ Run cre account access to request deployment access. │
╰──────────────────────────────────────────────────────╯
```

`1675280000` is the feed price ($1,675.28) in USDC 6-decimal fixed-point. Notes on the
output:

- **The tx hash is zero** because a plain simulation routes the EVM write through a
  **mock** forwarder rather than broadcasting — the trigger → feed read → DON consensus →
  report-signing path is fully exercised, which is what the CRE CLI simulation verifies.
- **`Failed to cleanup beholder …`** is a benign teardown log printed *after* the result;
  the simulator stops a telemetry client it never started in local mode. The run still
  exits `0`. Filter it for a clean demo: `… | grep -v "Failed to cleanup beholder"`.
