require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_USE_SSL === 'true' ? { rejectUnauthorized: false } : false
});


// Middlewares
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false
}));

app.use(cors());

// Middleware for route protection
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) next();
  else res.redirect('/admin/login');
}

// --- Admin Login ---
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

// --- Dashboard ---
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const totalParticipantsRes = await pool.query('SELECT COUNT(*) FROM participants');
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

    const sessionGenderRes = await pool.query(`
      SELECT ps.session_id, s.start_time,
             COUNT(*) FILTER (WHERE p.gender = 'Male') AS male_count,
             COUNT(*) FILTER (WHERE p.gender = 'Female') AS female_count
      FROM participant_sessions ps
      JOIN participants p ON ps.participant_id = p.participant_id
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY ps.session_id, s.start_time
      ORDER BY s.start_time ASC
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
      const key = r.month.toISOString().slice(0, 7);
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

// --- Analytics ---
app.get('/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const peakHours = await pool.query(`
      SELECT EXTRACT(HOUR FROM join_time) AS hour, COUNT(*) AS total
      FROM participant_sessions
      JOIN sessions ON participant_sessions.session_id = sessions.session_id
      GROUP BY hour ORDER BY hour`);

    const durationBuckets = await pool.query(`
      SELECT width_bucket(EXTRACT(EPOCH FROM (leave_time - join_time))/60, 0, 300, 6) AS bucket,
             COUNT(*) AS total
      FROM participant_sessions
      GROUP BY bucket ORDER BY bucket`);

    const groupSizes = await pool.query(`
      SELECT CASE
               WHEN count <= 5 THEN 'Small (1–5)'
               WHEN count <= 10 THEN 'Medium (6–10)'
               ELSE 'Large (11+)'
             END AS size_category,
             COUNT(*) AS total_sessions
      FROM (SELECT session_id, COUNT(*) AS count FROM participant_sessions GROUP BY session_id) grouped
      GROUP BY size_category`);

    const genderTrends = await pool.query(`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM') AS month,
             p.gender, COUNT(*) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      JOIN participants p ON ps.participant_id = p.participant_id
      GROUP BY month, p.gender ORDER BY month, p.gender`);

    const newVsReturning = await pool.query(`
      WITH first_sessions AS (
        SELECT participant_id, MIN(session_id) AS first_session
        FROM participant_sessions GROUP BY participant_id)
      SELECT TO_CHAR(s.start_time, 'YYYY-MM') AS month,
             CASE WHEN ps.session_id = fs.first_session THEN 'New' ELSE 'Returning' END AS type,
             COUNT(*) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      JOIN first_sessions fs ON fs.participant_id = ps.participant_id
      GROUP BY month, type ORDER BY month, type`);

    const sessionsPerMonth = await pool.query(`
      SELECT TO_CHAR(start_time, 'YYYY-MM') AS month, COUNT(*) AS total_sessions
      FROM sessions GROUP BY month ORDER BY month`);

    const spendingPerMonth = await pool.query(`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM') AS month, SUM(ps.adjusted_cost) AS total_spent
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY month ORDER BY month`);

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

// --- Reports ---
app.get('/admin/reports', requireAdmin, (req, res) => {
  res.render('reports', { admin: req.session.admin, title: 'Reports' });
});

// --- Settings ---
app.get('/admin/settings', requireAdmin, async (req, res) => {
  const adminId = req.session.admin.admin_id;
  const adminRes = await pool.query('SELECT * FROM admins WHERE admin_id = $1', [adminId]);
  const locationsRes = await pool.query('SELECT * FROM locations ORDER BY name');
  const queryLocationId = req.query.location_id;
  const selectedLocationId = queryLocationId || adminRes.rows[0].location_id || locationsRes.rows[0]?.location_id;
  const participantsRes = await pool.query('SELECT * FROM participants ORDER BY participant_id');

  const ratesRes = await pool.query(
    'SELECT * FROM rate_settings WHERE location_id = $1 ORDER BY group_min',
    [selectedLocationId]
  );

  const message = req.session.message;
  delete req.session.message;

  res.render('settings', {
    title: 'Settings',
    admin: adminRes.rows[0],
    locations: locationsRes.rows,
    selectedLocationId,
    rates: ratesRes.rows,
    message,
    participants: participantsRes.rows,
  });
});

// --- Profile Update ---
app.post('/admin/settings/update-profile', async (req, res) => {
  const { email } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET email = $1 WHERE admin_id = $2', [email, adminId]);
  req.session.message = 'Email updated successfully!';
  res.redirect('/admin/settings');
});

// --- Password Update ---
app.post('/admin/settings/update-password', async (req, res) => {
  const { current_password, new_password } = req.body;
  const adminId = req.session.admin_id;
  const result = await pool.query('SELECT password_hash FROM admins WHERE admin_id = $1', [adminId]);
  const hashCurrent = crypto.createHash('sha256').update(current_password).digest('hex');

  if (result.rows[0].password_hash === hashCurrent) {
    const hashNew = crypto.createHash('sha256').update(new_password).digest('hex');
    await pool.query('UPDATE admins SET password_hash = $1 WHERE admin_id = $2', [hashNew, adminId]);
    req.session.message = 'Password changed successfully!';
  } else {
    req.session.message = 'Current password is incorrect!';
  }
  res.redirect('/admin/settings');
});

// --- Add Location ---
app.post('/admin/settings/add-location', async (req, res) => {
  const { name } = req.body;
  await pool.query('INSERT INTO locations (name) VALUES ($1)', [name]);
  req.session.message = 'Location added successfully!';
  res.redirect('/admin/settings');
});

// --- Save Rates ---
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
    req.session.message = 'Rates updated successfully!';
    res.redirect(`/admin/settings?location_id=${location_id}`);
  } catch (err) {
    console.error("Error saving rates:", err);
    res.status(500).send("Failed to save rates.");
  }
});

app.post('/admin/settings/update-participants', requireAdmin, async (req, res) => {
  try {
    const updates = Object.entries(req.body);
    const grouped = {};

    updates.forEach(([key, value]) => {
      const [field, id] = key.split('_');
      if (!grouped[id]) grouped[id] = {};
      grouped[id][field] = value;
    });

    for (const id in grouped) {
      const { name, gender } = grouped[id];
      await pool.query('UPDATE participants SET name = $1, gender = $2 WHERE participant_id = $3', [name, gender || null, id]);
    }

    req.session.message = '✅ Participant changes saved!';
    res.redirect('/admin/settings');
  } catch (err) {
    console.error('Failed to update participants:', err);
    req.session.message = '❌ Failed to update participants.';
    res.redirect('/admin/settings');
  }
});

app.use(express.json()); 



// --- API: Create or Get Participant by Name ---
app.post('/api/participants/check-in', async (req, res) => {
  const { name, gender } = req.body;
  try {
    const check = await pool.query('SELECT participant_id FROM participants WHERE name = $1', [name]);
    if (check.rows.length > 0) {
      res.json({ participant_id: check.rows[0].participant_id });
    } else {
      const insert = await pool.query(
        'INSERT INTO participants (name, gender) VALUES ($1, $2) RETURNING participant_id',
        [name, gender || null]
      );
      res.json({ participant_id: insert.rows[0].participant_id });
    }
  } catch (err) {
    console.error("Error checking in participant:", err);
    res.status(500).json({ error: 'Failed to check in participant' });
  }
});

// --- API: Log participant session ---
app.post('/api/participant-sessions', async (req, res) => {
  const { participant_id, session_id, join_time, leave_time } = req.body;

  try {
    if (leave_time) {
      await pool.query(
        `UPDATE participant_sessions
         SET leave_time = $1
         WHERE participant_id = $2 AND session_id = $3`,
        [leave_time, participant_id, session_id]
      );
    } else {
      await pool.query(
        `INSERT INTO participant_sessions (participant_id, session_id, join_time, leave_time)
         VALUES ($1, $2, $3, $4)`,
        [participant_id, session_id, join_time, leave_time]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error logging participant session:", err);
    res.status(500).json({ error: 'Failed to log participant session' });
  }
});

//--- API: get participant ---
app.get('/api/participants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM participants');
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching participants:", err);
    res.status(500).json({ error: 'Failed to fetch participants' });
  }
});
app.get('/api/sessions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sessions');
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching sessions:", err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});
app.get('/api/participant-sessions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM participant_sessions');
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching participant sessions:", err);
    res.status(500).json({ error: 'Failed to fetch participant sessions' });
  }
});
app.get('/api/participant-sessions/:participant_id', async (req, res) => {
  const { participant_id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM participant_sessions WHERE participant_id = $1',
      [participant_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching data for participant:", err);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});
app.get('/api/summary', async (req, res) => {
  try {
    const totalParticipants = await pool.query('SELECT COUNT(*) FROM participants');
    const maleCount = await pool.query("SELECT COUNT(*) FROM participants WHERE gender = 'Male'");
    const femaleCount = await pool.query("SELECT COUNT(*) FROM participants WHERE gender = 'Female'");
    const totalSpent = await pool.query('SELECT SUM(adjusted_cost) FROM participant_sessions');
    const avgCost = await pool.query('SELECT AVG(adjusted_cost) FROM participant_sessions');

    res.json({
      totalParticipants: Number(totalParticipants.rows[0].count),
      maleCount: Number(maleCount.rows[0].count),
      femaleCount: Number(femaleCount.rows[0].count),
      totalSpent: parseFloat(totalSpent.rows[0].sum || 0),
      avgCost: parseFloat(avgCost.rows[0].avg || 0)
    });
  } catch (err) {
    console.error("Error fetching summary:", err);
    res.status(500).json({ error: 'Failed to fetch summary' });
  }
});

//--- check deviceid -------//
app.post('/api/device-check', async (req, res) => {
  const { device_id, name, gender } = req.body;

  try {
    if (name) {
      const existing = await pool.query('SELECT * FROM participants WHERE device_id = $1', [device_id]);
      if (existing.rows.length === 0) {
        const result = await pool.query(
          'INSERT INTO participants (name, device_id, gender) VALUES ($1, $2, $3) RETURNING participant_id',
          [name, device_id, gender]
        );
        return res.json({ status: 'created', participant_id: result.rows[0].participant_id, name, gender });
      } else {
        return res.json({
          status: 'exists',
          participant_id: existing.rows[0].participant_id,
          name: existing.rows[0].name,
          gender: existing.rows[0].gender
        });
      }
    } else {
      const result = await pool.query('SELECT * FROM participants WHERE device_id = $1', [device_id]);
      if (result.rows.length > 0) {
        return res.json({
          status: 'found',
          participant_id: result.rows[0].participant_id,
          name: result.rows[0].name,
          gender: result.rows[0].gender
        });
      } else {
        return res.status(404).json({ error: 'Device not found' });
      }
    }
  } catch (err) {
    console.error("Error with device-check:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// --- API: Update device_id based on participant_id ---
app.post('/api/update-device-id', async (req, res) => {
  const { participant_id, device_id } = req.body;

  if (!participant_id || !device_id) {
    return res.status(400).json({ error: 'Missing participant_id or device_id' });
  }

  try {
    await pool.query(
      'UPDATE participants SET device_id = $1 WHERE participant_id = $2',
      [device_id, participant_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating device_id:", err);
    res.status(500).json({ error: 'Failed to update device_id' });
  }
});
//  Add `started_by` when creating a session

app.post('/api/sessions', async (req, res) => {
  const { start_time, participant_id, location_id } = req.body;
  console.log('Received:', { start_time, participant_id, location_id }); // ✅ Now these are defined

  try {
    const result = await pool.query(
      `INSERT INTO sessions (start_time, started_by, location_id)
       VALUES ($1, $2, $3)
       RETURNING session_id`,
      [start_time, participant_id, location_id]
    );
    res.json({ session_id: result.rows[0].session_id });
  } catch (err) {
    console.error("Error starting session:", err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});



app.get('/api/sessions/active', async (req, res) => {
  const { location_id } = req.query;

  try {
    let query = `
      SELECT 
        s.session_id, 
        s.start_time, 
        s.location_id, 
        l.name AS location_name,
        COUNT(ps.participant_id) AS participant_count
      FROM sessions s
      JOIN locations l ON s.location_id = l.location_id
      LEFT JOIN participant_sessions ps ON s.session_id = ps.session_id
      WHERE s.end_time IS NULL
    `;
    const params = [];

    if (location_id) {
      query += ` AND s.location_id = $1`;
      params.push(location_id);
    }

    query += `
      GROUP BY s.session_id, s.start_time, s.location_id, l.name
      ORDER BY s.start_time DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching active sessions:", err);
    res.status(500).json({ error: 'Failed to fetch active sessions' });
  }
});



