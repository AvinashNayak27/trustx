import cors from 'cors';
import express, { type RequestHandler } from 'express';
import type { GenericReplayResult, ReplaySite, SessionMaterial } from '@tee-replay/protocol';
import { shortString } from 'starknet';
import { PaymentSigner } from './paymentSigner.js';
import { getProviderConfig } from './providerRegistry.js';

type FetchLike = typeof fetch;

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SESSION_MAX_AGE_MS = 2 * 60_000;
const MAX_CIPHERTEXT_BYTES = 384 * 1024;

function decodeEncryptedSessionMaterial(
  paymentSigner: PaymentSigner,
  encryptedSessionMaterial: unknown,
): SessionMaterial {
  if (!encryptedSessionMaterial || typeof encryptedSessionMaterial !== 'object') {
    throw new Error('Missing encrypted session material');
  }
  const ciphertext = (encryptedSessionMaterial as Record<string, unknown>).ciphertext;
  if (typeof ciphertext !== 'string' || ciphertext.length < 32 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error('Invalid encrypted session material');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(ciphertext, 'base64');
  } catch {
    throw new Error('Invalid encrypted session material encoding');
  }
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_CIPHERTEXT_BYTES) {
    throw new Error('Invalid encrypted session material size');
  }
  let plaintext: Uint8Array;
  try {
    plaintext = paymentSigner.decrypt(bytes);
  } catch {
    throw new Error('Unable to decrypt session material');
  }
  try {
    return JSON.parse(Buffer.from(plaintext).toString('utf8')) as SessionMaterial;
  } catch {
    throw new Error('Decrypted session material is not valid JSON');
  }
}

function sameSite(actual: unknown, expected: ReplaySite): actual is ReplaySite {
  if (!actual || typeof actual !== 'object') return false;
  const site = actual as Record<string, unknown>;
  return site.origin === expected.origin && site.path === expected.path && site.method === expected.method;
}

function validMaterial(value: SessionMaterial, requestId: string, provider: string, action: string): boolean {
  return (
    value &&
    value.requestId === requestId &&
    value.provider === provider &&
    value.action === action &&
    Number.isSafeInteger(value.issuedAtMs) &&
    Math.abs(Date.now() - value.issuedAtMs) <= SESSION_MAX_AGE_MS &&
    typeof value.headers === 'object' &&
    value.headers !== null
    && (provider !== 'amazon-pay' || (typeof value.targetUrl === 'string' && /^https:\/\/www\.amazon\.in\/pay\/transaction-details\?idempotencyId=[^&]+&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY$/u.test(value.targetUrl)))
  );
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('Upstream response is too large');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error('Upstream response is too large');
  return buffer.toString('utf8');
}

function toBaseUnits(value: string | number, decimals = 18): string {
  const normalized = value.toString();
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) throw new Error('Payment amount is invalid');
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new Error(`Payment amount has more than ${decimals} decimals`);
  return (BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')).toString();
}

// Amazon Pay has returned both `SUCCESS` and `Success` in receipt payloads.
// The escrow is bound to one signed felt, so accept only a success status and
// canonicalize it before both encoding and Stark signing.
function canonicalPaymentSuccessStatus(value: string): 'Success' {
  if (value.trim().toUpperCase() !== 'SUCCESS') {
    throw new Error(`Amazon Pay transaction is not successful (${value})`);
  }
  return 'Success';
}

