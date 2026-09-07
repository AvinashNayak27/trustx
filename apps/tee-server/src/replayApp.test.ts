import request from 'supertest';
import { shortString } from 'starknet';
import { describe, expect, it, vi } from 'vitest';
import type { SessionMaterial } from '@tee-replay/protocol';
import { computePaymentHash, PaymentSigner } from './paymentSigner.js';
import { createReplayApp } from './replayApp.js';

const MNEMONIC = 'test test test test test test test test test test test junk';

function encryptBody(paymentSigner: PaymentSigner, overrides: Partial<SessionMaterial> = {}) {
  const material: SessionMaterial = {
    provider: 'amazon-pay', action: 'transaction-details', requestId: 'request-123', issuedAtMs: Date.now(),
    site: { origin: 'https://www.amazon.in', path: '/pay/transaction-details', method: 'GET' },
    headers: { cookie: 'session=secret', authorization: 'must-not-forward' },
    targetUrl: 'https://www.amazon.in/pay/transaction-details?idempotencyId=abc&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY',
    ...overrides,
  };
  const ciphertext = Buffer.from(paymentSigner.encrypt(Buffer.from(JSON.stringify(material), 'utf8'))).toString('base64');
  return {
    requestId: material.requestId,
    site: material.site,
    encryptedSessionMaterial: { ciphertext },
  };
}

describe('replay app', () => {
  it('exposes the mnemonic-derived encryption public key on /health', async () => {
    const paymentSigner = new PaymentSigner(MNEMONIC);
    const { app } = createReplayApp({ paymentSigner });
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.encryptionPublicKey).toBe(paymentSigner.encryptionPublicKey);
    expect(response.body.encryptionPublicKey).toMatch(/^0x04[0-9a-f]+$/iu);
  });

  it('returns encoded Amazon payment data with a valid Stark signature', async () => {
    const receipt = {
      paymentStatusDetails: { status: 'SUCCESS', paymentAmount: 2 },
      paymentEntityOfTypePaymentMethodEntity: { paymentMethodInstruments: [{ unmaskedVpaId: 'alice@upi' }] },
      identifierEntities: [{ identifierValues: [{ ctaTitle: '123456789' }] }],
    };
    const encodedReceipt = JSON.stringify(receipt).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ cookie: 'session=secret' });
      return new Response(`<div id="payui-transaction-receipt-id" data="${encodedReceipt}"></div>`, {
        status: 200, headers: { 'content-type': 'text/html' },
      });
    }) as unknown as typeof fetch;
    const paymentSigner = new PaymentSigner(MNEMONIC);
    const { app } = createReplayApp({ fetchImpl, paymentSigner });
    const response = await request(app).post('/v1/replay/amazon-pay/transaction-details')
      .send(encryptBody(paymentSigner));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      transaction: {
        paymentStatusTitle: shortString.encodeShortString('Success'),
        paymentTotalAmount: '2000000000000000000',
        receiverUpiId: shortString.encodeShortString('alice@upi'),
        upiTransactionId: shortString.encodeShortString('123456789'),
      },
      message: 'Transaction data retrieved successfully!',
    });
    const transaction = response.body.transaction;
    const hash = computePaymentHash(
      transaction.paymentStatusTitle,
      transaction.paymentTotalAmount,
      transaction.receiverUpiId,
      transaction.upiTransactionId,
    );
    expect(paymentSigner.verify(response.body.signature, hash)).toBe(true);
  });

  it('rejects plaintext session material', async () => {
    const paymentSigner = new PaymentSigner(MNEMONIC);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { app } = createReplayApp({ fetchImpl, paymentSigner });
    const material: SessionMaterial = {
      provider: 'amazon-pay', action: 'transaction-details', requestId: 'request-123', issuedAtMs: Date.now(),
      site: { origin: 'https://www.amazon.in', path: '/pay/transaction-details', method: 'GET' },
      headers: { cookie: 'session=secret' },
      targetUrl: 'https://www.amazon.in/pay/transaction-details?idempotencyId=abc&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY',
    };
    const response = await request(app).post('/v1/replay/amazon-pay/transaction-details').send({
      requestId: material.requestId,
      site: material.site,
      sessionMaterial: material,
    });
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unregistered destination before replay', async () => {
    const paymentSigner = new PaymentSigner(MNEMONIC);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { app } = createReplayApp({ fetchImpl, paymentSigner });
    const body = encryptBody(paymentSigner);
    body.site = { ...body.site, origin: 'http://169.254.169.254' };
    const response = await request(app).post('/v1/replay/amazon-pay/transaction-details').send(body);
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects stale session material', async () => {
    const paymentSigner = new PaymentSigner(MNEMONIC);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { app } = createReplayApp({ fetchImpl, paymentSigner });
    const response = await request(app).post('/v1/replay/amazon-pay/transaction-details').send(
      encryptBody(paymentSigner, { issuedAtMs: Date.now() - 10 * 60_000 }),
    );
    expect(response.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
