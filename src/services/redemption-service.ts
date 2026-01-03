import { ethers, BigNumber } from "ethers";

const POLYGON_RPC = "https://polygon-rpc.com";
const DATA_API = "https://data-api.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const NEG_RISK_ADAPTER = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool)",
];

const CTF_ABI = ["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"];

enum OperationType {
  Call = 0,
  DelegateCall = 1,
}

interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  operation: OperationType;
}

interface Position {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  outcome: string;
  outcomeIndex: number;
  negativeRisk: boolean;
}

interface RedemptionResult {
  conditionId: string;
  success: boolean;
  txHash?: string;
  error?: string;
  sharesRedeemed: number;
}

function joinHexData(hexData: string[]): string {
  return `0x${hexData
    .map((hex) => {
      const stripped = hex.replace(/^0x/, "");
      return stripped.length % 2 === 0 ? stripped : "0" + stripped;
    })
    .join("")}`;
}

function abiEncodePacked(...params: { type: string; value: any }[]): string {
  return joinHexData(
    params.map(({ type, value }) => {
      const encoded = ethers.utils.defaultAbiCoder.encode([type], [value]);

      if (type === "bytes" || type === "string") {
        const bytesLength = parseInt(encoded.slice(66, 130), 16);
        return encoded.slice(130, 130 + 2 * bytesLength);
      }

      const typeMatch = type.match(/^u?int(\d*)$/);
      if (typeMatch) {
        if (typeMatch[1] !== "") {
          const bytesLength = parseInt(typeMatch[1]) / 8;
          return encoded.slice(-2 * bytesLength);
        }
        return encoded.slice(-64);
      }

      if (type === "address") {
        return encoded.slice(-40);
      }

      throw new Error(`unsupported type ${type}`);
    })
  );
}

async function signTransactionHash(signer: ethers.Wallet, message: string) {
  const messageArray = ethers.utils.arrayify(message);
  let sig = await signer.signMessage(messageArray);
  let sigV = parseInt(sig.slice(-2), 16);

  switch (sigV) {
    case 0:
    case 1:
      sigV += 31;
      break;
    case 27:
    case 28:
      sigV += 4;
      break;
    default:
      throw new Error("Invalid signature");
  }

  sig = sig.slice(0, -2) + sigV.toString(16);

  return {
    r: BigNumber.from("0x" + sig.slice(2, 66)).toString(),
    s: BigNumber.from("0x" + sig.slice(66, 130)).toString(),
    v: BigNumber.from("0x" + sig.slice(130, 132)).toString(),
  };
}

async function signAndExecuteSafeTransaction(
  signer: ethers.Wallet,
  safe: ethers.Contract,
  txn: SafeTransaction,
  overrides?: ethers.Overrides
): Promise<ethers.providers.TransactionResponse> {
  if (overrides == null) {
    overrides = {};
  }

  const nonce = await safe.nonce();
  const safeTxGas = "0";
  const baseGas = "0";
  const gasPrice = "0";
  const gasToken = ethers.constants.AddressZero;
  const refundReceiver = ethers.constants.AddressZero;

  const txHash = await safe.getTransactionHash(txn.to, txn.value, txn.data, txn.operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce);

  const rsvSignature = await signTransactionHash(signer, txHash);
  const packedSig = abiEncodePacked(
    { type: "uint256", value: rsvSignature.r },
    { type: "uint256", value: rsvSignature.s },
    { type: "uint8", value: rsvSignature.v }
  );

  return safe.execTransaction(txn.to, txn.value, txn.data, txn.operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, packedSig, overrides);
}

function encodeRedeem(collateralToken: string, conditionId: string): string {
  const iface = new ethers.utils.Interface(CTF_ABI);
  return iface.encodeFunctionData("redeemPositions", [collateralToken, ethers.constants.HashZero, conditionId, [1, 2]]);
}

