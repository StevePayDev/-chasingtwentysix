// Vercel Serverless Function: /api/stats
// Fetches live training totals from Strava and fundraising total from JustGiving.
// Cached for 1 hour to stay well within Strava's rate limits.

export default async function handler(req, res) {
  // Allow browser caching for 1 hour, then revalidate
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  try {
    const [strava, justgiving] = await Promise.all([
      fetchStravaStats(),
      fetchJustGivingTotal()
    ]);

    res.status(200).json({
      ok: true,
      updated: new Date().toISOString(),
      strava,
      justgiving
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      error: err.message,
      updated: new Date().toISOString()
    });
  }
}

// ============ STRAVA ============

async function fetchStravaStats() {
  // 1. Refresh the access token using the long-lived refresh token
  const tokenRes = await fetch('https://www.strava.com/api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: process.env.STRAVA_REFRESH_TOKEN
    })
  });

  if (!tokenRes.ok) throw new Error('Strava token refresh failed');
  const tokenData = await tokenRes.json();
  const accessToken = tokenData.access_token;

  // 2. Fetch recent activities (last 200, plenty for marathon training)
  const actRes = await fetch(
    'https://www.strava.com/api/v3/athlete/activities?per_page=200',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!actRes.ok) throw new Error('Strava activities fetch failed');
  const activities = await actRes.json();

  // 3. Filter to runs only, from training start date onwards
  const TRAINING_START = new Date('2026-05-24T00:00:00Z');
  const runs = activities.filter(a => {
    const isRun = a.type === 'Run' || a.sport_type === 'Run';
    if (!isRun) return false;
    return new Date(a.start_date) >= TRAINING_START;
  });

  const metresToMiles = m => m / 1609.344;

  const totalMiles = runs.reduce((s, r) => s + metresToMiles(r.distance), 0);
  const longestMiles = runs.reduce((m, r) => Math.max(m, metresToMiles(r.distance)), 0);
  const runCount = runs.length;

  // 4. Format the most recent 10 runs for the logbook
  const recent = runs.slice(0, 10).map(r => ({
    id: r.id,
    date: r.start_date_local.slice(0, 10),
    name: r.name,
    distance: parseFloat(metresToMiles(r.distance).toFixed(2)),
    moving_time: formatTime(r.moving_time),
    elevation_gain_m: Math.round(r.total_elevation_gain || 0),
    average_pace: r.average_speed ? formatPace(r.average_speed) : null,
    link: `https://www.strava.com/activities/${r.id}`
  }));

  return {
    total_miles: parseFloat(totalMiles.toFixed(1)),
    longest_miles: parseFloat(longestMiles.toFixed(1)),
    run_count: runCount,
    recent
  };
}

function formatTime(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPace(metresPerSec) {
  // Convert to minutes per mile
  const secPerMile = 1609.344 / metresPerSec;
  const min = Math.floor(secPerMile / 60);
  const sec = Math.round(secPerMile % 60);
  return `${min}:${String(sec).padStart(2, '0')}/mi`;
}

// ============ JUSTGIVING ============

async function fetchJustGivingTotal() {
  const slug = process.env.JUSTGIVING_SLUG;
  const url = `https://www.justgiving.com/page/${slug}`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ChasingTwentySix/1.0)',
      'Accept': 'text/html'
    }
  });

  if (!r.ok) throw new Error(`JustGiving fetch failed: ${r.status}`);
  const html = await r.text();

  // JustGiving pages embed totals in JSON-LD or data attributes.
  // Try multiple patterns to find the £ raised.
  let raised = 0;
  let goal = 0;

  // Pattern 1: JSON-LD or embedded JSON state
  const amountMatch = html.match(/"totalRaisedAmount"\s*:\s*"?£?([\d,.]+)"?/i)
    || html.match(/"amountRaised"\s*:\s*"?£?([\d,.]+)"?/i)
    || html.match(/"raisedAmount"\s*:\s*"?£?([\d,.]+)"?/i)
    || html.match(/data-amount-raised="?£?([\d,.]+)"?/i)
    || html.match(/£([\d,]+(?:\.\d{2})?)\s*(?:raised|of)/i);

  if (amountMatch) raised = parseFloat(amountMatch[1].replace(/,/g, ''));

  const goalMatch = html.match(/"targetAmount"\s*:\s*"?£?([\d,.]+)"?/i)
    || html.match(/"goalAmount"\s*:\s*"?£?([\d,.]+)"?/i)
    || html.match(/of\s+£([\d,]+(?:\.\d{2})?)/i);

  if (goalMatch) goal = parseFloat(goalMatch[1].replace(/,/g, ''));

  return {
    raised,
    goal: goal || 3500,
    page_url: url
  };
}

}
