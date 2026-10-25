/* ========================================
   KC — Keystore / Session / BIP-39 モジュール
   秘密鍵は PBKDF2(SHA-256, 600,000回) + AES-GCM-256 で
   暗号化してのみ保存する（平文保存は禁止）。
   ブラウザ（classic script）/ Node（ユニットテスト）両対応。
   ======================================== */
(function () {
  'use strict';

  const KS_STORAGE_KEY = 'kc_keystore';
  const LOCKOUT_KEY = 'kc_lockout';
  const AUTOLOCK_KEY = 'kc_autolock';
  const PBKDF2_ITERATIONS = 600000;
  const MAX_FAILS = 5;           // この回数失敗すると指数バックオフ
  const BACKOFF_BASE_SEC = 30;   // 30s → 60s → ... 上限600s
  const BIP39_CDN = 'https://cdn.jsdelivr.net/npm/@scure/bip39@1.3.0';

  // localStorage が無い環境（Node テスト）ではメモリストレージで代替
  const storage = (typeof localStorage !== 'undefined') ? localStorage : (() => {
    const m = {};
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; },
    };
  })();

  // --- base64 ヘルパー ---
  function toB64(bytes) {
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function fromB64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // --- KDF: PBKDF2(SHA-256) → AES-GCM-256 鍵 ---
  async function deriveKey(password, salt, iterations) {
    const baseKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // --- Keystore: 暗号化保存 ---
  async function encryptKeystore(password, secretKeyBytes, publicKey, address) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secretKeyBytes)
    );
    return {
      v: 1,
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: toB64(salt),
      cipher: 'AES-GCM',
      iv: toB64(iv),
      ct: toB64(ct),
      publicKey,
      address,
    };
  }

  // 復号に成功すれば Uint8Array、パスワード誤り・改ざんなら null
  async function decryptKeystore(password, ks) {
    if (!ks || !ks.salt || !ks.iv || !ks.ct) return null;
    try {
      const key = await deriveKey(password, fromB64(ks.salt), ks.iterations || PBKDF2_ITERATIONS);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(ks.iv) }, key, fromB64(ks.ct)
      );
      return new Uint8Array(pt);
    } catch (e) {
      return null;
    }
  }

  const Keystore = {
    encrypt: encryptKeystore,
    decrypt: decryptKeystore,
    save: (ks) => storage.setItem(KS_STORAGE_KEY, JSON.stringify(ks)),
    load: () => {
      try { return JSON.parse(storage.getItem(KS_STORAGE_KEY)); } catch (e) { return null; }
    },
    has: () => !!storage.getItem(KS_STORAGE_KEY),
    remove: () => storage.removeItem(KS_STORAGE_KEY),
    PBKDF2_ITERATIONS,
  };

  // --- Session: ロック中のメモリ保持・自動ロック・試行バックオフ ---
  const Session = (function () {
    let secretB64 = null;      // ロック解除中のみ保持（平文保存はしない）
    let idleTimer = null;
    let lockHandler = null;
    let unlockHandler = null;

    function autolockMinutes() {
      const v = parseInt(storage.getItem(AUTOLOCK_KEY) || '5', 10);
      return Number.isFinite(v) && v >= 0 ? v : 5; // 0 = オフ
    }

    function scheduleIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      const min = autolockMinutes();
      if (!isUnlocked() || min <= 0) return;
      idleTimer = setTimeout(() => lock(), min * 60 * 1000);
    }

    function isUnlocked() { return secretB64 !== null; }

    function lock() {
      secretB64 = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (lockHandler) lockHandler();
    }

    function lockoutRemainingMs() {
      try {
        const st = JSON.parse(storage.getItem(LOCKOUT_KEY) || 'null');
        if (!st || !st.until) return 0;
        return Math.max(0, st.until - Date.now());
      } catch (e) { return 0; }
    }

    function recordFailure() {
      let st = { fails: 0, until: 0 };
      try { st = JSON.parse(storage.getItem(LOCKOUT_KEY) || 'null') || st; } catch (e) { /* reset */ }
      if (st.until && Date.now() >= st.until) st = { fails: 0, until: 0 }; // 期限切れなら再計算
      st.fails = (st.fails || 0) + 1;
      if (st.fails >= MAX_FAILS) {
        const step = Math.min(st.fails - MAX_FAILS, 5); // 指数の頭打ち
        const backoffSec = Math.min(BACKOFF_BASE_SEC * Math.pow(2, step), 600);
        st.until = Date.now() + backoffSec * 1000;
      }
      storage.setItem(LOCKOUT_KEY, JSON.stringify(st));
      return lockoutRemainingMs();
    }

    async function unlock(password) {
      const remaining = lockoutRemainingMs();
      if (remaining > 0) {
        return { ok: false, lockedFor: Math.ceil(remaining / 1000) };
      }
      const ks = Keystore.load();
      if (!ks) return { ok: false, noKeystore: true };
      const bytes = await decryptKeystore(password, ks);
      if (!bytes) {
        const until = recordFailure();
        return { ok: false, wrong: true, lockedFor: until > 0 ? Math.ceil(until / 1000) : 0 };
      }
      storage.removeItem(LOCKOUT_KEY);
      secretB64 = toB64(bytes);
      scheduleIdle();
      if (unlockHandler) unlockHandler();
      return { ok: true };
    }

    // ロック中は throw（signMessage が唯一の利用経路）
    function getSecretKey() {
      if (!secretB64) throw new Error('ウォレットはロックされています');
      return secretB64;
    }

    // 作成・復元・移行直後など、パスワード確認済みの鍵を直接セッションに载せる
    function setUnlocked(secretKeyBase64) {
      secretB64 = secretKeyBase64;
      storage.removeItem(LOCKOUT_KEY);
      scheduleIdle();
      if (unlockHandler) unlockHandler();
    }

    function touch() {
      if (isUnlocked()) scheduleIdle();
    }

    return {
      unlock,
      setUnlocked,
      lock,
      isUnlocked,
      getSecretKey,
      touch,
      lockoutRemainingMs,
      autolockMinutes,
      setAutolockMinutes: (min) => { storage.setItem(AUTOLOCK_KEY, String(min)); scheduleIdle(); },
      onLock: (fn) => { lockHandler = fn; },
      onUnlock: (fn) => { unlockHandler = fn; },
    };
  })();

  // --- BIP-39 ニーモニック（CDN から遅延ロード）---
  const Mnemonic = (function () {
    let mod = null;
    let wordlist = null;
    let loading = null;

    async function load() {
      if (mod) return;
      if (!loading) {
        loading = (async () => {
          const m = await import(`${BIP39_CDN}/+esm`);
          const wl = await import(`${BIP39_CDN}/wordlists/english.js/+esm`);
          // jsdelivr +esm のエクスポート形状差異を吸収（名前付き/default/二重ラップ）
          const list = Array.isArray(wl.wordlist) ? wl.wordlist
            : (Array.isArray(wl.default) ? wl.default
            : (wl.default && Array.isArray(wl.default.wordlist) ? wl.default.wordlist : null));
          if (!list || list.length !== 2048) {
            throw new Error('BIP-39 単語リストの読み込みに失敗しました');
          }
          mod = m;
          wordlist = list;
        })().catch((e) => { loading = null; throw e; });
      }
      return loading;
    }

    function normalize(words) {
      return String(words || '').trim().split(/\s+/).join(' ');
    }

    async function generate(bits = 128) {
      await load();
      return mod.generateMnemonic(wordlist, bits); // 128bit=12語 / 256bit=24語
    }

    async function validate(words) {
      await load();
      try { return mod.validateMnemonic(normalize(words), wordlist); } catch (e) { return false; }
    }

    // ニーモニック → BIP-39 seed(64B) → 先頭32B を Ed25519 シードに使用
    async function toSeed(words) {
      await load();
      const seed = mod.mnemonicToSeedSync(normalize(words));
      return new Uint8Array(seed).slice(0, 32);
    }

    // ユニットテスト用にモジュールを差し替え可能にする
    function _inject(m, wl) { mod = m; wordlist = wl; }

    return { generate, validate, toSeed, normalize, _inject };
  })();

  globalThis.KCCrypto = { Keystore, Session, Mnemonic, toB64, fromB64 };
})();
