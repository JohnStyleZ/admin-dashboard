require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
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
  
  // Get all participants
  const participantsRes = await pool.query(
    `SELECT p.*, COUNT(ps.session_id) as session_count 
     FROM participants p 
     LEFT JOIN participant_sessions ps ON p.participant_id = ps.participant_id 
     GROUP BY p.participant_id 
     ORDER BY p.participant_id`
  );

  // Get sessions with counts
  const sessionsRes = await pool.query(
    `SELECT s.*, 
            l.name as location_name, 
            COUNT(ps.participant_id) as participant_count,
            SUM(ps.adjusted_cost) as revenue
     FROM sessions s
     LEFT JOIN locations l ON s.location_id = l.location_id
     LEFT JOIN participant_sessions ps ON s.session_id = ps.session_id
     GROUP BY s.session_id, l.name
     ORDER BY s.start_time DESC
     LIMIT 20`
  );

  // Get rate settings for selected location
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
    sessions: sessionsRes.rows,
    req: req
  });
});

// --- Profile Update ---
app.post('/admin/settings/update-profile', requireAdmin, async (req, res) => {
  const { email } = req.body;
  const adminId = req.session.admin_id;
  await pool.query('UPDATE admins SET email = $1 WHERE admin_id = $2', [email, adminId]);
  req.session.message = 'Email updated successfully!';
  res.redirect('/admin/settings?tab=profile');
});

// --- Password Update ---
app.post('/admin/settings/update-password', requireAdmin, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const adminId = req.session.admin_id;
  
  if (new_password !== confirm_password) {
    req.session.message = 'New passwords do not match!';
    return res.redirect('/admin/settings?tab=profile');
  }
  
  const result = await pool.query('SELECT password_hash FROM admins WHERE admin_id = $1', [adminId]);
  const hashCurrent = crypto.createHash('sha256').update(current_password).digest('hex');

  if (result.rows[0].password_hash === hashCurrent) {
    const hashNew = crypto.createHash('sha256').update(new_password).digest('hex');
    await pool.query('UPDATE admins SET password_hash = $1 WHERE admin_id = $2', [hashNew, adminId]);
    req.session.message = 'Password changed successfully!';
  } else {
    req.session.message = 'Current password is incorrect!';
  }
  res.redirect('/admin/settings?tab=profile');
});

// --- Add Location ---
app.post('/admin/settings/add-location', requireAdmin, async (req, res) => {
  const { name } = req.body;
  try {
    await pool.query('INSERT INTO locations (name) VALUES ($1)', [name]);
    req.session.message = 'Location added successfully!';
  } catch (err) {
    console.error('Error adding location:', err);
    req.session.message = 'Failed to add location: ' + err.message;
  }
  res.redirect('/admin/settings?tab=locations');
});

// --- Update Location ---
app.post('/admin/settings/update-location/:location_id', requireAdmin, async (req, res) => {
  const { location_id } = req.params;
  const { name } = req.body;
  
  try {
    await pool.query('UPDATE locations SET name = $1 WHERE location_id = $2', [name, location_id]);
    req.session.message = 'Location updated successfully!';
  } catch (err) {
    console.error('Error updating location:', err);
    req.session.message = 'Failed to update location: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=locations');
});

// --- Delete Location ---
app.post('/admin/settings/delete-location/:location_id', requireAdmin, async (req, res) => {
  const { location_id } = req.params;
  
  try {
    // Check if location is in use by sessions
    const sessionsCheck = await pool.query('SELECT COUNT(*) FROM sessions WHERE location_id = $1', [location_id]);
    
    if (parseInt(sessionsCheck.rows[0].count) > 0) {
      req.session.message = 'Cannot delete location: It is used by existing sessions.';
    } else {
      // Delete related rate settings first
      await pool.query('DELETE FROM rate_settings WHERE location_id = $1', [location_id]);
      // Then delete the location
      await pool.query('DELETE FROM locations WHERE location_id = $1', [location_id]);
      req.session.message = 'Location deleted successfully!';
    }
  } catch (err) {
    console.error('Error deleting location:', err);
    req.session.message = 'Failed to delete location: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=locations');
});

// --- Save Rates ---
app.post('/admin/settings/save-rates', requireAdmin, async (req, res) => {
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
  } catch (err) {
    console.error("Error saving rates:", err);
    req.session.message = "Failed to save rates: " + err.message;
  }
  res.redirect(`/admin/settings?tab=rates&location_id=${location_id}`);
});

// --- Add Participant ---
app.post('/admin/settings/add-participant', requireAdmin, async (req, res) => {
  const { name, gender, email } = req.body;
  
  try {
    await pool.query(
      'INSERT INTO participants (name, gender, email) VALUES ($1, $2, $3)',
      [name, gender || null, email || null]
    );
    
    req.session.message = 'Participant added successfully!';
  } catch (err) {
    console.error('Failed to add participant:', err);
    req.session.message = 'Failed to add participant: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=participants');
});

