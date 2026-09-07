# TrustX

TrustX is a private and secure peer-to-peer STRK ↔ UPI onramp/offramp for Starknet. A buyer pays a seller through UPI/Amazon Pay, while the STRK leg remains shielded until a receipt is attested and the escrow contract releases the funds.

## Live links

- UI: [trustx-ui.vercel.app](https://trustx-ui.vercel.app/)
- TEE replay/signing API: [trustx-tee-server.vercel.app](https://trustx-tee-server.vercel.app/health)
- Starknet Sepolia explorer: [Voyager Sepolia](https://sepolia.voyager.online/)
- Starknet Mainnet explorer: [Voyager](https://voyager.online/)
- Starknet: [starknet.io](https://www.starknet.io/)

## Demo and Mainnet activity

- Demo video: [TrustX demo on Cap](https://cap.so/s/eejb2wrkb7nk972)
- Mainnet deposit: [0x3f00ea…9da44](https://voyager.online/tx/0x3f00ea4080e58fb73ef1246eb46703841cf6fa3b566f4b4bd587f328a39da44)
- Mainnet intent signal: [0x17d7aa…d0460](https://voyager.online/tx/0x17d7aa46024de19eb489eff73177e5f165d6e2f4f0d666a69115c8a649d0460)
- Mainnet settlement: [0x1f7281…a2c5](https://voyager.online/tx/0x1f72819b26f167c821463081c893ab638efad354656200cc134fab5af5aa2c5)

The same metadata is machine-readable in [`strk20.json`](./strk20.json).

## Repository layout

```text
apps/
  ui/             Next.js buyer/seller checkout and escrow activity UI
  tee-server/     Express replay service and Stark signature service
  extension/      Chrome extension that captures Amazon Pay receipt context
packages/
  protocol/       Shared origins, replay types, and provider protocol
contracts/        Cairo escrow and privacy integration contracts
```

## Architecture

```text
User browser
  │
  ├─ TrustX UI ── Starknet wallet ── privacy pool / escrow contract
  │       │
  │       └─ requests a signed, validated payment attestation
  │
  └─ TrustX extension ── captures only the allow-listed Amazon Pay receipt request
          │
          └─ TEE server ── decrypts the short-lived session, replays the request,
                          canonicalizes receipt fields, and signs the payment hash
```

The extension never sends a broad browser session to the server. It selects the provider-approved request headers, encrypts the short-lived session material to the signer, and sends it to the TEE API. The TEE response contains canonical payment fields and a Stark signature. The UI checks the receipt status, amount, UPI destination, signer public key, and signature before submitting the privacy claim. The Cairo escrow verifies the same canonical hash on-chain, prevents replay/duplicate claims, and controls deposit, intent, claim, and recovery paths.

### Privacy and security boundaries

- STRK is held by the privacy pool/escrow until the attestation and claim path succeeds.
- The TEE signer key is server-only and is supplied through Vercel environment variables; it is not committed to this repository.
- The UI and extension use explicit production origins, with localhost retained only for development builds.
- The contract validates the configured signer and payment message on-chain; client-side validation is only an early failure check.
- UPI/Amazon Pay receipt data is used to attest the payment and is not intended as a general-purpose account or session proxy.

## Running locally

```bash
npm install
npm run dev:ui
npm run dev:tee
npm run build:extension
```

Copy each `.env.example` to `.env` where needed. Never commit a mnemonic, RPC key, or signer key. Build the Cairo workspace with Scarb from `contracts/`.

## Verification

```bash
npm run build:ui
npm run build:tee
npm run typecheck
npm test
cd contracts && scarb test
```

## Deployment note

The UI and TEE API are currently deployed on Vercel. We could not deploy the signer service to an actual confidential TEE because EigenCloud was unavailable for this project at deployment time. Vercel is therefore the current hosting fallback, not a claim that the production endpoint provides hardware-enforced TEE confidentiality. We will evaluate EigenCloud and other confidential-compute alternatives before treating the signer as production-grade TEE infrastructure.
