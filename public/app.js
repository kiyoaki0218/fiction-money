/* ========================================
   KC — Extreme Minimal Frontend App
   ======================================== */

const API_BASE = '';
const COIN_SYMBOL = 'KC';
const DECIMALS_MULT = 100000; // サーバの INTERNAL_MULTIPLIER (10^5) と一致させること

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupSessionHandlers();
  setupActivityListeners();
  loadWallet();
  checkUrlParams();
  updateStats();
});

// --- インライン onclick 排除のためのイベント委譲（CSP対応）---
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !window.app) return;
  const fn = app[el.dataset.act];
  if (typeof fn !== 'function') return;
  const args = Object.keys(el.dataset)
    .filter(k => /^a\d+$/.test(k))
    .sort((x, y) => parseInt(x.slice(1), 10) - parseInt(y.slice(1), 10))
    .map(k => el.dataset[k]);
  fn(...args);
});

// --- セレクトボックス / Enterキーの委譲（CSP対応）---
document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t) return;
  if (t.id === 'restore-mode') {
    const mnemonic = t.value === 'mnemonic';
    document.getElementById('restore-mnemonic-group').classList.toggle('hidden', !mnemonic);
    document.getElementById('restore-legacy-group').classList.toggle('hidden', mnemonic);
  }
  if (t.id === 'split-mode') {
    const equal = t.value === 'equal';
    document.getElementById('split-amount-label').textContent = equal ? '合計金額 (KC)' : '1人あたり金額 (KC)';
  }
  if (t.hasAttribute && t.hasAttribute('data-autolock')) {
    KCCrypto.Session.setAutolockMinutes(parseInt(t.value, 10));
    toast('自動ロック設定を保存しました', 'success');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && e.target.id === 'lock-password') app.unlock();
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

  // --- ウォレット管理（Phase 1: キーストア / ニーモニック / ロック）---

  // 新規作成 Step0→1: 招待コード確認 → パスワード設定画面へ
  createNewWallet: () => {
    const inviteCode = document.getElementById('invite-code').value.trim();
    if (!inviteCode) return toast('招待パスワードが必要です', 'error');
    pendingCreate = { inviteCode };
    showCreateStep('create-step-password');
  },

  // Step1→2: パスワード確定 → フレーズ発行
  createNextToPhrase: () => {
    if (!pendingCreate || !pendingCreate.inviteCode) {
      showView('view-welcome');
      return;
    }
    const pw1 = document.getElementById('create-password').value;
    const pw2 = document.getElementById('create-password2').value;
    if (pw1.length < 8) return toast('パスワードは8文字以上にしてください', 'error');
    if (pw1 !== pw2) return toast('パスワードが一致しません', 'error');
    pendingCreate.password = pw1;
    pendingCreate.bits = parseInt(document.getElementById('create-bits').value, 10) || 128;
    document.getElementById('create-password').value = '';
    document.getElementById('create-password2').value = '';
    showCreateStep('create-step-phrase');
    generatePendingMnemonic();
  },

  // Step2→3: 書き残し確認 → 3語入力
  confirmPhraseAck: () => {
    if (!document.getElementById('mnemonic-ack').checked) {
      return toast('書き残しの確認にチェックしてください', 'error');
    }
    const words = pendingCreate.words.split(' ');
    const picked = new Set();
    while (picked.size < 3) picked.add(Math.floor(Math.random() * words.length));
    pendingCreate.confirmIdx = Array.from(picked).sort((a, b) => a - b);
    document.getElementById('confirm-word-inputs').innerHTML = pendingCreate.confirmIdx.map((i) => `
      <div class="form-group">
        <label>${i + 1} 番目の単語</label>
        <input type="text" data-word-idx="${i}" autocomplete="off" autocapitalize="off" spellcheck="false">
      </div>
    `).join('');
    showCreateStep('create-step-confirm');
  },

  // Step3: キーペア生成 → 登録 → キーストア保存
  finishCreateWallet: async () => {
    if (!pendingCreate || !pendingCreate.words) return;
    const inputs = document.querySelectorAll('#confirm-word-inputs input');
    const words = pendingCreate.words.split(' ');
    for (const input of inputs) {
      const idx = parseInt(input.dataset.wordIdx, 10);
      if (input.value.trim().toLowerCase() !== words[idx]) {
        return toast(`${idx + 1} 番目の単語が違います。確認して再度入力してください`, 'error');
      }
    }
    const btn = document.getElementById('btn-create-finish');
    setBusy(btn, '鍵を生成中…');
    try {
      const seed = await KCCrypto.Mnemonic.toSeed(pendingCreate.words);
      const keyPair = nacl.sign.keyPair.fromSeed(seed);
      const publicKey = nacl.util.encodeBase64(keyPair.publicKey);
      const address = await deriveAddress(publicKey);
      // 登録が先（失敗時はキーストアを残さない）
      const registered = await registerWallet(publicKey, address, pendingCreate.inviteCode);
      if (!registered) {
        pendingCreate = null;
        showView('view-welcome');
        return;
      }
      setBusy(btn, '暗号化中…');
      const ks = await KCCrypto.Keystore.encrypt(pendingCreate.password, keyPair.secretKey, publicKey, address);
      KCCrypto.Keystore.save(ks);
      // パスワード確認済みなのでセッションを解放（onUnlock がダッシュボードへ遷移）
      KCCrypto.Session.setUnlocked(KCCrypto.toB64(keyPair.secretKey));
      toast('ウォレットを作成しました。フレーズは必ず安全に保管してください', 'success');
      pendingCreate = null;
    } catch (e) {
      toast('ウォレット作成に失敗しました', 'error');
    } finally {
      setBusy(btn, '作成して登録', false);
    }
  },

  // 復元（ニーモニック / 旧Base64鍵の2モード）→ キーストア保存
  restoreWallet: async () => {
    const mode = document.getElementById('restore-mode').value;
    const pw1 = document.getElementById('restore-password').value;
    const pw2 = document.getElementById('restore-password2').value;
    if (pw1.length < 8) return toast('パスワードは8文字以上にしてください', 'error');
    if (pw1 !== pw2) return toast('パスワードが一致しません', 'error');

    let publicKey;
    let secretKeyBytes;
    try {
      if (mode === 'mnemonic') {
        const words = document.getElementById('restore-phrase').value.trim();
        if (!words) return toast('ニーモニックを入力してください', 'error');
        if (!(await KCCrypto.Mnemonic.validate(words))) {
          return toast('ニーモニックが無効です。単語の綴り・順序を確認してください', 'error');
        }
        const seed = await KCCrypto.Mnemonic.toSeed(words);
        const keyPair = nacl.sign.keyPair.fromSeed(seed);
        publicKey = nacl.util.encodeBase64(keyPair.publicKey);
        secretKeyBytes = keyPair.secretKey;
      } else {
        const secretKeyInput = document.getElementById('restore-key').value.trim();
        if (!secretKeyInput) return toast('秘密鍵が必要です', 'error');
        secretKeyBytes = nacl.util.decodeBase64(secretKeyInput);
        const keyPair = nacl.sign.keyPair.fromSecretKey(secretKeyBytes);
        publicKey = nacl.util.encodeBase64(keyPair.publicKey);
      }
    } catch (e) {
      return toast(mode === 'mnemonic' ? 'ニーモニックが無効です' : '無効な秘密鍵です', 'error');
    }

    const address = await deriveAddress(publicKey);
    // アカウントがサーバーにあるか確認
    const res = await fetch(`${API_BASE}/api/balance/${address}`);
    if (res.ok) {
      const ks = await KCCrypto.Keystore.encrypt(pw1, secretKeyBytes, publicKey, address);
      KCCrypto.Keystore.save(ks);
      document.getElementById('restore-phrase').value = '';
      document.getElementById('restore-key').value = '';
      document.getElementById('restore-password').value = '';
      document.getElementById('restore-password2').value = '';
      KCCrypto.Session.setUnlocked(KCCrypto.toB64(secretKeyBytes));
      toast('ログインに成功しました', 'success');
    } else if (res.status === 404) {
      toast('このアカウントはサーバーに登録されていません。新規作成から招待パスワードを使用して登録してください。', 'error');
    } else {
      toast(`サーバーエラー (${res.status}): 環境変数(SUPABASE_URL/KEY)の設定が正しいか Vercel を確認してください。`, 'error');
    }
  },

  // 既存の平文鍵 → パスワード暗号化への移行（初回のみ）
  migrateWallet: async () => {
    const pw1 = document.getElementById('migrate-password').value;
    const pw2 = document.getElementById('migrate-password2').value;
    if (pw1.length < 8) return toast('パスワードは8文字以上にしてください', 'error');
    if (pw1 !== pw2) return toast('パスワードが一致しません', 'error');

    let legacy;
    try { legacy = JSON.parse(localStorage.getItem('kc_wallet')); } catch (e) { legacy = null; }
    if (!legacy || !legacy.secretKey) {
      localStorage.removeItem('kc_wallet');
      return showView('view-welcome');
    }
    const btn = document.getElementById('btn-migrate');
    setBusy(btn, '暗号化中…');
    try {
      const secretKeyBytes = nacl.util.decodeBase64(legacy.secretKey);
      const ks = await KCCrypto.Keystore.encrypt(pw1, secretKeyBytes, legacy.publicKey, legacy.address);
      KCCrypto.Keystore.save(ks);
      localStorage.removeItem('kc_wallet'); // 平文保存はここで消える
      document.getElementById('migrate-password').value = '';
      document.getElementById('migrate-password2').value = '';
      KCCrypto.Session.setUnlocked(KCCrypto.toB64(secretKeyBytes));
      toast('パスワードで暗号化して保存しました。忘れてもニーモニック（あれば）で復元できます', 'success');
    } catch (e) {
      toast('移行に失敗しました', 'error');
    } finally {
      setBusy(btn, '暗号化して続行', false);
    }
  },

  // ロック解除
  unlock: async () => {
    const pw = document.getElementById('lock-password').value;
    if (!pw) return toast('パスワードを入力してください', 'error');
    const btn = document.getElementById('btn-unlock');
    setBusy(btn, '確認中…');
    try {
      const res = await KCCrypto.Session.unlock(pw);
      document.getElementById('lock-password').value = '';
      if (!res.ok) {
        const hint = document.getElementById('lock-hint');
        hint.textContent = res.lockedFor > 0
          ? `試行上限に達しました。${res.lockedFor}秒後に再試行してください`
          : 'パスワードが違います';
      }
    } finally {
      setBusy(btn, 'ロック解除', false);
    }
  },

  lockNow: () => KCCrypto.Session.lock(),

  logout: () => {
    if (!confirm('ログアウトしますか？')) return;
    const keepKeystore = !confirm('キーストア（暗号化された鍵）もこの端末から削除しますか？\nOK = 削除して完全にログアウト\nキャンセル = ロック画面を表示（パスワードで再ログイン可）');
    KCCrypto.Session.lock();
    if (keepKeystore) return; // ロック画面のまま（キーストア残す）
    KCCrypto.Keystore.remove();
    app.wallet = null;
    showView('view-welcome');
    toast('ログアウトしました（キーストアを削除しました）', 'success');
  },

  exportKey: () => {
    if (!app.wallet) return;
    document.getElementById('export-password').value = '';
    showModal('modal-export-confirm');
    document.getElementById('export-password').focus();
  },

  // エクスポートはパスワード再入力後のみ表示
  confirmExportPassword: async () => {
    const pw = document.getElementById('export-password').value;
    if (!pw) return toast('パスワードを入力してください', 'error');
    const btn = document.getElementById('btn-export-confirm');
    setBusy(btn, '確認中…');
    try {
      const ks = KCCrypto.Keystore.load();
      const bytes = await KCCrypto.Keystore.decrypt(pw, ks);
      if (!bytes) return toast('パスワードが違います', 'error');
      document.getElementById('exported-key').value = KCCrypto.toB64(bytes);
      document.getElementById('export-password').value = '';
      app.hideModal('modal-export-confirm');
      showModal('modal-key-export');
    } finally {
      setBusy(btn, '確認', false);
    }
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
        app.setRequestTab('incoming');
      }
      if (id === 'panel-receive') {
        document.getElementById('wallet-address-full').textContent = app.wallet.address;
        const payUrl = `${window.location.origin}/?pay_to=${app.wallet.address}`;
        document.getElementById('receive-url').value = payUrl;
        generateQRCode(payUrl, 'receive-qrcode');
      }
    }
  },

  directSend: async () => {
    const to = document.getElementById('send-to').value.trim();
    const amountStr = document.getElementById('send-amount').value;
    const amount = parseFloat(amountStr);
    if (!to || !amount || amount <= 0) return toast('宛先と金額を入力してください', 'error');
    await openSendConfirm({ type: 'send', to, amount, requestId: pendingRequestId || null });
  },

  generateSendURL: async () => {
    const to = document.getElementById('send-to').value.trim();
    const amountStr = document.getElementById('send-amount').value;
    const amount = parseFloat(amountStr);
    if (!amount || amount <= 0) return toast('金額を入力してください', 'error');
    await openSendConfirm({ type: 'url', to, amount });
  },

  // 確認モーダル → 実行
  confirmSendPending: async () => {
    if (!pendingSend) return;
    const memo = document.getElementById('send-memo').value.trim().slice(0, 100);
    const state = pendingSend;
    const btn = document.getElementById('btn-confirm-send');
    setBusy(btn, state.type === 'url' ? 'URL作成中…' : '送金中…');
    try {
      if (state.type === 'url') await executeSendUrl(state, memo);
      else if (state.type === 'split') await executeSplitPay(state, memo);
      else await executeSend(state, memo);
    } finally {
      setBusy(btn, '送金を実行', false);
    }
  },

  cancelSendConfirm: () => {
    pendingSend = null;
    pendingRequestId = null;
    document.getElementById('send-memo').value = '';
    app.hideModal('modal-send-confirm');
    // 割り勘支払いのキャンセル時は進捗モーダルを戻す
    if (currentSplitId) showModal('modal-split');
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

  copyMyAddress: () => {
    if (app.wallet) app.copyToClipboardText(app.wallet.address);
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

// --- Phase 1 内部ヘルパー ---

// 新規作成フローの一時状態（パスワード・フレーズ）
let pendingCreate = null;

// --- Phase 2: 送金確認モーダル（入力 → 確認 → 実行）の状態 ---
let pendingSend = null;       // { type: 'send'|'url'|'split', to, amount, requestId?, billId? }
let pendingRequestId = null;  // 金額お任せのリクエスト支払い時に紐付けるリクエストID

async function openSendConfirm(state) {
  const isUrl = state.type === 'url';
  const isSplit = state.type === 'split';
  document.getElementById('confirm-title').textContent =
    isUrl ? '送金URLの確認' : isSplit ? '割り勘の支払い確認' : '送金の確認';

  const nameEl = document.getElementById('confirm-to-name');
  const addrEl = document.getElementById('confirm-to-addr');
  if (isSplit) {
    nameEl.textContent = '割り勘の作成者';
    addrEl.textContent = state.creatorShort || '';
  } else if (!state.to) {
    nameEl.textContent = '誰でも受け取れる';
    addrEl.textContent = '（ワンタイムURL）';
  } else {
    nameEl.textContent = officialNamesCache[state.to] || nicknamesCache[state.to] || '（登録名なし）';
    addrEl.textContent = state.to;
  }
  document.getElementById('confirm-amount').textContent = String(state.amount);

  // 送金後残高（取得できない場合は「残高確認中…」のまま）
  const afterEl = document.getElementById('confirm-after-balance');
  afterEl.textContent = '残高確認中…';
  try {
    const res = await fetch(`${API_BASE}/api/balance/${app.wallet.address}`);
    const data = await res.json();
    if (data.success) afterEl.textContent = (Number(data.balance) - state.amount).toFixed(5);
  } catch (e) { }

  const warn = document.getElementById('confirm-warning');
  warn.classList.add('hidden');
  if (isUrl) {
    warn.textContent = '⚠ このURLを受け取った人が資金を引き出します。';
    warn.classList.remove('hidden');
  } else if (state.to && !isSplit) {
    try {
      const res = await fetch(`${API_BASE}/api/account/${state.to}`);
      if (res.status === 404) {
        warn.textContent = '⚠ このアドレスは未登録です。送金できない可能性があります。';
        warn.classList.remove('hidden');
      }
    } catch (e) { }
  }

  document.getElementById('send-memo').value = '';
  pendingSend = state;
  showModal('modal-send-confirm');
}

// 通常送金の実行（署名メッセージ = from:to:amountInternal:nonce:memo:requestId）
async function executeSend(state, memo) {
  const amountInternal = Math.round(state.amount * DECIMALS_MULT);
  const requestId = state.requestId || '';
  const nonce = await fetchNonce() + 1;
  const message = `${app.wallet.address}:${state.to}:${amountInternal}:${nonce}:${memo}:${requestId}`;
  const signature = signMessage(message);

  try {
    const res = await fetch(`${API_BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: app.wallet.address, to: state.to, amount: state.amount, nonce, signature,
        publicKey: app.wallet.publicKey, memo, requestId: requestId || undefined
      })
    });
    const data = await res.json();
    if (data.success) {
      app.hideModal('modal-send-confirm');
      pendingSend = null;
      pendingRequestId = null;
      toast(data.requestPaid ? '送金完了（リクエストを支払い済みにしました）' : '送金完了', 'success');
      if (!document.getElementById('panel-send').classList.contains('hidden')) {
        app.togglePanel('panel-send');
      }
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
}

// 送金URL生成の実行（ONETIME / 特定宛先URL のどちらも同一モーダルから）
async function executeSendUrl(state, memo) {
  const amountInternal = Math.round(state.amount * DECIMALS_MULT);
  const nonce = await fetchNonce() + 1;

  try {
    if (!state.to) {
      const message = `${app.wallet.address}:ONETIME:${amountInternal}:${nonce}:${memo}`;
      const signature = signMessage(message);
      const res = await fetch(`${API_BASE}/api/onetime-link/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: app.wallet.address, amount: state.amount, nonce, signature,
          publicKey: app.wallet.publicKey, memo
        })
      });
      const data = await res.json();
      if (!data.success) return toast(data.error || 'エラー発生', 'error');
      const url = `${window.location.origin}/?receive_link=${data.linkId}`;
      document.getElementById('generated-url').value = url;
      document.getElementById('url-result').classList.remove('hidden');
      generateQRCode(url, 'send-qrcode');
    } else {
      const message = `${app.wallet.address}:${state.to}:${amountInternal}:${nonce}:${memo}`;
      const signature = signMessage(message);
      const params = new URLSearchParams({
        from: app.wallet.address, to: state.to, amount: String(state.amount), nonce: String(nonce),
        sig: signature, pub: app.wallet.publicKey
      });
      if (memo) params.set('memo', memo);
      const url = `${window.location.origin}/api/process-send?${params.toString()}`;
      document.getElementById('generated-url').value = url;
      document.getElementById('url-result').classList.remove('hidden');
      generateQRCode(url, 'send-qrcode');
    }
    app.hideModal('modal-send-confirm');
    pendingSend = null;
    toast('送金URLを作成しました', 'success');
  } catch (e) {
    toast('通信エラー', 'error');
  }
}

