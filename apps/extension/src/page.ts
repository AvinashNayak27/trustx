import type { ReplayResult } from '@tee-replay/protocol';
import { CONTENT_MARKER, PAGE_MARKER, type PageRequest, type PageResponse } from './messages';

type ConnectionStatus = 'connected' | 'disconnected' | 'pending';
type Pending = { resolve(value: unknown): void; reject(error: Error & { code?: string }): void };
type PageCall =
  | { action: 'CHECK_CONNECTION' }
  | { action: 'REQUEST_CONNECTION' }
  | { action: 'REPLAY'; payload: { provider: string; action: string } };
const pending = new Map<string, Pending>();

function call<T>(request: PageCall): Promise<T> {
  const id = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    window.postMessage({ ...request, marker: PAGE_MARKER, id } satisfies PageRequest, window.location.origin);
  });
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data as Partial<PageResponse> | null;
  if (!message || message.marker !== CONTENT_MARKER || typeof message.id !== 'string') return;
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id);
  if (message.ok) {
    operation.resolve(message.result);
    return;
  }
  const error = new Error(message.error?.message ?? 'Extension request failed') as Error & { code?: string };
  error.code = message.error?.code ?? 'REPLAY_REJECTED';
  operation.reject(error);
});

const api = Object.freeze({
  requestConnection: () => call<boolean>({ action: 'REQUEST_CONNECTION' }),
  checkConnectionStatus: () => call<ConnectionStatus>({ action: 'CHECK_CONNECTION' }),
  replay: (params: { provider: string; action: string }) =>
    call<ReplayResult>({ action: 'REPLAY', payload: params }),
});

Object.defineProperty(window, 'teeReplay', {
  value: api,
  configurable: false,
  writable: false,
});
document.documentElement.dataset.teeReplayInjected = 'true';
window.dispatchEvent(new CustomEvent('tee-replay#initialized'));
