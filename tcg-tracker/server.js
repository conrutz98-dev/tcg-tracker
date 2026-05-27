const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const JUSTTCG_KEY = process.env.JUSTTCG_API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || 'inventory.json';

// ── Simple JSON file database ──────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) { console.error('Error loading data:', e.message); }
  return { inventory: [], nextId: 1 };
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Error saving data:', e.message); }
}

let store = loadData();
if (store.inventory.length === 0) {
  store.inventory = [
    { id:1, name:'Charizard', set:'Base Set', num:'4/102', cond:'Graded', grade:'PSA 9', qty:1, price:450, cost:220, priceUpdated:null },
    { id:2, name:'Pikachu VMAX', set:'Vivid Voltage', num:'44/185', cond:'NM', grade:'', qty:3, price:18.50, cost:12, priceUpdated:null },
    { id:3, name:'Umbreon VMAX', set:'Evolving Skies', num:'215/203', cond:'NM', grade:'', qty:2, price:85, cost:60, priceUpdated:null },
    { id:4, name:'Mew ex', set:'151', num:'151/165', cond:'LP', grade:'', qty:5, price:22, cost:15, priceUpdated:null },
    { id:5, name:'Blastoise', set:'Base Set', num:'2/102', cond:'MP', grade:'', qty:1, price:55, cost:40, priceUpdated:null },
    { id:6, name:'Rayquaza VSTAR', set:'Pokemon GO', num:'111/078', cond:'Graded', grade:'BGS 9.5', qty:1, price:320, cost:180, priceUpdated:null },
  ];
  store.nextId = 7;
  saveData(store);
}

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Inventory routes ───────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  store = loadData();
  res.json(store.inventory);
});

app.post('/api/inventory', (req, res) => {
  store = loadData();
  const c = req.body;
  const card = { id: store.nextId++, name: c.name, set: c.set||'Unknown', num: c.num||'', cond: c.cond||'NM', grade: c.grade||'', qty: c.qty||1, price: c.price||0, cost: c.cost||0, priceUpdated: null };
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
  store.inventory[idx] = { id, name: c.name, set: c.set||'Unknown', num: c.num||'', cond: c.cond||'NM', grade: c.grade||'', qty: c.qty||1, price: c.price||0, cost: c.cost||0, priceUpdated: c.priceUpdated||null };
  saveData(store);
  res.json(store.inventory[idx]);
});

app.delete('/api/inventory/:id', (req, res) => {
  store = loadData();
  store.inventory = store.inventory.filter(c => c.id !== parseInt(req.params.id));
  saveData(store);
  res.json({ ok: true });
});

app.patch('/api/inventory/:id/price', (req, res) => {
  store = loadData();
  const idx = store.inventory.findIndex(c => c.id === parseInt(req.params.id));
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
    const card = { name: c.name, set: c.set||'Unknown', num: c.num||'', cond: c.cond||'NM', grade: c.grade||'', qty: c.qty||1, price: c.price||0, cost: c.cost||0, priceUpdated: null };
    if (mode === 'merge') {
      const idx = store.inventory.findIndex(x => x.name.toLowerCase()===c.name.toLowerCase() && x.set.toLowerCase()===(c.set||'').toLowerCase());
      if (idx > -1) { store.inventory[idx] = { ...store.inventory[idx], ...card }; updated++; }
      else { store.inventory.push({ id: store.nextId++, ...card }); added++; }
    } else { store.inventory.push({ id: store.nextId++, ...card }); added++; }
  }
  saveData(store);
  res.json({ ok: true, added, updated });
});

// ── JustTCG price lookup proxy ─────────────────────────────────────
// Proxied server-side so the API key is never exposed to the browser
function justTCGRequest(path) {
  return new Promise((resolve, reject) => {
    if (!JUSTTCG_KEY) return reject(new Error('JUSTTCG_API_KEY not set on server'));
    const options = {
      hostname: 'api.justtcg.com',
      path,
      method: 'GET',
      headers: { 'x-api-key': JUSTTCG_KEY, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Invalid JSON from JustTCG')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Search cards by name — frontend calls this to show suggestions
app.get('/api/price/search', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = await justTCGRequest(`/v1/products?game=pokemon&name=${encodeURIComponent(name)}&limit=10`);
    res.status(result.status).json(result.body);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get price for a specific product by ID
app.get('/api/price/product/:id', async (req, res) => {
  try {
    const result = await justTCGRequest(`/v1/products/${req.params.id}/prices`);
    res.status(result.status).json(result.body);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Combined: search by name+set and return best price match
app.get('/api/price/lookup', async (req, res) => {
  const { name, set, num } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Search for the card
    const searchResult = await justTCGRequest(`/v1/products?game=pokemon&name=${encodeURIComponent(name)}&limit=20`);
    if (searchResult.status !== 200) return res.status(searchResult.status).json(searchResult.body);

    const cards = searchResult.body.data || searchResult.body;
    if (!cards || cards.length === 0) return res.json({ found: false });

    // Find best match by set name and card number
    let match = null;
    if (set) {
      match = cards.find(c =>
        c.setName?.toLowerCase().includes(set.toLowerCase()) ||
        set.toLowerCase().includes(c.setName?.toLowerCase())
      );
    }
    if (!match && num) {
      match = cards.find(c => c.number === num || c.cardNumber === num);
    }
    if (!match) match = cards[0];

    // Get prices for that card
    const priceResult = await justTCGRequest(`/v1/products/${match.id}/prices`);
    if (priceResult.status !== 200) return res.json({ found: false });

    const prices = priceResult.body.data || priceResult.body;
    res.json({ found: true, card: match, prices });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✓ TCG Tracker running on port ${PORT}`);
  if (!JUSTTCG_KEY) console.warn('⚠  JUSTTCG_API_KEY not set — price fetching disabled');
});
