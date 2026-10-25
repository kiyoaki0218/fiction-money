// サーバーテスト用のインメモリ db.js 実装（Supabase なしで server.js を検証する）
// db.js のエクスポートと同形状の関数群を提供する。

const COIN_NAME = 'クレクレコイン';
const COIN_SYMBOL = 'KC';
const TOTAL_SUPPLY = 1_000_000_000;
const DECIMALS = 5;
const INTERNAL_MULTIPLIER = 10 ** DECIMALS;
const REGISTRATION_BONUS = 100;

// --- state ---
const accounts = new Map();      // address -> { address, public_key, balance, nonce, nickname, created_at }
const transactions = [];         // { id, type, from_addr, to_addr, amount, timestamp, memo }
const onetimeLinks = new Map();  // id -> { id, sender_address, amount, nonce, signature, memo, status }
const nicknames = new Map();     // owner|target -> nickname
const paymentRequests = new Map(); // id -> row
const splitBills = new Map();    // id -> bill row
const splitPayments = [];        // { bill_id, payer_address, amount, status, tx_id }

let seq = 0;
const newId = () => `id-${Date.now().toString(36)}-${++seq}`;

function account(address) {
  return accounts.get(address) || null;
}

// --- アカウント ---

async function registerAccount(address, publicKey) {
  if (accounts.has(address)) {
    return { success: false, error: 'アカウントは既に存在します' };
  }
  accounts.set(address, {
    address,
    public_key: publicKey,
    balance: REGISTRATION_BONUS * INTERNAL_MULTIPLIER,
    nonce: 0,
    nickname: null,
    created_at: new Date().toISOString(),
  });
  return {
    success: true,
    address,
    bonus: REGISTRATION_BONUS,
    bonusInternal: REGISTRATION_BONUS * INTERNAL_MULTIPLIER,
  };
}

async function getAccount(address) {
  return account(address) || null;
}

async function getAccountByPublicKey(publicKey) {
  for (const acc of accounts.values()) {
    if (acc.public_key === publicKey) return acc;
  }
  return null;
}

// --- 送金（process_transfer 相当） ---
// nonce は「現在値 + 1」でなければならない（クライアントが fetchNonce()+1 を送る）

async function processTransfer(fromAddr, toAddr, amountInternal, nonce, signature, txId) {
  const from = account(fromAddr);
  if (!from) return { success: false, error: '送信者が見つかりません' };
  if (Number(nonce) !== from.nonce + 1) return { success: false, error: 'nonceが不正です' };
  if (from.balance < amountInternal) return { success: false, error: '残高が不足しています' };

  let to = account(toAddr);
  if (!to) {
    // 宛先未登録でも受け取れる（実運用の RPC 挙動に合わせる）
    to = {
      address: toAddr, public_key: null, balance: 0, nonce: 0,
      nickname: null, created_at: new Date().toISOString(),
    };
    accounts.set(toAddr, to);
  }

  from.balance -= amountInternal;
  from.nonce += 1;
  to.balance += amountInternal;
  transactions.push({
    id: txId,
    type: 'transfer',
    from_addr: fromAddr,
    to_addr: toAddr,
    amount: amountInternal,
    timestamp: new Date().toISOString(),
    memo: null,
  });

  return {
    success: true,
    txId,
    from: fromAddr,
    to: toAddr,
    amount: amountInternal / INTERNAL_MULTIPLIER,
  };
}

// --- 取引履歴 ---

async function getTransactions(address, limit = 1000) {
  const txs = transactions
    .filter(tx => tx.from_addr === address || tx.to_addr === address)
    .slice(-limit)
    .reverse();

  return txs.map(tx => ({
    ...tx,
    from_nickname: tx.from_addr === 'GENESIS' ? 'SYSTEM' : (accounts.get(tx.from_addr) || {}).nickname,
    to_nickname: tx.to_addr === 'GENESIS' ? 'SYSTEM' : (accounts.get(tx.to_addr) || {}).nickname,
  }));
}

async function updateTxMemo(txId, memo) {
  if (!txId || !memo) return { success: true };
  const tx = transactions.find(t => t.id === txId);
  if (tx) tx.memo = String(memo).slice(0, 100);
  return { success: true };
}

// --- 通貨情報 ---

async function getCoinInfo() {
  const all = Array.from(accounts.values());
  const totalBalance = all.reduce((sum, acc) => sum + acc.balance, 0);
  return {
    circulating: totalBalance,
    circulatingDisplay: (totalBalance / INTERNAL_MULTIPLIER).toLocaleString(),
    totalAccounts: all.length,
  };
}

async function initAdminAccount() {
  return { success: false, error: 'not implemented in fake db' };
}

// --- ワンタイムURL ---

async function createOnetimeLink(fromAddr, amountInternal, nonce, signature, memo) {
  const id = newId();
  onetimeLinks.set(id, {
    id, sender_address: fromAddr, amount: amountInternal,
    nonce, signature, memo: memo || null, status: 'active',
  });
  return { success: true, linkId: id };
}

async function claimOnetimeLink(linkId, receiverAddr) {
  const link = onetimeLinks.get(linkId);
  if (!link || link.status !== 'active') {
    return { success: false, error: 'リンクは無効、または既に使用されています。' };
  }
  link.status = 'used';
  return {
    success: true,
    link: {
      sender_address: link.sender_address,
      amount: link.amount,
      nonce: link.nonce,
      signature: link.signature,
      memo: link.memo,
    },
  };
}

