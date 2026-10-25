// Phase 2+3 のサーバー API 統合テスト
// - test/helpers/fake-db.js を require.cache 経由で server.js に注入し、
//   Supabase なしで実際のエンドポイント（署名検証・メモ・自動消込・割り勘）を検証する。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const naclUtil = require('tweetnacl-util');

// --- db.js をインメモリ実装に差し替えてから server.js を読み込む ---
const fakePath = require.resolve('./helpers/fake-db.js');
const realDbPath = require.resolve('../db.js');
const fakeModule = new Module(realDbPath);
fakeModule.filename = realDbPath;
fakeModule.loaded = true;
fakeModule.exports = require(fakePath);
require.cache[realDbPath] = fakeModule;

const app = require('../server');

let server;
let base;
const MULT = 100000;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// --- ヘルパー ---

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data, res };
}

function makeUser() {
  const kp = nacl.sign.keyPair();
  const publicKey = naclUtil.encodeBase64(kp.publicKey);
  const address = crypto.createHash('sha256')
    .update(Buffer.from(publicKey, 'base64'))
    .digest('hex')
    .slice(0, 40);
  const sign = (msg) => naclUtil.encodeBase64(
    nacl.sign.detached(naclUtil.decodeUTF8(msg), kp.secretKey)
  );
  return { publicKey, secretKey: kp.secretKey, address, sign };
}

async function register(u) {
  return api('/api/register', {
    method: 'POST',
    body: { publicKey: u.publicKey, inviteCode: process.env.INVITE_CODE || 'kurekure2026' },
  });
}

async function nonceOf(address) {
  const { data } = await api(`/api/balance/${address}`);
  return data.nonce;
}

// 新形式署名での送金（ブラウザ側 app.js と同じ計算）
async function send(from, toAddress, kc, memo = '', requestId = null) {
  const amountInternal = Math.round(kc * MULT);
  const nonce = (await nonceOf(from.address)) + 1;
  const message = `${from.address}:${toAddress}:${amountInternal}:${nonce}:${memo}:${requestId || ''}`;
  const signature = from.sign(message);
  return api('/api/send', {
    method: 'POST',
    body: {
      from: from.address, to: toAddress, amount: kc, nonce, signature,
      publicKey: from.publicKey, memo, requestId: requestId || undefined,
    },
  });
}

async function listTransactions(address) {
  const { data } = await api(`/api/transactions/${address}`);
  return data.transactions;
}

// --- 登録済みユーザー（テスト毎に再利用） ---
const alice = makeUser();
const bob = makeUser();

test('セットアップ: 2アカウント登録', async () => {
  const r1 = await register(alice);
  assert.equal(r1.data.success, true, JSON.stringify(r1.data));
  const r2 = await register(bob);
  assert.equal(r2.data.success, true, JSON.stringify(r2.data));
  assert.equal(r1.data.bonus, 100);
});

test('送金: メモ付き送金が新形式署名で通り、履歴に memo が残る', async () => {
  const r = await send(alice, bob.address, 1.5, 'ランチ代');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.success, true);
  assert.equal(r.data.txId.length, 16);

  const bobTxs = await listTransactions(bob.address);
  const received = bobTxs.find(tx => tx.from_addr === alice.address);
  assert.ok(received, '宛先の履歴に取引が無い');
  assert.equal(received.memo, 'ランチ代');
  assert.equal(received.amount, 150000);

  const aliceTxs = await listTransactions(alice.address);
  assert.equal(aliceTxs[0].memo, 'ランチ代');
});

test('送金: 旧署名形式（float金額のみ）は 403 で拒否される', async () => {
  const nonce = (await nonceOf(alice.address)) + 1;
  const amount = 0.5;
  const oldMessage = `${alice.address}:${bob.address}:${amount}:${nonce}`;
  const signature = alice.sign(oldMessage);
  const r = await api('/api/send', {
    method: 'POST',
    body: {
      from: alice.address, to: bob.address, amount, nonce, signature,
      publicKey: alice.publicKey,
    },
  });
  assert.equal(r.status, 403);
  assert.equal(r.data.success, false);
});

