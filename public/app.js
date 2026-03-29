/* ========================================
   KC — Extreme Minimal Frontend App
   ======================================== */

const API_BASE = '';
const COIN_SYMBOL = 'KC';

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadWallet();
  checkUrlParams();
});

// --- Public App Interface ---
window.app = {
  wallet: null, // 公開プロパティへ
  // Navigation
  showWelcomeView: () => showView('view-welcome'),
  showRestoreView: () => showView('view-restore'),
  
  // Theme Management
  toggleTheme: () => {
    const isDark = document.body.classList.toggle('dark-theme');
    localStorage.setItem('kc_theme', isDark ? 'dark' : 'light');
  },

  // Wallet Management
  createNewWallet: async () => {
    const inviteCode = document.getElementById('invite-code').value.trim();
    if (!inviteCode) return toast('招待パスワードが必要です', 'error');
    
    const keyPair = nacl.sign.keyPair();
    const publicKey = nacl.util.encodeBase64(keyPair.publicKey);
    const secretKey = nacl.util.encodeBase64(keyPair.secretKey);
    await registerWallet(publicKey, secretKey, inviteCode);
  },
  
  restoreWallet: async () => {
    const secretKeyInput = document.getElementById('restore-key').value.trim();
    if (!secretKeyInput) return toast('秘密鍵が必要です', 'error');
    try {
      const secretKeyBytes = nacl.util.decodeBase64(secretKeyInput);
      const keyPair = nacl.sign.keyPair.fromSecretKey(secretKeyBytes);
      const publicKey = nacl.util.encodeBase64(keyPair.publicKey);
      await registerWallet(publicKey, secretKeyInput);
      document.getElementById('restore-key').value = '';
    } catch (e) {
      toast('無効な秘密鍵です', 'error');
    }
  },
  
  logout: () => {
    if (!confirm('ログアウトしますか？秘密鍵は保存されません。')) return;
    localStorage.removeItem('kc_wallet');
    app.wallet = null;
    showView('view-welcome');
  },
  
  exportKey: () => {
    if (!app.wallet) return;
    document.getElementById('exported-key').value = app.wallet.secretKey;
    showModal('modal-key-export');
  },
  
  // Transactions
  togglePanel: (id) => {
    const el = document.getElementById(id);
    const isHidden = el.classList.contains('hidden');
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    if (isHidden) {
      el.classList.remove('hidden');
      if (id === 'panel-history') loadHistory();
      if (id === 'panel-receive') {
        document.getElementById('wallet-address-full').textContent = app.wallet.address;
      }
    }
  },
  
  generateSendURL: async () => {
    const to = document.getElementById('send-to').value.trim();
    const amountStr = document.getElementById('send-amount').value;
    const amount = parseFloat(amountStr);
    if (!to || !amount) return toast('入力が不足しています', 'error');
    
    const nonce = await fetchNonce() + 1;
    const signature = signTransaction(to, amount, nonce);
    
    const params = new URLSearchParams({
      from: app.wallet.address, to, amount: String(amount), nonce: String(nonce),
      sig: signature, pub: app.wallet.publicKey
    });
    
    const url = `${window.location.origin}/api/process-send?${params.toString()}`;
    document.getElementById('generated-url').value = url;
    document.getElementById('url-result').classList.remove('hidden');
    toast('URLを生成しました', 'success');
  },
  
  directSend: async () => {
    const to = document.getElementById('send-to').value.trim();
    const amountStr = document.getElementById('send-amount').value;
    const amount = parseFloat(amountStr);
    if (!to || !amount) return toast('入力が不足しています', 'error');
    
    const nonce = await fetchNonce() + 1;
    const signature = signTransaction(to, amount, nonce);
    
    try {
      const res = await fetch(`${API_BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: app.wallet.address, to, amount, nonce, signature, publicKey: app.wallet.publicKey })
      });
      const data = await res.json();
      if (data.success) {
        toast('送金完了', 'success');
        app.togglePanel('panel-send');
        updateBalance();
      } else {
        toast(data.error || 'エラー発生', 'error');
      }
    } catch (e) {
      toast('通信エラー', 'error');
    }
  },
  
  adminGenesis: async () => {
    if (!confirm('Genesisを実行しますか？')) return;
    try {
      const res = await fetch(`${API_BASE}/api/admin/genesis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: app.wallet.publicKey })
      });
      const data = await res.json();
      if (data.success) {
        toast('Genesis完了', 'success');
        updateBalance();
      } else {
        toast(data.error, 'error');
      }
    } catch (e) {
      toast('通信エラー', 'error');
    }
  },
  
  copyToClipboard: (id) => {
    const el = document.getElementById(id);
    el.select();
    document.execCommand('copy');
    toast('コピーしました', 'success');
  },
  
  copyToClipboardText: (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('コピーしました', 'success');
  },
  
  hideModal: (id) => document.getElementById(id).classList.add('hidden'),
  updateBalance: () => updateBalance()
};