// --- ニックネーム ---

async function setNickname(owner, target, nickname) {
  nicknames.set(`${owner}|${target}`, nickname);
  return { success: true };
}

async function getNicknames(owner) {
  const out = [];
  for (const [key, value] of nicknames.entries()) {
    const [o, t] = key.split('|');
    if (o === owner) out.push({ target_address: t, nickname: value });
  }
  return out;
}

// --- 送金リクエスト ---

async function createPaymentRequest(requester, target, amountInternal) {
  const id = newId();
  paymentRequests.set(id, {
    id,
    requester_address: requester,
    target_address: target,
    amount: amountInternal,
    status: 'pending',
    paid_tx_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { success: true };
}

async function getPaymentRequests(address) {
  return Array.from(paymentRequests.values())
    .filter(r => r.target_address === address && (r.status === 'pending' || r.status === 'paid'))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

async function getPaymentRequestById(requestId) {
  return paymentRequests.get(requestId) || null;
}

async function markRequestPaid(requestId, txId) {
  const req = paymentRequests.get(requestId);
  if (!req || req.status !== 'pending') return { success: false };
  req.status = 'paid';
  req.paid_tx_id = txId || null;
  req.updated_at = new Date().toISOString();
  return { success: true };
}

async function discardPaymentRequest(requestId, targetAddress) {
  const req = paymentRequests.get(requestId);
  if (!req || req.target_address !== targetAddress) return { success: false };
  req.status = 'discarded';
  return { success: true };
}

async function getSentRequests(requester) {
  return Array.from(paymentRequests.values())
    .filter(r => r.requester_address === requester)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

async function reconcileSentRequests(requester) {
  const pending = Array.from(paymentRequests.values())
    .filter(r => r.requester_address === requester && r.status === 'pending');
  let updated = 0;
  for (const req of pending) {
    const match = transactions
      .filter(tx =>
        tx.to_addr === requester &&
        tx.from_addr === req.target_address &&
        (!req.amount || tx.amount >= req.amount))
      .slice(-1)[0];
    if (match && match.id) {
      const res = await markRequestPaid(req.id, match.id);
      if (res.success) updated += 1;
    }
  }
  return { success: true, updated };
}

// --- 割り勘 ---

async function createSplitBill(creator, title, mode, totalInternal, shareInternal, participantCount) {
  const id = newId();
  splitBills.set(id, {
    id,
    creator_address: creator,
    title,
    total_amount: totalInternal,
    mode,
    share_amount: shareInternal,
    participant_count: participantCount,
    status: 'open',
    created_at: new Date().toISOString(),
    completed_at: null,
  });
  return { success: true, id };
}

async function getSplitBill(billId) {
  const bill = splitBills.get(billId);
  if (!bill) return null;
  return {
    bill: { ...bill },
    payments: splitPayments
      .filter(p => p.bill_id === billId && p.status === 'paid')
      .map(p => ({ payer_address: p.payer_address, amount: p.amount, status: p.status })),
  };
}

async function reserveSplitPayment(billId, payer, amountInternal) {
  const exists = splitPayments.find(p => p.bill_id === billId && p.payer_address === payer);
  if (exists) return { success: true, reserved: false };
  splitPayments.push({
    bill_id: billId, payer_address: payer, amount: amountInternal,
    status: 'pending', tx_id: null,
  });
  return { success: true, reserved: true };
}

async function confirmSplitPayment(billId, payer, txId) {
  const row = splitPayments.find(p => p.bill_id === billId && p.payer_address === payer && p.status === 'pending');
  if (row) {
    row.status = 'paid';
    row.tx_id = txId;
  }
  return { success: true };
}

async function releaseSplitPayment(billId, payer) {
  const idx = splitPayments.findIndex(p => p.bill_id === billId && p.payer_address === payer && p.status === 'pending');
  if (idx >= 0) splitPayments.splice(idx, 1);
  return { success: true };
}

async function markSplitBillCompletedIfDone(billId) {
  const bill = splitBills.get(billId);
  if (!bill) return { completed: false };
  const paidCount = splitPayments.filter(p => p.bill_id === billId && p.status === 'paid').length;
  if (bill.status === 'open' && paidCount >= bill.participant_count) {
    bill.status = 'completed';
    bill.completed_at = new Date().toISOString();
    return { completed: true };
  }
  return { completed: bill.status === 'completed' };
}

function _reset() {
  accounts.clear();
  transactions.length = 0;
  onetimeLinks.clear();
  nicknames.clear();
  paymentRequests.clear();
  splitBills.clear();
  splitPayments.length = 0;
}

module.exports = {
  COIN_NAME,
  COIN_SYMBOL,
  TOTAL_SUPPLY,
  DECIMALS,
  INTERNAL_MULTIPLIER,
  REGISTRATION_BONUS,
  registerAccount,
  getAccount,
  getAccountByPublicKey,
  processTransfer,
  getTransactions,
  updateTxMemo,
  getCoinInfo,
  initAdminAccount,
  createOnetimeLink,
  claimOnetimeLink,
  setNickname,
  getNicknames,
  createPaymentRequest,
  getPaymentRequests,
  getPaymentRequestById,
  markRequestPaid,
  discardPaymentRequest,
  getSentRequests,
  reconcileSentRequests,
  createSplitBill,
  getSplitBill,
  reserveSplitPayment,
  confirmSplitPayment,
  releaseSplitPayment,
  markSplitBillCompletedIfDone,
  _reset,
};