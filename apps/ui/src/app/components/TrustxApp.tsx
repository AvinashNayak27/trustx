"use client";

import { useEffect, useMemo, useState } from "react";
import { ec, hash, num, shortString, validateAndParseAddress } from "starknet";
import { useStoreWallet } from "./Wallet/walletContext";
import SelectWallet from "./client/WalletHandle/SelectWallet";
import {
  INTENT_FEE,
  TEE_SERVER_URL,
  type NetworkId,
  getNetworkConfig,
} from "@/utils/constants";
import styles from "../uni.module.css";

type Status = "available" | "intent_active" | "settled" | "withdrawn";
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
  status: Status;
  transactionHash: string;
};
type TeeResult = {
  success: true;
  transaction: {
    paymentStatusTitle: string;
    paymentTotalAmount: string;
    receiverUpiId: string;
    upiTransactionId: string;
  };
  signature: { signature_r: string; signature_s: string };
};
type TxPhase = "creating" | "wallet" | "pending" | "success" | "error";
type TxNotice = {
  tone: "success" | "error" | "pending";
  title: string;
  body?: string;
  hash?: string;
  phase?: TxPhase;
};

declare global {
  interface Window {
    teeReplay?: {
      requestConnection(): Promise<boolean>;
      checkConnectionStatus(): Promise<
        "connected" | "disconnected" | "pending"
      >;
      replay(input: { provider: string; action: string }): Promise<TeeResult>;
    };
  }
}

const fmt = (raw: string | bigint) => {
  const value = BigInt(raw);
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole.toString();
};
const short = (value: string) =>
  value.length < 15 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
const upi = (value: string) => {
  try {
    return shortString.decodeShortString(value);
  } catch {
    return value;
  }
};
const maskedUpi = (value: string) => {
  const decoded = upi(value);
  const [name, host] = decoded.split("@");
  return host ? `${name.slice(0, 2)}•••@${host}` : short(decoded);
};
const parse18 = (value: string) => {
  const match = value.trim().match(/^(\d+)(?:\.(\d{0,18}))?$/);
  if (!match) throw new Error("Enter a valid amount.");
  const amount =
    BigInt(match[1]) * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"));
  if (amount <= 0n || amount >= 2n ** 128n)
    throw new Error("Amount is outside the supported range.");
  return amount;
};
const eventUrl = (explorer: string, txHash: string) =>
  `${explorer}/tx/${txHash}`;
const toHex32 = (value: string) =>
  num.toBigInt(value).toString(16).padStart(64, "0");
const paymentMessageHash = (
  status: string,
  amount: bigint,
  receiver: string,
  transactionId: string,
) => {
  const low = amount & ((1n << 128n) - 1n);
  const high = amount >> 128n;
  const h0 = hash.computePedersenHash("0x0", status);
  const h1 = hash.computePedersenHash(h0, num.toHex(low));
  const h2 = hash.computePedersenHash(h1, num.toHex(high));
  const h3 = hash.computePedersenHash(h2, receiver);
  const h4 = hash.computePedersenHash(h3, transactionId);
  const h5 = hash.computePedersenHash(h4, "0x5");
  return num.toHex(num.toBigInt(h5) % (1n << 251n));
};
const walletFailureDetails = (error: unknown) => {
  const value = error as Record<string, unknown> | undefined;
  return {
    name: value?.name,
    message: value?.message,
    cause: value?.cause,
    data: value?.data,
    details: value?.details,
    response: value?.response,
    stack: value?.stack,
  };
};

