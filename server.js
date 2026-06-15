require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname)));

// ── SCHEMAS ────────────────────────────────────────────────────────────────────

// Stores raw CSV rows grouped by month. One document per month so large datasets
// don't hit the 16 MB document limit in a single shot.
const MonthDataSchema = new mongoose.Schema({
  month:     { type: String, required: true, unique: true },
  rows:      [mongoose.Schema.Types.Mixed],
  updatedAt: { type: Date, default: Date.now }
});

// Generic key→value store for projections and mappings.
const SettingsSchema = new mongoose.Schema({
  _id:       String,
  data:      mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

const MonthData = mongoose.model('MonthData', MonthDataSchema);
const Settings  = mongoose.model('Settings',  SettingsSchema);

// ── DB CONNECTION ──────────────────────────────────────────────────────────────

mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => console.log('✅  Connected to MongoDB Atlas'))
  .catch(err => {
    console.error('❌  MongoDB connection failed:', err.message);
    console.error('    ➜  Check: Atlas Network Access → allow 0.0.0.0/0, and that your cluster is not paused.');
    console.error('    ➜  Server is still running — will keep retrying in the background.');
  });

mongoose.connection.on('connected',    () => console.log('✅  MongoDB reconnected'));
mongoose.connection.on('disconnected', () => console.warn('⚠️   MongoDB disconnected — retrying…'));

// ── ROUTES ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/data
 * Returns everything the dashboard needs on load:
 *   rawRows    – all stored CSV rows (aggregated client-side)
 *   projections – { [month]: { days_elapsed, project_to } }
 *   cityMap    – raw-city → canonical-city mapping (null if never uploaded)
 *   qaMap      – campaign → { sm, qa, cat } mapping (null if never uploaded)
 */
app.get('/api/data', async (req, res) => {
  try {
    const [monthDocs, projDoc, mappingsDoc] = await Promise.all([
      MonthData.find({}).lean(),
      Settings.findById('projections').lean(),
      Settings.findById('mappings').lean()
    ]);

    const rawRows = monthDocs.flatMap(d => d.rows);

    res.json({
      rawRows,
      projections: projDoc?.data   || {},
      cityMap:     mappingsDoc?.data?.cityMap || null,
      qaMap:       mappingsDoc?.data?.qaMap   || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/upload
 * Body: { rows: [...rawRows], projections: { [month]: {...} } }
 * Saves/replaces rows for each uploaded month and merges projections.
 */
app.post('/api/upload', async (req, res) => {
  try {
    const { rows = [], projections = {} } = req.body;

    // Group rows by month
    const byMonth = {};
    rows.forEach(r => {
      if (!byMonth[r.month]) byMonth[r.month] = [];
      byMonth[r.month].push(r);
    });

    // Upsert one document per month
    await Promise.all(
      Object.entries(byMonth).map(([month, monthRows]) =>
        MonthData.findOneAndUpdate(
          { month },
          { month, rows: monthRows, updatedAt: new Date() },
          { upsert: true, new: true }
        )
      )
    );

    // Merge new projections with whatever is already stored
    if (Object.keys(projections).length > 0) {
      const existing = await Settings.findById('projections').lean();
      const merged   = { ...(existing?.data || {}), ...projections };
      await Settings.findByIdAndUpdate(
        'projections',
        { data: merged, updatedAt: new Date() },
        { upsert: true }
      );
    }

    res.json({ ok: true, months: Object.keys(byMonth) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/upload/:month
 * Removes all stored rows for a specific month.
 */
app.delete('/api/upload/:month', async (req, res) => {
  try {
    await MonthData.deleteOne({ month: req.params.month });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/mappings
 * Returns { cityMap, qaMap }.
 */
app.get('/api/mappings', async (req, res) => {
  try {
    const doc = await Settings.findById('mappings').lean();
    res.json(doc?.data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/mappings
 * Body: { cityMap: {...}, qaMap: {...} }
 */
app.post('/api/mappings', async (req, res) => {
  try {
    const { cityMap, qaMap } = req.body;
    await Settings.findByIdAndUpdate(
      'mappings',
      { data: { cityMap, qaMap }, updatedAt: new Date() },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projections
 * Body: { month, projection }  — set projection to null to delete it.
 */
app.post('/api/projections', async (req, res) => {
  try {
    const { month, projection } = req.body;
    const existing = await Settings.findById('projections').lean();
    const data = existing?.data || {};
    if (projection === null) delete data[month];
    else data[month] = projection;
    await Settings.findByIdAndUpdate(
      'projections',
      { data, updatedAt: new Date() },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve login page at root, dashboard at /dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'Dashboard.html')));

// ── START ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀  Dashboard server running at http://localhost:${PORT}`);
  console.log(`    Login   → http://localhost:${PORT}/`);
  console.log(`    Dashboard → http://localhost:${PORT}/dashboard`);
});