test('送金: 誤った署名（メモ改ざん）も 403', async () => {
  const amountInternal = Math.round(0.25 * MULT);
  const nonce = (await nonceOf(alice.address)) + 1;
  const message = `${alice.address}:${bob.address}:${amountInternal}:${nonce}:別のメモ:`;
  const signature = alice.sign(message);
  const r = await api('/api/send', {
    method: 'POST',
    body: {
      from: alice.address, to: bob.address, amount: 0.25, nonce, signature,
      publicKey: alice.publicKey, memo: '改ざんされたメモ',
    },
  });
  assert.equal(r.status, 403);
});

test('リクエスト: 支払いで自動消込され、双方で paid が確認できる', async () => {
  // 1. bob が alice に 2 KC の支払いを依頼
  const create = await api('/api/requests/create', {
    method: 'POST',
    body: {
      requester: bob.address, target: alice.address, amount: 2,
      signature: bob.sign(`${bob.address}:REQUEST:${alice.address}:2`),
      publicKey: bob.publicKey,
    },
  });
  assert.equal(create.data.success, true);

  const { data: listData } = await api('/api/requests/list', {
    method: 'POST',
    body: {
      target: alice.address,
      signature: alice.sign(`${alice.address}:GET_REQUESTS`),
      publicKey: alice.publicKey,
    },
  });
  const requestId = listData.requests[0].id;
  assert.ok(requestId);
  assert.equal(listData.requests[0].status, 'pending');

  // 2. 金額不足 → 400（送金前に拒否され、残高も動かない）
  const before = await api(`/api/balance/${alice.address}`);
  const under = await send(alice, bob.address, 1.5, '', requestId);
  assert.equal(under.status, 400);
  assert.match(under.data.error, /以上/);
  const mid = await api(`/api/balance/${alice.address}`);
  assert.equal(mid.data.balanceInternal, before.data.balanceInternal, '不足額で送金が実行されてしまった');

  // 3. 別の宛先宛の送金では消込できない → 400
  const wrongTo = await send(alice, alice.address, 2, '', requestId);
  assert.equal(wrongTo.status, 400);

  // 4. 正しい送金 → 自動消込
  const ok = await send(alice, bob.address, 2, 'お礼', requestId);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.requestPaid, true);

  // 5. 支払側（alice）: 対象リクエストが paid 表示に
  const { data: targetList } = await api('/api/requests/list', {
    method: 'POST',
    body: {
      target: alice.address,
      signature: alice.sign(`${alice.address}:GET_REQUESTS`),
      publicKey: alice.publicKey,
    },
  });
  const settled = targetList.requests.find(r => r.id === requestId);
  assert.equal(settled.status, 'paid');
  assert.ok(settled.paid_tx_id, 'paid_tx_id が記録されていない');

  // 6. 請求側（bob）: sent 一覧で paid を確認
  const { data: sentList } = await api('/api/requests/sent', {
    method: 'POST',
    body: {
      owner: bob.address,
      signature: bob.sign(`${bob.address}:GET_REQUESTS_SENT`),
      publicKey: bob.publicKey,
    },
  });
  const sent = sentList.requests.find(r => r.id === requestId);
  assert.equal(sent.status, 'paid');

  // 7. 対応済みリクエストへの再度の支払い → 409（送金は実行されない）
  const before2 = await api(`/api/balance/${alice.address}`);
  const again = await send(alice, bob.address, 2, '', requestId);
  assert.equal(again.status, 409);
  const after2 = await api(`/api/balance/${alice.address}`);
  assert.equal(after2.data.balanceInternal, before2.data.balanceInternal);
});

test('リクエスト: reconcile で取りこぼした支払いを一括消込できる', async () => {
  // bob が alice に 1 KC を依頼（requestId なしで支払われた状況を再現）
  const create = await api('/api/requests/create', {
    method: 'POST',
    body: {
      requester: bob.address, target: alice.address, amount: 1,
      signature: bob.sign(`${bob.address}:REQUEST:${alice.address}:1`),
      publicKey: bob.publicKey,
    },
  });
  assert.equal(create.data.success, true);

  const miss = await send(alice, bob.address, 1, '取りこぼし');
  assert.equal(miss.status, 200);

  const { data: sentBefore } = await api('/api/requests/sent', {
    method: 'POST',
    body: {
      owner: bob.address,
      signature: bob.sign(`${bob.address}:GET_REQUESTS_SENT`),
      publicKey: bob.publicKey,
    },
  });
  const pendingReq = sentBefore.requests.find(r => r.status === 'pending');
  assert.ok(pendingReq, 'pending のリクエストが無い');

  const rec = await api('/api/requests/reconcile', {
    method: 'POST',
    body: {
      owner: bob.address,
      signature: bob.sign(`${bob.address}:RECONCILE_REQUESTS`),
      publicKey: bob.publicKey,
    },
  });
  assert.equal(rec.data.success, true);
  assert.equal(rec.data.updated, 1);

  const { data: sentAfter } = await api('/api/requests/sent', {
    method: 'POST',
    body: {
      owner: bob.address,
      signature: bob.sign(`${bob.address}:GET_REQUESTS_SENT`),
      publicKey: bob.publicKey,
    },
  });
  const reconciled = sentAfter.requests.find(r => r.id === pendingReq.id);
  assert.equal(reconciled.status, 'paid');
});

