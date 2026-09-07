# Trustx

Trustx is a private, secure P2P UPI on/off-ramp on Starknet. Sellers list STRK behind the privacy pool; buyers signal a private intent, pay by UPI, and settle with a TEE-attested receipt. Seller STRK remains shielded, and successful settlement credits the buyer with a shielded STRK note — private on both sides.

## Mainnet demo

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:8787`, connect a privacy-enabled Starknet wallet on Mainnet, and make sure the local TEE service is available at the configured URL.

## Environment

- `ALCHEMY_STARKNET_API_KEY` is used server-side to index `DepositCreated` events.
- `NEXT_PUBLIC_ALCHEMY_STARKNET_API_KEY` is a browser fallback for wallet RPC.
- `UPI_ESCROW_DEPLOYMENT_BLOCK` should be the deployment block in production.
- `NEXT_PUBLIC_TEE_SERVER_URL` must expose `/health` and match the signer stored on-chain.

## Trust model

- The UPI escrow verifies the TEE's Stark signature on-chain before settlement.
- Settlement does not make a public STRK transfer: the escrow approves the privacy pool to credit the buyer's shielded note.
- Buyers pay a 1 STRK private intent fee, which locks a listing for 30 minutes.
- Sellers can recover an unfilled listing only from their selected recovery address after any active intent expires.
- Listings are discovered from `DepositCreated` events through Alchemy, then their live state is read from the contract. No manual deposit IDs.

## Deployed Mainnet contract

- UPI escrow: `0x0598c8db6c7904f5a025fa340fecd2c926c7043f265a6a2129b06c842e74f33e`
- Deployment block: `14521858`
- TEE signer: `0x03502be14209a50a57d8bd703a78b4484ffbe32974354d2bef82d4662a70b772`
- Intent fee: 1 STRK

The Cairo source and contract deployment notes are in [`cairo/`](./cairo).
