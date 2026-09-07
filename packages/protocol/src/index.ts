/** Canonical TrustX web origin used by the production extension flow. */
export const HOST_APP_ORIGIN = 'https://trustx-ui.vercel.app';
/** Approved TrustX web origins that may initiate TEE replay. */
export const HOST_APP_ORIGINS = [
  HOST_APP_ORIGIN,
  // Keep the local demo origin available for development builds.
  'http://localhost:8787',
] as const;
/** Production TEE replay/signing service. */
export const TEE_SERVER_ORIGIN = 'https://trustx-tee-server.vercel.app';
export const AMAZON_PAY_ORIGIN = 'https://www.amazon.in';

export type ReplaySite = {
  origin: string;
  path: string;
  method: string;
};

export type ProviderConfig = {
  provider: string;
  action: string;
  authLink: string;
  capture: {
    urlRegex: string;
    method: string;
    headerNames: string[];
    maxBodyBytes: number;
  };
  site: ReplaySite;
};

export type SessionMaterial = {
  provider: string;
  action: string;
  requestId: string;
  issuedAtMs: number;
  site: ReplaySite;
  headers: Record<string, string>;
  targetUrl?: string;
  body?: string;
};

/** Base64-encoded ECIES ciphertext of a JSON-serialized SessionMaterial. */
export type EncryptedSessionMaterial = {
  ciphertext: string;
};

export type GenericReplayResult = {
  requestId: string;
  status: number;
  contentType: 'application/json';
  data: unknown;
  signedAt: number;
};

export type AmazonTransactionReplayResult = {
  success: true;
  transaction: {
    paymentStatusTitle: string;
    paymentTotalAmount: string;
    receiverUpiId: string;
    upiTransactionId: string;
  };
  signature: {
    signature_r: string;
    signature_s: string;
  };
  message: string;
};

export type ReplayResult = GenericReplayResult | AmazonTransactionReplayResult;

export type ReplayErrorCode =
  | 'USER_REJECTED'
  | 'NOT_CONNECTED'
  | 'FLOW_IN_PROGRESS'
  | 'NO_MATCH'
  | 'CAPTURE_TIMEOUT'
  | 'SIGNING_FAILED'
  | 'REPLAY_REJECTED'
  | 'UPSTREAM_FAILED';

export class ReplayError extends Error {
  constructor(
    public readonly code: ReplayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}
