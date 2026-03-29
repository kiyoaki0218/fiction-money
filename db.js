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
const REGISTRATION_BONUS = 1000;
const REGISTRATION_BONUS_INTERNAL = REGISTRATION_BONUS * INTERNAL_MULTIPLIER;

// --- アカウント操作 ---

async function registerAccount(address, publicKey) {
  // 1. ボーナスプールのチェック
  const { data: distributedRow } = await supabase
    .from('coin_info')
    .select('value')
    .eq('key', 'distributed')
    .single();
  
  const distributed = distributedRow ? Number(distributedRow.value) : 0;
  const poolSupply = TOTAL_SUPPLY_INTERNAL * (1 - ADMIN_RATIO);
  const remainingPool = poolSupply - distributed;

  const bonus = (remainingPool >= REGISTRATION_BONUS_INTERNAL) ? REGISTRATION_BONUS_INTERNAL : 0;

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
};