test('割り勘: 作成 → 支払 → 二重支払拒否 → 全員完了', async () => {
  // 合計 100 KC ÷ 2人 → 1人 50 KC
  const create = await api('/api/split/create', {
    method: 'POST',
    body: {
      creator: alice.address, title: '飲み会代', mode: 'equal',
      totalAmount: 100 * MULT, shareAmount: 0, participantCount: 2,
      signature: alice.sign(`${alice.address}:SPLIT_CREATE:飲み会代:equal:${100 * MULT}:0:2`),
      publicKey: alice.publicKey,
    },
  });
  assert.equal(create.data.success, true, JSON.stringify(create.data));
  assert.equal(create.data.shareDisplay, 50);
  const billId = create.data.id;

  // 参照（リンクを開いた誰でも）
  const view = await api(`/api/split/${billId}?viewer=${alice.address}`);
  assert.equal(view.data.success, true);
  const split = view.data.split;
  assert.equal(split.title, '飲み会代');
  assert.equal(split.paidCount, 0);
  assert.equal(split.shareInternal, 50 * MULT);
  assert.equal(split.viewerPaid, false);
  assert.ok(!split.creatorShort.includes(alice.address), 'フルアドレスが漏れている');

  // alice が支払う（作成者自身の支払い＝自分への送金）
  const aliceBalBefore = await api(`/api/balance/${alice.address}`);
  const nonce1 = (await nonceOf(alice.address)) + 1;
  const pay1 = await api('/api/split/pay', {
    method: 'POST',
    body: {
      payer: alice.address, billId, amount: 50, nonce: nonce1,
      signature: alice.sign(`${alice.address}:SPLIT_PAY:${billId}:${50 * MULT}:${nonce1}`),
      publicKey: alice.publicKey,
    },
  });
  assert.equal(pay1.status, 200, JSON.stringify(pay1.data));
  assert.equal(pay1.data.paidCount, 1);
  assert.equal(pay1.data.status, 'open');

  // 自分への送金なので残高の総額は変わらない（ただし nonce は進む）
  const aliceBalAfter = await api(`/api/balance/${alice.address}`);
  assert.equal(aliceBalAfter.data.balanceInternal, aliceBalBefore.data.balanceInternal);
  assert.ok(aliceBalAfter.data.nonce > aliceBalBefore.data.nonce, 'nonce が進んでいない');

  // 履歴に割り勘メモ
  const aliceTxs = await listTransactions(alice.address);
  assert.equal(aliceTxs[0].memo, '割り勘「飲み会代」');

  // 二重支払 → 409（送金は実行されない）
  const nonce2 = (await nonceOf(alice.address)) + 1;
  const doublePay = await api('/api/split/pay', {
    method: 'POST',
    body: {
      payer: alice.address, billId, amount: 50, nonce: nonce2,
      signature: alice.sign(`${alice.address}:SPLIT_PAY:${billId}:${50 * MULT}:${nonce2}`),
      publicKey: alice.publicKey,
    },
  });
  assert.equal(doublePay.status, 409);

  // 金額不一致 → 400
  const nonceB = (await nonceOf(bob.address)) + 1;
  const wrongAmount = await api('/api/split/pay', {
    method: 'POST',
    body: {
      payer: bob.address, billId, amount: 40, nonce: nonceB,
      signature: bob.sign(`${bob.address}:SPLIT_PAY:${billId}:${40 * MULT}:${nonceB}`),
      publicKey: bob.publicKey,
    },
  });
  assert.equal(wrongAmount.status, 400);

  // bob が支払う → 2/2 で completed
  const bobBalBefore = await api(`/api/balance/${bob.address}`);
  const nonceB2 = (await nonceOf(bob.address)) + 1;
  const pay2 = await api('/api/split/pay', {
    method: 'POST',
    body: {
      payer: bob.address, billId, amount: 50, nonce: nonceB2,
      signature: bob.sign(`${bob.address}:SPLIT_PAY:${billId}:${50 * MULT}:${nonceB2}`),
      publicKey: bob.publicKey,
    },
  });
  assert.equal(pay2.status, 200, JSON.stringify(pay2.data));
  assert.equal(pay2.data.paidCount, 2);
  assert.equal(pay2.data.status, 'completed');

  // 作成者(alice)に 50 KC が届いている
  const alicePaid = await api(`/api/balance/${alice.address}`);
  assert.equal(
    alicePaid.data.balanceInternal,
    aliceBalAfter.data.balanceInternal + 50 * MULT,
    '集金額が作成者に届いていない'
  );
  assert.ok(bobBalBefore.data.balanceInternal >= 50 * MULT);

  // 完了後の支払い → 409
  const nonceB3 = (await nonceOf(bob.address)) + 1;
  const afterDone = await api('/api/split/pay', {
    method: 'POST',
    body: {
      payer: bob.address, billId, amount: 50, nonce: nonceB3,
      signature: bob.sign(`${bob.address}:SPLIT_PAY:${billId}:${50 * MULT}:${nonceB3}`),
      publicKey: bob.publicKey,
    },
  });
  assert.equal(afterDone.status, 409);

  // 参照: viewerPaid 判定
  const viewBob = await api(`/api/split/${billId}?viewer=${bob.address}`);
  assert.equal(viewBob.data.split.viewerPaid, true);
  assert.equal(viewBob.data.split.paidCount, 2);
});

