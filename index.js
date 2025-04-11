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

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  // ... existing dashboard code ...
});

app.get('/admin/analytics', requireAdmin, async (req, res) => {
  // ... existing analytics code ...
});

app.get('/admin/reports', requireAdmin, (req, res) => {
  res.render('reports', { admin: req.session.admin, title: 'Reports' });
});

app.get('/admin/settings', requireAdmin, async (req, res) => {
  const adminId = req.session.admin.admin_id;
  const adminRes = await pool.query('SELECT * FROM admins WHERE admin_id = $1', [adminId]);
  const locationsRes = await pool.query('SELECT * FROM locations ORDER BY name');
  const selectedLocationId = adminRes.rows[0].location_id || locationsRes.rows[0]?.location_id;
  const ratesRes = await pool.query('SELECT * FROM rate_settings WHERE location_id = $1 ORDER BY range_label', [selectedLocationId]);

  res.render('settings', {
    title: 'Settings',
    admin: adminRes.rows[0],
    locations: locationsRes.rows,
    selectedLocationId,
    rates: ratesRes.rows
  });
});

app.post('/admin/settings/save-rates', requireAdmin, async (req, res) => {
  const { location_id } = req.body;
  const groupRanges = [
    '1–3 people',
    '4–5 people',
    '6–8 people',
    '9–10 people',
    '11–15 people',
    '16–20 people'
  ];

  for (let label of groupRanges) {
    const key = label.replace(/–/g, '-').replace(/\s+/g, '_');
    const dayRate = req.body[`day_${key}`];
    const nightRate = req.body[`night_${key}`];

    await pool.query(
      `INSERT INTO rate_settings (location_id, range_label, day_rate, night_rate)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, range_label)
       DO UPDATE SET day_rate = $3, night_rate = $4`,
      [location_id, label, dayRate, nightRate]
    );
  }

  res.redirect('/admin/settings');
});

app.post('/admin/settings/update-profile', async (req, res) => {
  const { email } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET email = $1 WHERE admin_id = $2', [email, adminId]);
  res.redirect('/admin/settings');
});

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

app.post('/admin/settings/update-location', async (req, res) => {
  const { location_id } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET location_id = $1 WHERE admin_id = $2', [location_id, adminId]);
  res.redirect('/admin/settings');
});

app.post('/admin/settings/add-location', async (req, res) => {
  const { name } = req.body;
  await pool.query('INSERT INTO locations (name) VALUES ($1)', [name]);
  res.redirect('/admin/settings');
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