// 割り勘支払いの実行
async function executeSplitPay(state, memo) {
  const amountInternal = Math.round(state.amount * DECIMALS_MULT);
  const nonce = await fetchNonce() + 1;
  const message = `${app.wallet.address}:SPLIT_PAY:${state.billId}:${amountInternal}:${nonce}`;
  const signature = signMessage(message);

  try {
    const res = await fetch(`${API_BASE}/api/split/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payer: app.wallet.address, billId: state.billId, amount: state.amount,
        nonce, signature, publicKey: app.wallet.publicKey
      })
    });
    const data = await res.json();
    if (data.success) {
      app.hideModal('modal-send-confirm');
      pendingSend = null;
      toast(data.message || '支払いが完了しました', 'success');
      updateBalance();
      if (currentSplitId) {
        showModal('modal-split');
        fetchSplitState(currentSplitId);
      }
    } else {
      toast(data.error || '支払いに失敗しました', 'error');
      if (data.error && data.error.includes('既に支払い済み') && currentSplitId) {
        showModal('modal-split');
        fetchSplitState(currentSplitId);
      }
    }
  } catch (e) {
    toast('通信エラー', 'error');
  }
}

const CREATE_STEPS = ['create-step-password', 'create-step-phrase', 'create-step-confirm'];
function showCreateStep(id) {
  CREATE_STEPS.forEach((s) => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
  if (id === 'create-step-password') {
    document.getElementById('mnemonic-ack').checked = false;
    document.getElementById('confirm-word-inputs').innerHTML = '';
  }
  showView('view-create');
}

async function generatePendingMnemonic() {
  const btn = document.getElementById('btn-create-next');
  setBusy(btn, '生成中…');
  try {
    pendingCreate.words = await KCCrypto.Mnemonic.generate(pendingCreate.bits);
    document.getElementById('mnemonic-words').innerHTML = pendingCreate.words.split(' ')
      .map((w, i) => `<span class="mnemonic-word">${i + 1}. ${escHtml(w)}</span>`).join('');
    document.getElementById('mnemonic-ack').checked = false;
  } catch (e) {
    toast('ニーモニックの生成に失敗しました。ネットワーク接続を確認してください', 'error');
    showView('view-welcome');
  } finally {
    setBusy(btn, 'フレーズを発行', false);
  }
}

// ボタンの処理中表示（PBKDF2 は数百ms〜数秒かかるため）
function setBusy(btn, label, busy = true) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
  } else {
    btn.textContent = label || btn.dataset.origText || btn.textContent;
    btn.disabled = false;
  }
}

function enterWallet() {
  showView('view-dashboard');
  updateBalance();
  checkUrlParams();
}

function setupSessionHandlers() {
  KCCrypto.Session.onLock(() => {
    app.wallet = null;
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    loadWallet(); // ロック画面を表示
    toast('ロックしました', 'info');
  });
  KCCrypto.Session.onUnlock(() => {
    const ks = KCCrypto.Keystore.load();
    if (!ks) return;
    app.wallet = { publicKey: ks.publicKey, address: ks.address };
    document.getElementById('lock-hint').textContent = '';
    enterWallet();
  });
  const sel = document.getElementById('autolock-setting');
  if (sel) sel.value = String(KCCrypto.Session.autolockMinutes());
}

// 無操作タイマーの更新（マウス/キー/タッチ + タブ復帰）
function setupActivityListeners() {
  ['mousemove', 'keydown', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, () => KCCrypto.Session.touch(), { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) KCCrypto.Session.touch();
  });
}

// サーバー登録（成功時 true）。秘密鍵はここでは扱わない
async function registerWallet(publicKey, address, inviteCode) {
  try {
    const res = await fetch(`${API_BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey, inviteCode })
    });
    const data = await res.json();
    if (res.status === 409 || data.success) {
      return true;
    }
    toast(data.error || '登録に失敗しました', 'error');
    return false;
  } catch (e) {
    toast('サーバー接続エラー', 'error');
    return false;
  }
}

