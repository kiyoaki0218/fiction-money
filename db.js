const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('\n❌ エラー: SUPABASE_URL または SUPABASE_KEY が環境変数に設定されていません。Vercel の Settings > Environment Variables を確認してください。\n');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder');

// --- 通貨設定 ---
const COIN_NAME = 'クレクレコイン';
const COIN_SYMBOL = 'KC';
const TOTAL_SUPPLY = 1_000_000_000;
const DECIMALS = 5;
const INTERNAL_MULTIPLIER = 10 ** DECIMALS;
const TOTAL_SUPPLY_INTERNAL = TOTAL_SUPPLY * INTERNAL_MULTIPLIER;
const ADMIN_RATIO = 0.9;
const REGISTRATION_BONUS = 100;
const REGISTRATION_BONUS_INTERNAL = REGISTRATION_BONUS * INTERNAL_MULTIPLIER;

// --- アカウント操作 ---

async function registerAccount(address, publicKey) {
  let bonus = REGISTRATION_BONUS_INTERNAL;

  // 1. ボーナスプールの枯渇チェック (GENESISの残高を確認)
  const { data: genesisAcc } = await supabase
    .from('accounts')
    .select('balance')
    .eq('address', 'GENESIS')
    .single();

  if (!genesisAcc || genesisAcc.balance < bonus) {
    // 枯渇時はボーナス0としてアカウント登録のみを許可
    bonus = 0;
  }

  // 2. RPCによるアトミックな登録
  const { data, error } = await supabase.rpc('register_account', {
    p_address: address,
    p_public_key: publicKey,
    p_bonus: bonus
  });

  if (error || !data.success) {
    return { success: false, error: (error ? error.message : data.error) || '登録に失敗しました' };
  }

  return {
    success: true,
    address,
    bonus: bonus / INTERNAL_MULTIPLIER,
    bonusInternal: bonus,
  };
}

async function getAccount(address) {
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('address', address)
    .single();
  return data;
}

async function getAccountByPublicKey(publicKey) {
  const { data } = await supabase
    .from('accounts')
    .select('*')
    .eq('public_key', publicKey)
    .single();
  return data;
}

// --- 送金処理 ---

