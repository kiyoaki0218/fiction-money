-- 新規テーブル1: onetime_links (Push型URL機能用)
CREATE TABLE public.onetime_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_address varchar NOT NULL,
  amount bigint NOT NULL,
  nonce bigint NOT NULL,
  signature varchar NOT NULL,
  status varchar NOT NULL DEFAULT 'active', -- 'active', 'used', 'cancelled'
  created_at timestamp with time zone DEFAULT now(),
  used_at timestamp with time zone
);

-- 先着1名でのアトミックな受取処理用 RPC
CREATE OR REPLACE FUNCTION claim_onetime_link(
    p_link_id uuid,
    p_receiver_address varchar
) RETURNS json AS $$
DECLARE
    v_link record;
    v_tx_id varchar;
BEGIN
    -- 該当リンクを 'active' の状態で行ロックを取得して取得
    SELECT * INTO v_link 
    FROM public.onetime_links 
    WHERE id = p_link_id AND status = 'active' 
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'リンクは無効、または既に使用されています。');
    END IF;

    -- ステータスを 'used' に更新
    UPDATE public.onetime_links 
    SET status = 'used', used_at = now() 
    WHERE id = p_link_id;

    RETURN json_build_object(
        'success', true, 
        'sender_address', v_link.sender_address,
        'amount', v_link.amount,
        'nonce', v_link.nonce,
        'signature', v_link.signature
    );
END;
$$ LANGUAGE plpgsql;


-- 新規テーブル2: nicknames (DM風送受信のニックネーム機能用 - Phase 3)
CREATE TABLE public.nicknames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_address varchar NOT NULL,
  target_address varchar NOT NULL,
  nickname varchar NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE (owner_address, target_address)
);
