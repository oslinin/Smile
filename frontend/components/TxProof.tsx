"use client";

const SEPOLIA_TX = "https://sepolia.etherscan.io/tx/";
const SEPOLIA_ADDR = "https://sepolia.etherscan.io/address/";

const DEPLOYMENTS = [
  {
    label: "OptionPricingEngine",
    address: "0x90600176DA27Fc3Daf7AfD5266c80d1b15a23014",
    tx: "0x3cc7c4cac3caa27a89999f56b8de2b7fae1b4a4b238541a49ddf1bc5a2120bbc",
  },
  {
    label: "AquaCollateralVault",
    address: "0x0bD5e1510ACd217E55E6744bb9e98557b4309729",
    tx: "0x6708d90ca3e348b4fbed7f48227a702fb9ab079eeb249a2911499c0af020d6e9",
  },
  {
    label: "AquaOptionSettlement",
    address: "0x96381D3795A73Fc6a982A9B77D51f6d3F392aDCA",
    tx: "0x19e96e78501aa321eb9f79e94808a1fa3fc8787c9714d3b481aa13ad5c430368",
  },
  {
    label: "OptionToken",
    address: "0x0073016623f0D562a1DD383a36367E3b74A1D576",
    tx: "0x6222b516e71b075fd797d38d39c73f19e3e4917221032fa7f4e6cc8430299205",
  },
];

interface TxProofProps {
  recentSwapTx?: string;  // Uniswap swap tx hash from the buy flow
}

export function TxProof({ recentSwapTx }: TxProofProps) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
      <h3 className="text-gray-400 text-xs uppercase tracking-widest">On-Chain Proof · Sepolia</h3>

      <div className="space-y-2">
        {DEPLOYMENTS.map(({ label, address, tx }) => (
          <div key={label} className="flex items-center justify-between gap-4">
            <span className="text-gray-500 text-xs w-44 shrink-0">{label}</span>
            <div className="flex items-center gap-3 min-w-0">
              <a
                href={`${SEPOLIA_ADDR}${address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-blue-400 hover:text-blue-300 truncate"
              >
                {address.slice(0, 10)}…{address.slice(-6)}
              </a>
              <a
                href={`${SEPOLIA_TX}${tx}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-green-500 hover:text-green-400 whitespace-nowrap"
              >
                deploy tx ↗
              </a>
            </div>
          </div>
        ))}

        {recentSwapTx && (
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-gray-800">
            <span className="text-gray-500 text-xs w-44 shrink-0">Uniswap Premium Swap</span>
            <a
              href={`${SEPOLIA_TX}${recentSwapTx}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-pink-400 hover:text-pink-300"
            >
              {recentSwapTx.slice(0, 10)}…{recentSwapTx.slice(-6)} ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
