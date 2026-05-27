const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || 'inventory.json';

// ── Simple JSON file database (no compilation needed) ──────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return { inventory: [], nextId: 1 };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving data:', e.message);
  }
}

// Seed sample data if empty
let store = loadData();
if (store.inventory.length === 0) {
  store.inventory = [
    { id:1, name:'Charizard', set:'Base Set', num:'4/102', cond:'Graded', grade:'PSA 9', qty:1, price:450, cost:220, priceUpdated:null },
    { id:2, name:'Pikachu VMAX', set:'Vivid Voltage', num:'44/185', cond:'NM', grade:'', qty:3, price:18.50, cost:12, priceUpdated:null },
    { id:3, name:'Umbreon VMAX', set:'Evolving Skies', num:'215/203', cond:'NM', grade:'', qty:2, price:85, cost:60, priceUpdated:null },
    { id:4, name:'Mew ex', set:'151', num:'151/165', cond:'LP', grade:'', qty:5, price:22, cost:15, priceUpdated:null },
    { id:5, name:'Blastoise', set:'Base Set', num:'2/102', cond:'MP', grade:'', qty:1, price:55, cost:40, priceUpdated:null },
    { id:6, name:'Rayquaza VSTAR', set:'Pokémon GO', num:'111/078', cond:'Graded', grade:'BGS 9.5', qty:1, price:320, cost:180, priceUpdated:null },
  ];
  store.nextId = 7;
  saveData(store);
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Inventory API ──────────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  store = loadData();
  res.json(store.inventory);
});

app.post('/api/inventory', (req, res) => {
  store = loadData();
  const c = req.body;
  const card = {
    id: store.nextId++,
    name: c.name,
    set: c.set || 'Unknown',
    num: c.num || '',
    cond: c.cond || 'NM',
    grade: c.grade || '',
    qty: c.qty || 1,
    price: c.price || 0,
    cost: c.cost || 0,
    priceUpdated: null,
  };
  store.inventory.push(card);
  saveData(store);
  res.json(card);
});

app.put('/api/inventory/:id', (req, res) => {
  store = loadData();
  const id = parseInt(req.params.id);
  const idx = store.inventory.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const c = req.body;
  store.inventory[idx] = {
    id,
    name: c.name,
    set: c.set || 'Unknown',
    num: c.num || '',
    cond: c.cond || 'NM',
    grade: c.grade || '',
    qty: c.qty || 1,
    price: c.price || 0,
    cost: c.cost || 0,
    priceUpdated: c.priceUpdated || null,
  };
  saveData(store);
  res.json(store.inventory[idx]);
});

app.delete('/api/inventory/:id', (req, res) => {
  store = loadData();
  const id = parseInt(req.params.id);
  store.inventory = store.inventory.filter(c => c.id !== id);
  saveData(store);
  res.json({ ok: true });
});

app.patch('/api/inventory/:id/price', (req, res) => {
  store = loadData();
  const id = parseInt(req.params.id);
  const idx = store.inventory.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.inventory[idx].price = req.body.price;
  store.inventory[idx].priceUpdated = req.body.priceUpdated;
  saveData(store);
  res.json({ ok: true });
});

app.post('/api/inventory/import', (req, res) => {
  store = loadData();
  const { cards, mode } = req.body;
  if (!cards || !Array.isArray(cards)) return res.status(400).json({ error: 'Invalid data' });

  if (mode === 'replace') store.inventory = [];

  let added = 0, updated = 0;
  for (const c of cards) {
    const card = {
      name: c.name, set: c.set || 'Unknown', num: c.num || '',
      cond: c.cond || 'NM', grade: c.grade || '',
      qty: c.qty || 1, price: c.price || 0, cost: c.cost || 0, priceUpdated: null,
    };
    if (mode === 'merge') {
      const idx = store.inventory.findIndex(x => x.name.toLowerCase() === c.name.toLowerCase() && x.set.toLowerCase() === (c.set||'').toLowerCase());
      if (idx > -1) { store.inventory[idx] = { ...store.inventory[idx], ...card }; updated++; }
      else { store.inventory.push({ id: store.nextId++, ...card }); added++; }
    } else {
      store.inventory.push({ id: store.nextId++, ...card }); added++;
    }
  }
  saveData(store);
  res.json({ ok: true, added, updated });
});

// ── Anthropic proxy ────────────────────────────────────────────────
app.post('/api/ai', (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on server' });

  const payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    
    messages: req.body.messages,
  };

  const body = JSON.stringify(payload);
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
  };

  const proxy = https.request(options, (r) => {
    let data = '';
    r.on('data', chunk => data += chunk);
    r.on('end', () => {
      res.writeHead(r.statusCode, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });
  proxy.on('error', (e) => res.status(500).json({ error: e.message }));
  proxy.write(body);
  proxy.end();
});

app.listen(PORT, () => {
  console.log(`✓ TCG Tracker running on port ${PORT}`);
  if (!API_KEY) console.warn('⚠  ANTHROPIC_API_KEY not set — price fetching disabled');
});
