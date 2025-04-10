require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
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
  if (req.session && req.session.admin) next();
  else res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;

  // ✅ Put logs here — inside this route handler
  console.log("Submitted username:", username);
  console.log("Entered password:", password);

  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    console.log("DB result:", result.rows);

    if (result.rows.length > 0) {
      const admin = result.rows[0];
      const isMatch = await crypto.createHash('sha256').compare(password, admin.password_hash);
      console.log("Password match:", isMatch);
      if (isMatch) {
        req.session.admin = admin;
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
  try {
    const participantsResult = await pool.query('SELECT COUNT(*) AS total FROM participants');
    const sessionsResult = await pool.query('SELECT COUNT(*) AS total FROM sessions');
    res.render('dashboard', {
      admin: req.session.admin,
      totalParticipants: participantsResult.rows[0].total,
      totalSessions: sessionsResult.rows[0].total
    });
  } catch (err) {
    console.error(err);
    res.send("Error retrieving dashboard data.");
  }
});

app.get('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    res.redirect('/admin/login');
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.send(`✅ Connected to DB. Server time: ${result.rows[0].now}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Failed to connect to DB');
  }
});
