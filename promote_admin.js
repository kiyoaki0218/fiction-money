const Database = require('better-sqlite3');
const db = new Database('kurekure.db');

const targetAddress = 'd7041bd1a59fb43b1bbbb3866d654f94c23f34dc';
const amountInternal = 900000000 * 100000; // 9億 KC ( decimals 5 )

try {
  const account = db.prepare('SELECT address FROM accounts WHERE address = ?').get(targetAddress);
  if (!account) {
    console.error(`エラー: アドレス ${targetAddress} が登録されていません。ブラウザでウォレットを作成してから実行してください。`);
    process.exit(1);
  }

  const runUpdates = db.transaction(() => {
    // 1. 既存の管理者（大量保有者）を削除（または残高0に）
    db.prepare('DELETE FROM accounts WHERE balance > 100000000 AND address != ?').run(targetAddress);
    
    // 2. 既存の Genesis トランザクションを削除
    db.prepare("DELETE FROM transactions WHERE type = 'genesis'").run();

    // 3. 対象アドレスを残高更新
    db.prepare('UPDATE accounts SET balance = ? WHERE address = ?').run(amountInternal, targetAddress);

    // 4. 新しい Genesis 履歴を作成
    const txId = require('crypto').createHash('sha256').update(`GENESIS:${targetAddress}:${Date.now()}`).digest('hex').slice(0, 16);
    db.prepare(`
      INSERT INTO transactions (id, type, from_addr, to_addr, amount, nonce, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(txId, 'genesis', 'GENESIS', targetAddress, amountInternal, 0, '管理者への初期配布');
  });

  runUpdates();
  console.log(`成功: ${targetAddress} を管理者に設定し、900,000,000 KC を付与しました。`);

} catch (e) {
  console.error('エラーが発生しました:', e.message);
} finally {
  db.close();
}
