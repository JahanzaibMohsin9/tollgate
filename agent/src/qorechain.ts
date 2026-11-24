/**
 * QoreChain's own read-only MCP server (@qorechain/mcp), used by Tollgate as an independent second source.
 *
 * Tollgate's MCP server starts `qorechain-mcp` over stdio (exactly as an MCP client would) and asks it, before
 * the agent opens a channel or pays:
 *   - get_address_info  the owner's balance and whether its ML-DSA-87 key is registered
 *   - get_pq_status     the voucher signer's and the provider's ML-DSA-87 status (registered, possession proven)
 *   - read_contract     the escrow's approvedSigner(owner, provider) and lastChannel(owner, provider)
 *
 * QoreChain's server never signs, holds keys or broadcasts, so nothing here can move funds. The preflight only
 * saves the relayer's fee on calls the chain would refuse anyway; the chain still enforces every limit.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { formatEther, getAddress, type Address } from "viem";

const require = createRequire(import.meta.url);

/** Path of the `qorechain-mcp` bin shipped in the @qorechain/mcp package. */
export const qorechainMcpBin = () => require.resolve("@qorechain/mcp/package.json").replace(/package\.json$/, "dist/bin.js");

type PqStatus = { address_status?: { registered: boolean; algorithm: string; possession_proven: boolean } };
type AddressInfo = { exists: boolean; balances: { denom: string; amount: string }[]; pq_key_registered: boolean };
type ReadResult = { reverted: boolean; revert_reason: string | null; decoded: (string | boolean)[] };

export type Preflight = {
  source: "@qorechain/mcp (QoreChain's read-only MCP server)";
  owner: { address: Address; balance_qor: string; mldsa87_registered: boolean };
  provider: { address: Address; approved_by_owner: boolean; voucher_signer: Address | null; mldsa87_ready: boolean };
  voucher_signer: { mldsa87_ready: boolean } | null;
  last_channel: string | null;
  /** Reasons the chain would refuse an open of `deposit`; empty = go ahead (the chain still checks the caps). */
  would_be_refused: string[];
};

export class QorechainReads {
  private constructor(private readonly client: Client) {}

  static async start(network: "testnet" | "mainnet" = "testnet"): Promise<QorechainReads> {
    const transport = new StdioClientTransport({ command: process.execPath, args: [qorechainMcpBin(), "--network", network], stderr: "ignore" });
    const client = new Client({ name: "tollgate", version: "0.3.0" });
    await client.connect(transport);
    return new QorechainReads(client);
  }

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const r = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    const text = r.content.map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`qorechain-mcp ${name}: ${text}`);
    return JSON.parse(text) as T;
  }

  private async ready(address: Address) {
    const s = await this.call<PqStatus>("get_pq_status", { target: address });
    const a = s.address_status;
    return !!a && a.registered && a.algorithm === "ML-DSA-87" && a.possession_proven;
  }

  /** Everything the agent should know before opening a channel with `depositWei` (0 = just checking). */
  async preflight(p: { escrow: Address; owner: Address; provider: Address; depositWei?: bigint }): Promise<Preflight> {
    const [info, approved, last] = await Promise.all([
      this.call<AddressInfo>("get_address_info", { address: p.owner }),
      this.call<ReadResult>("read_contract", {
        to: p.escrow,
        function: "approvedSigner(address,address)",
        args: [p.owner, p.provider],
        returns: ["address"],
      }),
      this.call<ReadResult>("read_contract", {
        to: p.escrow,
        function: "lastChannel(address,address)",
        args: [p.owner, p.provider],
        returns: ["bool", "uint256"],
      }),
    ]);
    const uqor = BigInt(info.balances.find((b) => b.denom === "uqor")?.amount ?? "0");
    const balanceWei = uqor * 10n ** 12n; // 1 uqor = 10^12 wei (18 vs 6 decimals)
    const signer = approved.reverted ? null : getAddress(String(approved.decoded[0]));
    const isApproved = !!signer && signer !== "0x0000000000000000000000000000000000000000";
    const [providerReady, signerReady] = await Promise.all([this.ready(p.provider), isApproved ? this.ready(signer!) : Promise.resolve(false)]);

    const refused: string[] = [];
    if (!isApproved) refused.push(`provider ${p.provider} is not approved by the owner (the escrow would revert ProviderNotAllowed)`);
    if (isApproved && !signerReady) refused.push("the approved voucher signer has no ML-DSA-87 key with proven possession (open would revert)");
    if (!providerReady) refused.push("the provider has no ML-DSA-87 key with proven possession, so its receipts could not be verified");
    if (p.depositWei !== undefined && p.depositWei > balanceWei) {
      refused.push(`the owner holds ${formatEther(balanceWei)} QOR, less than the ${formatEther(p.depositWei)} QOR deposit`);
    }
    return {
      source: "@qorechain/mcp (QoreChain's read-only MCP server)",
      owner: { address: p.owner, balance_qor: formatEther(balanceWei), mldsa87_registered: info.pq_key_registered },
      provider: { address: p.provider, approved_by_owner: isApproved, voucher_signer: isApproved ? signer : null, mldsa87_ready: providerReady },
      voucher_signer: isApproved ? { mldsa87_ready: signerReady } : null,
      last_channel: !last.reverted && last.decoded[0] === true ? String(last.decoded[1]) : null,
      would_be_refused: refused,
    };
  }

  close() {
    return this.client.close();
  }
}
