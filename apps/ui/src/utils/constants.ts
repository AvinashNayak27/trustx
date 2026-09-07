import { RpcProvider } from "starknet";

export type NetworkId = "sepolia" | "mainnet";

export type NetworkConfig = {
  id: NetworkId;
  label: string;
  chainId: string;
  escrow: string;
  privacyPool: string;
  token: string;
  explorer: string;
  deploymentBlock: number;
  feeCollector: string;
  provider: RpcProvider;
};

export const STRK_TOKEN =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
export const SEPOLIA_CHAIN_ID = "0x534e5f5345504f4c4941";
export const MAINNET_CHAIN_ID = "0x534e5f4d41494e";
export const SEPOLIA_PRIVACY_POOL =
  "0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91";
export const MAINNET_PRIVACY_POOL =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";
export const SEPOLIA_ESCROW =
  process.env.NEXT_PUBLIC_UPI_ESCROW_SEPOLIA ??
  "0x014e9d3995d24fc26ee235fdbac5c0654168dd412a295ed1fff828149b142b0e";
export const MAINNET_ESCROW =
  process.env.NEXT_PUBLIC_UPI_ESCROW_MAINNET ??
  "0x0598c8db6c7904f5a025fa340fecd2c926c7043f265a6a2129b06c842e74f33e";
export const SEPOLIA_DEPLOYMENT_BLOCK = Number(
  process.env.NEXT_PUBLIC_UPI_ESCROW_DEPLOYMENT_BLOCK ??
    process.env.UPI_ESCROW_DEPLOYMENT_BLOCK ??
    "14707895",
);
export const MAINNET_DEPLOYMENT_BLOCK = Number(
  process.env.NEXT_PUBLIC_UPI_ESCROW_MAINNET_DEPLOYMENT_BLOCK ??
    process.env.UPI_ESCROW_MAINNET_DEPLOYMENT_BLOCK ??
    "14521858",
);
export const SEPOLIA_FEE_COLLECTOR =
  process.env.NEXT_PUBLIC_FEE_COLLECTOR_ADDRESS ??
  "0x018dd7eb021121a4965b58a8e3e2d4ceef98935192c10e6aad1c079ce92fc5d2";
export const MAINNET_FEE_COLLECTOR =
  process.env.NEXT_PUBLIC_MAINNET_FEE_COLLECTOR_ADDRESS ??
  "0x03c044e7fb854db34470b9a190a67264f866c814e6965670763615cd92c3f0ca";

const alchemyKey =
  process.env.NEXT_PUBLIC_ALCHEMY_STARKNET_API_KEY ??
  process.env.NEXT_PUBLIC_PROVIDER_URL ??
  "";
const providerFor = (network: NetworkId) =>
  new RpcProvider({
    nodeUrl: `https://starknet-${network}.g.alchemy.com/starknet/version/rpc/v0_10/${alchemyKey}`,
  });

export const NETWORKS: Record<NetworkId, NetworkConfig> = {
  sepolia: {
    id: "sepolia",
    label: "Sepolia",
    chainId: SEPOLIA_CHAIN_ID,
    escrow: SEPOLIA_ESCROW,
    privacyPool: SEPOLIA_PRIVACY_POOL,
    token: STRK_TOKEN,
    explorer: "https://sepolia.voyager.online",
    deploymentBlock: SEPOLIA_DEPLOYMENT_BLOCK,
    feeCollector: SEPOLIA_FEE_COLLECTOR,
    provider: providerFor("sepolia"),
  },
  mainnet: {
    id: "mainnet",
    label: "Mainnet",
    chainId: MAINNET_CHAIN_ID,
    escrow: MAINNET_ESCROW,
    privacyPool: MAINNET_PRIVACY_POOL,
    token: STRK_TOKEN,
    explorer: "https://voyager.online",
    deploymentBlock: MAINNET_DEPLOYMENT_BLOCK,
    feeCollector: MAINNET_FEE_COLLECTOR,
    provider: providerFor("mainnet"),
  },
};

export const getNetworkConfig = (network: NetworkId) => NETWORKS[network];

// Backwards-compatible Sepolia exports used by wallet and server code during migration.
export const UPI_ESCROW_SEPOLIA = SEPOLIA_ESCROW;
export const VOYAGER_SEPOLIA = NETWORKS.sepolia.explorer;
export const sepoliaProvider = NETWORKS.sepolia.provider;
export const TEE_SERVER_URL =
  process.env.NEXT_PUBLIC_TEE_SERVER_URL ?? "http://localhost:8789";
export const INTENT_FEE = 10n ** 18n;