// 起動時のルーティング: キーストア→ロック / 旧平文→移行 / 未登録→ウェルカム
function loadWallet() {
  if (KCCrypto.Keystore.has()) {
    const ks = KCCrypto.Keystore.load();
    if (ks && ks.address) {
      document.getElementById('lock-address').textContent = `アドレス: ${ks.address}`;
    }
    const remaining = KCCrypto.Session.lockoutRemainingMs();
    document.getElementById('lock-hint').textContent = remaining > 0
      ? `試行上限中。${Math.ceil(remaining / 1000)}秒後に再試行してください`
      : '';
    showView('view-lock');
    return;
  }

  const legacy = localStorage.getItem('kc_wallet');
  if (legacy) {
    let parsed = null;
    try { parsed = JSON.parse(legacy); } catch (e) { /* 壊れたデータは破棄 */ }
    if (parsed && parsed.secretKey) {
      document.getElementById('migrate-address').textContent = `アドレス: ${parsed.address || ''}`;
      showView('view-migrate');
      return;
    }
    localStorage.removeItem('kc_wallet');
  }

  showView('view-welcome');
}

async function updateBalance() {
  if (!app.wallet) return;
  document.getElementById('wallet-address-short').textContent = app.wallet.address.slice(0, 8) + '...';

  try {
    const res = await fetch(`${API_BASE}/api/balance/${app.wallet.address}`);
    const data = await res.json();
    if (data.success) {
      document.getElementById('balance-value').textContent = Number(data.balance).toFixed(5);
      // 管理ボタンはサーバが判定した管理者（ADMIN_ADDRESS）のみ表示
      const adminBtn = document.getElementById('btn-admin-genesis');
      if (adminBtn) adminBtn.style.display = data.isAdmin ? 'inline-block' : 'none';
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
    const signature = signMessage(message);

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
        const officialName = isSent ? tx.to_nickname : tx.from_nickname;
        if (officialName) officialNamesCache[addr] = officialName;
        
        const name = officialName || nicknamesCache[addr] || addr.slice(0, 10) + '...';
        
        let dateStr = '';
        if (tx.timestamp) {
          const d = new Date(tx.timestamp);
          dateStr = d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }

        const memoLine = tx.memo
          ? `<div class="tx-memo" title="${escHtml(tx.memo)}">📝 ${escHtml(tx.memo)}</div>`
          : '';

        return `
          <div class="history-item">
            <div>
              <div style="font-weight:700;">${tx.type === 'transfer' ? (isSent ? '送金' : '受取') : '配付'} <span style="font-size:0.6rem;font-weight:normal;color:#aaa;margin-left:5px;">${escHtml(dateStr)}</span></div>
              <div style="font-size:0.6rem; margin-top:2px; opacity:0.9;">相手: <span style="font-weight:bold;">${escHtml(name)}</span> ${officialNamesCache[addr] ? '' : `<span style="font-size:0.5rem; opacity:0.6">(${escHtml(addr.slice(0, 6))}...)</span>`}</div>
              ${memoLine}
            </div>
            <div style="font-weight:800;">${sign}${escHtml(tx.amountDisplay)}</div>
          </div>
        `;
      }).join('');
    } else {
      listEl.innerHTML = '<p style="text-align:center; color:#999; padding:10px; font-size:0.7rem;">履歴はありません</p>';
    }
  } catch (e) { }
}

