-- Phase 2+3 用マイグレーション（Supabase SQL Editor で実行する）
--
-- 変更点:
--   1. transactions.memo / onetime_links.memo ... メモ付き送金
--   2. payment_requests.paid_tx_id / updated_at ... リクエストの自動消込
--   3. split_bills / split_bill_payments ... 割り勘（グループ集金）リンク
--
-- 重要:
--   * 既存 RPC (register_account / process_transfer / claim_onetime_link) は変更しない。
--   * この SQL を適用してから本番コードをデプロイすること（memo 列がないと
--     メモ付き送金・ワンタイムリンク作成が失敗する）。

-- 1. メモ列
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS memo varchar(100);
ALTER TABLE public.onetime_links ADD COLUMN IF NOT EXISTS memo varchar(100);

-- 2. リクエスト自動消込用の列
--    txId は sha256 の先頭16hex 文字列なので uuid ではなく varchar にする。
ALTER TABLE public.payment_requests ADD COLUMN IF NOT EXISTS paid_tx_id varchar;
ALTER TABLE public.payment_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 3. 割り勘（グループ集金）
CREATE TABLE IF NOT EXISTS public.split_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_address varchar NOT NULL,
  title varchar NOT NULL,
  total_amount bigint NOT NULL,             -- 内部単位(10^5)。進捗の分母
  mode varchar NOT NULL,                    -- 'equal'（合計÷人数） | 'fixed'（1人あたり固定）
  share_amount bigint NOT NULL,             -- 1人あたり（equal はサーバが floor 計算）
  participant_count int NOT NULL,
  status varchar NOT NULL DEFAULT 'open',   -- 'open' | 'completed' | 'cancelled'
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.split_bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES public.split_bills(id) ON DELETE CASCADE,
  payer_address varchar NOT NULL,
  amount bigint NOT NULL,
  status varchar NOT NULL DEFAULT 'pending', -- 'pending'（予約） | 'paid' | 'failed'
  tx_id varchar,
  created_at timestamptz DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (bill_id, payer_address)            -- 二重支払い防止（予約段階で排他）
);

CREATE INDEX IF NOT EXISTS idx_split_bill_payments_bill
  ON public.split_bill_payments (bill_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_requester
  ON public.payment_requests (requester_address, status);

-- サーバ（service role）以外からの直接アクセスを遮断
ALTER TABLE public.split_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.split_bill_payments ENABLE ROW LEVEL SECURITY;
-- ポリシーは作らない＝service role のみアクセス可（参照は全て /api 経由）
