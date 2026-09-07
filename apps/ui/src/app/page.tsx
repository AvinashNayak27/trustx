"use client";

import { useState } from "react";
import SelectWallet from "./components/client/WalletHandle/SelectWallet";
import TrustxApp from "./components/TrustxApp";
import { type NetworkId } from "@/utils/constants";
import { useStoreWallet } from "./components/Wallet/walletContext";
import styles from "./uni.module.css";

export default function Page() {
  const [network, setNetwork] = useState<NetworkId>("sepolia");
  const disconnect = useStoreWallet((state) => state.disconnect);
  const switchNetwork = (next: NetworkId) => {
    if (next === network) return;
    disconnect();
    setNetwork(next);
  };

  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <a className={styles.brand} href="/" aria-label="Trustx home">
          <span className={styles.brandMark}>T</span>
          <span>TrustX</span>
        </a>
        <div className={styles.navRight}>
          <div
            className={styles.networkToggle}
            role="group"
            aria-label="Network"
          >
            {(["sepolia", "mainnet"] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={network === item ? styles.networkActive : ""}
                onClick={() => switchNetwork(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <SelectWallet variant="nav" network={network} />
        </div>
      </nav>
      <TrustxApp network={network} />
      <footer className={styles.footer}>
        <span>Trustx · Private UPI on/off-ramp</span>
        <a
          href={
            network === "mainnet"
              ? "https://voyager.online"
              : "https://sepolia.voyager.online"
          }
          target="_blank"
          rel="noreferrer"
        >
          Built on Starknet
        </a>
      </footer>
    </div>
  );
}
