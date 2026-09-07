import type { ReplayResult } from '@tee-replay/protocol';

export const PAGE_MARKER = 'tee-replay-page';
export const CONTENT_MARKER = 'tee-replay-content';

export type PageRequest =
  | { marker: typeof PAGE_MARKER; id: string; action: 'CHECK_CONNECTION' }
  | { marker: typeof PAGE_MARKER; id: string; action: 'REQUEST_CONNECTION' }
  | {
      marker: typeof PAGE_MARKER;
      id: string;
      action: 'REPLAY';
      payload: { provider: string; action: string };
    };

export type PageResponse = {
  marker: typeof CONTENT_MARKER;
  id: string;
  ok: boolean;
  result?: ReplayResult | boolean | 'connected' | 'disconnected' | 'pending';
  error?: { code: string; message: string };
};

export type BackgroundRequest = {
  type: 'START_REPLAY';
  requestId: string;
  provider: string;
  action: string;
};

export type BackgroundResponse =
  | { type: 'REPLAY_RESULT'; requestId: string; result: ReplayResult }
  | { type: 'REPLAY_ERROR'; requestId: string; error: { code: string; message: string } };