// --- Internal Functions ---

function initTheme() {
  const theme = localStorage.getItem('kc_theme');
  if (theme === 'dark') document.body.classList.add('dark-theme');
}

async function registerWallet(publicKey, secretKey, inviteCode) {
  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, inviteCode })
    });
    const data = await res.json();
    if (res.status === 409 || data.success) {
      const address = data.address || await deriveAddress(publicKey);
      app.wallet = { publicKey, secretKey, address };
      localStorage.setItem('kc_wallet', JSON.stringify(app.wallet));
      showView('view-dashboard');
      updateBalance();
      toast('ウォレット準備完了', 'success');
    } else {
      toast(data.error, 'error');
    }
  } catch (e) {
    toast('サーバー接続エラー', 'error');
  }
}

function loadWallet() {
  const saved = localStorage.getItem('kc_wallet');
  if (saved) {
    app.wallet = JSON.parse(saved);
    showView('view-dashboard');
    updateBalance();
  } else {
    showView('view-welcome');
  }
}

async function updateBalance() {
  if (!app.wallet) return;
  document.getElementById('wallet-address-short').textContent = app.wallet.address.slice(0, 8) + '...';
  
  // Admin button visibility
  const adminBtn = document.getElementById('btn-admin-genesis');
  if (adminBtn) adminBtn.style.display = 'inline-block';

  try {
    const res = await fetch(`${API_BASE}/api/balance/${app.wallet.address}`);
    const data = await res.json();
    if (data.success) {
      document.getElementById('balance-value').textContent = Number(data.balance).toFixed(5);
    }
  } catch (e) {}
}

async function loadHistory() {
  const listEl = document.getElementById('history-list');
  try {
    const res = await fetch(`${API_BASE}/api/transactions/${app.wallet.address}`);
    const data = await res.json();
    if (data.success && data.transactions.length > 0) {
      listEl.innerHTML = data.transactions.map(tx => {
        const isSent = tx.direction === 'sent';
        const sign = isSent ? '-' : '+';
        const classStr = isSent ? 'sent' : 'received';
        const addr = isSent ? tx.to_addr : tx.from_addr;
        return `
          <div class="history-item">
            <div>
              <div style="font-weight:700;">${tx.type === 'transfer' ? (isSent ? '送金' : '受取') : '配付'}</div>
              <div style="font-size:0.6rem; opacity:0.6;">${addr.slice(0,10)}...</div>
            </div>
            <div style="font-weight:800;">${sign}${tx.amountDisplay}</div>
          </div>
        `;
      }).join('');
    } else {
      listEl.innerHTML = '<p style="text-align:center; color:#999; padding:10px; font-size:0.7rem;">履歴はありません</p>';
    }
  } catch (e) {}
}

function signTransaction(to, amount, nonce) {
  const message = `${app.wallet.address}:${to}:${amount}:${nonce}`;
  const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
  const msgBytes = nacl.util.decodeUTF8(message);
  const signature = nacl.sign.detached(msgBytes, secretKeyBytes);
  return nacl.util.encodeBase64(signature);
}

async function fetchNonce() {
  const res = await fetch(`${API_BASE}/api/balance/${app.wallet.address}`);
  const data = await res.json();
  return data.nonce || 0;
}

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  
  // 招待コードの自動セット
  const invite = params.get('invite');
  const inviteInput = document.getElementById('invite-code');
  if (invite && inviteInput) {
    inviteInput.value = invite;
  }

  if (params.get('tx_success') === '1') {
    const amount = params.get('tx_amount');
    const msgEl = document.getElementById('send-received-msg');
    if (msgEl) msgEl.textContent = `${amount} KC を受け取りました。`;
    showModal('modal-send-received');
    window.history.replaceState({}, '', window.location.pathname);
  }
}

function toast(msg, type) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

async function deriveAddress(publicKey) {
  const encoder = new TextEncoder();
  const data = encoder.encode(publicKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
