const express = require('express');
const cors = require('cors');
const path = require('path');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const db = require('./db');
const { rateLimit } = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// リバースプロキシ（Vercel）配下でクライアントIPを正しく取得する（express-rate-limit の検証要件）
app.set('trust proxy', 1);

// Vercel の rewrites は rewrite 後のパス（/server.js）を関数へ渡してくるため、
// rewrite 宛先のクエリ __orig に載せた元のパスへ復元する（→ /api/* のルーティングが
// 通常のローカル実行と同じ動作になる）。ローカルでは __orig が無いので何もしない。
app.use((req, res, next) => {
  const qIdx = req.url.indexOf('?');
  const qs = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';
  const m = qs.match(/(?:^|&)__orig=([^&]*)/);
  if (m) {
    let rest = qs.replace(/(?:^|&)__orig=[^&]*/, '');
    rest = rest.replace(/^&/, '');
    let orig;
    try { orig = decodeURIComponent(m[1]); } catch (e) { orig = m[1]; }
    req.url = orig + (rest ? `?${rest}` : '');
  }
  next();
});

// セキュリティヘッダ。
// Vercel 上では vercel.json の headers 設定が全応答（静的ファイル含む）に適用されるため重複を避け、
// ローカル/非Vercel環境でのみ Express から同じヘッダを返す。
if (!process.env.VERCEL) {
  const securityHeaders = [
    ['Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'"],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    ['Permissions-Policy', 'camera=(self), microphone=(), geolocation=()'],
  ];
  app.use((req, res, next) => {
    securityHeaders.forEach(([key, value]) => res.setHeader(key, value));
    next();
  });
}

// 管理者アドレス（未設定なら管理APIは無効＝フェイルクローズ）
const ADMIN_ADDRESS = (process.env.ADMIN_ADDRESS || '').toLowerCase();

// レート制限（サーバレス環境ではインスタンス毎のベストエフォートカウント）
const rl = (limit) => rateLimit({ windowMs: 60 * 1000, limit, standardHeaders: 'draft-8', legacyHeaders: false });
const registerLimiter = rl(10);   // 登録・招待
const sendLimiter = rl(30);       // 送金実行
const linkLimiter = rl(10);       // ワンタイムリンク作成
const splitLimiter = rl(20);      // 割り勘の作成・支払
const adminLimiter = rl(5);       // 管理API

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ユーティリティ ---

function verifySignature(message, signature, publicKey) {
  try {
    const msgBytes = naclUtil.decodeUTF8(message);
    const sigBytes = naclUtil.decodeBase64(signature);
    const pubBytes = naclUtil.decodeBase64(publicKey);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubBytes);
  } catch (e) {
    return false;
  }
}

function addressFromPublicKey(publicKeyBase64) {
  const crypto = require('crypto');
  const pubBytes = Buffer.from(publicKeyBase64, 'base64');
  return crypto.createHash('sha256').update(pubBytes).digest('hex').slice(0, 40);
}

// --- API エンドポイント ---

