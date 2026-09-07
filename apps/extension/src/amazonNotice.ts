const NOTICE_DURATION_MS = 5_000;

function mountNotice() {
  if (document.getElementById('teeReplayAmazonNotice')) return;

  const transactionDetails = location.pathname === '/pay/transaction-details';
  const host = document.createElement('div');
  host.id = 'teeReplayAmazonNotice';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  host.style.cssText = 'position:fixed;top:18px;right:18px;z-index:2147483647;pointer-events:none';

  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .glass {
        position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 11px;
        width: min(390px, calc(100vw - 36px)); padding: 14px 15px 16px; overflow: hidden;
        color: #fafafa; background: #141414; border: 1px solid #262626; border-left: 2px solid #c53400;
        border-radius: 2px; box-shadow: 0 20px 60px rgba(0, 0, 0, .62);
        font: 13px/1.45 "DM Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        animation: enter .32s cubic-bezier(.2, .8, .2, 1) both;
      }
      .glass::before { content: ""; position: absolute; inset: 8px; pointer-events: none; border: 1px solid rgba(197, 52, 0, .18); }
      .orb {
        position: relative; width: 28px; height: 28px; border: 1px solid #c53400; border-radius: 2px;
        background: rgba(197, 52, 0, .12); box-shadow: inset 0 0 0 5px #141414; animation: spin 1.2s linear infinite;
      }
      .orb::after { content: ""; position: absolute; inset: 8px; background: #c53400; }
      .copy { position: relative; min-width: 0; }
      .title { margin: 0 0 4px; color: #fafafa; font: 700 11px/1.2 "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }
      .detail { margin: 0; color: rgba(250, 250, 250, .65); font-size: 12px; }
      .bar { position:absolute; left:0; bottom:0; width:100%; height:2px; background:rgba(197, 52, 0, .18); }
      .bar::after { content:""; display:block; width:100%; height:100%; transform-origin:left; background:#c53400; animation:countdown 5s linear both; }
      .leaving { animation: leave .3s ease forwards; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes countdown { to { transform: scaleX(0); } }
      @keyframes enter { from { opacity:0; transform:translateY(-10px); } }
      @keyframes leave { to { opacity:0; transform:translateY(-8px); } }
      @media (prefers-reduced-motion: reduce) { .glass, .orb, .bar::after { animation: none; } }
    </style>
    <div class="glass">
      <div class="orb" aria-hidden="true"></div>
      <div class="copy">
        <p class="title">${transactionDetails ? 'TrustX · securing receipt' : 'TrustX · TEE replay ready'}</p>
        <p class="detail">${transactionDetails ? 'Retrieving the receipt and signing it with the configured Stark signer.' : 'Select the UPI transaction you want to attest.'}</p>
      </div>
      <div class="bar" aria-hidden="true"></div>
    </div>`;

  document.documentElement.append(host);
  if (transactionDetails) {
    window.setTimeout(() => {
      shadow.querySelector('.glass')?.classList.add('leaving');
      window.setTimeout(() => host.remove(), 320);
    }, NOTICE_DURATION_MS);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountNotice, { once: true });
} else {
  mountNotice();
}
