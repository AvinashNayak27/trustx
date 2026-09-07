import {
  HOST_APP_ORIGINS,
  TEE_SERVER_ORIGIN,
  type ProviderConfig,
  type ReplayResult,
  type SessionMaterial,
} from '@tee-replay/protocol';
import type { BackgroundRequest, BackgroundResponse } from './messages';
import { matchesProviderRequest, selectCapturedHeaders } from './capture';
import { encryptSessionMaterial } from './sessionCrypto';

type CaptureSession = {
  requestId: string;
  provider: string;
  action: string;
  providerTabId: number;
  port: chrome.runtime.Port;
  config: ProviderConfig;
  encryptionPublicKey: string;
  timeout: ReturnType<typeof setTimeout>;
  processing: boolean;
};

const sessionsByProviderTab = new Map<number, CaptureSession>();
const requestBodies = new Map<string, string>();
const PROVIDER_TAB_CLOSE_DELAY_MS = 5_000;

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function sendError(session: CaptureSession, code: string, message: string) {
  const response: BackgroundResponse = { type: 'REPLAY_ERROR', requestId: session.requestId, error: { code, message } };
  try { session.port.postMessage(response); } catch { /* initiating tab closed */ }
}

async function cleanup(session: CaptureSession, closeProviderTab = true) {
  clearTimeout(session.timeout);
  sessionsByProviderTab.delete(session.providerTabId);
  if (closeProviderTab) {
    try { await chrome.tabs.remove(session.providerTabId); } catch { /* already closed */ }
  }
}

function rawBody(details: chrome.webRequest.OnBeforeRequestDetails): string | undefined {
  if (details.requestBody?.raw?.length) {
    const bytes = details.requestBody.raw.flatMap((part: chrome.webRequest.UploadData) => part.bytes ? [...new Uint8Array(part.bytes)] : []);
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  if (details.requestBody?.formData) {
    const params = new URLSearchParams();
    for (const [name, values] of Object.entries(details.requestBody.formData)) {
      for (const value of values ?? []) {
        if (typeof value === 'string') params.append(name, value);
      }
    }
    return params.toString();
  }
  return undefined;
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !sessionsByProviderTab.has(details.tabId)) return undefined;
    const body = rawBody(details);
    if (body !== undefined) requestBodies.set(details.requestId, body);
    return undefined;
  },
  { urls: ['https://www.amazon.in/pay/transaction-details*'] },
  ['requestBody'],
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const session = sessionsByProviderTab.get(details.tabId);
    if (!session || session.processing) return undefined;
    const config = session.config;
    if (!matchesProviderRequest(config, details)) return undefined;
    session.processing = true;
    clearTimeout(session.timeout);
    void processCapture(session, details).finally(() => requestBodies.delete(details.requestId));
    return undefined;
  },
  { urls: ['https://www.amazon.in/pay/transaction-details*'] },
  ['requestHeaders', 'extraHeaders'],
);

async function processCapture(session: CaptureSession, details: chrome.webRequest.OnBeforeSendHeadersDetails) {
  try {
    console.info('[TEE Replay] Matched provider request', {
      provider: session.provider,
      action: session.action,
      method: details.method,
      url: details.url,
    });
    const headers = selectCapturedHeaders(session.config.capture.headerNames, details.requestHeaders ?? []);
    const body = requestBodies.get(details.requestId);
    if (body && new TextEncoder().encode(body).byteLength > session.config.capture.maxBodyBytes) {
      throw new Error('Captured request body exceeds the provider limit.');
    }
    const material: SessionMaterial = {
      provider: session.provider,
      action: session.action,
      requestId: session.requestId,
      issuedAtMs: Date.now(),
      site: session.config.site,
      headers,
      targetUrl: details.url,
      ...(body === undefined ? {} : { body }),
    };
    const ciphertext = encryptSessionMaterial(session.encryptionPublicKey, material);
    for (const name of Object.keys(headers)) headers[name] = '';
    for (const name of Object.keys(material.headers)) material.headers[name] = '';
    if (material.body) material.body = '';
    const replayUrl = `${TEE_SERVER_ORIGIN}/v1/replay/${encodeURIComponent(session.provider)}/${encodeURIComponent(session.action)}`;
    console.info('[TEE Replay] Sending encrypted session material for signed replay', replayUrl);
    const replayResponse = await fetch(replayUrl, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: session.requestId,
        site: session.config.site,
        encryptedSessionMaterial: { ciphertext },
      }),
    });
    const replayPayload = await replayResponse.json() as ReplayResult | { error?: { code?: string; message?: string } };
    if (!replayResponse.ok || 'error' in replayPayload) {
      const error = 'error' in replayPayload ? replayPayload.error : undefined;
      throw Object.assign(new Error(error?.message ?? 'Replay server rejected the request.'), { code: error?.code ?? 'REPLAY_REJECTED' });
    }
    const replayResult = replayPayload as ReplayResult;
    const response: BackgroundResponse = { type: 'REPLAY_RESULT', requestId: session.requestId, result: replayResult };
    console.info('[TEE Replay] Replay completed', { requestId: session.requestId });
    session.port.postMessage(response);
    await delay(PROVIDER_TAB_CLOSE_DELAY_MS);
    await cleanup(session);
  } catch (error) {
    const typed = error as Error & { code?: string };
    sendError(session, typed.code ?? 'SIGNING_FAILED', typed.message || 'Capture failed.');
    await cleanup(session);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tee-replay' || !port.sender?.tab?.id) return;
  port.onMessage.addListener((message: BackgroundRequest) => {
    if (message.type !== 'START_REPLAY') return;
    void startReplay(port, message);
  });
  port.onDisconnect.addListener(() => {
    for (const session of sessionsByProviderTab.values()) {
      if (session.port === port) void cleanup(session);
    }
  });
});