// 署名の単一実行経路。秘密鍵はロック解除中のみ Session がメモリに保持する
function signMessage(message) {
  const secretKeyB64 = KCCrypto.Session.getSecretKey(); // ロック中は throw
  const secretKeyBytes = nacl.util.decodeBase64(secretKeyB64);
  const msgBytes = nacl.util.decodeUTF8(message);
  return nacl.util.encodeBase64(nacl.sign.detached(msgBytes, secretKeyBytes));
}

// --- 外部由来文字列の HTML エスケープ（XSS対策） ---
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

  // 割り勘リンク（未ログインでも閲覧可）
  const splitId = params.get('split');
  if (splitId) {
    app.openSplit(splitId);
    window.history.replaceState({}, '', window.location.pathname + window.location.hash);
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
let officialNamesCache = {
    'GENESIS': 'SYSTEM'
};

app.editNickname = async () => {
  const target = document.getElementById('dm-action-addr').textContent;
  const currentName = nicknamesCache[target] || '';
  const newName = prompt('ニックネームを入力してください (空で削除)', currentName);
  if (newName === null) return; // cancelled

  const message = `${app.wallet.address}:${target}:${newName}`;
  const signature = signMessage(message);

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
  // 金額入力プロンプトを削除し、常に NULL (相手に任せる) で送信
  const amount = null;

  const messageStr = '0'; // amount が null の場合は '0' をシグナルとする
  const message = `${app.wallet.address}:REQUEST:${target}:${messageStr}`;
  const signature = signMessage(message);

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
      toast('送金のお願いを送信しました', 'success');
      app.hideModal('modal-dm-action');
    } else {
      toast('送信に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
  }
};

app.openDMAction = (addr) => {
  const isOfficial = !!officialNamesCache[addr];
  const displayName = officialNamesCache[addr] || nicknamesCache[addr] || addr.slice(0, 8) + '...';
  
  document.getElementById('dm-action-addr').textContent = isOfficial ? displayName : addr;
  document.getElementById('dm-action-name').textContent = displayName;
  showModal('modal-dm-action');
};

async function loadDMList() {
  const listEl = document.getElementById('dm-list');
  listEl.innerHTML = '<p style="text-align:center; padding:10px; font-size: 0.7rem;">読み込み中...</p>';
  try {
    const message = `${app.wallet.address}:GET_NICKNAMES`;
    const signature = signMessage(message);

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
        const isSent = tx.from_addr === app.wallet.address;
        const addr = isSent ? tx.to_addr : tx.from_addr;
        const offName = isSent ? tx.to_nickname : tx.from_nickname;
        
        contacts.add(addr);
        if (offName) officialNamesCache[addr] = offName;
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
          <div class="history-item" style="cursor:pointer;" data-act="openDMAction" data-a1="${escHtml(addr)}">
            <div>
              <div style="font-weight:700;">${escHtml(officialNamesCache[addr] || nicknamesCache[addr] || addr.slice(0, 8) + '...')}</div>
              <div style="font-size:0.5rem; opacity:0.6;">${escHtml(officialNamesCache[addr] || addr.slice(0,16) + '...')}</div>
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
    const signature = signMessage(message);

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
          const amtStr = r.amountDisplay ? `${r.amountDisplay} KC` : '金額はお任せ';
          if (r.status === 'paid') {
            // 支払い済み＝自動消込済み。請求側・支払側の双方で確認可能
            return `
              <div class="history-item" style="border: 1px dashed #2ecc71; margin-bottom: 5px;">
                <div style="flex: 1;">
                  <div style="font-weight:700;">${escHtml(name)} からのお願い</div>
                  <div style="font-weight:800; font-size: 0.6rem; opacity:0.7;">${escHtml(amtStr)}</div>
                </div>
                <span class="badge badge-paid">✅ 支払済</span>
              </div>
            `;
          }
          return `
            <div class="history-item" style="border: 1px dashed #ff6b6b; margin-bottom: 5px; position: relative;">
              <div style="flex: 1;">
                <div style="font-weight:700;">${escHtml(name)} からのお願い</div>
                <div style="font-weight:800; font-size: 0.6rem; color: #ff6b6b;">${escHtml(amtStr)}</div>
              </div>
              <div style="display: flex; gap: 5px; align-items: center;">
                <button class="btn btn-sm" style="margin-bottom: 0;" data-act="fulfillRequest" data-a1="${escHtml(r.requester_address)}" data-a2="${escHtml(r.amountDisplay || '')}" data-a3="${escHtml(r.id)}">支払う</button>
                <button class="btn btn-sm" style="background: transparent; color: #ff6b6b; border: 1px solid #ff6b6b; padding: 2px 8px; width: auto; margin-bottom: 0; font-weight: bold;" data-act="discardRequest" data-a1="${escHtml(r.id)}">×</button>
              </div>
            </div>
          `;
        }).join('');
    } else if (data.success) {
      listEl.innerHTML = '';
    }
  } catch (e) {}
}