app.get('/api/locations', async (req, res) => {
  try {
    const result = await pool.query('SELECT location_id, name FROM locations ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching locations:', err);
    res.status(500).json({ error: 'Failed to fetch locations' });
  }
});

app.post('/api/sessions/:id/end', async (req, res) => {
  const sessionId = req.params.id;
  const { end_time } = req.body;

  try {
    console.log(`Ending session ${sessionId} at ${end_time}`);

    // Step 1: End the session
    await pool.query(
      'UPDATE sessions SET end_time = $1 WHERE session_id = $2',
      [end_time, sessionId]
    );

    // Step 2: Fill in leave_time for any participant still in session
    const result = await pool.query(
      `UPDATE participant_sessions
       SET leave_time = $1
       WHERE session_id = $2 AND leave_time IS NULL
       RETURNING participant_id`,
      [end_time, sessionId]
    );

    console.log(`Updated leave_time for participants:`, result.rows.map(r => r.participant_id));

    res.json({ success: true });
  } catch (err) {
    console.error("Error ending session:", err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// GET participants in a specific session
app.get('/api/sessions/:id/participants', async (req, res) => {
  const sessionId = req.params.id;
  try {
    const result = await pool.query(`
      SELECT p.name, p.gender, ps.join_time, s.started_by
      FROM participant_sessions ps
      JOIN participants p ON ps.participant_id = p.participant_id
      JOIN sessions s ON ps.session_id = s.session_id
      WHERE ps.session_id = $1 AND ps.leave_time IS NULL
    `, [sessionId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching participants:', err);
    res.status(500).json({ error: 'Failed to fetch participants' });
  }
});


// --- Logout ---
app.get('/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    res.redirect('/admin/login');
  });
});

app.get('/', (req, res) => {
  res.redirect('/admin/login');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