async function startReplay(port: chrome.runtime.Port, message: BackgroundRequest) {
  if ([...sessionsByProviderTab.values()].some((session) => session.port === port)) {
    port.postMessage({ type: 'REPLAY_ERROR', requestId: message.requestId, error: { code: 'FLOW_IN_PROGRESS', message: 'A replay is already active for this page.' } } satisfies BackgroundResponse);
    return;
  }
  try {
    const initiatingUrl = port.sender?.tab?.url;
    if (
      !initiatingUrl ||
      !(HOST_APP_ORIGINS as readonly string[]).includes(new URL(initiatingUrl).origin)
    ) {
      throw new Error('The initiating page is not an approved return origin.');
    }
    const providerUrl = `${TEE_SERVER_ORIGIN}/v1/providers/${encodeURIComponent(message.provider)}/${encodeURIComponent(message.action)}`;
    console.info('[TEE Replay] Loading provider policy', providerUrl);
    const [providerResponse, healthResponse] = await Promise.all([
      fetch(providerUrl, { credentials: 'omit' }),
      fetch(`${TEE_SERVER_ORIGIN}/health`, { credentials: 'omit' }),
    ]);
    if (!providerResponse.ok) throw new Error('Unknown provider action.');
    if (!healthResponse.ok) throw new Error('TEE health check failed.');
    const config = await providerResponse.json() as ProviderConfig;
    const health = await healthResponse.json() as { encryptionPublicKey?: string };
    if (config.provider !== message.provider || config.action !== message.action) throw new Error('Provider configuration mismatch.');
    if (typeof health.encryptionPublicKey !== 'string' || !health.encryptionPublicKey.startsWith('0x')) {
      throw new Error('TEE encryption public key is unavailable.');
    }
    const providerTab = await chrome.tabs.create({ url: config.authLink, active: true });
    if (providerTab.id === undefined) throw new Error('Could not open the provider tab.');
    const timeout = setTimeout(() => {
      const session = sessionsByProviderTab.get(providerTab.id as number);
      if (!session) return;
      sendError(session, 'CAPTURE_TIMEOUT', 'No matching provider request was observed within two minutes.');
      void cleanup(session);
    }, 120_000);
    sessionsByProviderTab.set(providerTab.id, {
      requestId: message.requestId,
      provider: message.provider,
      action: message.action,
      providerTabId: providerTab.id,
      port,
      config,
      encryptionPublicKey: health.encryptionPublicKey,
      timeout,
      processing: false,
    });
  } catch (error) {
    port.postMessage({ type: 'REPLAY_ERROR', requestId: message.requestId, error: { code: 'REPLAY_REJECTED', message: error instanceof Error ? error.message : 'Could not start replay.' } } satisfies BackgroundResponse);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessionsByProviderTab.get(tabId);
  if (!session) return;
  sendError(session, 'NO_MATCH', 'The provider tab closed before a matching request was captured.');
  void cleanup(session, false);
});