// --- Phase 3: お願いのタブ（受け取った／送った）・自動消込 ---

app.setRequestTab = (tab) => {
  const incoming = tab === 'incoming';
  document.getElementById('requests-list').classList.toggle('hidden', !incoming);
  document.getElementById('sent-requests-list').classList.toggle('hidden', incoming);
  document.getElementById('tab-requests-incoming').classList.toggle('active', incoming);
  document.getElementById('tab-requests-sent').classList.toggle('active', !incoming);
  if (incoming) loadRequests(); else loadSentRequests();
};

async function loadSentRequests() {
  const listEl = document.getElementById('sent-requests-list');
  listEl.innerHTML = '<p style="text-align:center; padding:10px; font-size: 0.7rem;">読み込み中...</p>';
  try {
    const signature = signMessage(`${app.wallet.address}:GET_REQUESTS_SENT`);
    const res = await fetch(`${API_BASE}/api/requests/sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: app.wallet.address, signature, publicKey: app.wallet.publicKey })
    });
    const data = await res.json();

    if (!data.success || data.requests.length === 0) {
      listEl.innerHTML = '<p style="text-align:center; color:#999; padding:10px; font-size: 0.7rem;">作成したお願いはありません</p>';
      return;
    }

    const statusBadge = (status) => {
      if (status === 'paid') return '<span class="badge badge-paid">✅ 支払済</span>';
      if (status === 'discarded') return '<span class="badge">✖ 破棄</span>';
      return '<span class="badge badge-pending">⏳ 支払い待ち</span>';
    };

    listEl.innerHTML =
      '<h3 style="font-size: 0.7rem; margin-bottom: 5px;">📤 送ったお願い</h3>' +
      data.requests.map(r => {
        const target = r.target_address.slice(0, 8) + '...';
        const amtStr = r.amountDisplay ? `${r.amountDisplay} KC` : '金額はお任せ';
        let dateStr = '';
        if (r.created_at) {
          const d = new Date(r.created_at);
          dateStr = d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }
        return `
          <div class="history-item" style="margin-bottom: 5px;">
            <div style="flex: 1;">
              <div style="font-weight:700;">${escHtml(target)} へ ${escHtml(amtStr)}</div>
              <div style="font-size:0.55rem; opacity:0.6;">${escHtml(dateStr)}</div>
            </div>
            ${statusBadge(r.status)}
          </div>
        `;
      }).join('') +
      '<button class="btn btn-sm btn-secondary" style="margin-top: 8px;" id="btn-reconcile" data-act="reconcileRequests">未消込の支払いを照合</button>';
  } catch (e) {
    listEl.innerHTML = '<p style="text-align:center; color:red; padding:10px;">エラーが発生しました</p>';
  }
}

// 取りこぼし救済: 過去の支払いと突き合わせて一括消込
app.reconcileRequests = async () => {
  const btn = document.getElementById('btn-reconcile');
  if (btn) setBusy(btn, '照合中…');
  try {
    const signature = signMessage(`${app.wallet.address}:RECONCILE_REQUESTS`);
    const res = await fetch(`${API_BASE}/api/requests/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: app.wallet.address, signature, publicKey: app.wallet.publicKey })
    });
    const data = await res.json();
    if (data.success) {
      toast(data.updated > 0 ? `${data.updated}件のリクエストを消込しました` : '消込できる支払いはありませんでした', 'success');
      loadSentRequests();
    } else {
      toast(data.error || '照合に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
  } finally {
    if (btn) setBusy(btn, '未消込の支払いを照合', false);
  }
};

