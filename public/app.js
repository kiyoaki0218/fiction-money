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
  updateStats();
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
      const address = await deriveAddress(publicKey);

      // まずアカウントがサーバーにあるか確認
      const res = await fetch(`${API_BASE}/api/balance/${address}`);
      if (res.ok) {
        // 存在すればそのままログイン
        app.wallet = { publicKey, secretKey: secretKeyInput, address };
        localStorage.setItem('kc_wallet', JSON.stringify(app.wallet));
        showView('view-dashboard');
        updateBalance();
        toast('ログインに成功しました', 'success');
      } else if (res.status === 404) {
        toast('このアカウントはサーバーに登録されていません。新規作成から招待パスワードを使用して登録してください。', 'error');
      } else {
        toast(`サーバーエラー (${res.status}): 環境変数(SUPABASE_URL/KEY)の設定が正しいか Vercel を確認してください。`, 'error');
      }
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
      if (id === 'panel-dm') {
        loadDMList();
        loadRequests();
      }
      if (id === 'panel-receive') {
        document.getElementById('wallet-address-full').textContent = app.wallet.address;
        const payUrl = `${window.location.origin}/?pay_to=${app.wallet.address}`;
        document.getElementById('receive-url').value = payUrl;
        generateQRCode(payUrl, 'receive-qrcode');
      }
    }
  },

  generateSendURL: async () => {
    const to = document.getElementById('send-to').value.trim();
    const amountStr = document.getElementById('send-amount').value;
    const amount = parseFloat(amountStr);
    if (!amount) return toast('金額を入力してください', 'error');

    if (!to) {
      // 誰でも受け取れるURLモード（ONETIME）
      const nonce = await fetchNonce() + 1;
      const message = `${app.wallet.address}:ONETIME:${amount}:${nonce}`;
      const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
      const msgBytes = nacl.util.decodeUTF8(message);
      const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
      const signature = nacl.util.encodeBase64(sigBytes);

      try {
        const res = await fetch(`${API_BASE}/api/onetime-link/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: app.wallet.address, amount, nonce, signature, publicKey: app.wallet.publicKey
          })
        });
        const data = await res.json();
        if (data.success) {
          const url = `${window.location.origin}/?receive_link=${data.linkId}`;
          document.getElementById('generated-url').value = url;
          document.getElementById('url-result').classList.remove('hidden');
          generateQRCode(url, 'send-qrcode');
          toast('送金URLを作成しました', 'success');
        } else {
          toast(data.error || 'エラー発生', 'error');
        }
      } catch (e) {
        toast('通信エラー', 'error');
      }
    } else {
      // 特定の宛先を想定した従来のURLモード
      const nonce = await fetchNonce() + 1;
      const message = `${app.wallet.address}:${to}:${amount}:${nonce}`;
      const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
      const msgBytes = nacl.util.decodeUTF8(message);
      const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
      const signature = nacl.util.encodeBase64(sigBytes);

      const params = new URLSearchParams({
        from: app.wallet.address, to, amount: String(amount), nonce: String(nonce),
        sig: signature, pub: app.wallet.publicKey
      });
      
      const url = `${window.location.origin}/api/process-send?${params.toString()}`;
      document.getElementById('generated-url').value = url;
      document.getElementById('url-result').classList.remove('hidden');
      generateQRCode(url, 'send-qrcode');
      toast('送金URLを作成しました', 'success');
    }
  },

  directSend: async () => {
    const to = document.getElementById('send-to').value.trim();
    const amountStr = document.getElementById('send-amount').value;
    const amount = parseFloat(amountStr);
    if (!to || !amount) return toast('入力が不足しています', 'error');

    const nonce = await fetchNonce() + 1;
    const message = `${app.wallet.address}:${to}:${amount}:${nonce}`;
    const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
    const msgBytes = nacl.util.decodeUTF8(message);
    const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
    const signature = nacl.util.encodeBase64(sigBytes);
    
    try {
      const res = await fetch(`${API_BASE}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          from: app.wallet.address, to, amount, nonce, signature, 
          publicKey: app.wallet.publicKey 
        })
      });
      const data = await res.json();
      if (data.success) {
        toast('送金完了', 'success');
        app.togglePanel('panel-send');
        // 入力をクリア
        document.getElementById('send-to').value = '';
        document.getElementById('send-amount').value = '';
        document.getElementById('url-result').classList.add('hidden');
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
  updateBalance: () => updateBalance(),
  updateStats: () => updateStats()
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
  } catch (e) { }
  updateStats();
}

