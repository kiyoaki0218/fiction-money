const express = require('express');
const cors = require('cors');
const path = require('path');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

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
app.post('/api/register', async (req, res) => {
  try {
    const { publicKey, inviteCode } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: '公開鍵が必要です' });
    }

    if (inviteCode !== INVITE_CODE) {
      return res.status(403).json({ success: false, error: '有効な招待コードが必要です' });
    }

    const address = addressFromPublicKey(publicKey);
    const result = await db.registerAccount(address, publicKey);

    if (!result.success) {
      return res.status(409).json(result);
    }

    res.json({
      ...result,
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
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 送金実行（署名検証付き）
app.post('/api/send', async (req, res) => {
  try {
    const { from, to, amount, nonce, signature, publicKey } = req.body;

    if (!from || !to || !amount || nonce === undefined || !signature || !publicKey) {
      return res.status(400).json({ success: false, error: '全てのフィールドが必要です' });
    }

    // 公開鍵からアドレスを導出して送信者の検証
    const derivedAddress = addressFromPublicKey(publicKey);
    if (derivedAddress !== from) {
      return res.status(403).json({ success: false, error: '公開鍵と送信者アドレスが一致しません' });
    }

    // 署名検証
    const message = `${from}:${to}:${amount}:${nonce}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    const amountInternal = Math.round(amount * db.INTERNAL_MULTIPLIER);
    const crypto = require('crypto');
    const txId = crypto.createHash('sha256')
      .update(`${from}:${to}:${amountInternal}:${nonce}:${signature}`)
      .digest('hex').slice(0, 16);

    const result = await db.processTransfer(from, to, amountInternal, nonce, signature, txId);
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      ...result,
      message: `${result.amount} ${db.COIN_SYMBOL} を送金しました`,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ワンタイムURL用リンクの作成 (Push型)
app.post('/api/onetime-link/create', async (req, res) => {
  try {
    const { from, amount, nonce, signature, publicKey } = req.body;
    if (!from || !amount || nonce === undefined || !signature || !publicKey) {
      return res.status(400).json({ success: false, error: '必要なパラメータが不足しています' });
    }

    const derivedAddress = addressFromPublicKey(publicKey);
    if (derivedAddress !== from) {
      return res.status(403).json({ success: false, error: '公開鍵が不正です' });
    }

    // ONETIME という専用のダミー宛先で署名検証を行う
    const message = `${from}:ONETIME:${amount}:${nonce}`;
    if (!verifySignature(message, signature, publicKey)) {
      return res.status(403).json({ success: false, error: '署名の検証に失敗しました' });
    }

    const amountInternal = Math.round(parseFloat(amount) * db.INTERNAL_MULTIPLIER);
    const result = await db.createOnetimeLink(from, amountInternal, nonce, signature);
    
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

    res.json({ success: true, amount: transResult.amount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 取引履歴
app.get('/api/transactions/:address', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
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

// 管理者: Genesis（初回のみ）
app.post('/api/admin/genesis', async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) {
      return res.status(400).json({ success: false, error: '公開鍵が必要です' });
    }

    const address = addressFromPublicKey(publicKey);
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