export function createReplayApp(options: {
  paymentSigner?: PaymentSigner;
  fetchImpl?: FetchLike;
  logger?: (message: string) => void;
} = {}) {
  const app = express();
  const paymentSigner = options.paymentSigner;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredOrigins = new Set(
    (process.env.CORS_ORIGINS ?? 'http://localhost:8787')
      // Comma-separated Trustx app origins (local + production HTTPS).
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  if (options.logger) {
    app.use((request, response, next) => {
      const startedAt = Date.now();
      response.on('finish', () => {
        options.logger?.(
          `${request.method} ${request.path} -> ${response.statusCode} (${Date.now() - startedAt}ms)`,
        );
      });
      next();
    });
  }

  app.use(cors({
    origin(origin, callback) {
      const allowed = !origin || origin.startsWith('chrome-extension://') || configuredOrigins.has(origin);
      callback(null, allowed);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type'],
    maxAge: 86_400,
  }));
  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));

  app.get('/health', (_request, response) => response.json({
    service: 'tee-replay',
    status: 'ok',
    mode: 'mnemonic-stark-signer',
    starkPublicKey: paymentSigner?.starkPublicKey,
    encryptionPublicKey: paymentSigner?.encryptionPublicKey,
  }));

  app.get('/v1/providers/:provider/:action', (request, response) => {
    const provider = request.params.provider;
    const action = request.params.action;
    if (typeof provider !== 'string' || typeof action !== 'string') {
      return response.status(400).json({ error: { code: 'REPLAY_REJECTED', message: 'Invalid provider action' } });
    }
    const config = getProviderConfig(provider, action);
    return config
      ? response.json(config)
      : response.status(404).json({ error: { code: 'REPLAY_REJECTED', message: 'Unknown provider action' } });
  });

  app.post('/v1/replay/:provider/:action', (async (request, response) => {
    const { provider, action } = request.params;
    if (typeof provider !== 'string' || typeof action !== 'string') {
      return response.status(400).json({ error: { code: 'REPLAY_REJECTED', message: 'Invalid provider action' } });
    }
    const config = getProviderConfig(provider, action);
    if (!config) {
      return response.status(404).json({ error: { code: 'REPLAY_REJECTED', message: 'Unknown provider action' } });
    }
    const { requestId, site, encryptedSessionMaterial } = request.body as Record<string, unknown>;
    if (
      typeof requestId !== 'string' ||
      requestId.length < 8 ||
      requestId.length > 128 ||
      !sameSite(site, config.site)
    ) {
      return response.status(400).json({ error: { code: 'REPLAY_REJECTED', message: 'Invalid replay request' } });
    }
    if (!paymentSigner) {
      return response.status(503).json({ error: { code: 'REPLAY_REJECTED', message: 'MNEMONIC signer is not configured' } });
    }

    let material: SessionMaterial;
    try {
      material = decodeEncryptedSessionMaterial(paymentSigner, encryptedSessionMaterial);
    } catch (error) {
      return response.status(400).json({
        error: {
          code: 'REPLAY_REJECTED',
          message: error instanceof Error ? error.message : 'Invalid encrypted session material',
        },
      });
    }
    if (!validMaterial(material, requestId, provider, action) || !sameSite(material.site, config.site)) {
      return response.status(400).json({ error: { code: 'REPLAY_REJECTED', message: 'Session material binding failed' } });
    }
    if (material.body && Buffer.byteLength(material.body) > config.capture.maxBodyBytes) {
      return response.status(413).json({ error: { code: 'REPLAY_REJECTED', message: 'Captured body is too large' } });
    }

    const allowedHeaders = new Set(config.capture.headerNames.map((name) => name.toLowerCase()));
    const headers = Object.fromEntries(
      Object.entries(material.headers)
        .filter(([name, value]) => allowedHeaders.has(name.toLowerCase()) && typeof value === 'string')
        .map(([name, value]) => [name.toLowerCase(), value]),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      if (provider === 'amazon-pay' && action === 'transaction-details') {
        const upstream = await fetchImpl(material.targetUrl!, { method: 'GET', headers, redirect: 'follow', signal: controller.signal });
        if (!upstream.ok) throw new Error(`Amazon Pay receipt request failed (${upstream.status})`);
        const html = await upstream.text();
        const element = html.match(/<[^>]*\bid=["']payui-transaction-receipt-id["'][^>]*>/u)?.[0];
        const dataValue = element?.match(/\bdata=["']([\s\S]*?)["']/u)?.[1];
        if (!dataValue) throw new Error('Transaction receipt data not found');
        const data = JSON.parse(dataValue.replaceAll('&quot;', '"').replaceAll('&#34;', '"').replaceAll('&amp;', '&')) as any;
        const paymentAmount = data.paymentStatusDetails?.paymentAmount;
        const paymentStatusTitle = data.paymentStatusDetails?.status;
        const receiverUpiId = data.paymentEntityOfTypePaymentMethodEntity?.paymentMethodInstruments?.[0]?.unmaskedVpaId;
        const upiTransactionId = data.identifierEntities?.[0]?.identifierValues?.[0]?.ctaTitle;
        if (
          (typeof paymentAmount !== 'number' && typeof paymentAmount !== 'string') ||
          typeof paymentStatusTitle !== 'string' ||
          typeof receiverUpiId !== 'string' ||
          typeof upiTransactionId !== 'string'
        ) {
          throw new Error('Transaction receipt contains invalid payment data');
        }
        const paymentTotalAmount = toBaseUnits(paymentAmount);
        const canonicalPaymentStatusTitle = canonicalPaymentSuccessStatus(paymentStatusTitle);
        const paymentStatusTitleEncoded = shortString.encodeShortString(canonicalPaymentStatusTitle);
        const receiverUpiIdEncoded = shortString.encodeShortString(receiverUpiId);
        const upiTransactionIdEncoded = shortString.encodeShortString(upiTransactionId);
        const signature = paymentSigner.sign(
          paymentStatusTitleEncoded,
          paymentTotalAmount,
          receiverUpiIdEncoded,
          upiTransactionIdEncoded,
        );

        return response.json({
          success: true,
          transaction: {
            paymentStatusTitle: paymentStatusTitleEncoded,
            paymentTotalAmount,
            receiverUpiId: receiverUpiIdEncoded,
            upiTransactionId: upiTransactionIdEncoded,
          },
          signature,
          message: 'Transaction data retrieved successfully!',
        });
      }
      const upstream = await fetchImpl(`${config.site.origin}${config.site.path}`, {
        method: config.site.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(config.site.method === 'GET' || config.site.method === 'HEAD' || !material.body
          ? {}
          : { body: material.body }),
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        throw new Error('Upstream redirects are not allowed');
      }
      const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim();
      if (contentType !== 'application/json') throw new Error('Upstream did not return JSON');
      const text = await readLimitedBody(upstream);
      const data = JSON.parse(text) as unknown;
      const replayResult: GenericReplayResult = {
        requestId,
        status: upstream.status,
        contentType: 'application/json',
        data,
        signedAt: Date.now(),
      };
      return response.status(upstream.ok ? 200 : 502).json({
        ...replayResult,
      });
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'Upstream request timed out'
        : error instanceof Error ? error.message : 'Upstream replay failed';
      return response.status(502).json({ error: { code: 'UPSTREAM_FAILED', message } });
    } finally {
      clearTimeout(timeout);
      for (const key of Object.keys(headers)) headers[key] = '';
      for (const key of Object.keys(material.headers)) material.headers[key] = '';
      if (material.body) material.body = '';
    }
  }) as RequestHandler);

  return { app, paymentSigner };
}
