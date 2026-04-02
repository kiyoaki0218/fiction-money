-- Phase 3 機能追加用 SQL (送金リクエスト用)

CREATE TABLE public.payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_address varchar NOT NULL,
  target_address varchar NOT NULL,
  amount bigint, -- NULLの場合は相手に金額指定を任せる
  status varchar NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'rejected'
  created_at timestamp with time zone DEFAULT now()
);