test('割り勘: 固定額モードの作成（人数×1人額）', async () => {
  const shareI = 7.5 * MULT;
  const count = 4;
  const create = await api('/api/split/create', {
    method: 'POST',
    body: {
      creator: alice.address, title: 'BBQ代', mode: 'fixed',
      totalAmount: 0, shareAmount: shareI, participantCount: count,
      signature: alice.sign(`${alice.address}:SPLIT_CREATE:BBQ代:fixed:0:${shareI}:${count}`),
      publicKey: alice.publicKey,
    },
  });
  assert.equal(create.data.success, true, JSON.stringify(create.data));
  assert.equal(create.data.shareDisplay, 7.5);
  assert.equal(create.data.effectiveTotalDisplay, 30);
});

test('ワンタイムリンク: memo 付き作成・受取で履歴に memo が残る', async () => {
  const amount = 3;
  const amountInternal = amount * MULT;
  const nonce = (await nonceOf(alice.address)) + 1;
  const signature = alice.sign(`${alice.address}:ONETIME:${amountInternal}:${nonce}:ギフト`);
  const create = await api('/api/onetime-link/create', {
    method: 'POST',
    body: {
      from: alice.address, amount, nonce, signature,
      publicKey: alice.publicKey, memo: 'ギフト',
    },
  });
  assert.equal(create.data.success, true, JSON.stringify(create.data));

  const receive = await api('/api/onetime-link/receive', {
    method: 'POST',
    body: { linkId: create.data.linkId, receiver: bob.address },
  });
  assert.equal(receive.data.success, true, JSON.stringify(receive.data));
  assert.equal(receive.data.amount, 3);

  const bobTxs = await listTransactions(bob.address);
  const gift = bobTxs.find(tx => tx.amount === amountInternal);
  assert.ok(gift, '受取履歴に取引が無い');
  assert.equal(gift.memo, 'ギフト');
});

test('process-send URL: memo 込み署名でリダイレクトし memo が付く', async () => {
  const amount = 0.5;
  const amountInternal = Math.round(amount * MULT);
  const nonce = (await nonceOf(alice.address)) + 1;
  const memo = 'お買い物代';
  const signature = alice.sign(`${alice.address}:${bob.address}:${amountInternal}:${nonce}:${memo}`);
  const params = new URLSearchParams({
    from: alice.address, to: bob.address, amount: String(amount), nonce: String(nonce),
    sig: signature, pub: alice.publicKey, memo,
  });

  const res = await fetch(`${base}/api/process-send?${params.toString()}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /tx_success=1/);

  const bobTxs = await listTransactions(bob.address);
  const found = bobTxs.find(tx => tx.amount === amountInternal && tx.memo === memo);
  assert.ok(found, 'process-send の送金に memo が付いていない');
});