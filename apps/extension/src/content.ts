import {
  CONTENT_MARKER,
  PAGE_MARKER,
  type BackgroundRequest,
  type BackgroundResponse,
  type PageRequest,
  type PageResponse,
} from './messages';

let connected = false;
let approvalOpen = false;
const activeRequests = new Set<string>();
const port = chrome.runtime.connect({ name: 'tee-replay' });

function sendPage(response: PageResponse) {
  window.postMessage(response, window.location.origin);
}

function showApproval(): Promise<boolean> {
  if (approvalOpen) return Promise.resolve(false);
  approvalOpen = true;
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.76)';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>*{box-sizing:border-box}.card{width:min(420px,calc(100vw - 32px));padding:22px;border:1px solid #262626;border-top:2px solid #c53400;border-radius:12px;background:#141414;color:#fafafa;font:14px/1.5 system-ui,Segoe UI,sans-serif;box-shadow:0 24px 80px #000}.eyebrow{margin:0 0 8px;color:#c53400;font:10px ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase}.card h2{margin:0;font-size:20px;letter-spacing:-.04em;text-transform:uppercase}.card p{margin:10px 0 0;color:rgba(250,250,250,.65)}.origin{margin-top:14px;padding:10px;border:1px solid #262626;border-radius:8px;background:#000;color:#fafafa;font:11px ui-monospace,monospace;overflow-wrap:anywhere}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button{min-height:36px;padding:0 12px;border:1px solid #262626;border-radius:2px;background:transparent;color:#fafafa;font:700 11px ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase;cursor:pointer}button:hover{border-color:#c53400}#allow{border-color:#c53400;background:#c53400;color:#fff}#allow:hover{background:#a02a00;box-shadow:0 0 18px rgba(197,52,0,.55)}</style><div class="card"><p class="eyebrow">TrustX · private STRK</p><h2>Allow TEE replay?</h2><p>TrustX will capture this approved Amazon Pay session, send it to your local TEE signer, and clear it after the receipt is attested.</p><div class="origin"></div><div class="actions"><button id="deny">Cancel</button><button id="allow">Allow</button></div></div>`;
    const originNode = shadow.querySelector('.origin');
    if (originNode) originNode.textContent = window.location.origin;
    const finish = (approved: boolean) => {
      approvalOpen = false;
      connected = approved;
      host.remove();
      resolve(approved);
    };
    shadow.querySelector('#deny')?.addEventListener('click', () => finish(false), { once: true });
    shadow.querySelector('#allow')?.addEventListener('click', () => finish(true), { once: true });
    document.documentElement.append(host);
  });
}

window.addEventListener('message', async (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data as Partial<PageRequest> | null;
  if (!message || message.marker !== PAGE_MARKER || typeof message.id !== 'string') return;

  if (message.action === 'CHECK_CONNECTION') {
    sendPage({ marker: CONTENT_MARKER, id: message.id, ok: true, result: connected ? 'connected' : approvalOpen ? 'pending' : 'disconnected' });
    return;
  }
  if (message.action === 'REQUEST_CONNECTION') {
    const approved = connected || (await showApproval());
    sendPage({ marker: CONTENT_MARKER, id: message.id, ok: true, result: approved });
    return;
  }
  if (message.action === 'REPLAY') {
    if (!connected) {
      sendPage({ marker: CONTENT_MARKER, id: message.id, ok: false, error: { code: 'NOT_CONNECTED', message: 'Connect this page before starting a replay.' } });
      return;
    }
    if (!message.payload || typeof message.payload.provider !== 'string' || typeof message.payload.action !== 'string') {
      sendPage({ marker: CONTENT_MARKER, id: message.id, ok: false, error: { code: 'REPLAY_REJECTED', message: 'Invalid replay parameters.' } });
      return;
    }
    activeRequests.add(message.id);
    const request: BackgroundRequest = {
      type: 'START_REPLAY',
      requestId: message.id,
      provider: message.payload.provider,
      action: message.payload.action,
    };
    port.postMessage(request);
  }
});

port.onMessage.addListener((message: BackgroundResponse) => {
  if (!activeRequests.has(message.requestId)) return;
  activeRequests.delete(message.requestId);
  if (message.type === 'REPLAY_RESULT') {
    sendPage({ marker: CONTENT_MARKER, id: message.requestId, ok: true, result: message.result });
  } else {
    sendPage({ marker: CONTENT_MARKER, id: message.requestId, ok: false, error: message.error });
  }
});

port.onDisconnect.addListener(() => {
  for (const requestId of activeRequests) {
    sendPage({ marker: CONTENT_MARKER, id: requestId, ok: false, error: { code: 'REPLAY_REJECTED', message: 'Extension service disconnected.' } });
  }
  activeRequests.clear();
});

const script = document.createElement('script');
script.src = chrome.runtime.getURL('page.js');
script.onload = () => script.remove();
(document.head ?? document.documentElement).append(script);
