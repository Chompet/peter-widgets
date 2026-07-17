import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NOTION_VERSION = "2026-03-11";
const GYM_DATA_SOURCE_ID = "c6c20955-80e6-4c8a-89b6-74c2c83b75b8";
const DAILY_DATA_SOURCE_ID = "1bc5c314-5a3d-4a27-98f7-05fa1a0b2e3c";
const TIME_ZONE = "Europe/London";

export const EXERCISES = [
  ["Leg Press", "Leg Press (Kg)", "Leg Press Sets", "Leg Press Reps"],
  ["Lat Pull Down", "Lat Pull Down (Kg)", "Lat Pull Down Sets", "Lat Pull Down Reps"],
  ["Back Exercise", "Back Exercise (kg)", "Back Exercise Sets", "Back Exercise Reps"],
  ["Converging Press", "Converging Press Weight (kg)", "Converging Press Sets", "Converging Press Reps"],
  ["Pectoral Fly", "Pectoral Fly Weight (kg)", "Pectoral Fly Sets", "Pectoral Fly Reps"],
  ["Abdominal", "Abdominal Weight (kg)", "Abdominal Sets", "Abdominal Reps"],
  ["Biceps", "Biceps Weight (kg)", "Biceps Sets", "Biceps Reps"]
];

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32) {
    throw new Error("FITNESS_DASHBOARD_KEY must be a base64url-encoded 32-byte key.");
  }
  return key;
}

export function encryptSummary(summary, encodedKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(summary), "utf8"),
    cipher.final()
  ]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  return { v: 1, alg: "A256GCM", iv: base64url(iv), ciphertext: base64url(ciphertext) };
}

function property(page, name) {
  return page?.properties?.[name];
}

export function numeric(page, name) {
  const value = property(page, name);
  const candidate = value?.number ?? value?.formula?.number ?? value?.rollup?.number;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : 0;
}

function checked(page, name) {
  return property(page, name)?.checkbox === true;
}

function dateOf(page) {
  return property(page, "Date")?.date?.start?.slice(0, 10) || "";
}

function addDays(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function mondayOf(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1));
}

function sessionVolume(page) {
  return EXERCISES.reduce((total, [, weight, sets, reps]) => (
    total + numeric(page, weight) * numeric(page, sets) * numeric(page, reps)
  ), 0);
}