async function processTransfer(fromAddr, toAddr, amountInternal, nonce, signature, txId) {
  // RPCによる送金処理（残高チェック、ナンス更新、取引記録をセットで実行）
  const { data, error } = await supabase.rpc('process_transfer', {
    p_id: txId,
    p_from: fromAddr,
    p_to: toAddr,
    p_amount: amountInternal,
    p_nonce: nonce,
    p_signature: signature
  });

  if (error || !data.success) {
    return { success: false, error: (error ? error.message : data.error) || '送金に失敗しました' };
  }

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
  // 取引履歴を取得
  const { data: txs, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .or(`from_addr.eq.${address},to_addr.eq.${address}`)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (txError || !txs) return [];

  // 関連するすべてのアドレスを抽出
  const addresses = new Set();
  txs.forEach(tx => {
    addresses.add(tx.from_addr);
    addresses.add(tx.to_addr);
  });

  // アカウント情報を一括取得してニックネームをマッピング
  const { data: accounts } = await supabase
    .from('accounts')
    .select('address, nickname')
    .in('address', Array.from(addresses));

  const nameMap = {};
  if (accounts) {
    accounts.forEach(a => {
      nameMap[a.address] = a.nickname;
    });
  }

  // 履歴データにニックネームを付与
  return txs.map(tx => ({
    ...tx,
    from_nickname: tx.from_addr === 'GENESIS' ? 'SYSTEM' : nameMap[tx.from_addr],
    to_nickname: tx.to_addr === 'GENESIS' ? 'SYSTEM' : nameMap[tx.to_addr]
  }));
}

// --- 通貨情報 ---

async function getCoinInfo() {
  const { data: rows } = await supabase.from('coin_info').select('key, value');
  const info = {};
  if (rows) {
    rows.forEach(row => info[row.key] = row.value);
  }

  // 流通量の取得
  const { data: accounts } = await supabase.from('accounts').select('balance');
  const totalBalance = accounts ? accounts.reduce((sum, acc) => sum + Number(acc.balance), 0) : 0;

  info.circulating = totalBalance;
  info.circulatingDisplay = (totalBalance / INTERNAL_MULTIPLIER).toLocaleString();
  info.totalAccounts = accounts ? accounts.length : 0;

  return info;
}

// --- Genesis: 管理者アカウントの初期化 ---

async function initAdminAccount(address, publicKey) {
  const adminBalance = Math.floor(TOTAL_SUPPLY_INTERNAL * ADMIN_RATIO);

  // 管理者作成プロシージャ
  const { data, error } = await supabase.rpc('register_account', {
    p_address: address,
    p_public_key: publicKey,
    p_bonus: adminBalance
  });

  if (error || !data.success) {
    return { success: false, error: (error ? error.message : data.error) || '管理者初期化に失敗しました' };
  }

  return {
    success: true,
    address,
    balance: adminBalance / INTERNAL_MULTIPLIER,
    balanceInternal: adminBalance,
  };
}

// --- ワンタイムURL (Push型) 処理 ---

async function createOnetimeLink(fromAddr, amountInternal, nonce, signature, memo) {
  const { data, error } = await supabase
    .from('onetime_links')
    .insert([{
      sender_address: fromAddr, amount: amountInternal, nonce, signature,
      status: 'active', memo: memo || null
    }])
    .select('id')
    .single();

  if (error || !data) {
    return { success: false, error: error ? error.message : 'リンクの発行に失敗しました' };
  }
  return { success: true, linkId: data.id };
}

async function claimOnetimeLink(linkId, receiverAddr) {
  const { data, error } = await supabase.rpc('claim_onetime_link', {
    p_link_id: linkId,
    p_receiver_address: receiverAddr
  });

  if (error || !data.success) {
    return { success: false, error: (error ? error.message : data.error) || '受取に失敗しました' };
  }

  // RPC の戻り値に含まれない memo を行から取得（best effort）
  const { data: row } = await supabase
    .from('onetime_links')
    .select('memo')
    .eq('id', linkId)
    .single();
  if (row && row.memo) data.memo = row.memo;

  return { success: true, link: data };
}

// --- ニックネーム (DM機能) 処理 ---

async function setNickname(owner, target, nickname) {
  // 制約上、同じ owner と target の組み合わせでupsertする
  const { error } = await supabase
    .from('nicknames')
    .upsert([{ owner_address: owner, target_address: target, nickname }], { onConflict: 'owner_address,target_address' });

  if (error) return { success: false, error: error.message };
  return { success: true };
}

async function getNicknames(owner) {
  const { data, error } = await supabase
    .from('nicknames')
    .select('target_address, nickname')
    .eq('owner_address', owner);

  if (error) return [];
  return data;
}

// --- 送金リクエスト (DM機能) 処理 ---

async function createPaymentRequest(requester, target, amountInternal) {
  const { error } = await supabase
    .from('payment_requests')
    .insert([{ requester_address: requester, target_address: target, amount: amountInternal, status: 'pending' }]);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

async function getPaymentRequests(address) {
  // 自分に対するリクエストを取得（pending＝未対応、paid＝支払い済み＝自動消込済み）
  const { data, error } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('target_address', address)
    .in('status', ['pending', 'paid'])
    .order('created_at', { ascending: false });

  if (error) return [];
  return data;
}

async function getPaymentRequestById(requestId) {
  const { data } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', requestId)
    .single();
  return data || null;
}

async function markRequestPaid(requestId, txId) {
  const { error } = await supabase
    .from('payment_requests')
    .update({ status: 'paid', paid_tx_id: txId || null, updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending');
  return { success: !error };
}

// --- Phase 2: トランザクションへのメモ付与（best effort） ---

async function updateTxMemo(txId, memo) {
  if (!txId || !memo) return { success: true };
  const { error } = await supabase
    .from('transactions')
    .update({ memo: String(memo).slice(0, 100) })
    .eq('id', txId);
  return { success: !error, error: error ? error.message : null };
}

// --- Phase 3: 請求側のリクエスト一覧 / 自動消込 ---

async function getSentRequests(requester) {
  const { data, error } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('requester_address', requester)
    .order('created_at', { ascending: false });

  if (error) return [];
  return data;
}

// 取りこぼし救済: pending のリクエストと、宛先・送信元・金額が一致する
// 直近の受取取引を突き合わせて一括で paid 化する
async function reconcileSentRequests(requester) {
  const pending = await supabase
    .from('payment_requests')
    .select('*')
    .eq('requester_address', requester)
    .eq('status', 'pending');

  if (pending.error || !pending.data) return { success: false, error: pending.error ? pending.error.message : '照合に失敗しました' };

  let updated = 0;
  for (const req of pending.data) {
    const query = supabase
      .from('transactions')
      .select('id')
      .eq('to_addr', requester)
      .eq('from_addr', req.target_address)
      .order('timestamp', { ascending: false })
      .limit(1);
    if (req.amount) query.gte('amount', req.amount);
    const { data: txs } = await query;
    if (txs && txs.length > 0 && txs[0].id) {
      const res = await markRequestPaid(req.id, txs[0].id);
      if (res.success) updated += 1;
    }
  }
  return { success: true, updated };
}

async function discardPaymentRequest(requestId, targetAddress) {
  const { error } = await supabase
    .from('payment_requests')
    .update({ status: 'discarded' })
    .eq('id', requestId)
    .eq('target_address', targetAddress);
  return { success: !error };
}

// --- Phase 3: 割り勘（グループ集金） ---

async function createSplitBill(creator, title, mode, totalInternal, shareInternal, participantCount) {
  const { data, error } = await supabase
    .from('split_bills')
    .insert([{
      creator_address: creator,
      title,
      total_amount: totalInternal,
      mode,
      share_amount: shareInternal,
      participant_count: participantCount,
      status: 'open'
    }])
    .select('id')
    .single();

  if (error || !data) {
    return { success: false, error: error ? error.message : '集金リンクの作成に失敗しました' };
  }
  return { success: true, id: data.id };
}

async function getSplitBill(billId) {
  const { data: bill, error } = await supabase
    .from('split_bills')
    .select('*')
    .eq('id', billId)
    .single();

  if (error || !bill) return null;

  const { data: payments } = await supabase
    .from('split_bill_payments')
    .select('payer_address, amount, status')
    .eq('bill_id', billId)
    .eq('status', 'paid');

  return { bill, payments: payments || [] };
}

// 支払い枠の予約（UNIQUE(bill_id, payer_address) で二重支払いを排他）
async function reserveSplitPayment(billId, payer, amountInternal) {
  const { data, error } = await supabase
    .from('split_bill_payments')
    .upsert(
      [{ bill_id: billId, payer_address: payer, amount: amountInternal, status: 'pending' }],
      { onConflict: 'bill_id,payer_address', ignoreDuplicates: true }
    )
    .select('id');

  if (error) return { success: false, reserved: false, error: error.message };
  // ignoreDuplicates 時、競合すると data は空配列になる
  if (!data || data.length === 0) return { success: true, reserved: false };
  return { success: true, reserved: true };
}

async function confirmSplitPayment(billId, payer, txId) {
  const { error } = await supabase
    .from('split_bill_payments')
    .update({ status: 'paid', tx_id: txId, paid_at: new Date().toISOString() })
    .eq('bill_id', billId)
    .eq('payer_address', payer)
    .eq('status', 'pending');
  return { success: !error };
}

async function releaseSplitPayment(billId, payer) {
  const { error } = await supabase
    .from('split_bill_payments')
    .delete()
    .eq('bill_id', billId)
    .eq('payer_address', payer)
    .eq('status', 'pending');
  return { success: !error };
}

// 支払い人数が参加人数に達したら completed にする
async function markSplitBillCompletedIfDone(billId) {
  const { count } = await supabase
    .from('split_bill_payments')
    .select('id', { count: 'exact', head: true })
    .eq('bill_id', billId)
    .eq('status', 'paid');

  const { data: bill } = await supabase
    .from('split_bills')
    .select('participant_count, status')
    .eq('id', billId)
    .single();

  if (!bill) return { completed: false };
  if (bill.status === 'open' && count !== null && count >= bill.participant_count) {
    await supabase
      .from('split_bills')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', billId)
      .eq('status', 'open');
    return { completed: true };
  }
  return { completed: bill.status === 'completed' };
}

module.exports = {
  COIN_NAME,
  COIN_SYMBOL,
  TOTAL_SUPPLY,
  DECIMALS,
  INTERNAL_MULTIPLIER,
  TOTAL_SUPPLY_INTERNAL,
  REGISTRATION_BONUS,
  registerAccount,
  getAccount,
  getAccountByPublicKey,
  processTransfer,
  getTransactions,
  getCoinInfo,
  initAdminAccount,
  createOnetimeLink,
  claimOnetimeLink,
  setNickname,
  getNicknames,
  createPaymentRequest,
  getPaymentRequests,
  markRequestPaid,
  discardPaymentRequest,
  updateTxMemo,
  getPaymentRequestById,
  getSentRequests,
  reconcileSentRequests,
  createSplitBill,
  getSplitBill,
  reserveSplitPayment,
  confirmSplitPayment,
  releaseSplitPayment,
  markSplitBillCompletedIfDone,
};