// --- Update Participants ---
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
      const { name, gender, email } = grouped[id];
      await pool.query(
        'UPDATE participants SET name = $1, gender = $2, email = $3 WHERE participant_id = $4', 
        [name, gender || null, email || null, id]
      );
    }

    req.session.message = '✅ Participant changes saved!';
  } catch (err) {
    console.error('Failed to update participants:', err);
    req.session.message = '❌ Failed to update participants: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=participants');
});

// --- Delete Participant ---
app.post('/admin/settings/delete-participant/:participant_id', requireAdmin, async (req, res) => {
  const { participant_id } = req.params;
  
  try {
    // First check if participant has sessions
    const sessionsCheck = await pool.query(
      'SELECT COUNT(*) FROM participant_sessions WHERE participant_id = $1',
      [participant_id]
    );
    
    if (parseInt(sessionsCheck.rows[0].count) > 0) {
      // If participant has sessions, just anonymize the data
      await pool.query(
        `UPDATE participants 
         SET name = 'Deleted User', gender = NULL, email = NULL, device_id = NULL, password = NULL, 
             security_question = NULL, security_answer = NULL
         WHERE participant_id = $1`,
        [participant_id]
      );
      req.session.message = 'Participant anonymized (had existing sessions)';
    } else {
      // No sessions, can fully delete
      await pool.query('DELETE FROM participants WHERE participant_id = $1', [participant_id]);
      req.session.message = 'Participant deleted successfully!';
    }
  } catch (err) {
    console.error('Failed to delete participant:', err);
    req.session.message = 'Failed to delete participant: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=participants');
});

// --- Create Session ---
app.post('/admin/settings/create-session', requireAdmin, async (req, res) => {
  const { date, time, location_id, room_number } = req.body;
  
  try {
    // Combine date and time into timestamp
    const dateTimeStr = `${date}T${time}:00`;
    const timestamp = new Date(dateTimeStr);
    
    if (isNaN(timestamp.getTime())) {
      throw new Error('Invalid date or time format');
    }
    
    await pool.query(
      'INSERT INTO sessions (location_id, start_time, room_number) VALUES ($1, $2, $3)',
      [location_id, timestamp, room_number || null]
    );
    
    req.session.message = 'Session created successfully!';
  } catch (err) {
    console.error('Failed to create session:', err);
    req.session.message = 'Failed to create session: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=sessions');
});