app.fulfillRequest = async (requester, amount, requestId) => {
  if (amount) {
    // 金額指定あり: 確認モーダルを直接開き、リクエストIDを署名に紐付ける
    await openSendConfirm({ type: 'send', to: requester, amount: parseFloat(amount), requestId });
    return;
  }
  // 金額お任せ: 送金フォームで入力 → 確認時に同じリクエストへ紐付け
  pendingRequestId = requestId;
  app.togglePanel('panel-send');
  document.getElementById('send-to').value = requester;
  document.getElementById('send-amount').value = '';
  document.getElementById('send-amount').focus();
  toast('金額を入力して「送金する」を押してください', 'info');
};

app.discardRequest = async (requestId) => {
  if (!confirm('この送金リクエストを破棄しますか？')) return;

  const message = `${requestId}:DISCARD`;
  const signature = signMessage(message);

  try {
    const res = await fetch(`${API_BASE}/api/requests/discard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, signature, publicKey: app.wallet.publicKey })
    });
    const data = await res.json();
    if (data.success) {
      toast('リクエストを破棄しました', 'success');
      loadRequests();
    } else {
      toast('破棄に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
  }
};

// --- Phase 3: 割り勘（グループ集金）リンク ---
let currentSplitId = null;
let currentSplitState = null;
let splitPollTimer = null;

app.createSplit = async () => {
  const title = document.getElementById('split-title').value.trim();
  const mode = document.getElementById('split-mode').value;
  const amount = parseFloat(document.getElementById('split-amount').value);
  const count = parseInt(document.getElementById('split-count').value, 10);
  if (!title) return toast('タイトルを入力してください', 'error');
  if (!amount || amount <= 0) return toast('金額を入力してください', 'error');
  if (!Number.isFinite(count) || count < 2 || count > 100) {
    return toast('人数は2〜100で指定してください', 'error');
  }

  // 内部整数(10^5)で署名・送信する
  const totalI = mode === 'equal' ? Math.round(amount * DECIMALS_MULT) : 0;
  const shareI = mode === 'fixed' ? Math.round(amount * DECIMALS_MULT) : 0;
  const message = `${app.wallet.address}:SPLIT_CREATE:${title}:${mode}:${totalI}:${shareI}:${count}`;
  const signature = signMessage(message);

  const btn = document.getElementById('btn-create-split');
  setBusy(btn, '作成中…');
  try {
    const res = await fetch(`${API_BASE}/api/split/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creator: app.wallet.address, title, mode, totalAmount: totalI, shareAmount: shareI,
        participantCount: count, signature, publicKey: app.wallet.publicKey
      })
    });
    const data = await res.json();
    if (data.success) {
      const url = `${window.location.origin}/?split=${data.id}`;
      document.getElementById('split-url').value = url;
      document.getElementById('split-result').classList.remove('hidden');
      generateQRCode(url, 'split-qrcode');
      const remainderNote = data.remainderDisplay > 0
        ? `（端数 ${data.remainderDisplay} KC は作成者負担）`
        : '';
      toast(`集金リンクを作成しました：1人 ${data.shareDisplay} KC ${remainderNote}`, 'success');
    } else {
      toast(data.error || '作成に失敗しました', 'error');
    }
  } catch (e) {
    toast('通信エラー', 'error');
  } finally {
    setBusy(btn, '集金リンクを作成', false);
  }
};

