const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const JUSTTCG_KEY = process.env.JUSTTCG_API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || 'inventory.json';

// ── JSON database ──────────────────────────────────────────────────
function loadData() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { console.error('Load error:', e.message); }
  return { inventory: [], nextId: 1 };
}
function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Save error:', e.message); }
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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Inventory routes ───────────────────────────────────────────────
app.get('/api/inventory', (req, res) => { store = loadData(); res.json(store.inventory); });

app.post('/api/inventory', (req, res) => {
  store = loadData();
  const c = req.body;
  const card = { id: store.nextId++, name: c.name, set: c.set||'Unknown', num: c.num||'', cond: c.cond||'NM', grade: c.grade||'', qty: c.qty||1, price: c.price||0, cost: c.cost||0, priceUpdated: null };
  store.inventory.push(card); saveData(store); res.json(card);
});

app.put('/api/inventory/:id', (req, res) => {
  store = loadData();
  const id = parseInt(req.params.id);
  const idx = store.inventory.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const c = req.body;
  store.inventory[idx] = { id, name: c.name, set: c.set||'Unknown', num: c.num||'', cond: c.cond||'NM', grade: c.grade||'', qty: c.qty||1, price: c.price||0, cost: c.cost||0, priceUpdated: c.priceUpdated||null };
  saveData(store); res.json(store.inventory[idx]);
});

app.delete('/api/inventory/:id', (req, res) => {
  store = loadData();
  store.inventory = store.inventory.filter(c => c.id !== parseInt(req.params.id));
  saveData(store); res.json({ ok: true });
});

app.patch('/api/inventory/:id/price', (req, res) => {
  store = loadData();
  const idx = store.inventory.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.inventory[idx].price = req.body.price;
  store.inventory[idx].priceUpdated = req.body.priceUpdated;
  saveData(store); res.json({ ok: true });
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
  saveData(store); res.json({ ok: true, added, updated });
});

// ── JustTCG helpers ────────────────────────────────────────────────
function justTCGGet(queryString) {
  return new Promise((resolve, reject) => {
    if (!JUSTTCG_KEY) return reject(new Error('JUSTTCG_API_KEY not set on server'));
    const options = {
      hostname: 'api.justtcg.com',
      path: `/v1/cards?${queryString}`,
      method: 'GET',
      headers: { 'x-api-key': JUSTTCG_KEY, 'Accept': 'application/json' }
    };
    const req = https.request(options, r => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Bad JSON from JustTCG: ' + data.slice(0,120))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function justTCGGetSets(game) {
  return new Promise((resolve, reject) => {
    if (!JUSTTCG_KEY) return reject(new Error('JUSTTCG_API_KEY not set'));
    const options = {
      hostname: 'api.justtcg.com',
      path: `/v1/sets?game=${encodeURIComponent(game)}&limit=200`,
      method: 'GET',
      headers: { 'x-api-key': JUSTTCG_KEY, 'Accept': 'application/json' }
    };
    const req = https.request(options, r => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Convert a human set name like "Vivid Voltage" to JustTCG set ID
// JustTCG IDs look like: "vivid-voltage-pokemon"
function setNameToId(name) {
  return name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-') + '-pokemon';
}

// ── Price search endpoint — search by name + game ──────────────────
// Used by the add card modal search box
app.get('/api/price/search', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const qs = `game=pokemon&name=${encodeURIComponent(name)}&limit=10`;
    const result = await justTCGGet(qs);
    if (result.status !== 200) return res.status(result.status).json(result.body);
    res.json(result.body);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Price lookup endpoint — search by name + set ───────────────────
// Used by the ⟳ price refresh button
app.get('/api/price/lookup', async (req, res) => {
  const { name, set, num } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    // Strategy 1: search by game + name, filter by set client-side
    const nameQs = `game=pokemon&name=${encodeURIComponent(name)}&limit=20`;
    const nameResult = await justTCGGet(nameQs);

    if (nameResult.status === 200 && nameResult.body.data?.length) {
      const cards = nameResult.body.data;

      // Try to narrow down by set name match
      let matches = cards;
      if (set) {
        const setLower = set.toLowerCase();
        const setFiltered = cards.filter(c =>
          c.set_name?.toLowerCase().includes(setLower) ||
          setLower.includes(c.set_name?.toLowerCase()) ||
          c.set?.toLowerCase().includes(setLower.replace(/\s+/g,'-')) ||
          setLower.replace(/\s+/g,'-').includes(c.set?.toLowerCase())
        );
        if (setFiltered.length) matches = setFiltered;
      }

      // Further narrow by card number if available
      if (num && matches.length > 1) {
        const numFiltered = matches.filter(c => c.number === num || c.number === num.split('/')[0]);
        if (numFiltered.length) matches = numFiltered;
      }

      if (matches.length === 1) return res.json({ found: true, single: true, data: matches });
      if (matches.length > 1) return res.json({ found: true, single: false, data: matches });
    }

    // Strategy 2: try fetching by set ID directly
    if (set) {
      const setId = setNameToId(set);
      const setQs = `game=pokemon&set=${encodeURIComponent(setId)}&name=${encodeURIComponent(name)}&limit=10`;
      const setResult = await justTCGGet(setQs);
      if (setResult.status === 200 && setResult.body.data?.length) {
        const cards = setResult.body.data;
        return res.json({ found: true, single: cards.length === 1, data: cards });
      }
    }

    res.json({ found: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Sets list — so frontend can show set suggestions ───────────────
app.get('/api/sets', async (req, res) => {
  try {
    const result = await justTCGGetSets('pokemon');
    res.status(result.status).json(result.body);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`✓ TCG Tracker running on port ${PORT}`);
  if (!JUSTTCG_KEY) console.warn('⚠  JUSTTCG_API_KEY not set — price fetching disabled');
});
