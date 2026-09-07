import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '@tee-replay/protocol';
import { matchesProviderRequest, selectCapturedHeaders } from './capture';

const config: ProviderConfig = {
  provider: 'amazon-pay',
  action: 'transaction-details',
  authLink: 'https://www.amazon.in/pay/history',
  capture: {
    urlRegex: '^https://www\\.amazon\\.in/pay/transaction-details\\?idempotencyId=[^&]+&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY$',
    method: 'GET',
    headerNames: ['cookie'],
    maxBodyBytes: 65_536,
  },
  site: { origin: 'https://www.amazon.in', path: '/pay/transaction-details', method: 'GET' },
};

const matchingUrl =
  'https://www.amazon.in/pay/transaction-details?idempotencyId=abc123&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY';

describe('capture policy', () => {
  it('matches only the exact configured request', () => {
    expect(matchesProviderRequest(config, { method: 'GET', url: matchingUrl })).toBe(true);
    expect(matchesProviderRequest(config, { method: 'POST', url: matchingUrl })).toBe(false);
    expect(matchesProviderRequest(config, {
      method: 'GET',
      url: 'https://www.amazon.in/pay/transaction-details?idempotencyId=abc123&useCase=other&ingress=TRANSACTION_HISTORY',
    })).toBe(false);
  });

  it('keeps only explicitly approved headers', () => {
    expect(selectCapturedHeaders(['cookie'], [
      { name: 'Cookie', value: 'session=secret' },
      { name: 'Authorization', value: 'do-not-copy' },
      { name: 'User-Agent', value: 'browser' },
    ])).toEqual({ cookie: 'session=secret' });
  });
});
