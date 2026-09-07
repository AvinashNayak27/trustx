import type { ProviderConfig } from '@tee-replay/protocol';

const AMAZON_PAY_ORIGIN = 'https://www.amazon.in';

export const amazonPayProvider: ProviderConfig = {
  provider: 'amazon-pay',
  action: 'transaction-details',
  authLink: `${AMAZON_PAY_ORIGIN}/pay/history?tab=ALL&filter=%7B%22paymentInstruments%22%3A%5B%7B%22paymentInstrumentType%22%3A%22UPI%22%2C%22paymentInstrumentIds%22%3Anull%2C%22brandValue%22%3Anull%7D%5D%2C%22types%22%3A%5B%22P2POutgoingPay%22%5D%7D&ref=`,
  capture: {
    urlRegex: '^https://www\\.amazon\\.in/pay/transaction-details\\?idempotencyId=[^&]+&useCase=p2p_outgoing_pay&ingress=TRANSACTION_HISTORY$',
    method: 'GET',
    headerNames: ['cookie'],
    maxBodyBytes: 65_536,
  },
  site: {
    origin: AMAZON_PAY_ORIGIN,
    path: '/pay/transaction-details',
    method: 'GET',
  },
};

export function getProviderConfig(provider: string, action: string): ProviderConfig | null {
  return provider === amazonPayProvider.provider && action === amazonPayProvider.action ? amazonPayProvider : null;
}
