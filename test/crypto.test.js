// Phase 1: Keystore (PBKDF2+AES-GCM) / Session ロックのユニットテスト
// 実行: npm test  (node --test test/)
const { test, before } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

before(async () => {
  // classic script を Node として読み込み、globalThis.KCCrypto を得る
  await import(pathToFileURL(path.join(__dirname, '..', 'public', 'crypto.js')).href);
});

const K = () => globalThis.KCCrypto;

const SECRET = new Uint8Array(64).map((_, i) => (i * 7) % 256);

test('keystore: 暗号化→復号の往復と保存フォーマット', async () => {
  const ks = await K().Keystore.encrypt('correct-horse-battery', SECRET, 'PUBKEY', 'ADDR1');
  assert.equal(ks.v, 1);
  assert.equal(ks.kdf, 'PBKDF2');
  assert.equal(ks.hash, 'SHA-256');
  assert.equal(ks.cipher, 'AES-GCM');
  assert.equal(ks.iterations, 600000);
  assert.equal(ks.publicKey, 'PUBKEY');
  assert.equal(ks.address, 'ADDR1');
  assert.equal(ks.salt.length > 0, true);
  assert.equal(ks.iv.length > 0, true);
  // 平文が保存物に一切含まれないこと（Base64化しても64B鍵と不一致）
  assert.notEqual(ks.ct, K().toB64(SECRET));

  const out = await K().Keystore.decrypt('correct-horse-battery', ks);
  assert.ok(out);
  assert.deepEqual(Array.from(out), Array.from(SECRET));
});

test('keystore: 誤パスワードでは復号できない', async () => {
  const ks = await K().Keystore.encrypt('pw12345678', SECRET, 'PUBKEY', 'ADDR1');
  assert.equal(await K().Keystore.decrypt('wrong-password', ks), null);
  assert.equal(await K().Keystore.decrypt('', ks), null);
});

test('keystore: 改ざんされた暗号文は拒否される', async () => {
  const ks = await K().Keystore.encrypt('pw12345678', SECRET, 'PUBKEY', 'ADDR1');
  const ct = K().fromB64(ks.ct);
  ct[0] ^= 0xff;
  const tampered = { ...ks, ct: K().toB64(ct) };
  assert.equal(await K().Keystore.decrypt('pw12345678', tampered), null);
});

test('session: ロック中は鍵を取得できず、解除で取得・ロックで破棄される', async () => {
  const S = K().Session;
  const ks = await K().Keystore.encrypt('session-pw-1', SECRET, 'PUBKEY', 'ADDR2');
  K().Keystore.save(ks);

  assert.equal(S.isUnlocked(), false);
  assert.throws(() => S.getSecretKey(), /ロック/);

  const bad = await S.unlock('not-the-password');
  assert.equal(bad.ok, false);
  assert.equal(bad.wrong, true);

  const ok = await S.unlock('session-pw-1');
  assert.equal(ok.ok, true);
  assert.equal(S.isUnlocked(), true);
  const b64 = S.getSecretKey();
  assert.deepEqual(Array.from(K().fromB64(b64)), Array.from(SECRET));

  S.lock();
  assert.equal(S.isUnlocked(), false);
  assert.throws(() => S.getSecretKey(), /ロック/);
});

test('session: 自動ロック設定の保存と読み込み（0=オフ）', async () => {
  const S = K().Session;
  S.setAutolockMinutes(15);
  assert.equal(S.autolockMinutes(), 15);
  S.setAutolockMinutes(0);
  assert.equal(S.autolockMinutes(), 0);
  S.setAutolockMinutes(5);
  assert.equal(S.autolockMinutes(), 5);
});

test('session: 5回失敗でロックアウトし、中は正しいパスワードも拒否（最後に実行）', async () => {
  const S = K().Session;
  const ks = await K().Keystore.encrypt('right-password', SECRET, 'PUBKEY', 'ADDR3');
  K().Keystore.save(ks);

  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await S.unlock('bad-password');
    assert.equal(last.ok, false);
    assert.equal(last.wrong, true);
  }
  // 5回目でロックアウト（30秒）
  assert.ok(last.lockedFor >= 25, `lockout expected >=25s, got ${last.lockedFor}`);

  // ロックアウト中は正しいパスワードでも不可（PBKDF2前に拒否）
  const duringLockout = await S.unlock('right-password');
  assert.equal(duringLockout.ok, false);
  assert.ok(duringLockout.lockedFor > 0);
  assert.equal(S.isUnlocked(), false);
});