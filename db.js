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

async function getTransactions(address, limit = 50) {
  const { data } = await supabase
    .from('transactions')
    .select('*')
    .or(`from_addr.eq.${address},to_addr.eq.${address}`)
    .order('timestamp', { ascending: false })
    .limit(limit);
  return data || [];
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

async function createOnetimeLink(fromAddr, amountInternal, nonce, signature) {
  const { data, error } = await supabase
    .from('onetime_links')
    .insert([{ sender_address: fromAddr, amount: amountInternal, nonce, signature, status: 'active' }])
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
  // 自分に対するリクエストを取得
  const { data, error } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('target_address', address)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return [];
  return data;
}

async function markRequestPaid(requestId) {
  const { error } = await supabase
    .from('payment_requests')
    .update({ status: 'paid' })
    .eq('id', requestId);
  return { success: !error };
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
};