export default function TrustxApp({ network }: { network: NetworkId }) {
  const networkConfig = getNetworkConfig(network);
  const wallet = useStoreWallet((state) => state.myWalletAccount);
  const address = useStoreWallet((state) => state.address);
  const connected = useStoreWallet((state) => state.isConnected);
  const chain = useStoreWallet((state) => state.chain);
  const [tab, setTab] = useState<"market" | "sell" | "mine">("market");
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState("");
  const [filter, setFilter] = useState<
    "available" | "all" | "intent_active" | "settled" | "withdrawn"
  >("available");
  const [selected, setSelected] = useState<Listing | null>(null);
  const [amount, setAmount] = useState("20");
  const [price, setPrice] = useState("10");
  const [upiId, setUpiId] = useState("");
  const [recovery, setRecovery] = useState("");
  const [notice, setNotice] = useState<TxNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [teeStatus, setTeeStatus] = useState<"checking" | "ready" | "error">(
    "checking",
  );
  const [teeMessage, setTeeMessage] = useState(
    "Checking Trustx attestation signer…",
  );
  const [attestation, setAttestation] = useState<TeeResult | null>(null);
  const [showAttestationDetails, setShowAttestationDetails] = useState(false);
  const [fees, setFees] = useState("0");

  const isCorrectNetwork = connected && chain === networkConfig.chainId;
  // An active intent only blocks recovery and a second intent on-chain. It does
  // not make the listing unavailable to the buyer completing UPI verification.
  const activeListings = useMemo(
    () =>
      listings.filter((listing) =>
        filter === "all" || filter === "available"
          ? listing.status === "available" || listing.status === "intent_active"
          : listing.status === filter,
      ),
    [filter, listings],
  );
  const myListings = useMemo(
    () =>
      listings.filter(
        (listing) =>
          address &&
          num.toBigInt(listing.recoveryAddress) === num.toBigInt(address),
      ),
    [address, listings],
  );

  const loadListings = async (): Promise<Listing[]> => {
    setLoading(true);
    setFeedError("");
    try {
      const response = await fetch(
        `/api/listings?network=${network}&status=all&limit=48`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        listings?: Listing[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error ?? "Could not load the marketplace.");
      const next = data.listings ?? [];
      setListings(next);
      return next;
    } catch (error) {
      setFeedError(
        error instanceof Error ? error.message : "Could not load listings.",
      );
      return [];
    } finally {
      setLoading(false);
    }
  };

  const readOnChainListing = async (id: string): Promise<Listing> => {
    const result = await networkConfig.provider.callContract({
      contractAddress: networkConfig.escrow,
      entrypoint: "get_deposit",
      calldata: [id],
    });
    if (result.length < 8 || num.toBigInt(result[1]) === 0n)
      throw new Error("Listing is not available on the escrow yet.");
    const intentExpiresAt = Number(num.toBigInt(result[7]));
    const settled = num.toBigInt(result[5]) !== 0n;
    const withdrawn = num.toBigInt(result[6]) !== 0n;
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
          : intentExpiresAt > Math.floor(Date.now() / 1000)
            ? "intent_active"
            : "available",
      transactionHash: "",
    };
  };

  const waitForListingState = async (
    id: string,
    matches: (listing: Listing) => boolean,
    signal: AbortSignal,
  ) => {
    console.info("[Trustx tx] Started escrow-state watcher", { id });
    for (let attempt = 1; attempt <= 150 && !signal.aborted; attempt += 1) {
      try {
        const listing = await readOnChainListing(id);
        if (matches(listing)) {
          console.info(
            "[Trustx tx] Escrow-state watcher confirmed transaction",
            { id, attempt, status: listing.status },
          );
          return true;
        }
      } catch (error) {
        if (attempt === 1 || attempt % 10 === 0)
          console.warn("[Trustx tx] Escrow-state watcher retry", {
            id,
            attempt,
            error,
          });
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 4000));
    }
    if (signal.aborted) return false;
    throw new Error(
      "Timed out waiting for the escrow contract state to update.",
    );
  };

  useEffect(() => {
    void loadListings();
    const id = window.setInterval(() => void loadListings(), 15_000);
    return () => window.clearInterval(id);
  }, [network]);
  useEffect(() => {
    if (!recovery && address) setRecovery(address);
  }, [address, recovery]);
  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const [health, signer] = await Promise.all([
          fetch(`${TEE_SERVER_URL}/health`, { cache: "no-store" }).then(
            (r) =>
              r.json() as Promise<{ starkPublicKey?: string; status?: string }>,
          ),
          networkConfig.provider.callContract({
            contractAddress: networkConfig.escrow,
            entrypoint: "get_signer_public_key",
            calldata: [],
          }),
        ]);
        if (
          !health.starkPublicKey ||
          health.status !== "ok" ||
          num.toBigInt(health.starkPublicKey) !== num.toBigInt(signer[0])
        )
          throw new Error(
            "TEE signer does not match the on-chain escrow signer.",
          );
        if (live) {
          setTeeStatus("ready");
          setTeeMessage(
            `TEE signer verified · ${short(health.starkPublicKey)}`,
          );
        }
      } catch (error) {
        if (live) {
          setTeeStatus("error");
          setTeeMessage(
            error instanceof Error ? error.message : "TEE server unavailable.",
          );
        }
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 20_000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [network, networkConfig]);

  const wait = async (hash: string, title: string) => {
    setNotice({
      tone: "pending",
      phase: "pending",
      title,
      body: "Submitted. Waiting for Starknet execution…",
      hash,
    });
    const receipt: any = await networkConfig.provider.waitForTransaction(hash, {
      retries: 180,
      retryInterval: 2500,
    });
    const reverted =
      receipt?.execution_status === "REVERTED" ||
      receipt?.execution_status === "REJECTED";
    if (reverted)
      throw new Error(
        receipt?.revert_reason ?? "The contract rejected this transaction.",
      );
    console.info("[Trustx tx] confirmed receipt", { title, hash, receipt });
    setNotice({
      tone: "success",
      phase: "success",
      title: `Confirmed on ${networkConfig.label}`,
      body: "Contract execution succeeded and marketplace state is refreshing.",
      hash,
    });
    await loadListings();
  };
  const requireWallet = () => {
    if (!wallet || !isCorrectNetwork)
      throw new Error(`Connect a ${networkConfig.label} privacy wallet first.`);
    return wallet;
  };
  const submitPrivacy = async (
    actions: any[],
    title: string,
    confirmOnChain?: (signal: AbortSignal) => Promise<boolean>,
  ) => {
    const account = requireWallet();
    setBusy(true);
    setNotice({
      tone: "pending",
      phase: "creating",
      title,
      body: "Preparing private transaction…",
    });
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      setNotice({
        tone: "pending",
        phase: "wallet",
        title,
        body: "Confirm this single transaction in your privacy wallet.",
      });
      console.info("[Trustx tx] Requesting private wallet batch", {
        title,
        actions,
      });
      const watcher = new AbortController();
      const walletRequest = account
        .strk20InvokeTransaction(actions)
        .then((result: any) => ({ source: "wallet" as const, result }));
      const stateWatch = confirmOnChain?.(watcher.signal).then((confirmed) => ({
        source: "chain" as const,
        confirmed,
      }));
      const outcome = await Promise.race(
        stateWatch ? [walletRequest, stateWatch] : [walletRequest],
      );
      if (outcome.source === "chain") {
        if (!outcome.confirmed)
          throw new Error("Escrow-state watcher stopped before confirmation.");
        console.warn(
          "[Trustx tx] Wallet request did not resolve; state watcher confirmed the submitted transaction",
          { title },
        );
        setNotice({
          tone: "success",
          phase: "success",
          title: `Confirmed on ${networkConfig.label}`,
          body: "Confirmed from escrow state. Your wallet did not return a transaction hash.",
        });
        void walletRequest
          .then(({ result }) =>
            console.info(
              "[Trustx tx] Wallet request resolved after state confirmation",
              { title, result },
            ),
          )
          .catch((error) =>
            console.warn(
              "[Trustx tx] Wallet request rejected after state confirmation",
              { title, error },
            ),
          );
        await loadListings();
        return "state-confirmed";
      }
      watcher.abort();
      const hash = outcome.result?.transaction_hash;
      if (!hash)
        throw new Error(
          "Wallet submitted no transaction hash. Check wallet activity before retrying.",
        );
      console.info("[Trustx tx] wallet submitted private transaction", {
        title,
        hash,
        actions,
      });
      await wait(hash, title);
      return hash as string;
    } catch (error) {
      console.error("[Trustx tx] private transaction failed", {
        title,
        error,
        failure: walletFailureDetails(error),
      });
      setNotice({
        tone: "error",
        phase: "error",
        title: "Transaction failed",
        body: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const submitNormal = async (call: any, title: string) => {
    const account = requireWallet();
    setBusy(true);
    setNotice({
      tone: "pending",
      phase: "creating",
      title,
      body: "Preparing transaction…",
    });
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      setNotice({
        tone: "pending",
        phase: "wallet",
        title,
        body: "Confirm this transaction in your wallet.",
      });
      const result: any = await account.execute(call);
      const hash = result?.transaction_hash;
      if (!hash)
        throw new Error(
          "Wallet submitted no transaction hash. Check wallet activity before retrying.",
        );
      console.info("[Trustx tx] wallet submitted transaction", {
        title,
        hash,
        call,
      });
      await wait(hash, title);
      return hash as string;
    } catch (error) {
      console.error("[Trustx tx] transaction failed", {
        title,
        error,
        failure: walletFailureDetails(error),
      });
      setNotice({
        tone: "error",
        phase: "error",
        title: "Transaction failed",
        body: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const createListing = async () => {
    try {
      const tokenAmount = parse18(amount);
      const priceAmount = parse18(price);
      const sellerUpi = shortString.encodeShortString(upiId.trim());
      const recoveryAddress = num.toHex(
        validateAndParseAddress(recovery.trim()),
      );
      const nextId = (
        await networkConfig.provider.callContract({
          contractAddress: networkConfig.escrow,
          entrypoint: "get_next_deposit_id",
          calldata: [],
        })
      )[0];
      const tx = await submitPrivacy(
        [
          {
            type: "withdraw",
            token: networkConfig.token,
            amount: num.toHex(tokenAmount),
            recipient: networkConfig.escrow,
          },
          {
            type: "invoke",
            contract: networkConfig.escrow,
            calldata: [
              "0x0",
              "0x0",
              num.toHex(networkConfig.token),
              num.toHex(tokenAmount),
              num.toHex(sellerUpi),
              num.toHex(priceAmount),
              recoveryAddress,
              "0x0",
              "0x0",
              "0x0",
              "0x0",
              "0x0",
              "0x0",
              "0x0",
              "0x0",
            ],
          },
        ],
        "Creating your Trustx listing",
        (signal) =>
          waitForListingState(
            nextId,
            (listing) => listing.amount === tokenAmount.toString(),
            signal,
          ),
      );
      if (tx) setTab("mine");
    } catch (error) {
      setNotice({
        tone: "error",
        title: "Listing needs attention",
        body: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const signalIntent = async () => {
    if (!selected) return;
    const previousExpiry = selected.intentExpiresAt;
    const tx = await submitPrivacy(
      [
        {
          type: "withdraw",
          token: networkConfig.token,
          amount: num.toHex(INTENT_FEE),
          recipient: networkConfig.escrow,
        },
        {
          type: "invoke",
          contract: networkConfig.escrow,
          calldata: [
            "0x2",
            selected.id,
            num.toHex(networkConfig.token),
            num.toHex(INTENT_FEE),
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
            "0x0",
          ],
        },
      ],
      "Starting your 30-minute purchase window",
      (signal) =>
        waitForListingState(
          selected.id,
          (listing) => listing.intentExpiresAt > previousExpiry,
          signal,
        ),
    );
    if (tx) {
      const refreshed = await loadListings();
      const next = refreshed.find((listing) => listing.id === selected.id);
      if (next) setSelected(next);
    }
  };
  const verifyPayment = async () => {
    if (!selected || !window.teeReplay) {
      setNotice({
        tone: "error",
        title: "TEE extension required",
        body: "Install and connect the Trustx TEE replay extension.",
      });
      return;
    }
    setBusy(true);
    setNotice({
      tone: "pending",
      title: "Retrieving your Amazon Pay receipt",
      body: "The TEE is verifying and signing the transaction.",
    });
    try {
      if (
        (await window.teeReplay.checkConnectionStatus()) !== "connected" &&
        !(await window.teeReplay.requestConnection())
      )
        throw new Error("TEE extension connection was rejected.");
      const result = await window.teeReplay.replay({
        provider: "amazon-pay",
        action: "transaction-details",
      });
      if (!result.success)
        throw new Error("TEE did not return a payment attestation.");
      console.info("[Trustx TEE] verified attestation", {
        listing: selected,
        attestation: result,
      });
      setAttestation(result);
      setNotice(null);
    } catch (error) {
      setNotice({
        tone: "error",
        title: "Payment verification failed",
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };
  const settle = async () => {
    if (!selected || !attestation || !address) return;
    const payment = attestation.transaction;
    const total = BigInt(payment.paymentTotalAmount);
    const low = num.toHex(total & ((1n << 128n) - 1n));
    const high = num.toHex(total >> 128n);
    const expectedHash = paymentMessageHash(
      payment.paymentStatusTitle,
      total,
      payment.receiverUpiId,
      payment.upiTransactionId,
    );
    let onChainSigner = "";
    let signatureValid = false;
    let matchingCompressedSigner: string | undefined;
    let signatureVerificationError: string | undefined;
    try {
      onChainSigner = (
        await networkConfig.provider.callContract({
          contractAddress: networkConfig.escrow,
          entrypoint: "get_signer_public_key",
          calldata: [],
        })
      )[0];
      const signature = new ec.starkCurve.Signature(
        num.toBigInt(attestation.signature.signature_r),
        num.toBigInt(attestation.signature.signature_s),
      );
      // Cairo stores only the Stark public-key x coordinate. The browser
      // verifier requires an encoded point, so test both possible y parities.
      const signerX = toHex32(onChainSigner);
      for (const prefix of ["02", "03"]) {
        const candidate = `0x${prefix}${signerX}`;
        if (ec.starkCurve.verify(signature, expectedHash, candidate)) {
          signatureValid = true;
          matchingCompressedSigner = candidate;
          break;
        }
      }
    } catch (error) {
      signatureVerificationError =
        error instanceof Error ? error.message : String(error);
    }
    console.info("[Trustx claim] TEE attestation preflight", {
      receivedAttestation: attestation,
      expectedEscrowFields: {
        depositId: selected.id,
        token: selected.token,
        tokenAmountWei: selected.amount,
        receiverUpiId: selected.upiId,
        paymentStatus: "Success",
      },
      receivedPayment: payment,
      computedPaymentMessageHash: expectedHash,
      onChainSigner,
      matchingCompressedSigner,
      receivedSignature: attestation.signature,
      signatureValid,
      signatureVerificationError,
      receiverMatchesListing:
        num.toBigInt(payment.receiverUpiId) === num.toBigInt(selected.upiId),
      paymentAmountWei: total.toString(),
    });
    await submitPrivacy(
      [
        {
          type: "transfer",
          token: selected.token,
          amount: "OPEN",
          recipient: address,
        },
        {
          type: "invoke",
          contract: networkConfig.escrow,
          calldata: [
            "0x1",
            selected.id,
            selected.token,
            num.toHex(BigInt(selected.amount)),
            selected.upiId,
            "0x0",
            "0x0",
            num.toHex(attestation.signature.signature_r),
            num.toHex(attestation.signature.signature_s),
            num.toHex(payment.paymentStatusTitle),
            low,
            high,
            num.toHex(payment.receiverUpiId),
            num.toHex(payment.upiTransactionId),
            "${openNoteIds[0]}",
          ],
        },
      ],
      "Claiming STRK privately",
      (signal) =>
        waitForListingState(selected.id, (listing) => listing.settled, signal),
    );
  };
  const recover = async (listing: Listing) =>
    submitNormal(
      {
        contractAddress: networkConfig.escrow,
        entrypoint: "withdraw",
        calldata: [listing.id],
      },
      "Recovering your listing",
    );
  const readFees = async () => {
    try {
      const result = await networkConfig.provider.callContract({
        contractAddress: networkConfig.escrow,
        entrypoint: "get_accrued_intent_fees",
        calldata: [],
      });
      setFees(num.toBigInt(result[0]).toString());
    } catch {
      setFees("0");
    }
  };

  useEffect(() => {
    if (address) void readFees();
    else setFees("0");
  }, [address, network]);
  const isCollector =
    address &&
    num.toBigInt(address) === num.toBigInt(networkConfig.feeCollector);

  return (
    <main className={styles.trustxApp}>
      {notice ? (
        <aside
          className={`${styles.txToast} ${notice.phase === "success" ? styles.txToastSuccess : notice.phase === "error" ? styles.txToastError : ""}`}
          role={notice.phase === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <div className={styles.txToastCard}>
            <div className={styles.txToastHead}>
              <div>
                <span className={styles.txToastEyebrow}>
                  Transaction status · {networkConfig.label}
                </span>
                <strong>{notice.title}</strong>
              </div>
              <button
                type="button"
                className={styles.txToastClose}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setNotice(null);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setNotice(null);
                }}
                aria-label="Dismiss transaction status"
              >
                ×
              </button>
            </div>
            <div className={styles.txSteps}>
              {(
                [
                  ["creating", "Creating"],
                  ["wallet", "Confirm in wallet"],
                  ["pending", `Pending on ${networkConfig.label}`],
                  ["success", "Succeeded"],
                ] as const
              ).map(([phase, label], index) => {
                const phases: TxPhase[] = [
                  "creating",
                  "wallet",
                  "pending",
                  "success",
                ];
                const current = notice.phase ?? "creating";
                const currentIndex = phases.indexOf(current);
                const complete =
                  current === "success" ||
                  (current !== "error" && index < currentIndex);
                return (
                  <div
                    key={phase}
                    className={`${styles.txStep} ${complete ? styles.txStepComplete : ""} ${current === phase ? styles.txStepCurrent : ""}`}
                  >
                    <span className={styles.txStepDot}>
                      {complete ? "✓" : index + 1}
                    </span>
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>
            {notice.body ? (
              <div
                className={
                  notice.phase === "error"
                    ? styles.txToastMessage
                    : styles.txToastHint
                }
              >
                {notice.body}
              </div>
            ) : null}
            {notice.hash ? (
              <a
                className={styles.txToastExplorer}
                href={eventUrl(networkConfig.explorer, notice.hash)}
                target="_blank"
                rel="noreferrer"
              >
                View on Voyager ↗
              </a>
            ) : null}
          </div>
        </aside>
      ) : null}
      <section className={styles.hero}>
        <div className={styles.kicker}>
          STARKNET {networkConfig.label.toUpperCase()} · TEE ATTESTED
        </div>
        <h1>
          Private STRK <em>↔ UPI</em>
        </h1>
        <p>Shielded until the Amazon Pay receipt is TEE-attested.</p>
        <div className={styles.heroActions}>
          <button onClick={() => setTab("market")}>Explore marketplace</button>
          <button className={styles.ghostButton} onClick={() => setTab("sell")}>
            Create a listing
          </button>
        </div>
        <div className={styles.proofRow}>
          <span>✓ Private STRK settlement</span>
          <span>✓ 30-minute buyer protection</span>
          <span>✓ TEE-signed payment proof</span>
        </div>
      </section>
      <section className={styles.workspace}>
        <div className={styles.workspaceNav}>
          <div>
            {(
              [
                ["market", "Buy"],
                ["sell", "Sell"],
                ["mine", "History"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={tab === key ? styles.activeNav : ""}
              >
                {label}
              </button>
            ))}
          </div>
          <span
            className={
              teeStatus === "ready" ? styles.teeReady : styles.teeError
            }
          >
            {teeStatus === "ready" ? "●" : "●"} {teeMessage}
          </span>
        </div>
        {tab === "market" ? (
          <section className={styles.market}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.eyebrow}>LIVE ON-CHAIN</span>
                <h2>Buy private STRK</h2>
                <p>
                  Listings are discovered from UPI escrow events on Starknet{" "}
                  {networkConfig.label}.
                </p>
              </div>
              <div className={styles.filterRow}>
                {(
                  ["available", "intent_active", "settled", "all"] as const
                ).map((item) => (
                  <button
                    key={item}
                    onClick={() => setFilter(item)}
                    className={filter === item ? styles.filterActive : ""}
                  >
                    {item.replace("_", " ")}
                  </button>
                ))}
                <button onClick={() => void loadListings()}>Refresh</button>
              </div>
            </div>
            {feedError ? (
              <div className={styles.empty}>{feedError}</div>
            ) : loading ? (
              <div className={styles.empty}>
                Reading {networkConfig.label} escrow events…
              </div>
            ) : (
              <div className={styles.listGrid}>
                {activeListings.length ? (
                  activeListings.map((listing) => (
                    <article className={styles.listingCard} key={listing.id}>
                      <div className={styles.cardTop}>
                        <span
                          className={styles.status}
                          data-status={listing.status}
                        >
                          {listing.status.replace("_", " ")}
                        </span>
                        <span>#{BigInt(listing.id).toString()}</span>
                      </div>
                      <strong>{fmt(listing.amount)} STRK</strong>
                      <div className={styles.price}>
                        ₹{fmt(listing.pricePerTokenInr)} <small>per STRK</small>
                      </div>
                      <div className={styles.cardMeta}>
                        <span>UPI recipient</span>
                        <b>{maskedUpi(listing.upiId)}</b>
                      </div>
                      <button
                        disabled={
                          listing.status === "settled" ||
                          listing.status === "withdrawn"
                        }
                        onClick={() => {
                          setSelected(listing);
                          setAttestation(null);
                          setShowAttestationDetails(false);
                        }}
                      >
                        {listing.status === "intent_active"
                          ? "Continue UPI checkout"
                          : listing.status === "available"
                            ? "Buy with UPI"
                            : "Unavailable"}
                      </button>
                    </article>
                  ))
                ) : (
                  <div className={styles.empty}>
                    No listings match this filter yet.
                  </div>
                )}
              </div>
            )}
          </section>
        ) : null}
        {tab === "sell" ? (
          <section className={styles.formWrap}>
            <div>
              <span className={styles.eyebrow}>SELLER FLOW</span>
              <h2>List private STRK for UPI</h2>
              <p>
                Your funds are locked in the escrow; only your recovery wallet
                can reclaim an unfilled listing.
              </p>
            </div>
            <div className={styles.formGrid}>
              <label>
                Amount in STRK
                <input
                  value={amount}
                  inputMode="decimal"
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label>
                INR per STRK
                <input
                  value={price}
                  inputMode="decimal"
                  onChange={(e) => setPrice(e.target.value)}
                />
              </label>
            </div>
            <label>
              UPI ID
              <input
                value={upiId}
                placeholder="you@upi"
                onChange={(e) => setUpiId(e.target.value)}
              />
            </label>
            <label>
              Recovery wallet
              <input
                value={recovery}
                placeholder="0x… Starknet address"
                onChange={(e) => setRecovery(e.target.value)}
              />
            </label>
            <small className={styles.help}>
              This address alone can recover the listing once no buyer intent is
              active.
            </small>
            {connected ? (
              <button
                className={styles.primaryCta}
                disabled={!isCorrectNetwork || busy}
                onClick={() => void createListing()}
              >
                Create private listing
              </button>
            ) : (
              <SelectWallet variant="ctaBig" network={network} />
            )}
          </section>
        ) : null}
        {tab === "mine" ? (
          <section className={styles.market}>
            <div className={styles.sectionHead}>
              <div>
                <span className={styles.eyebrow}>SELLER DASHBOARD</span>
                <h2>My listings</h2>
                <p>
                  Listings where your connected wallet is the recovery wallet.
                </p>
              </div>
            </div>
            {!connected ? (
              <div className={styles.empty}>
                Connect a {networkConfig.label} wallet to view your listings.
              </div>
            ) : (
              <div className={styles.listGrid}>
                {myListings.length ? (
                  myListings.map((listing) => (
                    <article className={styles.listingCard} key={listing.id}>
                      <div className={styles.cardTop}>
                        <span
                          className={styles.status}
                          data-status={listing.status}
                        >
                          {listing.status.replace("_", " ")}
                        </span>
                        <span>#{BigInt(listing.id).toString()}</span>
                      </div>
                      <strong>{fmt(listing.amount)} STRK</strong>
                      <div className={styles.price}>
                        ₹{fmt(listing.pricePerTokenInr)} <small>per STRK</small>
                      </div>
                      {listing.status === "available" ? (
                        <button
                          disabled={busy}
                          onClick={() => void recover(listing)}
                        >
                          Recover listing
                        </button>
                      ) : (
                        <a
                          href={eventUrl(
                            networkConfig.explorer,
                            listing.transactionHash,
                          )}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View activity ↗
                        </a>
                      )}
                    </article>
                  ))
                ) : (
                  <div className={styles.empty}>
                    No Trustx listings found for this recovery wallet.
                  </div>
                )}
              </div>
            )}
            {isCollector ? (
              <div className={styles.treasury}>
                <div>
                  <span className={styles.eyebrow}>PROTOCOL FEES</span>
                  <strong>{fmt(fees)} STRK accrued</strong>
                </div>
                <button
                  disabled={busy || BigInt(fees) === 0n}
                  onClick={() =>
                    void submitNormal(
                      {
                        contractAddress: networkConfig.escrow,
                        entrypoint: "withdraw_intent_fees",
                        calldata: [],
                      },
                      "Withdrawing protocol fees",
                    )
                  }
                >
                  Withdraw fees
                </button>
              </div>
            ) : null}
          </section>
        ) : null}
      </section>
      {selected ? (
        <div
          className={styles.sheetBackdrop}
          onClick={() => !busy && setSelected(null)}
        >
          <section
            className={styles.checkout}
            onClick={(e) => e.stopPropagation()}
          >
            <button className={styles.close} onClick={() => setSelected(null)}>
              ×
            </button>
            <span className={styles.eyebrow}>BUYER CHECKOUT</span>
            <h2>Buy {fmt(selected.amount)} STRK</h2>
            <div className={styles.checkoutPrice}>
              ₹
              {fmt(
                (BigInt(selected.amount) * BigInt(selected.pricePerTokenInr)) /
                  10n ** 18n,
              )}{" "}
              <span>via {upi(selected.upiId)}</span>
            </div>
            <ol className={styles.steps}>
              <li
                className={
                  selected.status === "intent_active" ? styles.done : ""
                }
              >
                <b>1</b>
                <div>
                  <strong>Lock your purchase window</strong>
                  <p>Pay a 1 STRK privacy fee to reserve 30 minutes.</p>
                  {selected.status === "available" ? (
                    <button
                      disabled={busy || !isCorrectNetwork}
                      onClick={() => void signalIntent()}
                    >
                      Signal intent · 1 STRK fee
                    </button>
                  ) : (
                    <small>
                      Purchase intent active. Complete payment before it
                      expires.
                    </small>
                  )}
                </div>
              </li>
              <li className={attestation ? styles.done : ""}>
                <b>2</b>
                <div>
                  <strong>Pay and verify on Amazon Pay</strong>
                  <p>
                    Send the UPI amount above, then let the TEE retrieve the
                    receipt.
                  </p>
                  <button
                    disabled={
                      busy ||
                      selected.status !== "intent_active" ||
                      !!attestation ||
                      teeStatus !== "ready"
                    }
                    onClick={() => void verifyPayment()}
                  >
                    {attestation
                      ? "Payment attestation ready"
                      : "Verify Amazon Pay transaction"}
                  </button>
                  {attestation ? (
                    <button
                      className={styles.textButton}
                      onClick={() => {
                        setAttestation(null);
                        setShowAttestationDetails(false);
                      }}
                    >
                      Choose another transaction
                    </button>
                  ) : null}
                </div>
              </li>
              <li className={selected.status === "settled" ? styles.done : ""}>
                <b>3</b>
                <div>
                  <strong>Claim privately</strong>
                  <p>
                    Your TEE signature is verified on-chain before STRK becomes
                    your private note.
                  </p>
                  <button
                    className={styles.primaryCta}
                    disabled={
                      busy ||
                      !attestation ||
                      selected.status !== "intent_active"
                    }
                    onClick={() => void settle()}
                  >
                    Claim STRK privately
                  </button>
                </div>
              </li>
            </ol>
            {attestation ? (
              <div className={styles.attestation}>
                <div>
                  <strong>Payment attestation ready</strong>
                  <button
                    type="button"
                    className={styles.attestationInfo}
                    onClick={() => setShowAttestationDetails(true)}
                    aria-label="View payment attestation details"
                  >
                    i
                  </button>
                </div>
                <span>
                  ₹{fmt(attestation.transaction.paymentTotalAmount)} to{" "}
                  {upi(attestation.transaction.receiverUpiId)}
                </span>
                <small>TEE-signed · ready for on-chain claim</small>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
      {showAttestationDetails && attestation ? (
        <div
          className={styles.attestationOverlay}
          onClick={() => setShowAttestationDetails(false)}
        >
          <section
            className={styles.attestationSheet}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Payment attestation details"
          >
            <div className={styles.attestationSheetHead}>
              <div>
                <span className={styles.eyebrow}>TEE-ATTESTED RECEIPT</span>
                <h2>Payment details</h2>
              </div>
              <button
                type="button"
                className={styles.close}
                onClick={() => setShowAttestationDetails(false)}
                aria-label="Close payment details"
              >
                ×
              </button>
            </div>
            <dl className={styles.attestationDetails}>
              <div>
                <dt>Status</dt>
                <dd>{upi(attestation.transaction.paymentStatusTitle)}</dd>
              </div>
              <div>
                <dt>Payment amount</dt>
                <dd>₹{fmt(attestation.transaction.paymentTotalAmount)}</dd>
              </div>
              <div>
                <dt>UPI receiver</dt>
                <dd>{upi(attestation.transaction.receiverUpiId)}</dd>
              </div>
              <div>
                <dt>UPI transaction ID</dt>
                <dd>{upi(attestation.transaction.upiTransactionId)}</dd>
              </div>
              <div>
                <dt>Escrow signer</dt>
                <dd>
                  {short(teeMessage.replace("TEE signer verified · ", ""))}
                </dd>
              </div>
              <div>
                <dt>Signature r</dt>
                <dd>{attestation.signature.signature_r}</dd>
              </div>
              <div>
                <dt>Signature s</dt>
                <dd>{attestation.signature.signature_s}</dd>
              </div>
            </dl>
          </section>
        </div>
      ) : null}
    </main>
  );
}