// 通貨情報
app.get('/api/info', async (req, res) => {
  try {
    const info = await db.getCoinInfo();
    res.json({
      success: true,
      coin: {
        name: db.COIN_NAME,
        symbol: db.COIN_SYMBOL,
        totalSupply: db.TOTAL_SUPPLY,
        decimals: db.DECIMALS,
        registrationBonus: db.REGISTRATION_BONUS,
        ...info,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const INVITE_CODE = process.env.INVITE_CODE || 'kurekure2026';

// ウォレット登録
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { publicKey, inviteCode } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: '公開鍵が必要です' });
    }

    if (inviteCode !== INVITE_CODE) {
      return res.status(403).json({ success: false, error: '有効な招待コードが必要です' });
    }

    const address = addressFromPublicKey(publicKey);
    const isAdmin = address === ADMIN_ADDRESS;
    const result = await db.registerAccount(address, publicKey);

    if (!result.success) {
      return res.status(409).json({ ...result, isAdmin });
    }

    res.json({
      ...result,
      isAdmin,
      message: result.bonus > 0
        ? `ウォレット登録完了！登録ボーナス ${result.bonus} ${db.COIN_SYMBOL} を付与しました`
        : 'ウォレット登録完了（ボーナスプールが枯渇しています）',
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 残高確認
app.get('/api/balance/:address', async (req, res) => {
  try {
    const account = await db.getAccount(req.params.address);
    if (!account) {
      return res.status(404).json({ success: false, error: 'アカウントが見つかりません' });
    }

    res.json({
      success: true,
      address: account.address,
      balance: account.balance / db.INTERNAL_MULTIPLIER,
      balanceInternal: account.balance,
      nonce: account.nonce,
      isAdmin: account.address === ADMIN_ADDRESS,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 送金実行（署名検証付き）
app.post('/api/send', sendLimiter, async (req, res) => {
  try {
    const { from, to, amount, nonce, signature, publicKey, memo, requestId } = req.body;

    if (!from || !to || !amount || nonce === undefined || !signature || !publicKey) {
      return res.status(400).json({ success: false, error: '全てのフィールドが必要です' });
    }

    // 公開鍵からアドレスを導出して送信者の検証
    const derivedAddress = addressFromPublicKey(publicKey);
    if (derivedAddress !== from) {
      return res.status(403).json({ success: false, error: '公開鍵と送信者アドレスが一致しません' });
    }

    const amountInternal = Math.round(amount * db.INTERNAL_MULTIPLIER);
    if (amountInternal <= 0) {
      return res.status(400).json({ success: false, error: '金額が不正です' });
    }
    const memoStr = String(memo || '').slice(0, 100);

    // 署名検証（内部整数 + メモ + リクエストID を署名対象に含める）
    const message = `${from}:${to}:${amountInternal}:${nonce}:${memoStr}:${requestId || ''}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    // リクエスト自動消込: 送金前に検証し、不一致なら金を動かさない
    let request = null;
    if (requestId) {
      request = await db.getPaymentRequestById(requestId);
      if (!request) {
        return res.status(404).json({ success: false, error: '送金リクエストが見つかりません' });
      }
      if (request.status !== 'pending') {
        return res.status(409).json({ success: false, error: 'このリクエストは対応済みです' });
      }
      if (request.target_address !== from) {
        return res.status(403).json({ success: false, error: 'このリクエストの支払者ではありません' });
      }
      if (request.requester_address !== to) {
        return res.status(400).json({ success: false, error: 'リクエストを送信した相手宛の送金が必要です' });
      }
      if (request.amount && amountInternal < Number(request.amount)) {
        const need = (Number(request.amount) / db.INTERNAL_MULTIPLIER).toFixed(db.DECIMALS);
        return res.status(400).json({ success: false, error: `リクエスト額 ${need} ${db.COIN_SYMBOL} 以上の送金が必要です` });
      }
    }

    const crypto = require('crypto');
    const txId = crypto.createHash('sha256')
      .update(`${from}:${to}:${amountInternal}:${nonce}:${signature}:${memoStr}`)
      .digest('hex').slice(0, 16);

    const result = await db.processTransfer(from, to, amountInternal, nonce, signature, txId);
    if (!result.success) {
      return res.status(400).json(result);
    }

    // メモの付与（best effort: 失敗しても送金自体は成立している）
    if (memoStr) await db.updateTxMemo(txId, memoStr);

    // リクエストの自動消込
    let requestPaid = false;
    if (request) {
      const paid = await db.markRequestPaid(request.id, txId);
      requestPaid = paid.success;
    }

    res.json({
      ...result,
      txId,
      requestPaid,
      message: `${result.amount} ${db.COIN_SYMBOL} を送金しました`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ワンタイムURL用リンクの作成 (Push型)
app.post('/api/onetime-link/create', linkLimiter, async (req, res) => {
  try {
    const { from, amount, nonce, signature, publicKey, memo } = req.body;
    if (!from || !amount || nonce === undefined || !signature || !publicKey) {
      return res.status(400).json({ success: false, error: '必要なパラメータが不足しています' });
    }

    const derivedAddress = addressFromPublicKey(publicKey);
    if (derivedAddress !== from) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    const amountInternal = Math.round(parseFloat(amount) * db.INTERNAL_MULTIPLIER);
    if (amountInternal <= 0) {
      return res.status(400).json({ success: false, error: '金額が不正です' });
    }
    const memoStr = String(memo || '').slice(0, 100);

    // ONETIME という専用のダミー宛先で署名検証を行う（内部整数 + メモ込み）
    const message = `${from}:ONETIME:${amountInternal}:${nonce}:${memoStr}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    const result = await db.createOnetimeLink(from, amountInternal, nonce, signature, memoStr);
    
    if (!result.success) {
      return res.status(500).json(result);
    }
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ワンタイムURLの受取・送金実行
app.post('/api/onetime-link/receive', async (req, res) => {
  try {
    const { linkId, receiver } = req.body;
    if (!linkId || !receiver) {
      return res.status(400).json({ success: false, error: 'リンクIDまたは受取アドレスが不足しています' });
    }

    // リンクの取得と状態更新 (使用済みにする)
    const claimResult = await db.claimOnetimeLink(linkId, receiver);
    if (!claimResult.success) {
      return res.status(400).json(claimResult);
    }
    const link = claimResult.link;

    const crypto = require('crypto');
    // ONETIMEとして署名されたデータを元に、実際の受取人アドレスを組み込んでtxIdを生成（ログ用）
    const txId = crypto.createHash('sha256')
      .update(`${link.sender_address}:${receiver}:${link.amount}:${link.nonce}:${link.signature}`)
      .digest('hex').slice(0, 16);

    // 実際の送金処理を実行
    const transResult = await db.processTransfer(link.sender_address, receiver, link.amount, link.nonce, link.signature, txId);
    
    if (!transResult.success) {
      // リンクは消費されたが送金が失敗した場合（残高不足等）
      return res.status(400).json({ success: false, error: '送金に失敗しました。送信者の残高が不足している可能性があります。' });
    }

    // メモを履歴に付与（best effort）
    if (link.memo) await db.updateTxMemo(txId, link.memo);

    res.json({ success: true, amount: transResult.amount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 従来の特定宛先用URL経由の送金処理
app.get('/api/process-send', sendLimiter, async (req, res) => {
  try {
    const { from, to, amount, nonce, sig, pub, memo } = req.query;

    if (!from || !to || !amount || !nonce || !sig || !pub) {
      return res.status(400).json({ success: false, error: '不正な送金URLです' });
    }

    const publicKey = decodeURIComponent(pub);
    const signature = decodeURIComponent(sig);

    const derivedAddress = addressFromPublicKey(publicKey);
    if (derivedAddress !== from) {
      return res.status(403).json({ success: false, error: '公開鍵と送信者アドレスが一致しません' });
    }

    const memoStr = String(memo || '').slice(0, 100);
    const amountNum = parseFloat(amount);
    const amountInternal = Math.round(amountNum * db.INTERNAL_MULTIPLIER);

    const message = `${from}:${to}:${amountInternal}:${nonce}:${memoStr}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    const crypto = require('crypto');
    const txId = crypto.createHash('sha256')
      .update(`${from}:${to}:${amountInternal}:${nonce}:${signature}:${memoStr}`)
      .digest('hex').slice(0, 16);

    const result = await db.processTransfer(from, to, amountInternal, parseInt(nonce), signature, txId);
    if (!result.success) {
      return res.status(400).json(result);
    }

    if (memoStr) await db.updateTxMemo(txId, memoStr);

    let redirectUrl = `/?tx_success=1&tx_id=${txId}&tx_amount=${amountNum}&tx_from=${from.slice(0, 8)}`;
    res.redirect(redirectUrl);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 取引履歴
app.get('/api/transactions/:address', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 1000;
    const txs = await db.getTransactions(req.params.address, limit);

    const formatted = txs.map(tx => ({
      ...tx,
      amountDisplay: (tx.amount / db.INTERNAL_MULTIPLIER).toFixed(db.DECIMALS),
      direction: tx.from_addr === req.params.address ? 'sent' : 'received',
    }));

    res.json({ success: true, transactions: formatted });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Phase 3: ニックネーム管理 API ---

// ニックネーム一覧取得 (プライバシー保護のため署名必須)
app.post('/api/nicknames/list', async (req, res) => {
  try {
    const { owner, signature, publicKey } = req.body;
    if (!verifySignature(`${owner}:GET_NICKNAMES`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    const derivedAddress = addressFromPublicKey(publicKey);
    if (derivedAddress !== owner) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    const nicknames = await db.getNicknames(owner);
    res.json({ success: true, nicknames });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ニックネーム設定
app.post('/api/nicknames/set', async (req, res) => {
  try {
    const { owner, target, nickname, signature, publicKey } = req.body;
    if (!verifySignature(`${owner}:${target}:${nickname}`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    const result = await db.setNickname(owner, target, nickname);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Phase 3: 送金リクエスト (DM) API ---

app.post('/api/requests/create', async (req, res) => {
  try {
    const { requester, target, amount, signature, publicKey } = req.body;
    // リクエストの送信者(requester)が署名
    const msgAmount = amount ? amount : '0';
    if (!verifySignature(`${requester}:REQUEST:${target}:${msgAmount}`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    const amountInternal = amount ? Math.round(parseFloat(amount) * db.INTERNAL_MULTIPLIER) : null;
    const result = await db.createPaymentRequest(requester, target, amountInternal);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/requests/list', async (req, res) => {
  try {
    const { target, signature, publicKey } = req.body;
    if (!verifySignature(`${target}:GET_REQUESTS`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    const requests = await db.getPaymentRequests(target);
    const formatted = requests.map(r => ({
      ...r,
      amountDisplay: r.amount ? (r.amount / db.INTERNAL_MULTIPLIER).toFixed(db.DECIMALS) : null
    }));
    res.json({ success: true, requests: formatted });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/requests/discard', async (req, res) => {
  try {
    const { requestId, signature, publicKey } = req.body;
    if (!verifySignature(`${requestId}:DISCARD`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    const targetAddress = addressFromPublicKey(publicKey);
    const result = await db.discardPaymentRequest(requestId, targetAddress);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 請求側: 自分が作ったリクエストの一覧（pending / paid / discarded のステータス管理）
app.post('/api/requests/sent', async (req, res) => {
  try {
    const { owner, signature, publicKey } = req.body;
    if (!verifySignature(`${owner}:GET_REQUESTS_SENT`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    if (addressFromPublicKey(publicKey) !== owner) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    const requests = await db.getSentRequests(owner);
    const formatted = requests.map(r => ({
      ...r,
      amountDisplay: r.amount ? (r.amount / db.INTERNAL_MULTIPLIER).toFixed(db.DECIMALS) : null
    }));
    res.json({ success: true, requests: formatted });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 請求側: 取りこぼし救済（過去の支払いと突き合わせて一括消込）
app.post('/api/requests/reconcile', async (req, res) => {
  try {
    const { owner, signature, publicKey } = req.body;
    if (!verifySignature(`${owner}:RECONCILE_REQUESTS`, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名が無効です' });
    }
    if (addressFromPublicKey(publicKey) !== owner) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    const result = await db.reconcileSentRequests(owner);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Phase 3: 割り勘（グループ集金）API ---

const SPLIT_MAX_TOTAL = 10_000_000 * 100_000; // 合計上限 10,000,000 KC（内部単位）

// 集金リンクの作成（署名必須）
app.post('/api/split/create', splitLimiter, async (req, res) => {
  try {
    const { creator, title, mode, totalAmount, shareAmount, participantCount, signature, publicKey } = req.body;

    if (addressFromPublicKey(publicKey) !== creator) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    const rawTitle = String(title || '').trim().slice(0, 40);
    const count = parseInt(participantCount, 10);
    const totalI = parseInt(totalAmount, 10) || 0;
    const shareI = parseInt(shareAmount, 10) || 0;
    if (!rawTitle) return res.status(400).json({ success: false, error: 'タイトルを入力してください' });
    if (mode !== 'equal' && mode !== 'fixed') return res.status(400).json({ success: false, error: '方式が不正です' });
    if (!Number.isFinite(count) || count < 2 || count > 100) {
      return res.status(400).json({ success: false, error: '人数は2〜100で指定してください' });
    }

    const message = `${creator}:SPLIT_CREATE:${rawTitle}:${mode}:${totalI}:${shareI}:${count}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    let share;
    let effectiveTotal;
    if (mode === 'equal') {
      if (totalI <= 0) return res.status(400).json({ success: false, error: '合計金額を入力してください' });
      share = Math.floor(totalI / count);         // 端数は作成者負担
      effectiveTotal = share * count;
    } else {
      if (shareI <= 0) return res.status(400).json({ success: false, error: '1人あたりの金額を入力してください' });
      share = shareI;
      effectiveTotal = share * count;
    }
    if (share <= 0) return res.status(400).json({ success: false, error: '1人あたりの金額が小さすぎます' });
    if (effectiveTotal > SPLIT_MAX_TOTAL) {
      return res.status(400).json({ success: false, error: '合計金額が上限（10,000,000 KC）を超えています' });
    }

    const storedTotal = mode === 'equal' ? totalI : effectiveTotal;
    const result = await db.createSplitBill(creator, rawTitle, mode, storedTotal, share, count);
    if (!result.success) return res.status(500).json(result);

    res.json({
      success: true,
      id: result.id,
      shareInternal: share,
      shareDisplay: share / db.INTERNAL_MULTIPLIER,
      effectiveTotalDisplay: effectiveTotal / db.INTERNAL_MULTIPLIER,
      remainderDisplay: (mode === 'equal' ? totalI - effectiveTotal : 0) / db.INTERNAL_MULTIPLIER,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 集金リンクの参照（リンクを開いた誰でも閲覧可・フルアドレスは非表示）
app.get('/api/split/:id', async (req, res) => {
  try {
    const found = await db.getSplitBill(req.params.id);
    if (!found) return res.status(404).json({ success: false, error: '集金リンクが見つかりません' });

    const { bill, payments } = found;
    const collected = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const viewer = req.query.viewer ? String(req.query.viewer) : null;
    const viewerPaid = viewer ? payments.some(p => p.payer_address === viewer) : false;

    res.json({
      success: true,
      split: {
        id: bill.id,
        title: bill.title,
        mode: bill.mode,
        status: bill.status,
        totalDisplay: Number(bill.total_amount) / db.INTERNAL_MULTIPLIER,
        shareInternal: Number(bill.share_amount),
        shareDisplay: Number(bill.share_amount) / db.INTERNAL_MULTIPLIER,
        collectedDisplay: collected / db.INTERNAL_MULTIPLIER,
        participantCount: bill.participant_count,
        paidCount: payments.length,
        viewerPaid,
        creatorShort: bill.creator_address.slice(0, 8) + '...',
        payers: payments.map(p => p.payer_address.slice(0, 8) + '...'),
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 集金への支払い（署名必須・予約→送金→確定の3段階で二重支払い防止）
app.post('/api/split/pay', splitLimiter, async (req, res) => {
  try {
    const { payer, billId, amount, nonce, signature, publicKey } = req.body;
    if (!payer || !billId || !amount || nonce === undefined || !signature || !publicKey) {
      return res.status(400).json({ success: false, error: '全てのフィールドが必要です' });
    }
    if (addressFromPublicKey(publicKey) !== payer) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    const amountInternal = Math.round(Number(amount) * db.INTERNAL_MULTIPLIER);
    const message = `${payer}:SPLIT_PAY:${billId}:${amountInternal}:${nonce}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    const found = await db.getSplitBill(billId);
    if (!found) return res.status(404).json({ success: false, error: '集金リンクが見つかりません' });
    const bill = found.bill;
    if (bill.status !== 'open') {
      return res.status(409).json({ success: false, error: 'この集金は終了しています' });
    }
    if (amountInternal !== Number(bill.share_amount)) {
      return res.status(400).json({ success: false, error: '金額が1人あたりの集金額と一致しません' });
    }

    // 1. 支払い枠の予約（UNIQUE 制約で二重支払いを排他）
    const reserve = await db.reserveSplitPayment(billId, payer, amountInternal);
    if (!reserve.success) {
      return res.status(500).json({ success: false, error: reserve.error || '支払い処理の開始に失敗しました' });
    }
    if (!reserve.reserved) {
      return res.status(409).json({ success: false, error: 'この割り勘は既に支払い済みです' });
    }

    // 2. 送金（作成者への振り込み）
    const crypto = require('crypto');
    const txId = crypto.createHash('sha256')
      .update(`SPLIT:${billId}:${payer}:${amountInternal}:${nonce}:${signature}`)
      .digest('hex').slice(0, 16);

    const transfer = await db.processTransfer(payer, bill.creator_address, amountInternal, nonce, signature, txId);
    if (!transfer.success) {
      await db.releaseSplitPayment(billId, payer); // 予約を解放して再試行可能に
      return res.status(400).json({ success: false, error: transfer.error || '送金に失敗しました' });
    }

    // 3. 確定 + メモ付与 + 完了判定
    await db.confirmSplitPayment(billId, payer, txId);
    await db.updateTxMemo(txId, `割り勘「${String(bill.title).slice(0, 60)}」`);
    const done = await db.markSplitBillCompletedIfDone(billId);
    const refreshed = await db.getSplitBill(billId);
    const payments = refreshed ? refreshed.payments : [];
    const collected = payments.reduce((sum, p) => sum + Number(p.amount), 0);

    res.json({
      success: true,
      txId,
      paidCount: payments.length,
      collectedDisplay: collected / db.INTERNAL_MULTIPLIER,
      status: done.completed ? 'completed' : 'open',
      message: `${(amountInternal / db.INTERNAL_MULTIPLIER)} ${db.COIN_SYMBOL} を支払いました`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 管理者: Genesis（初回のみ）
app.post('/api/admin/genesis', adminLimiter, async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: '公開鍵が必要です' });
    }

    const address = addressFromPublicKey(publicKey);

    // ADMIN_ADDRESS 未設定時は無効。不一致の呼び出しは拒否（フェイルクローズ）
    if (!ADMIN_ADDRESS || address !== ADMIN_ADDRESS) {
      return res.status(403).json({ success: false, error: '管理者アドレスが一致していません' });
    }

    const result = await db.initAdminAccount(address, publicKey);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// アドレス検索（存在確認）
app.get('/api/account/:address', async (req, res) => {
  try {
    const account = await db.getAccount(req.params.address);
    if (!account) {
      return res.status(404).json({ success: false, error: 'アカウントが見つかりません' });
    }
    res.json({
      success: true,
      address: account.address,
      exists: true,
      createdAt: account.created_at,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// SPA対応: 全未マッチルートでindex.htmlを返す
app.get('/{*splat}', (req, res) => {
  if (req.path.match(/\.\w+$/)) {
    return res.status(404).end();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- サーバー起動 ---
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  🪙 ${db.COIN_NAME} サーバーレス準備完了 (Port: ${PORT})`);
  });
}

module.exports = app;
