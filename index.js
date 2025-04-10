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

    const dailyMultiMonthTrendRes = await pool.query(\`
      SELECT TO_CHAR(s.start_time, 'YYYY-MM-DD') AS day,
             DATE_TRUNC('month', s.start_time) AS month,
             SUM(ps.adjusted_cost) AS total
      FROM participant_sessions ps
      JOIN sessions s ON ps.session_id = s.session_id
      GROUP BY day, month
      ORDER BY day
    \`);

    const dailyGrouped = {};
    dailyMultiMonthTrendRes.rows.forEach(r => {
      const key = r.month.toISOString().slice(0, 7); // e.g., "2025-03"
      if (!dailyGrouped[key]) dailyGrouped[key] = [];
      dailyGrouped[key].push({ day: r.day, total: parseFloat(r.total) });
    });

    const sessionDatesRes = await pool.query(\`
      SELECT DISTINCT DATE(start_time) AS session_date
      FROM sessions
      ORDER BY session_date;
    \`);

    const sessionDates = sessionDatesRes.rows.map(r => r.session_date.toISOString().split('T')[0]);

    const groupSizeQuery = await pool.query(\`
      SELECT s.session_id,
             COUNT(*) FILTER (WHERE p.gender = 'Male') AS male_count,
             COUNT(*) FILTER (WHERE p.gender = 'Female') AS female_count
      FROM sessions s
      JOIN participant_sessions ps ON s.session_id = ps.session_id
      JOIN participants p ON ps.participant_id = p.participant_id
      GROUP BY s.session_id
    \`);

    const groupSizeBuckets = {
      "1–3": { male: 0, female: 0 },
      "4–5": { male: 0, female: 0 },
      "6–8": { male: 0, female: 0 },
      "9–10": { male: 0, female: 0 },
      "11–15": { male: 0, female: 0 },
      "16–20": { male: 0, female: 0 }
    };

    groupSizeQuery.rows.forEach(row => {
      const total = row.male_count + row.female_count;
      let bucket = "";
      if (total >= 1 && total <= 3) bucket = "1–3";
      else if (total <= 5) bucket = "4–5";
      else if (total <= 8) bucket = "6–8";
      else if (total <= 10) bucket = "9–10";
      else if (total <= 15) bucket = "11–15";
      else if (total <= 20) bucket = "16–20";
      else return;

      groupSizeBuckets[bucket].male += row.male_count;
      groupSizeBuckets[bucket].female += row.female_count;
    });

    const groupSizeLabels = Object.keys(groupSizeBuckets);
    const groupSizeMale = groupSizeLabels.map(label => groupSizeBuckets[label].male);
    const groupSizeFemale = groupSizeLabels.map(label => groupSizeBuckets[label].female);

    res.render('dashboard', {
      admin: req.session.admin,
      totalParticipants: totalParticipantsRes.rows[0].count,
      maleCount: maleCountRes.rows[0].count,
      femaleCount: femaleCountRes.rows[0].count,
      totalSpent: parseFloat(totalSpentRes.rows[0].sum || 0).toFixed(2),
      avgCost: parseFloat(avgCostRes.rows[0].avg || 0).toFixed(2),
      topParticipants: topParticipantsRes.rows,
      sessionDates,
      dailyChartByMonth: dailyGrouped,
      groupSizeLabels,
      groupSizeMale,
      groupSizeFemale
    });
  } catch (err) {
    console.error(err);
    res.send("Error loading dashboard");
  }
});