// --- Delete Session ---
app.post('/admin/settings/delete-session/:session_id', requireAdmin, async (req, res) => {
  const { session_id } = req.params;
  
  try {
    // First delete related participant sessions
    await pool.query('DELETE FROM participant_sessions WHERE session_id = $1', [session_id]);
    // Then delete the session
    await pool.query('DELETE FROM sessions WHERE session_id = $1', [session_id]);
    
    req.session.message = 'Session deleted successfully!';
  } catch (err) {
    console.error('Failed to delete session:', err);
    req.session.message = 'Failed to delete session: ' + err.message;
  }
  
  res.redirect('/admin/settings?tab=sessions');
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
      `SELECT ps.*, s.location_id, l.name AS location_name
       FROM participant_sessions ps
       JOIN sessions s ON ps.session_id = s.session_id
       JOIN locations l ON s.location_id = l.location_id
       WHERE ps.participant_id = $1
       ORDER BY ps.join_time DESC`,
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
    // If name and gender provided, this is a new user registration
    if (name && gender && device_id) {
      const createRes = await pool.query(
        `INSERT INTO participants (name, gender, device_id)
         VALUES ($1, $2, $3)
         RETURNING participant_id, name, gender`,
        [name, gender, device_id]
      );
      return res.json(createRes.rows[0]);
    }

    // Check if device ID exists
    const result = await pool.query(
      'SELECT participant_id, name, gender, email FROM participants WHERE device_id = $1',
      [device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Device check error:', err);
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
  const { start_time, participant_id, location_id, room_number } = req.body;
  console.log('Received:', { start_time, participant_id, location_id, room_number });

  try {
    const result = await pool.query(
      `INSERT INTO sessions (start_time, started_by, location_id, room_number)
       VALUES ($1, $2, $3, $4)
       RETURNING session_id`,
      [start_time, participant_id, location_id, room_number]
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
        s.room_number,
        s.started_by,
        p.name AS started_by_name,
        l.name AS location_name,
        COUNT(ps.participant_id) AS participant_count
      FROM sessions s
      JOIN locations l ON s.location_id = l.location_id
      LEFT JOIN participants p ON s.started_by = p.participant_id
      LEFT JOIN participant_sessions ps ON s.session_id = ps.session_id
      WHERE s.end_time IS NULL
    `;
    const params = [];

    if (location_id) {
      query += ` AND s.location_id = $1`;
      params.push(location_id);
    }

    query += `
      GROUP BY s.session_id, s.start_time, s.location_id, s.room_number, s.started_by, p.name, l.name
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
    const result = await pool.query('SELECT location_id, name FROM locations');
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
      SELECT 
        ps.participant_id,
        ps.join_time,
        ps.leave_time,
        ps.computed_cost,
        ps.adjusted_cost,
        p.name,
        p.gender
      FROM participant_sessions ps
      JOIN participants p ON ps.participant_id = p.participant_id
      WHERE ps.session_id = $1 AND ps.leave_time IS NULL
      ORDER BY ps.join_time
    `, [sessionId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching participants:", err);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
});

// --- API: Get session started by user with unpaid status ---
app.get('/api/sessions/unpaid-host/:participant_id', async (req, res) => {
  const { participant_id } = req.params;
  try {
    const result = await pool.query(`
      SELECT 
        s.*, 
        l.name AS location_name,
        p.name AS started_by_name
      FROM sessions s
      JOIN locations l ON s.location_id = l.location_id
      JOIN participants p ON s.started_by = p.participant_id
      WHERE s.started_by = $1 AND s.total_actual_paid IS NULL
      ORDER BY s.start_time DESC
      LIMIT 1
    `, [participant_id]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching unpaid session:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  const sessionId = req.params.id;
  try {
    const result = await pool.query(`
      SELECT 
        s.*, 
        l.name AS location_name,
        p.name AS started_by_name
      FROM sessions s
      LEFT JOIN locations l ON s.location_id = l.location_id
      LEFT JOIN participants p ON s.started_by = p.participant_id
      WHERE s.session_id = $1
    `, [sessionId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching session with location:", err);
    res.status(500).json({ error: "Failed to fetch session info" });
  }
});

app.post('/api/sessions/:id/paid', async (req, res) => {
  const sessionId = req.params.id;
  const { total_actual_paid } = req.body;

  try {
    const result = await pool.query(
      'UPDATE sessions SET total_actual_paid = $1 WHERE session_id = $2 AND end_time IS NOT NULL RETURNING *',
      [total_actual_paid, sessionId]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Session not ended or invalid ID' });
    }
    res.json({ success: true, session: result.rows[0] });
  } catch (err) {
    console.error('Error updating total_actual_paid:', err);
    res.status(500).json({ error: 'Failed to update total actual paid' });
  }
});

app.post('/api/sessions/:id/adjust-costs', async (req, res) => {
  const sessionId = req.params.id;
  const { costs } = req.body; // Array of { participant_id, adjusted_cost }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const { participant_id, adjusted_cost } of costs) {
      console.log(`Updating: participant_id=${participant_id}, session_id=${sessionId}, cost=${adjusted_cost}`);
    
      const result = await client.query(
        `UPDATE participant_sessions 
         SET adjusted_cost = $1 
         WHERE session_id = $2 AND participant_id = $3`,
        [adjusted_cost, sessionId, participant_id]
      );
    
      console.log(`Rows affected: ${result.rowCount}`);
    }


    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating participant costs:', err);
    res.status(500).json({ error: 'Failed to update participant costs' });
  } finally {
    client.release();
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

// Database initialization and migrations
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    // Begin transaction for all migrations
    await client.query('BEGIN');
    
    // Check if room_number column exists in sessions table
    const columnCheckResult = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'sessions' AND column_name = 'room_number'
    `);
    
    const hasRoomNumber = columnCheckResult.rows.length > 0;
    
    // Add room_number column if it doesn't exist
    if (!hasRoomNumber) {
      console.log('Adding room_number column to sessions table');
      await client.query(`
        ALTER TABLE sessions
        ADD COLUMN room_number TEXT
      `);
    }
    
    await client.query('COMMIT');
    console.log('Database migrations completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error performing database migrations:', err);
  } finally {
    client.release();
  }
}

// Run migrations before starting server
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});

// --- Authentication API Endpoints ---

// Register new user with email/password
app.post('/api/auth/register', async (req, res) => {
  const { email, password, name, gender, security_question, security_answer, device_id } = req.body;

  if (!email || !password || !name || !gender || !security_question || !security_answer) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    // Check if email already exists
    const emailCheck = await pool.query('SELECT * FROM participants WHERE email = $1', [email]);
    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Hash password and security answer
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Generate a unique device ID if not provided
    const finalDeviceId = device_id || `device_${Date.now()}`;

    // Insert new user
    const result = await pool.query(
      `INSERT INTO participants (name, gender, email, password, security_question, security_answer, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING participant_id, name, gender, email, device_id`,
      [name, gender, email, hashedPassword, security_question, security_answer, finalDeviceId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login with email/password
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    // Find user by email
    const result = await pool.query('SELECT * FROM participants WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password);
    
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Return user data
    res.json({
      participant_id: user.participant_id,
      name: user.name,
      gender: user.gender,
      email: user.email,
      device_id: user.device_id
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get security question for reset
app.post('/api/auth/get-security-question', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    // Find user by email
    const result = await pool.query('SELECT security_question FROM participants WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      // For security, use a random delay and don't reveal if email doesn't exist
      setTimeout(() => {
        return res.status(404).json({ message: 'User not found' });
      }, 500 + Math.random() * 500);
      return;
    }

    const questionId = result.rows[0].security_question;
    
    // Map question IDs to actual question text
    const questionMap = {
      'pet': 'What was your first pet\'s name?',
      'street': 'What street did you grow up on?',
      'mother': 'What is your mother\'s maiden name?',
      'school': 'What elementary school did you attend?',
      'birth': 'In what city were you born?'
    };

    res.json({
      questionId,
      questionText: questionMap[questionId] || 'Security question'
    });
  } catch (err) {
    console.error('Error fetching security question:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Verify security answer
app.post('/api/auth/verify-security-answer', async (req, res) => {
  const { email, question_id, answer } = req.body;

  if (!email || !question_id || !answer) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    // Find user by email
    const result = await pool.query(
      'SELECT participant_id, security_question, security_answer FROM participants WHERE email = $1',
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = result.rows[0];
    
    // Verify question and answer
    if (question_id !== user.security_question || 
        answer.toLowerCase().trim() !== user.security_answer.toLowerCase().trim()) {
      return res.status(401).json({ message: 'Invalid answer' });
    }

    // Generate a reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiryTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    
    // Store the token in the database
    await pool.query(
      `UPDATE participants 
       SET reset_token = $1, reset_token_expires = $2 
       WHERE participant_id = $3`,
      [resetToken, expiryTime, user.participant_id]
    );

    res.json({ resetToken });
  } catch (err) {
    console.error('Error verifying security answer:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Reset password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ message: 'Token and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: 'Password must be at least 6 characters' });
  }

  try {
    // Find user by reset token
    const result = await pool.query(
      `SELECT participant_id FROM participants 
       WHERE reset_token = $1 AND reset_token_expires > NOW()`,
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    const userId = result.rows[0].participant_id;
    
    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Update password and clear reset token
    await pool.query(
      `UPDATE participants 
       SET password = $1, reset_token = NULL, reset_token_expires = NULL 
       WHERE participant_id = $2`,
      [hashedPassword, userId]
    );

    res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Transfer host status to another participant
app.post('/api/sessions/:sessionId/transfer-host', async (req, res) => {
  const { sessionId } = req.params;
  const { new_host_id } = req.body;
  
  if (!sessionId || !new_host_id) {
    return res.status(400).json({ message: 'Missing required parameters' });
  }
  
  try {
    // Update the session's started_by field to the new host
    await pool.query(
      'UPDATE sessions SET started_by = $1 WHERE session_id = $2',
      [new_host_id, sessionId]
    );
    
    res.json({ message: 'Host transferred successfully' });
  } catch (err) {
    console.error('Error transferring host:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Handle participant rejoining a session
app.post('/api/participant-sessions/rejoin', async (req, res) => {
  const { participant_id, session_id, previous_record_id } = req.body;
  
  if (!participant_id || !session_id || !previous_record_id) {
    return res.status(400).json({ message: 'Missing required parameters' });
  }
  
  try {
    // Simply clear the leave_time for the existing record
    const updateResult = await pool.query(
      `UPDATE participant_sessions 
       SET leave_time = NULL
       WHERE id = $1 AND participant_id = $2 AND session_id = $3
       RETURNING *`,
      [previous_record_id, participant_id, session_id]
    );
    
    if (updateResult.rows.length === 0) {
      // If no record was updated, fall back to creating a new record
      const insertResult = await pool.query(
        `INSERT INTO participant_sessions (participant_id, session_id, join_time, leave_time)
         VALUES ($1, $2, NOW(), NULL)
         RETURNING *`,
        [participant_id, session_id]
      );
      
      return res.status(201).json(insertResult.rows[0]);
    }
    
    // Return the updated record
    res.status(200).json(updateResult.rows[0]);
  } catch (err) {
    console.error('Error handling rejoin:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET all participants in a specific session including those who left (for calculator)
app.get('/api/sessions/:id/all-participants', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const result = await pool.query(`
      SELECT 
        ps.participant_id,
        ps.join_time,
        ps.leave_time,
        ps.computed_cost,
        ps.adjusted_cost,
        p.name,
        p.gender
      FROM participant_sessions ps
      JOIN participants p ON ps.participant_id = p.participant_id
      WHERE ps.session_id = $1
      ORDER BY ps.join_time
    `, [sessionId]);

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching all participants:", err);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
});