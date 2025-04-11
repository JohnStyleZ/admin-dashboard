require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Update email
app.post('/admin/settings/update-profile', async (req, res) => {
  const { email } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET email = $1 WHERE admin_id = $2', [email, adminId]);
  res.redirect('/admin/settings');
});

// Update password using SHA-256
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

// Set default location
app.post('/admin/settings/update-location', async (req, res) => {
  const { location_id } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET location_id = $1 WHERE admin_id = $2', [location_id, adminId]);
  res.redirect('/admin/settings');
});

// Add new location
app.post('/admin/settings/add-location', async (req, res) => {
  const { name } = req.body;
  await pool.query('INSERT INTO locations (name) VALUES ($1)', [name]);
  res.redirect('/admin/settings');
});

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
  try {
    const totalParticipantsRes = await pool.query('SELECT COUNT(*) FROM participants');
    const sessionGenderRes = await pool.query(`
      SELECT ps.session_id, s.start_time,
             COUNT(*) FILTER (WHERE p.gender = 'Male') AS male_count,
             COUNT(*) FILTER (WHERE p.gender = 'Female') AS female_count
      FROM participant_sessions ps
      JOIN participants p ON ps.participant_id = p.participant_id
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY ps.session_id, s.start_time
      ORDER BY s.start_time ASC`);

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
      LIMIT 10`);

    const dailyMultiMonthTrendRes = await pool.query(`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM-DD') AS day,
             DATE_TRUNC('month', s.start_time) AS month,
             SUM(ps.adjusted_cost) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY day, month
      ORDER BY day`);

    const dailyGrouped = {};
    dailyMultiMonthTrendRes.rows.forEach(r => {
      const key = r.month.toISOString().slice(0, 7);
      if (!dailyGrouped[key]) dailyGrouped[key] = [];
      dailyGrouped[key].push({ day: r.day, total: parseFloat(r.total) });
    });

    const sessionDatesRes = await pool.query(`
      SELECT DISTINCT DATE(start_time) AS session_date
      FROM sessions
      ORDER BY session_date`);

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

app.get('/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const peakHours = await pool.query(`
      SELECT EXTRACT(HOUR FROM join_time) AS hour, COUNT(*) AS total
      FROM participant_sessions
      JOIN sessions ON participant_sessions.session_id = sessions.session_id
      GROUP BY hour
      ORDER BY hour`);

    const durationBuckets = await pool.query(`
      SELECT width_bucket(EXTRACT(EPOCH FROM (leave_time - join_time))/60, 0, 300, 6) AS bucket,
             COUNT(*) AS total
      FROM participant_sessions
      GROUP BY bucket
      ORDER BY bucket`);

    const groupSizes = await pool.query(`
      SELECT CASE
               WHEN count <= 5 THEN 'Small (1–5)'
               WHEN count <= 10 THEN 'Medium (6–10)'
               ELSE 'Large (11+)'
             END AS size_category,
             COUNT(*) AS total_sessions
      FROM (
        SELECT session_id, COUNT(*) AS count
        FROM participant_sessions
        GROUP BY session_id
      ) grouped
      GROUP BY size_category`);

    const genderTrends = await pool.query(`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM') AS month,
             p.gender,
             COUNT(*) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      JOIN participants p ON ps.participant_id = p.participant_id
      GROUP BY month, p.gender
      ORDER BY month, p.gender`);

    const newVsReturning = await pool.query(`
      WITH first_sessions AS (
        SELECT participant_id, MIN(session_id) AS first_session
        FROM participant_sessions
        GROUP BY participant_id
      )
      SELECT TO_CHAR(s.start_time, 'YYYY-MM') AS month,
             CASE
               WHEN ps.session_id = fs.first_session THEN 'New'
               ELSE 'Returning'
             END AS type,
             COUNT(*) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      JOIN first_sessions fs ON fs.participant_id = ps.participant_id
      GROUP BY month, type
      ORDER BY month, type`);
    const sessionsPerMonth = await pool.query(`
      SELECT TO_CHAR(start_time, 'YYYY-MM') AS month, COUNT(*) AS total_sessions
      FROM sessions
      GROUP BY month
      ORDER BY month;
    `);
    
    const spendingPerMonth = await pool.query(`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM') AS month, SUM(ps.adjusted_cost) AS total_spent
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY month
      ORDER BY month;
    `);

    res.render('analytics', {
      admin: req.session.admin,
      title: 'Analytics',
      peakHours: peakHours.rows,
      durationBuckets: durationBuckets.rows,
      groupSizes: groupSizes.rows,
      genderTrends: genderTrends.rows,
      sessionsPerMonth: sessionsPerMonth.rows,
      spendingPerMonth: spendingPerMonth.rows,
      newVsReturning: newVsReturning.rows
    });
  } catch (err) {
    console.error(err);
    res.send("Error loading analytics");
  }
});

app.get('/admin/reports', requireAdmin, (req, res) => {
  res.render('reports', { admin: req.session.admin, title: 'Reports' });
});

app.get('/admin/settings', async (req, res) => {
  const adminId = req.session.admin_id;
  if (!adminId) return res.redirect('/admin/login');

  const adminRes = await pool.query('SELECT * FROM admins WHERE admin_id = $1', [adminId]);
  const locationsRes = await pool.query('SELECT * FROM locations ORDER BY name');

  res.render('settings', {
    title: 'Settings',
    admin: adminRes.rows[0],
    locations: locationsRes.rows
  });
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
