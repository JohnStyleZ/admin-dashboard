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
  if (req.session && req.session.admin) next();
  else res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  console.log("Submitted username:", username);
  console.log("Entered password:", password);

  try {
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    console.log("DB result:", result.rows);

    if (result.rows.length > 0) {
      const admin = result.rows[0];
      const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
      console.log("Password hash:", passwordHash);

      if (passwordHash === admin.password_hash) {
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
    const totalParticipantsRes = await pool.query('SELECT COUNT(*) FROM participants');
    const sessionGenderRes = await pool.query(`
  SELECT 
    ps.session_id,
    s.start_time,
    COUNT(*) FILTER (WHERE p.gender = 'Male') AS male_count,
    COUNT(*) FILTER (WHERE p.gender = 'Female') AS female_count
  FROM participant_sessions ps
  JOIN participants p ON ps.participant_id = p.participant_id
  JOIN sessions s ON ps.session_id = s.session_id
  GROUP BY ps.session_id, s.start_time
  ORDER BY s.start_time ASC
`);

    const maleCountRes = await pool.query("SELECT COUNT(*) FROM participants WHERE gender = 'Male'");
    const femaleCountRes = await pool.query("SELECT COUNT(*) FROM participants WHERE gender = 'Female'");

    const totalSpentRes = await pool.query('SELECT SUM(adjusted_cost) FROM participant_sessions');
    const avgCostRes = await pool.query('SELECT AVG(adjusted_cost) FROM participant_sessions');

    const topParticipantsRes = await pool.query(`
      SELECT p.name, COUNT(ps.session_id) AS count
      FROM participants p
      JOIN participant_sessions ps ON p.participant_id = ps.participant_id
      GROUP BY p.name
      ORDER BY count DESC
      LIMIT 10
    `);

    const dailyMultiMonthTrendRes = await pool.query(`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM-DD') AS day,
             DATE_TRUNC('month', s.start_time) AS month,
             SUM(ps.adjusted_cost) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY day, month
      ORDER BY day


    `);

    const dailyGrouped = {};
    dailyMultiMonthTrendRes.rows.forEach(r => {
      const key = r.month.toISOString().slice(0, 7); // e.g., "2025-03"
      if (!dailyGrouped[key]) dailyGrouped[key] = [];
      dailyGrouped[key].push({ day: r.day, total: parseFloat(r.total) });
    });

    const sessionDatesRes = await pool.query(`
      SELECT DISTINCT DATE(start_time) AS session_date
      FROM sessions
      ORDER BY session_date;
    `);

    const sessionDates = sessionDatesRes.rows.map(r => r.session_date.toISOString().split('T')[0]);



    res.render('dashboard', {
      admin: req.session.admin,
      totalParticipants: totalParticipantsRes.rows[0].count,
      maleCount: maleCountRes.rows[0].count,
      femaleCount: femaleCountRes.rows[0].count,
      totalSpent: parseFloat(totalSpentRes.rows[0].sum || 0).toFixed(2),
      avgCost: parseFloat(avgCostRes.rows[0].avg || 0).toFixed(2),
      topParticipants: topParticipantsRes.rows,
      sessionGenderData: sessionGenderRes.rows,
      sessionDates,
      dailyChartByMonth: dailyGrouped

    });
  } catch (err) {
    console.error(err);
    res.send("Error loading dashboard");
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