// リンク開封（誰でも閲覧可）→ 3秒ポーリングで進捗更新
app.openSplit = async (id) => {
  currentSplitId = id;
  showModal('modal-split');
  await fetchSplitState(id);
  if (splitPollTimer) clearInterval(splitPollTimer);
  splitPollTimer = setInterval(() => {
    if (currentSplitId) fetchSplitState(currentSplitId);
  }, 3000);
};

app.closeSplit = () => {
  if (splitPollTimer) clearInterval(splitPollTimer);
  splitPollTimer = null;
  currentSplitId = null;
  currentSplitState = null;
  app.hideModal('modal-split');
  if (window.location.search) {
    window.history.replaceState({}, '', window.location.pathname);
  }
};

app.paySplit = () => {
  if (!app.wallet) return toast('支払いにはログインが必要です', 'error');
  if (!currentSplitState) return;
  if (currentSplitState.status !== 'open') return toast('この集金は終了しています', 'error');
  if (currentSplitState.viewerPaid) return toast('すでに支払い済みです', 'success');
  openSendConfirm({
    type: 'split',
    billId: currentSplitId,
    amount: currentSplitState.shareDisplay,
    creatorShort: currentSplitState.creatorShort
  });
};

async function fetchSplitState(id) {
  try {
    const viewer = app.wallet ? `?viewer=${encodeURIComponent(app.wallet.address)}` : '';
    const res = await fetch(`${API_BASE}/api/split/${id}${viewer}`);
    const data = await res.json();
    if (!data.success) {
      toast(data.error || '集金情報を取得できません', 'error');
      app.closeSplit();
      return;
    }
    renderSplit(data.split);
  } catch (e) {
    // ポーリング中の一時的な通信エラーは無視（次ティックで再試行）
  }
}

