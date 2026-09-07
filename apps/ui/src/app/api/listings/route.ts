import { NextRequest, NextResponse } from "next/server";
import { hash, num } from "starknet";
import {
  MAINNET_DEPLOYMENT_BLOCK,
  MAINNET_ESCROW,
  SEPOLIA_DEPLOYMENT_BLOCK,
  SEPOLIA_ESCROW,
  type NetworkId,
} from "@/utils/constants";

export const dynamic = "force-dynamic";

type RpcEvent = {
  keys: string[];
  data: string[];
  block_number?: number;
  transaction_hash: string;
};
type Listing = {
  id: string;
  token: string;
  amount: string;
  pricePerTokenInr: string;
  upiId: string;
  recoveryAddress: string;
  settled: boolean;
  withdrawn: boolean;
  intentExpiresAt: number;
  status: "available" | "intent_active" | "settled" | "withdrawn";
  transactionHash: string;
};

const apiKey =
  process.env.ALCHEMY_STARKNET_API_KEY ??
  process.env.NEXT_PUBLIC_ALCHEMY_STARKNET_API_KEY ??
  process.env.NEXT_PUBLIC_PROVIDER_URL;

async function rpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<T> {
  if (!apiKey) throw new Error("Alchemy RPC is not configured.");
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params,
    }),
    cache: "no-store",
  });
  const payload = (await response.json()) as {
    result?: T;
    error?: { message?: string };
  };
  if (!response.ok || payload.error || payload.result === undefined) {
    throw new Error(
      payload.error?.message ?? `Alchemy ${method} request failed.`,
    );
  }
  return payload.result;
}

async function readDeposit(
  id: string,
  event: RpcEvent,
  rpcUrl: string,
  escrow: string,
): Promise<Listing | null> {
  const result = await rpc<string[]>(rpcUrl, "starknet_call", [
    {
      contract_address: escrow,
      entry_point_selector: hash.getSelectorFromName("get_deposit"),
      calldata: [id],
    },
    "latest",
  ]);
  if (result.length < 8 || num.toBigInt(result[1]) === 0n) return null;
  const settled = num.toBigInt(result[5]) !== 0n;
  const withdrawn = num.toBigInt(result[6]) !== 0n;
  const intentExpiresAt = Number(num.toBigInt(result[7]));
  const now = Math.floor(Date.now() / 1000);
  return {
    id: num.toHex(id),
    token: num.toHex(result[0]),
    amount: num.toBigInt(result[1]).toString(),
    pricePerTokenInr: num.toBigInt(result[2]).toString(),
    upiId: num.toHex(result[3]),
    recoveryAddress: num.toHex(result[4]),
    settled,
    withdrawn,
    intentExpiresAt,
    status: withdrawn
      ? "withdrawn"
      : settled
        ? "settled"
        : intentExpiresAt > now
          ? "intent_active"
          : "available",
    transactionHash: event.transaction_hash,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const network: NetworkId =
      searchParams.get("network") === "mainnet" ? "mainnet" : "sepolia";
    const escrow = network === "mainnet" ? MAINNET_ESCROW : SEPOLIA_ESCROW;
    const deploymentBlock =
      network === "mainnet"
        ? MAINNET_DEPLOYMENT_BLOCK
        : SEPOLIA_DEPLOYMENT_BLOCK;
    const rpcUrl = `https://starknet-${network}.g.alchemy.com/starknet/version/rpc/v0_10/${apiKey ?? ""}`;
    const owner = searchParams.get("owner");
    const status = searchParams.get("status");
    const limit = Math.min(
      Math.max(Number(searchParams.get("limit") ?? "24"), 1),
      48,
    );
    const continuationToken = searchParams.get("cursor") ?? undefined;
    const chunk = await rpc<{
      events: RpcEvent[];
      continuation_token?: string;
    }>(rpcUrl, "starknet_getEvents", [
      {
        from_block: { block_number: deploymentBlock },
        to_block: "latest",
        address: escrow,
        keys: [],
        chunk_size: 100,
        ...(continuationToken ? { continuation_token: continuationToken } : {}),
      },
    ]);
    // DepositCreated is the only UPI event with five data fields. The deposit id
    // is its final event key; contract reads below remain the state source of truth.
    const creations = chunk.events.filter(
      (event) => event.data.length === 5 && event.keys.length >= 2,
    );
    const latestById = new Map<string, RpcEvent>();
    for (const event of creations)
      latestById.set(num.toHex(event.keys[event.keys.length - 1]), event);
    const records = await Promise.all(
      [...latestById.entries()].map(([id, event]) =>
        readDeposit(id, event, rpcUrl, escrow),
      ),
    );
    const listings = records
      .filter((value): value is Listing => value !== null)
      .filter(
        (listing) =>
          !owner ||
          num.toBigInt(listing.recoveryAddress) === num.toBigInt(owner),
      )
      .filter(
        (listing) => !status || status === "all" || listing.status === status,
      )
      .sort((a, b) => Number(num.toBigInt(b.id) - num.toBigInt(a.id)))
      .slice(0, limit);
    return NextResponse.json(
      {
        listings,
        nextCursor: chunk.continuation_token ?? null,
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control":
            "public, max-age=10, s-maxage=10, stale-while-revalidate=30",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to load listings.",
      },
      { status: 503 },
    );
  }
}
