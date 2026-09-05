// Vercel Serverless Function: /api/stats
// Fetches live training totals from Garmin Connect and fundraising total from JustGiving.
// Cached for 1 hour.

import { GarminConnect } from 'garmin-connect';

export default async function handler(req, res) {
  // Allow browser caching for 1 hour, then revalidate
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');

  // TEMP DIAGNOSTIC: use allSettled so one integration failing doesn't
  // hide the other's result, and log full details to Vercel function logs.
  const [garminResult, justgivingResult] = await Promise.allSettled([
    fetchGarminStats(),
    fetchJustGivingTotal()
  ]);

  if (garminResult.status === 'rejected') {
    console.error('[stats] Garmin failed:', garminResult.reason);
  }
  if (justgivingResult.status === 'rejected') {
    console.error('[stats] JustGiving failed:', justgivingResult.reason);
  }

  res.status(200).json({
    ok: garminResult.status === 'fulfilled' || justgivingResult.status === 'fulfilled',
    updated: new Date().toISOString(),
    garmin: garminResult.status === 'fulfilled' ? garminResult.value : null,
    garmin_error: garminResult.status === 'rejected' ? garminResult.reason.message : null,
    justgiving: justgivingResult.status === 'fulfilled' ? justgivingResult.value : null,
    justgiving_error: justgivingResult.status === 'rejected' ? justgivingResult.reason.message : null
  });
}
// ============ GARMIN ============
//
// Uses the unofficial `garmin-connect` package, which logs in with your real
// Garmin Connect username/password (there is no public OAuth API for personal
// projects). Two important caveats:
//  - It cannot get past Garmin's MFA/2FA challenge — the account used here
//    must have two-factor authentication turned OFF.
//  - Every cold invocation logs in from scratch (Vercel functions don't keep
//    the token between requests reliably), so this hits Garmin's login
//    endpoint from a datacenter IP on roughly the same schedule the frontend
//    polls (~every 30 min, and this response is itself cached for 1 hour).
//    Repeated automated logins are a real risk factor for Garmin flagging or
//    locking the account — watch for that if this goes live.

async function fetchGarminStats() {
  const GCClient = new GarminConnect({
    username: process.env.GARMIN_USERNAME,
    password: process.env.GARMIN_PASSWORD
  });

  try {
    await GCClient.login();
  } catch (err) {
    console.error('[stats] Garmin login failed:', err.message);
    throw new Error(`Garmin login failed: ${err.message}`);
  }

  // Last 200 activities, plenty for marathon training
  let activities;
  try {
    activities = await GCClient.getActivities(0, 200);
  } catch (err) {
    console.error('[stats] Garmin getActivities failed:', err.message);
    throw new Error(`Garmin activities fetch failed: ${err.message}`);
  }

  // Filter to runs only, from training start date onwards
  // Use local date string comparison to avoid any timezone edge cases
  const TRAINING_START = '2026-05-24'; // YYYY-MM-DD, inclusive
  const runs = activities.filter(a => {
    const isRun = a.activityType && a.activityType.typeKey && a.activityType.typeKey.includes('running');
    if (!isRun) return false;
    // startTimeLocal format: "2026-05-24 09:00:00"
    const runDate = (a.startTimeLocal || '').slice(0, 10);
    return runDate >= TRAINING_START;
  });

  const metresToMiles = m => m / 1609.344;

  const totalMiles = runs.reduce((s, r) => s + metresToMiles(r.distance), 0);
  const longestMiles = runs.reduce((m, r) => Math.max(m, metresToMiles(r.distance)), 0);
  const runCount = runs.length;

  // Format the most recent 10 runs for the logbook
  const recent = runs.slice(0, 10).map(r => ({
    id: r.activityId,
    date: r.startTimeLocal.slice(0, 10),
    name: r.activityName,
    distance: parseFloat(metresToMiles(r.distance).toFixed(2)),
    moving_time: formatTime(r.duration),
    elevation_gain_m: Math.round(r.elevationGain || 0),
    average_pace: r.averageSpeed ? formatPace(r.averageSpeed) : null,
    link: `https://connect.garmin.com/modern/activity/${r.activityId}`
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
  seconds = Math.round(seconds);
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
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-GB,en;q=0.9'
    }
  });

  if (!r.ok) {
    console.error('[stats] JustGiving HTTP', r.status);
    throw new Error(`JustGiving fetch failed: ${r.status}`);
  }
  const html = await r.text();
  let raised = 0;
  let goal = 0;
  let matched_pattern = null;

  // Collect all £ amounts on the page
  const allMatches = html.match(/£\s*[\d,]+(?:\.\d{1,2})?/g) || [];
  const uniqueAmounts = [...new Set(allMatches)];
  const parsed = uniqueAmounts
    .map(s => parseFloat(s.replace(/[£,\s]/g, '')))
    .filter(n => !isNaN(n) && n > 0);

  if (parsed.length >= 2) {
    // Sort descending - largest first
    const sorted = [...parsed].sort((a, b) => b - a);
    // Goal is the largest amount, raised total is the second-largest
    // (this works because the total raised is always between £0 and the goal,
    // and individual donation amounts are typically smaller than the running total)
    goal = sorted[0];
    raised = sorted[1];
    matched_pattern = 'sorted-amounts';
  } else if (parsed.length === 1) {
    goal = parsed[0];
    raised = 0;
    matched_pattern = 'goal-only';
  }

  return {
    raised,
    goal: goal || 3500,
    page_url: url,
    matched_pattern,
    _debug: {
      unique_money_phrases: uniqueAmounts.slice(0, 12),
      html_length: html.length
    }
  };
}
