const express = require('express');
const Database = require('better-sqlite3');
const https = require('https');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

// ── Database setup ─────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || 'inventory.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    set_name TEXT NOT NULL DEFAULT 'Unknown',
    card_number TEXT DEFAULT '',
    condition TEXT DEFAULT 'NM',
    grade TEXT DEFAULT '',
    quantity INTEGER DEFAULT 1,
    market_price REAL DEFAULT 0,
    purchase_price REAL DEFAULT 0,
    price_updated TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed sample data if empty
const count = db.prepare('SELECT COUNT(*) as c FROM inventory').get();
if (count.c === 0) {
  const insert = db.prepare(`
    INSERT INTO inventory (name, set_name, card_number, condition, grade, quantity, market_price, purchase_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  [
    ['Charizard', 'Base Set', '4/102', 'Graded', 'PSA 9', 1, 450, 220],
    ['Pikachu VMAX', 'Vivid Voltage', '44/185', 'NM', '', 3, 18.50, 12],
    ['Umbreon VMAX', 'Evolving Skies', '215/203', 'NM', '', 2, 85, 60],
    ['Mew ex', '151', '151/165', 'LP', '', 5, 22, 15],
    ['Blastoise', 'Base Set', '2/102', 'MP', '', 1, 55, 40],
    ['Rayquaza VSTAR', 'Pokémon GO', '111/078', 'Graded', 'BGS 9.5', 1, 320, 180],
  ].forEach(r => insert.run(...r));
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Inventory API ──────────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  const rows = db.prepare('SELECT * FROM inventory ORDER BY created_at ASC').all();
  res.json(rows.map(toCard));
});

app.post('/api/inventory', (req, res) => {
  const c = req.body;
  const stmt = db.prepare(`
    INSERT INTO inventory (name, set_name, card_number, condition, grade, quantity, market_price, purchase_price)
    VALUES (@name, @set_name, @card_number, @condition, @grade, @quantity, @market_price, @purchase_price)
  `);
  const result = stmt.run({
    name: c.name,
    set_name: c.set || 'Unknown',
    card_number: c.num || '',
    condition: c.cond || 'NM',
    grade: c.grade || '',
    quantity: c.qty || 1,
    market_price: c.price || 0,
    purchase_price: c.cost || 0,
  });
  const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(result.lastInsertRowid);
  res.json(toCard(row));
});

app.put('/api/inventory/:id', (req, res) => {
  const c = req.body;
  db.prepare(`
    UPDATE inventory SET
      name = @name, set_name = @set_name, card_number = @card_number,
      condition = @condition, grade = @grade, quantity = @quantity,
      market_price = @market_price, purchase_price = @purchase_price,
      price_updated = @price_updated
    WHERE id = @id
  `).run({
    id: req.params.id,
    name: c.name,
    set_name: c.set || 'Unknown',
    card_number: c.num || '',
    condition: c.cond || 'NM',
    grade: c.grade || '',
    quantity: c.qty || 1,
    market_price: c.price || 0,
    purchase_price: c.cost || 0,
    price_updated: c.priceUpdated || null,
  });
  const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  res.json(toCard(row));
});

app.delete('/api/inventory/:id', (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Bulk import
app.post('/api/inventory/import', (req, res) => {
  const { cards, mode } = req.body;
  if (!cards || !Array.isArray(cards)) return res.status(400).json({ error: 'Invalid data' });

  if (mode === 'replace') {
    db.prepare('DELETE FROM inventory').run();
  }

  const insert = db.prepare(`
    INSERT INTO inventory (name, set_name, card_number, condition, grade, quantity, market_price, purchase_price)
    VALUES (@name, @set_name, @card_number, @condition, @grade, @quantity, @market_price, @purchase_price)
  `);
  const update = db.prepare(`
    UPDATE inventory SET
      card_number=@card_number, condition=@condition, grade=@grade,
      quantity=@quantity, market_price=@market_price, purchase_price=@purchase_price
    WHERE lower(name)=lower(@name) AND lower(set_name)=lower(@set_name)
  `);
  const find = db.prepare('SELECT id FROM inventory WHERE lower(name)=lower(@name) AND lower(set_name)=lower(@set_name)');

  const importMany = db.transaction((cards) => {
    let added = 0, updated = 0;
    for (const c of cards) {
      const row = { name: c.name, set_name: c.set || 'Unknown', card_number: c.num || '', condition: c.cond || 'NM', grade: c.grade || '', quantity: c.qty || 1, market_price: c.price || 0, purchase_price: c.cost || 0 };
      if (mode === 'merge') {
        const existing = find.get({ name: c.name, set_name: c.set || 'Unknown' });
        if (existing) { update.run(row); updated++; }
        else { insert.run(row); added++; }
      } else {
        insert.run(row); added++;
      }
    }
    return { added, updated };
  });

  const result = importMany(cards);
  res.json({ ok: true, ...result });
});

// Update just price
app.patch('/api/inventory/:id/price', (req, res) => {
  const { price, priceUpdated } = req.body;
  db.prepare('UPDATE inventory SET market_price=?, price_updated=? WHERE id=?')
    .run(price, priceUpdated, req.params.id);
  res.json({ ok: true });
});

// ── Anthropic proxy ────────────────────────────────────────────────
app.post('/api/ai', (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });

  const body = JSON.stringify(req.body);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
  };

  const proxy = https.request(options, (r) => {
    res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
    r.pipe(res);
  });
  proxy.on('error', (e) => res.status(500).json({ error: e.message }));
  proxy.write(body);
  proxy.end();
});

// ── Helpers ────────────────────────────────────────────────────────
function toCard(row) {
  return {
    id: row.id,
    name: row.name,
    set: row.set_name,
    num: row.card_number,
    cond: row.condition,
    grade: row.grade,
    qty: row.quantity,
    price: row.market_price,
    cost: row.purchase_price,
    priceUpdated: row.price_updated,
  };
}

app.listen(PORT, () => {
  console.log(`✓ TCG Tracker running on port ${PORT}`);
  if (!API_KEY) console.warn('⚠ ANTHROPIC_API_KEY not set — price fetching will not work');
});