function renderSplit(s) {
  currentSplitState = s;
  document.getElementById('split-modal-title').textContent = s.title;
  document.getElementById('split-modal-status').textContent =
    s.status === 'completed' ? '✅ 全員の支払いが揃いました' : `募集中 — ${s.paidCount}/${s.participantCount}人`;
  document.getElementById('split-modal-share').textContent = s.shareDisplay;
  document.getElementById('split-modal-progress').textContent = `${s.paidCount}/${s.participantCount}`;
  document.getElementById('split-modal-collected').textContent = s.collectedDisplay;
  document.getElementById('split-modal-total').textContent = s.totalDisplay;
  const pct = s.totalDisplay > 0 ? Math.min(100, (s.collectedDisplay / s.totalDisplay) * 100) : 0;
  document.getElementById('split-modal-bar').style.width = `${pct}%`;
  document.getElementById('split-modal-creator').textContent = `作成者: ${s.creatorShort}`;
  document.getElementById('split-modal-payers').textContent =
    s.payers && s.payers.length ? `支払済: ${s.payers.join(', ')}` : 'まだ誰も支払っていません';

  const payBtn = document.getElementById('btn-split-pay');
  const hint = document.getElementById('split-modal-pay-hint');
  const canPay = !!(app.wallet && s.status === 'open' && !s.viewerPaid);
  payBtn.classList.toggle('hidden', !canPay);
  hint.classList.toggle('hidden', canPay);
  if (!canPay) {
    hint.textContent = !app.wallet
      ? '支払いにはログインが必要です'
      : s.viewerPaid ? 'あなたは支払い済みです' : '集金は終了しました';
  }
}

// --- Phase 2: QRコード読み取り（カメラ） ---
let qrScanner = null;

app.startScan = async () => {
  if (!window.Html5Qrcode) {
    return toast('QR読み取りライブラリが読み込めていません', 'error');
  }
  document.getElementById('scanner-overlay').classList.remove('hidden');
  document.getElementById('scanner-status').textContent = 'カメラをQRコードに向けてください';
  try {
    qrScanner = new Html5Qrcode('scanner-region', { verbose: false });
    await qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decodedText) => { handleScannedText(decodedText); },
      undefined
    );
  } catch (e) {
    document.getElementById('scanner-status').textContent =
      'カメラを開始できません（許可設定を確認するか手入力してください）';
    toast('カメラを起動できませんでした', 'error');
  }
};

app.stopScan = () => stopScanner();

async function stopScanner() {
  document.getElementById('scanner-overlay').classList.add('hidden');
  if (qrScanner) {
    try { await qrScanner.stop(); } catch (e) { /* 既に停止済み */ }
    try { qrScanner.clear(); } catch (e) { /* ignore */ }
    qrScanner = null;
  }
  document.getElementById('scanner-region').innerHTML = '';
}

function handleScannedText(text) {
  const raw = String(text || '').trim();
  if (!raw) return;
  if (navigator.vibrate) navigator.vibrate(150); // 読み取り成功のフィードバック
  stopScanner();

  // 自分のアプリのURLか
  let url = null;
  try { url = new URL(raw); } catch (e) { url = null; }
  if (url && url.origin === window.location.origin) {
    if (url.pathname === '/api/process-send') {
      if (confirm('送金URLを読み取りました。実行しますか？')) window.location.href = raw;
      return;
    }
    const params = url.searchParams;
    const payTo = params.get('pay_to');
    if (payTo) return fillSendForm(payTo);
    const receiveLink = params.get('receive_link');
    if (receiveLink) return processOnetimeLink(receiveLink);
    const splitId = params.get('split');
    if (splitId) return app.openSplit(splitId);
    const invite = params.get('invite');
    if (invite) {
      const inviteInput = document.getElementById('invite-code');
      if (inviteInput) inviteInput.value = invite;
      toast('招待コードをセットしました', 'success');
      return;
    }
    toast('このQRコードは対応していません', 'error');
    return;
  }

  // 生アドレス（40桁hex）
  if (/^[0-9a-f]{40}$/i.test(raw)) return fillSendForm(raw.toLowerCase());
  toast('読み取れた内容を解釈できません', 'error');
}

function fillSendForm(addr) {
  if (document.getElementById('panel-send').classList.contains('hidden')) {
    app.togglePanel('panel-send');
  }
  document.getElementById('send-to').value = addr;
  document.getElementById('send-amount').focus();
  toast('アドレスを送金フォームにセットしました', 'success');
}
