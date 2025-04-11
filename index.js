require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin_id) next();
  else res.redirect('/admin/login');
}

// Login
app.get('/admin/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      const admin = result.rows[0];
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
      if (passwordHash === admin.password_hash) {
        req.session.admin = admin;
        req.session.admin_id = admin.admin_id;
        return res.redirect('/admin/dashboard');
      }
    }
    res.render('login', { error: 'Invalid username or password' });
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'An error occurred. Try again later.' });
  }
});

// Email update
app.post('/admin/settings/update-profile', async (req, res) => {
  const { email } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET email = $1 WHERE admin_id = $2', [email, adminId]);
  res.redirect('/admin/settings');
});

// Password update
app.post('/admin/settings/update-password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const adminId = req.session.admin_id;
  const result = await pool.query('SELECT password_hash FROM admins WHERE admin_id = $1', [adminId]);
  const hashCurrent = crypto.createHash('sha256').update(current_password).digest('hex');

  if (result.rows[0].password_hash === hashCurrent) {
    const hashNew = crypto.createHash('sha256').update(new_password).digest('hex');
    await pool.query('UPDATE admins SET password_hash = $1 WHERE admin_id = $2', [hashNew, adminId]);
  }
  res.redirect('/admin/settings');
});

// Add location
app.post('/admin/settings/add-location', async (req, res) => {
  const { name } = req.body;
  await pool.query('INSERT INTO locations (name) VALUES ($1)', [name]);
  res.redirect('/admin/settings');
});

// Render settings page
app.get('/admin/settings', requireAdmin, async (req, res) => {
  const adminId = req.session.admin_id;
  const adminRes = await pool.query('SELECT * FROM admins WHERE admin_id = $1', [adminId]);
  const locationsRes = await pool.query('SELECT * FROM locations ORDER BY name');

  const queryLocationId = req.query.location_id;
  const selectedLocationId = queryLocationId || adminRes.rows[0].location_id || locationsRes.rows[0]?.location_id;

  const ratesRes = await pool.query(
    'SELECT * FROM rate_settings WHERE location_id = $1 ORDER BY group_min',
    [selectedLocationId]
  );

  res.render('settings', {
    title: 'Settings',
    admin: adminRes.rows[0],
    locations: locationsRes.rows,
    selectedLocationId,
    rates: ratesRes.rows
  });
});

// Save rates
app.post('/admin/settings/save-rates', async (req, res) => {
  const { location_id, ...ratesInput } = req.body;

  const groupSizes = [
    { min: 1, max: 3 },
    { min: 4, max: 5 },
    { min: 6, max: 8 },
    { min: 9, max: 10 },
    { min: 11, max: 15 },
    { min: 16, max: 20 }
  ];

  try {
    for (const group of groupSizes) {
      const dayKey = `day_${group.min}_${group.max}`;
      const nightKey = `night_${group.min}_${group.max}`;
      const rangeLabel = `${group.min}–${group.max} people`;

      const dayRate = parseFloat(ratesInput[dayKey]);
      const nightRate = parseFloat(ratesInput[nightKey]);

      const existsRes = await pool.query(
        'SELECT id FROM rate_settings WHERE location_id = $1 AND group_min = $2 AND group_max = $3',
        [location_id, group.min, group.max]
      );

      if (existsRes.rows.length > 0) {
        await pool.query(
          'UPDATE rate_settings SET day_rate = $1, night_rate = $2, range_label = $3 WHERE id = $4',
          [dayRate, nightRate, rangeLabel, existsRes.rows[0].id]
        );
      } else {
        await pool.query(
          'INSERT INTO rate_settings (location_id, group_min, group_max, day_rate, night_rate, range_label) VALUES ($1, $2, $3, $4, $5, $6)',
          [location_id, group.min, group.max, dayRate, nightRate, rangeLabel]
        );
      }
    }

    res.redirect(`/admin/settings?location_id=${location_id}`);
  } catch (err) {
    console.error("Error saving rates:", err);
    res.status(500).send("Failed to save rates.");
  }
});

app.get('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    res.redirect('/admin/login');
  });
});

app.get('/', (req, res) => {
  res.redirect('/admin/login');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
