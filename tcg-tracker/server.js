const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const JUSTTCG_KEY = process.env.JUSTTCG_API_KEY || '';
const DATA_FILE = process.env.DATA_FILE || 'inventory.json';

// ── JSON file database ─────────────────────────────────────────────
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

// ── JustTCG API proxy ──────────────────────────────────────────────
function justTCG(queryString) {
  return new Promise((resolve, reject) => {
    if (!JUSTTCG_KEY) return reject(new Error('JUSTTCG_API_KEY not set'));
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
        catch(e) { reject(new Error('Invalid JSON from JustTCG: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Search by name — builds a cardId slug from name for lookup
// JustTCG uses cardId slugs like "pokemon-base-set-charizard-4"
// We search by name and return matches so user can pick the right one
app.get('/api/price/search', async (req, res) => {
  const { name, game } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    // Search using name as cardId prefix pattern
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const result = await justTCG(`cardId=${encodeURIComponent('pokemon-' + slug)}&game=Pokemon&limit=10`);
    res.status(result.status).json(result.body);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lookup price for a card — tries to build the cardId slug from name+set+num
app.get('/api/price/lookup', async (req, res) => {
  const { name, set, num, cardId } = req.query;
  if (!name && !cardId) return res.status(400).json({ error: 'name or cardId required' });

  try {
    let queryString;

    if (cardId) {
      // Direct lookup by known cardId
      queryString = `cardId=${encodeURIComponent(cardId)}&condition[]=NM&condition[]=LP&condition[]=MP&condition[]=HP`;
    } else {
      // Build a slug: "pokemon-{set}-{name}-{num}"
      const toSlug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const slug = `pokemon-${toSlug(set)}-${toSlug(name)}${num ? '-' + toSlug(num) : ''}`;
      queryString = `cardId=${encodeURIComponent(slug)}&condition[]=NM&condition[]=LP&condition[]=MP&condition[]=HP`;
    }

    const result = await justTCG(queryString);

    if (result.status !== 200 || !result.body.data?.length) {
      // Try without set in the slug as fallback
      const toSlug = s => (s||'').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const fallbackSlug = `pokemon-${toSlug(name)}`;
      const fallback = await justTCG(`cardId=${encodeURIComponent(fallbackSlug)}&condition[]=NM&condition[]=LP&condition[]=MP&condition[]=HP`);

      if (fallback.status === 200 && fallback.body.data?.length) {
        return res.json({ found: true, data: fallback.body.data });
      }
      return res.json({ found: false });
    }

    res.json({ found: true, data: result.body.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`✓ TCG Tracker running on port ${PORT}`);
  if (!JUSTTCG_KEY) console.warn('⚠  JUSTTCG_API_KEY not set');
});
