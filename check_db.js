const Database = require('better-sqlite3');
const db = new Database('kurekure.db');

console.log('--- アカウント一覧 ---');
const accounts = db.prepare('SELECT address, balance/100000.0 as balance_kc, nonce FROM accounts').all();
console.table(accounts);

console.log('\n--- トランザクション履歴 (最新5件) ---');
const txs = db.prepare('SELECT type, from_addr, to_addr, amount/100000.0 as amount_kc, timestamp FROM transactions ORDER BY timestamp DESC LIMIT 5').all();
console.table(txs);

db.close();
