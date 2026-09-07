import { describe, expect, it } from 'vitest';
import type { SessionMaterial } from '@tee-replay/protocol';
import { encryptSessionMaterial } from './sessionCrypto';

describe('sessionCrypto', () => {
  it('returns base64 ciphertext that does not contain plaintext secrets', () => {
    // Fixed uncompressed secp256k1 public key for unit isolation (not a live TEE key).
    const encryptionPublicKey =
      '0x04' +
      '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' +
      '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
    const material: SessionMaterial = {
      provider: 'amazon-pay',
      action: 'transaction-details',
      requestId: 'request-123',
      issuedAtMs: Date.now(),
      site: { origin: 'https://www.amazon.in', path: '/pay/transaction-details', method: 'GET' },
      headers: { cookie: 'session=secret' },
      targetUrl: 'https://www.amazon.in/pay/transaction-details?idempotencyId=abc&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY',
    };

    const ciphertext = encryptSessionMaterial(encryptionPublicKey, material);
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/u);
    expect(ciphertext).not.toContain('session=secret');
    expect(atob(ciphertext)).not.toContain('session=secret');
  });
});