async function fetchPositions(userAddress: string): Promise<Position[]> {
  const url = `${DATA_API}/positions?user=${userAddress}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`Failed to fetch positions: ${response.statusText}`);
    }
    return response.json();
  } catch (error: any) {
    clearTimeout(timeout);
    if (error.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  }
}

export class RedemptionService {
  private provider: ethers.providers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private userAddress: string;
  private isSafeWallet: boolean;
  private pollIntervalMs: number;
  private isRunning: boolean = false;

  constructor(options: { privateKey: string; funderAddress?: string; pollIntervalMs?: number }) {
    this.provider = new ethers.providers.JsonRpcProvider(POLYGON_RPC);
    this.wallet = new ethers.Wallet(options.privateKey, this.provider);
    this.userAddress = options.funderAddress || this.wallet.address;
    this.isSafeWallet = !!options.funderAddress && options.funderAddress.toLowerCase() !== this.wallet.address.toLowerCase();
    this.pollIntervalMs = options.pollIntervalMs || 30000; // Default 30 seconds
  }

  async redeemPosition(conditionId: string, isNegRisk: boolean): Promise<RedemptionResult> {
    const targetContract = isNegRisk ? NEG_RISK_ADAPTER : CTF_ADDRESS;
    const calldata = encodeRedeem(USDC_ADDRESS, conditionId);

    try {
      let tx: ethers.providers.TransactionResponse;
      console.log(`[RedemptionService] Sending transaction...`);

      // Get gas price with 100% boost for faster confirmation (Polygon can be congested)
      const gasPrice = await this.provider.getGasPrice();
      const boostedGasPrice = gasPrice.mul(200).div(100);
      // Get pending nonce to handle stuck transactions
      const nonce = await this.provider.getTransactionCount(this.wallet.address, "pending");
      const overrides: ethers.Overrides = { gasPrice: boostedGasPrice, nonce };

      if (this.isSafeWallet) {
        const safe = new ethers.Contract(this.userAddress, SAFE_ABI, this.wallet);
        const txn: SafeTransaction = {
          to: targetContract,
          value: "0",
          data: calldata,
          operation: OperationType.Call,
        };
        tx = await signAndExecuteSafeTransaction(this.wallet, safe, txn, overrides);
      } else {
        const contract = new ethers.Contract(targetContract, CTF_ABI, this.wallet);
        tx = await contract.redeemPositions(USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2], overrides);
      }

      console.log(`[RedemptionService] TX sent: ${tx.hash}, waiting for confirmation...`);

      // Wait with timeout (60 seconds)
      const receiptPromise = tx.wait();
      const timeoutPromise = new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Transaction confirmation timeout")), 60000));

      const receipt = await Promise.race([receiptPromise, timeoutPromise]);

      if (!receipt) {
        return {
          conditionId,
          success: false,
          txHash: tx.hash,
          error: "Transaction sent but confirmation timed out",
          sharesRedeemed: 0,
        };
      }

      return {
        conditionId,
        success: receipt.status === 1,
        txHash: tx.hash,
        sharesRedeemed: 0,
      };
    } catch (error: any) {
      return {
        conditionId,
        success: false,
        error: error.message || String(error),
        sharesRedeemed: 0,
      };
    }
  }

  async checkAndRedeem(): Promise<RedemptionResult[]> {
    const results: RedemptionResult[] = [];
    console.log(`[RedemptionService] Checking positions for ${this.userAddress.slice(0, 10)}...`);

    try {
      const positions = await fetchPositions(this.userAddress);
      console.log(`[RedemptionService] Fetched ${positions.length} position(s)`);
      const redeemable = positions.filter((p) => p.redeemable);

      if (redeemable.length === 0) {
        return results;
      }

      // Group by condition ID to avoid duplicate redemptions
      const conditionMap = new Map<string, { isNegRisk: boolean; totalShares: number }>();

      for (const pos of redeemable) {
        const existing = conditionMap.get(pos.conditionId);
        if (existing) {
          existing.totalShares += pos.size;
        } else {
          conditionMap.set(pos.conditionId, {
            isNegRisk: pos.negativeRisk,
            totalShares: pos.size,
          });
        }
      }

      console.log(`[RedemptionService] Found ${conditionMap.size} redeemable condition(s)`);

      for (const [conditionId, { isNegRisk, totalShares }] of conditionMap) {
        console.log(`[RedemptionService] Redeeming ${totalShares.toFixed(2)} shares for ${conditionId.slice(0, 10)}...`);

        const result = await this.redeemPosition(conditionId, isNegRisk);
        results.push(result);

        if (result.success) {
          console.log(`[RedemptionService] SUCCESS: ${result.txHash}`);
        } else {
          console.log(`[RedemptionService] FAILED: ${result.error}`);
        }

        // Small delay between redemptions to avoid nonce issues
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error: any) {
      console.error(`[RedemptionService] Error checking positions: ${error.message}`);
    }

    return results;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("[RedemptionService] Already running");
      return;
    }

    this.isRunning = true;
    console.log("[RedemptionService] Starting redemption service...");
    console.log(`[RedemptionService] Wallet: ${this.wallet.address}`);
    console.log(`[RedemptionService] User: ${this.userAddress}`);
    console.log(`[RedemptionService] Mode: ${this.isSafeWallet ? "Safe Wallet" : "EOA"}`);
    console.log(`[RedemptionService] Poll interval: ${this.pollIntervalMs}ms`);

    // Initial check
    console.log("[RedemptionService] Running initial check...");
    await this.checkAndRedeem();
    console.log("[RedemptionService] Initial check complete. Entering poll loop...");

    // Start polling
    while (this.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      if (this.isRunning) {
        await this.checkAndRedeem();
      }
    }
  }

  stop(): void {
    console.log("[RedemptionService] Stopping redemption service...");
    this.isRunning = false;
  }
}

// CLI entry point
async function main() {
  const privateKey = process.env.PRIVATE_KEY;
  const funderAddress = process.env.FUNDER_ADDRESS;
  const daemon = process.env.DAEMON === "true";
  const pollInterval = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

  if (!privateKey) {
    console.error("Error: PRIVATE_KEY environment variable required");
    process.exit(1);
  }

  const service = new RedemptionService({
    privateKey,
    funderAddress,
    pollIntervalMs: pollInterval,
  });

  if (daemon) {
    // Handle graceful shutdown
    process.on("SIGINT", () => {
      service.stop();
      process.exit(0);
    });

    process.on("SIGTERM", () => {
      service.stop();
      process.exit(0);
    });

    await service.start();
  } else {
    // One-shot mode: check and redeem once, then exit
    console.log("[RedemptionService] Running one-shot redemption check...");
    console.log(`[RedemptionService] Wallet: ${service["wallet"].address}`);
    console.log(`[RedemptionService] User: ${service["userAddress"]}`);
    console.log(`[RedemptionService] Mode: ${service["isSafeWallet"] ? "Safe Wallet" : "EOA"}`);

    const results = await service.checkAndRedeem();

    if (results.length === 0) {
      console.log("[RedemptionService] No positions redeemed.");
    } else {
      for (const r of results) {
        if (r.success) {
          console.log(`[RedemptionService] ✓ Redeemed ${r.conditionId.slice(0, 10)}... TX: ${r.txHash}`);
        } else {
          console.log(`[RedemptionService] ✗ Failed ${r.conditionId.slice(0, 10)}...: ${r.error}`);
        }
      }
    }

    console.log("[RedemptionService] Done.");
  }
}

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