async function updateStats() {
  try {
    const res = await fetch(`${API_BASE}/api/info`);
    const data = await res.json();
    if (data.success && data.coin) {
      const el = document.getElementById('circulating-supply');
      if (el) el.textContent = data.coin.circulatingDisplay;
    }
  } catch (e) { }
}

async function loadHistory() {
  const listEl = document.getElementById('history-list');
  try {
    const message = `${app.wallet.address}:GET_NICKNAMES`;
    const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
    const msgBytes = nacl.util.decodeUTF8(message);
    const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
    const signature = nacl.util.encodeBase64(sigBytes);

    const [txRes, nickRes] = await Promise.all([
      fetch(`${API_BASE}/api/transactions/${app.wallet.address}`),
      fetch(`${API_BASE}/api/nicknames/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: app.wallet.address, signature, publicKey: app.wallet.publicKey })
      })
    ]);

    const txData = await txRes.json();
    const nickData = await nickRes.json();
    
    if (nickData.success) {
      nickData.nicknames.forEach(n => {
        if (n.nickname) nicknamesCache[n.target_address] = n.nickname;
      });
    }

    if (txData.success && txData.transactions.length > 0) {
      listEl.innerHTML = txData.transactions.map(tx => {
        const isSent = tx.direction === 'sent';
        const sign = isSent ? '-' : '+';
        const addr = isSent ? tx.to_addr : tx.from_addr;
        const name = (addr === 'GENESIS') ? '管理(GENESIS)' : (nicknamesCache[addr] || addr.slice(0, 10) + '...');
        
        let dateStr = '';
        if (tx.timestamp) {
          const d = new Date(tx.timestamp);
          dateStr = d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }

        return `
          <div class="history-item">
            <div>
              <div style="font-weight:700;">${tx.type === 'transfer' ? (isSent ? '送金' : '受取') : '配付'} <span style="font-size:0.6rem;font-weight:normal;color:#aaa;margin-left:5px;">${dateStr}</span></div>
              <div style="font-size:0.6rem; margin-top:2px; opacity:0.9;">相手: <span style="font-weight:bold;">${name}</span> <span style="font-size:0.5rem; opacity:0.6">(${addr.slice(0, 6)}...)</span></div>
            </div>
            <div style="font-weight:800;">${sign}${tx.amountDisplay}</div>
          </div>
        `;
      }).join('');
    } else {
      listEl.innerHTML = '<p style="text-align:center; color:#999; padding:10px; font-size:0.7rem;">履歴はありません</p>';
    }
  } catch (e) { }
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

  // ウォレット登録・ログインが必要な処理（pay_to / receive_link）
  if (app.wallet) {
    const payTo = params.get('pay_to');
    if (payTo) {
      app.togglePanel('panel-send');
      document.getElementById('send-to').value = payTo;
      document.getElementById('send-amount').focus();
      toast('支払先アドレスがセットされました', 'info');
      // パラメータを消去
      window.history.replaceState({}, '', window.location.pathname);
    }

    const receiveLink = params.get('receive_link');
    if (receiveLink) {
      processOnetimeLink(receiveLink);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  // 古い送金方式の成功時表示ロジック（互換性担保または削除可能）
  if (params.get('tx_success') === '1') {
    const amount = params.get('tx_amount');
    const msgEl = document.getElementById('send-received-msg');
    if (msgEl) msgEl.textContent = `${amount} KC を受け取りました。`;
    showModal('modal-send-received');

    updateBalance();
    window.history.replaceState({}, '', window.location.pathname);
  }
}

async function processOnetimeLink(linkId) {
  try {
    const res = await fetch(`${API_BASE}/api/onetime-link/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        linkId,
        receiver: app.wallet.address
      })
    });
    const data = await res.json();
    if (data.success) {
      const msgEl = document.getElementById('send-received-msg');
      if (msgEl) msgEl.textContent = `${data.amount} KC をギフトリンクから受け取りました！`;
      showModal('modal-send-received');
      updateBalance();
    } else {
      toast(data.error || 'リンクの受取に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
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
  const pubBytes = nacl.util.decodeBase64(publicKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', pubBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function generateQRCode(text, elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.innerHTML = '';
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  const isDark = document.body.classList.contains('dark-theme');
  const colorDark = isDark ? '#ffffff' : '#000000';
  const colorLight = isDark ? '#222222' : '#ffffff';
  if (window.QRCode && QRCode.toCanvas) {
    QRCode.toCanvas(canvas, text, { width: 160, margin: 2, color: { dark: colorDark, light: colorLight } }, err => { if (err) console.error(err); });
  }
}

// --- Phase 3: DM & Nickname functions ---
let nicknamesCache = {};

app.editNickname = async () => {
  const target = document.getElementById('dm-action-addr').textContent;
  const currentName = nicknamesCache[target] || '';
  const newName = prompt('ニックネームを入力してください (空で削除)', currentName);
  if (newName === null) return; // cancelled

  const message = `${app.wallet.address}:${target}:${newName}`;
  const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
  const msgBytes = nacl.util.decodeUTF8(message);
  const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
  const signature = nacl.util.encodeBase64(sigBytes);

  try {
    const res = await fetch(`${API_BASE}/api/nicknames/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: app.wallet.address, target, nickname: newName, signature, publicKey: app.wallet.publicKey
      })
    });
    const data = await res.json();
    if (data.success) {
      toast('ニックネームを保存しました', 'success');
      app.hideModal('modal-dm-action');
      loadDMList();
    } else {
      toast('保存に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
  }
};

app.prepareDirectSendFromDM = () => {
  const target = document.getElementById('dm-action-addr').textContent;
  app.hideModal('modal-dm-action');
  app.togglePanel('panel-send');
  document.getElementById('send-to').value = target;
  document.getElementById('send-amount').focus();
};

app.sendPaymentRequest = async () => {
  const target = document.getElementById('dm-action-addr').textContent;
  const amountStr = prompt('請求する金額を入力してください (空欄の場合は相手が決めることができます)');
  if (amountStr === null) return;
  const amount = amountStr ? parseFloat(amountStr) : null;
  if (amountStr && isNaN(amount)) return toast('無効な金額です', 'error');

  const messageStr = amount ? amount.toString() : '0';
  const message = `${app.wallet.address}:REQUEST:${target}:${messageStr}`;
  const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
  const msgBytes = nacl.util.decodeUTF8(message);
  const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
  const signature = nacl.util.encodeBase64(sigBytes);

  try {
    const res = await fetch(`${API_BASE}/api/requests/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requester: app.wallet.address, target, amount, signature, publicKey: app.wallet.publicKey
      })
    });
    const data = await res.json();
    if (data.success) {
      toast('リクエストを送信しました', 'success');
      app.hideModal('modal-dm-action');
    } else {
      toast('リクエストの送信に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
  }
};

app.openDMAction = (addr) => {
  document.getElementById('dm-action-addr').textContent = addr;
  document.getElementById('dm-action-name').textContent = nicknamesCache[addr] || addr.slice(0, 8) + '...';
  showModal('modal-dm-action');
};

async function loadDMList() {
  const listEl = document.getElementById('dm-list');
  listEl.innerHTML = '<p style="text-align:center; padding:10px; font-size: 0.7rem;">読み込み中...</p>';
  try {
    const message = `${app.wallet.address}:GET_NICKNAMES`;
    const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
    const msgBytes = nacl.util.decodeUTF8(message);
    const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
    const signature = nacl.util.encodeBase64(sigBytes);

    const [txRes, nickRes] = await Promise.all([
      fetch(`${API_BASE}/api/transactions/${app.wallet.address}`),
      fetch(`${API_BASE}/api/nicknames/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: app.wallet.address, signature, publicKey: app.wallet.publicKey })
      }),
    ]);
    const txData = await txRes.json();
    const nickData = await nickRes.json();

    const contacts = new Set();
    if (txData.success) {
      txData.transactions.forEach(tx => {
        const addr = tx.from_addr === app.wallet.address ? tx.to_addr : tx.from_addr;
        if (addr !== 'GENESIS') contacts.add(addr);
      });
    }

    nicknamesCache = {};
    if (nickData.success) {
      nickData.nicknames.forEach(n => {
        if (n.nickname) nicknamesCache[n.target_address] = n.nickname;
        if (n.target_address !== 'GENESIS') contacts.add(n.target_address);
      });
    }

    if (contacts.size > 0) {
      listEl.innerHTML = Array.from(contacts).map(addr => {
        const name = nicknamesCache[addr] || addr.slice(0, 8) + '...';
        return `
          <div class="history-item" style="cursor:pointer;" onclick="app.openDMAction('${addr}')">
            <div>
              <div style="font-weight:700;">${name}</div>
              <div style="font-size:0.5rem; opacity:0.6;">${addr.slice(0,16)}...</div>
            </div>
            <div style="font-size:0.6rem;">&gt;</div>
          </div>
        `;
      }).join('');
    } else {
      listEl.innerHTML = '<p style="text-align:center; color:#999; padding:10px; font-size:0.7rem;">履歴情報はありません</p>';
    }
  } catch (e) {
    listEl.innerHTML = '<p style="text-align:center; color:red; padding:10px;">エラーが発生しました</p>';
  }
}

async function loadRequests() {
  const listEl = document.getElementById('requests-list');
  listEl.innerHTML = '';
  try {
    const message = `${app.wallet.address}:GET_REQUESTS`;
    const secretKeyBytes = nacl.util.decodeBase64(app.wallet.secretKey);
    const msgBytes = nacl.util.decodeUTF8(message);
    const sigBytes = nacl.sign.detached(msgBytes, secretKeyBytes);
    const signature = nacl.util.encodeBase64(sigBytes);

    const res = await fetch(`${API_BASE}/api/requests/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: app.wallet.address, signature, publicKey: app.wallet.publicKey })
    });
    const data = await res.json();
    
    if (data.success && data.requests.length > 0) {
      listEl.innerHTML = '<h3 style="font-size: 0.7rem; color: #ff6b6b; margin-bottom: 5px;">🔥 あなたへの送金リクエスト</h3>' +
        data.requests.map(r => {
          const name = nicknamesCache[r.requester_address] || r.requester_address.slice(0, 8) + '...';
          const amtStr = r.amountDisplay ? `${r.amountDisplay} KC` : '金額指定なし';
          return `
            <div class="history-item" style="border: 1px dashed #ff6b6b; margin-bottom: 5px;">
              <div>
                <div style="font-weight:700;">${name} からのリクエスト</div>
                <div style="font-weight:800;">${amtStr}</div>
              </div>
              <button class="btn btn-sm" onclick="app.fulfillRequest('${r.requester_address}', '${r.amountDisplay || ''}')">支払う</button>
            </div>
          `;
        }).join('');
    }
  } catch (e) {}
}

app.fulfillRequest = (requester, amount) => {
  app.togglePanel('panel-send');
  document.getElementById('send-to').value = requester;
  if (amount) {
    document.getElementById('send-amount').value = parseFloat(amount);
  } else {
    document.getElementById('send-amount').value = '';
    document.getElementById('send-amount').focus();
  }
};
