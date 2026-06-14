require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

let db;
async function connectDB() {
  if (db) return db;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('dgr');
  console.log('[MongoDB] Connected to dgr-contacts');
  return db;
}

// Fail-safe: se CONTACTS_API_KEY não estiver definida, bloqueia tudo.
// Sem CONTACTS_API_ENFORCE=true: regista chamadas não autorizadas mas serve (observação 48h).
// Com CONTACTS_API_ENFORCE=true: regista + 403 (modo bloqueio definitivo).
function requireApiKey(req, res, next) {
  const envKey = process.env.CONTACTS_API_KEY;
  if (!envKey) return res.status(403).json({ error: 'forbidden' });

  if (req.headers['x-api-key'] === envKey) return next();

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const enforce = process.env.CONTACTS_API_ENFORCE === 'true';
  console.warn(
    `[CONTACTS-NOAUTH] ${new Date().toISOString()} | ${req.method} ${req.path} | IP: ${ip} | key_present: ${!!req.headers['x-api-key']} | enforce: ${enforce}`
  );

  if (enforce) return res.status(403).json({ error: 'forbidden' });
  next();
}

app.get('/', requireApiKey, async (req, res) => {
  try {
    const database = await connectDB();
    const total = await database.collection('contacts').countDocuments();
    res.json({ service: 'DGR Contacts API', status: 'running', total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contacts/stats', requireApiKey, async (req, res) => {
  try {
    const database = await connectDB();
    const stats = await database.collection('contacts').aggregate([
      { $match: { is_spam: { $ne: true } } },
      { $group: { _id: { country: '$country', flag: '$country_flag', code: '$country_code' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    const total = await database.collection('contacts').countDocuments({ is_spam: { $ne: true } });
    res.json({ stats, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contacts', requireApiKey, async (req, res) => {
  try {
    const database = await connectDB();
    const filter = { is_spam: { $ne: true } };
    if (req.query.country) filter.country = req.query.country;
    if (req.query.instance) filter.instance = req.query.instance;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;
    const contacts = await database.collection('contacts').find(filter).skip(skip).limit(limit).toArray();
    const total = await database.collection('contacts').countDocuments(filter);
    res.json({ contacts, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contacts/bulk', requireApiKey, async (req, res) => {
  try {
    const database = await connectDB();
    const { contacts } = req.body;
    if (!contacts || !Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });
    const ops = contacts.map(c => ({
      updateOne: { filter: { phone: c.phone }, update: { $set: c }, upsert: true }
    }));
    const result = await database.collection('contacts').bulkWrite(ops);
    const total = await database.collection('contacts').countDocuments();
    res.json({ saved: result.upsertedCount + result.modifiedCount, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/contacts/:phone', requireApiKey, async (req, res) => {
  try {
    const database = await connectDB();
    await database.collection('contacts').updateOne({ phone: req.params.phone }, { $set: req.body });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/contacts', async (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || req.headers['x-admin-key'] !== adminKey) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const database = await connectDB();
    const result = await database.collection('contacts').deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await connectDB().catch(e => console.error('[MongoDB] Failed:', e.message));
  console.log(`DGR Contacts API running on port ${PORT}`);
});