function rounded(value, places = 1) {
  const multiplier = 10 ** places;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

export function buildSummary(gymPages, dailyPages, now = new Date()) {
  const today = localDate(now);
  const weekStart = mondayOf(today);
  const weekEnd = addDays(weekStart, 6);
  const inWeek = page => {
    const date = dateOf(page);
    return date >= weekStart && date <= weekEnd;
  };
  const gymThisWeek = gymPages.filter(inWeek);
  const dailyThisWeek = dailyPages.filter(inWeek);
  const minutesByDate = new Map();
  const activeDates = new Set();
  const strengthDates = new Set();

  let moderateMinutes = 0;
  let vigorousMinutes = 0;
  let strengthVolumeKg = 0;
  let rowingKm = 0;
  let cyclingKm = 0;
  let runningKm = 0;

  for (const page of gymThisWeek) {
    const date = dateOf(page);
    const moderate = numeric(page, "Rowing Time (min)") + numeric(page, "Bike Time (min)") + numeric(page, "Incline Walk (min)");
    const vigorous = numeric(page, "Running Time (min)") + numeric(page, "Sprint Time (sec)") / 60;
    const strengthMinutes = numeric(page, "Strength Duration (min)");
    const volume = sessionVolume(page);
    const total = moderate + vigorous + strengthMinutes + numeric(page, "Other Duration (min)");

    moderateMinutes += moderate;
    vigorousMinutes += vigorous;
    strengthVolumeKg += volume;
    rowingKm += numeric(page, "Rowing Distance (km)");
    cyclingKm += numeric(page, "Bike Distance (km)");
    runningKm += numeric(page, "Running Distance (km)");
    if (total > 0 || volume > 0) activeDates.add(date);
    if (strengthMinutes > 0 || volume > 0) strengthDates.add(date);
    minutesByDate.set(date, (minutesByDate.get(date) || 0) + total);
  }

  for (const page of dailyThisWeek) {
    const date = dateOf(page);
    const qiGong = numeric(page, "Qi Gong (min)");
    const homeWorkout = numeric(page, "Home Workout (min)");
    const running = numeric(page, "Running (min)");
    const swimming = numeric(page, "Swimming (min)");
    const movement = qiGong + homeWorkout + running + swimming;
    moderateMinutes += qiGong + homeWorkout + swimming;
    vigorousMinutes += running;
    runningKm += numeric(page, "Running Distance (km)");

    const active = movement > 0 || ["Qi Gong", "Home Workout", "Running", "Swimming"].some(name => checked(page, name));
    if (active) activeDates.add(date);
    minutesByDate.set(date, (minutesByDate.get(date) || 0) + movement);
  }

  const strengthSessions = gymPages
    .map(page => ({ page, date: dateOf(page), volumeKg: sessionVolume(page) }))
    .filter(item => item.date && item.volumeKg > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-6);

  const latestLoads = EXERCISES.map(([name, weightProperty]) => {
    const values = gymPages
      .map(page => ({ date: dateOf(page), value: numeric(page, weightProperty) }))
      .filter(item => item.date && item.value > 0)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (!values.length) return null;
    return {
      name,
      value: values[0].value,
      unit: "kg",
      change: rounded(values[0].value - (values[1]?.value ?? values[0].value))
    };
  }).filter(Boolean).slice(0, 3);

  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  const dateLabel = value => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const updated = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now);

  return {
    mode: "live",
    updated: `${updated} UK`,
    week: { label: "This week", start: weekStart, end: weekEnd },
    targets: { cardioEquivalentMinutes: 150, strengthDays: 2, activeDays: 5 },
    summary: {
      cardioEquivalentMinutes: rounded(moderateMinutes + vigorousMinutes * 2),
      strengthDays: strengthDates.size,
      activeDays: activeDates.size,
      gymSessions: gymThisWeek.length,
      strengthVolumeKg: rounded(strengthVolumeKg, 0)
    },
    distance: {
      rowingKm: rounded(rowingKm),
      cyclingKm: rounded(cyclingKm),
      runningKm: rounded(runningKm)
    },
    days: labels.map((label, index) => {
      const date = addDays(weekStart, index);
      const minutes = rounded(minutesByDate.get(date) || 0);
      return { label, minutes, active: activeDates.has(date) };
    }),
    strengthTrend: strengthSessions.map(item => ({ label: dateLabel(item.date), volumeKg: rounded(item.volumeKg, 0) })),
    latestLoads
  };
}

async function queryDataSource(id, token, onOrAfter) {
  const pages = [];
  let startCursor;
  do {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${id}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        page_size: 100,
        filter: { property: "Date", date: { on_or_after: onOrAfter } },
        sorts: [{ property: "Date", direction: "ascending" }],
        ...(startCursor ? { start_cursor: startCursor } : {})
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Notion query failed (${response.status}): ${body.slice(0, 500)}`);
    }
    const result = await response.json();
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor : undefined;
  } while (startCursor);
  return pages;
}

async function main() {
  const token = process.env.NOTION_TOKEN;
  const encodedKey = process.env.FITNESS_DASHBOARD_KEY;
  if (!token) throw new Error("NOTION_TOKEN is required.");
  decodeKey(encodedKey);

  const currentMonday = mondayOf(localDate());
  const historyStart = addDays(currentMonday, -56);
  const [gymPages, dailyPages] = await Promise.all([
    queryDataSource(GYM_DATA_SOURCE_ID, token, historyStart),
    queryDataSource(DAILY_DATA_SOURCE_ID, token, currentMonday)
  ]);
  const encrypted = encryptSummary(buildSummary(gymPages, dailyPages), encodedKey);
  await mkdir("fitness", { recursive: true });
  await writeFile("fitness/data.enc.json", `${JSON.stringify(encrypted)}\n`, { mode: 0o600 });
  console.log(`Encrypted aggregate written from ${gymPages.length} gym and ${dailyPages.length} daily records.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
