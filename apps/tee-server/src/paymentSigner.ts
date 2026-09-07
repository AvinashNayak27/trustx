import { decrypt, encrypt } from 'eciesjs';
import { ec, uint256 } from 'starknet';
import { mnemonicToAccount } from 'viem/accounts';

// The UPI escrow's Cairo verifier constrains the final Pedersen value to a
// felt-safe 251-bit message before calling check_ecdsa_signature. This must
// remain identical to `STARK_MESSAGE_BOUND` in strk20-starter-kit/cairo.
const STARK_MESSAGE_BOUND = 1n << 251n;

export type PaymentSignature = {
  signature_r: string;
  signature_s: string;
};

export function computePaymentHash(
  paymentStatusTitle: string,
  paymentTotalAmount: string,
  receiverUpiId: string,
  upiTransactionId: string,
): string {
  const { low, high } = uint256.bnToUint256(BigInt(paymentTotalAmount));
  const toBigInt = (value: string | number | bigint) => BigInt(value);
  let hash = 0n;
  hash = toBigInt(ec.starkCurve.pedersen(hash, BigInt(paymentStatusTitle)));
  hash = toBigInt(ec.starkCurve.pedersen(hash, BigInt(low)));
  hash = toBigInt(ec.starkCurve.pedersen(hash, BigInt(high)));
  hash = toBigInt(ec.starkCurve.pedersen(hash, BigInt(receiverUpiId)));
  hash = toBigInt(ec.starkCurve.pedersen(hash, BigInt(upiTransactionId)));
  hash = toBigInt(ec.starkCurve.pedersen(hash, 5n));
  hash %= STARK_MESSAGE_BOUND;
  return `0x${hash.toString(16).padStart(64, '0')}`;
}

export class PaymentSigner {
  /** Uncompressed secp256k1 public key (0x04…), used by clients to ECIES-encrypt session material. */
  readonly encryptionPublicKey: string;
  readonly starkPublicKey: string;
  readonly #evmPrivateKey: Uint8Array;
  readonly #starkPrivateKey: string;
  readonly #verificationKey: Uint8Array;

  constructor(mnemonic: string) {
    const evmAccount = mnemonicToAccount(mnemonic);
    const evmPrivateKey = evmAccount.getHdKey().privateKey;
    if (!evmPrivateKey) throw new Error('Unable to derive private key from mnemonic');

    this.#evmPrivateKey = Uint8Array.from(evmPrivateKey);
    this.encryptionPublicKey = evmAccount.publicKey;
    const evmPrivateKeyHex = `0x${Buffer.from(evmPrivateKey).toString('hex')}`;
    this.#starkPrivateKey = `0x${ec.starkCurve.grindKey(evmPrivateKeyHex)}`;
    this.starkPublicKey = ec.starkCurve.getStarkKey(this.#starkPrivateKey);
    this.#verificationKey = ec.starkCurve.getPublicKey(this.#starkPrivateKey);
  }

  static fromEnvironment(): PaymentSigner {
    const mnemonic = process.env.MNEMONIC;
    if (!mnemonic) throw new Error('MNEMONIC not found in environment');
    return new PaymentSigner(mnemonic);
  }

  /** ECIES-encrypt plaintext to this signer's secp256k1 public key (for tests / round-trips). */
  encrypt(plaintext: Uint8Array): Uint8Array {
    return encrypt(this.encryptionPublicKey, plaintext);
  }

  /** ECIES-decrypt ciphertext produced for this signer's public key. */
  decrypt(ciphertext: Uint8Array): Uint8Array {
    return decrypt(this.#evmPrivateKey, ciphertext);
  }

  sign(
    paymentStatusTitle: string,
    paymentTotalAmount: string,
    receiverUpiId: string,
    upiTransactionId: string,
  ): PaymentSignature {
    const messageHash = computePaymentHash(
      paymentStatusTitle,
      paymentTotalAmount,
      receiverUpiId,
      upiTransactionId,
    );
    const signature = ec.starkCurve.sign(messageHash, this.#starkPrivateKey);
    return {
      signature_r: signature.r.toString(),
      signature_s: signature.s.toString(),
    };
  }

  verify(signature: PaymentSignature, messageHash: string): boolean {
    return ec.starkCurve.verify(
      new ec.starkCurve.Signature(BigInt(signature.signature_r), BigInt(signature.signature_s)),
      messageHash,
      this.#verificationKey,
    );
  }
}
