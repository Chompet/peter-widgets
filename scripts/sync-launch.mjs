import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NOTION_VERSION = "2026-03-11";
const LAUNCH_DATA_SOURCE_ID = "392ac314-c1c8-8026-b767-000b22b3e034";
const SONGS_DATA_SOURCE_ID = "392ac314-c1c8-805a-9b84-000b3fd94e85";
const ARTWORK_DATA_SOURCE_ID = "392ac314-c1c8-80a1-baa2-000bb72211ce";
const VIDEOS_DATA_SOURCE_ID = "982ac314-c1c8-8233-88d5-07f0ba8f4305";
const TIME_ZONE = "Europe/London";

function base64url(buffer) { return Buffer.from(buffer).toString("base64url"); }
function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32) throw new Error("LAUNCH_DASHBOARD_KEY must be a base64url-encoded 32-byte key.");
  return key;
}

export function encryptDashboard(data, encodedKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return { v: 1, alg: "A256GCM", iv: base64url(iv), ciphertext: base64url(Buffer.concat([encrypted, cipher.getAuthTag()])) };
}

function property(page, name) { return page?.properties?.[name]; }
function plain(items) { return (items || []).map(item => item.plain_text || item.text?.content || "").join("").trim(); }
function title(page, name) { return plain(property(page, name)?.title); }
function text(page, name) { return plain(property(page, name)?.rich_text); }
function select(page, name) {
  const value = property(page, name);
  return value?.select?.name || value?.status?.name || "";
}
function multiSelect(page, name) { return (property(page, name)?.multi_select || []).map(item => cleanLabel(item.name)); }
function number(page, name) {
  const value = property(page, name)?.number;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
function checkbox(page, name) { return property(page, name)?.checkbox === true; }
function date(page, name) { return property(page, name)?.date?.start || null; }
function cleanLabel(value) { return String(value || "").replace(/^[^A-Za-z0-9]+/, "").replace(/\s+/g, " ").trim(); }

function stageScore(value) {
  const status = cleanLabel(value).toLowerCase();
  if (status === "done" || status === "finished" || status === "exported" || status === "published" || status === "complete") return 1;
  if (status.includes("revision")) return .75;
  if (status.includes("in progress") || status.includes("sketching")) return .5;
  if (status.includes("ready to check")) return .9;
  if (status.includes("blocked")) return .25;
  return 0;
}

function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function percent(value) { return Math.round(Math.max(0, Math.min(1, value)) * 100); }
function priorityRank(value) { return ({ Critical: 0, High: 1, Medium: 2, Low: 3 })[cleanLabel(value)] ?? 4; }
function statusRank(value) {
  const status = cleanLabel(value).toLowerCase();
  if (status.includes("blocked")) return 0;
  if (status.includes("in progress")) return 1;
  if (status.includes("ready")) return 2;
  if (status.includes("planned")) return 3;
  return 4;
}
function dateValue(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.valueOf()) ? parsed : null;
}
function formatDate(value) {
  const parsed = dateValue(value);
  return parsed ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(parsed) : "No date";
}

function weightedProgress(items) {
  const weighted = items.filter(item => item.required);
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  return total ? weighted.reduce((sum, item) => sum + item.weight * item.score, 0) / total : 0;
}

function assetSummary(pages, titleName, statusName) {
  const items = pages.map(page => ({ name: title(page, titleName) || "Untitled", status: cleanLabel(select(page, statusName)) || "Planned", score: stageScore(select(page, statusName)) }));
  return {
    total: items.length,
    complete: items.filter(item => item.score === 1).length,
    active: items.filter(item => item.score > 0 && item.score < 1).length,
    progress: percent(average(items.map(item => item.score))),
    items
  };
}

export function buildDashboard(launchPages, songPages, artworkPages, videoPages, now = new Date()) {
  const deliverables = launchPages.map(page => {
    const status = cleanLabel(select(page, "Status")) || "Planned";
    return {
      name: title(page, "Name") || "Untitled deliverable",
      category: cleanLabel(select(page, "Category")) || "Other",
      status,
      priority: cleanLabel(select(page, "Priority")) || "Medium",
      phase: cleanLabel(select(page, "Phase")) || "Foundation",
      required: checkbox(page, "Required"),
      weight: Math.max(0, number(page, "Weight") || 1),
      due: date(page, "Due"),
      channels: multiSelect(page, "Channel"),
      score: stageScore(status)
    };
  }).filter(item => item.name !== "Untitled deliverable");

  const readiness = percent(weightedProgress(deliverables));
  const required = deliverables.filter(item => item.required);
  const incomplete = required.filter(item => item.score < 1);
  const categories = [...new Set(deliverables.map(item => item.category))].map(category => {
    const rows = deliverables.filter(item => item.category === category);
    return {
      category,
      progress: percent(weightedProgress(rows)),
      required: rows.filter(item => item.required).length,
      complete: rows.filter(item => item.required && item.score === 1).length,
      optional: rows.filter(item => !item.required).length
    };
  });
  const phases = ["Foundation", "Pre-launch", "Launch week", "Post-launch"].map(phase => {
    const rows = deliverables.filter(item => item.phase === phase);
    return { phase, progress: percent(weightedProgress(rows)), total: rows.length, complete: rows.filter(item => item.required && item.score === 1).length };
  });

  const releaseRow = deliverables.find(item => item.name.toLowerCase().includes("release date confirmed"));
  const releaseDate = releaseRow?.due || null;
  const daysToRelease = releaseDate ? Math.ceil((dateValue(releaseDate) - now) / 86400000) : null;
  const actions = [...incomplete].sort((a, b) =>
    priorityRank(a.priority) - priorityRank(b.priority) ||
    statusRank(a.status) - statusRank(b.status) ||
    (dateValue(a.due)?.valueOf() || Infinity) - (dateValue(b.due)?.valueOf() || Infinity)
  ).slice(0, 8).map(({ score, weight, ...item }) => ({ ...item, dueLabel: formatDate(item.due) }));
  const blockers = deliverables.filter(item => item.required && cleanLabel(item.status).toLowerCase().includes("blocked"))
    .map(item => ({ name: item.name, category: item.category, priority: item.priority }));

  const mix = percent(average(songPages.map(page => stageScore(select(page, "Mix Status")))));
  const master = percent(average(songPages.map(page => stageScore(select(page, "Master Status")))));
  const songArtwork = percent(average(songPages.map(page => stageScore(select(page, "Artwork Status")))));
  const production = Math.round(mix * .45 + master * .35 + songArtwork * .20);
  const artwork = assetSummary(artworkPages, "Artwork", "Status");
  const videos = assetSummary(videoPages, "Video", "Status");

  const focus = blockers.length
    ? { title: "Unblock the launch", detail: `${blockers.length} required deliverable${blockers.length === 1 ? " is" : "s are"} blocked.` }
    : actions.length
      ? { title: actions[0].name, detail: `${actions[0].priority} priority · ${actions[0].category} · ${actions[0].status}` }
      : { title: "Launch ready", detail: "All required launch deliverables are complete." };
  const updated = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);

  return {
    mode: "live",
    updated: `${updated} UK`,
    readiness,
    release: { date: releaseDate, label: releaseDate ? formatDate(releaseDate) : "Set the target date", days: daysToRelease },
    focus,
    counts: {
      deliverables: deliverables.length,
      required: required.length,
      complete: required.filter(item => item.score === 1).length,
      inProgress: required.filter(item => item.score > 0 && item.score < 1).length,
      blocked: blockers.length,
      optional: deliverables.filter(item => !item.required).length
    },
    production: { overall: production, mixing: mix, mastering: master, artwork: songArtwork, tracks: songPages.length },
    categories,
    phases,
    actions,
    blockers,
    assets: {
      artwork: { total: artwork.total, complete: artwork.complete, active: artwork.active, progress: artwork.progress },
      video: { total: videos.total, complete: videos.complete, active: videos.active, progress: videos.progress, optional: true }
    }
  };
}

async function queryDataSource(token, dataSourceId, sorts = []) {
  const pages = [];
  let startCursor;
  do {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 100, sorts, ...(startCursor ? { start_cursor: startCursor } : {}) })
    });
    if (!response.ok) throw new Error(`Notion query failed for ${dataSourceId} (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const result = await response.json();
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor : undefined;
  } while (startCursor);
  return pages;
}

async function main() {
  const token = process.env.LAUNCH_NOTION_TOKEN;
  const key = process.env.LAUNCH_DASHBOARD_KEY;
  if (!token) throw new Error("LAUNCH_NOTION_TOKEN is required.");
  decodeKey(key);
  const [launch, songs, artwork, videos] = await Promise.all([
    queryDataSource(token, LAUNCH_DATA_SOURCE_ID, [{ property: "Priority", direction: "ascending" }]),
    queryDataSource(token, SONGS_DATA_SOURCE_ID, [{ property: "Track Number", direction: "ascending" }]),
    queryDataSource(token, ARTWORK_DATA_SOURCE_ID),
    queryDataSource(token, VIDEOS_DATA_SOURCE_ID)
  ]);
  const dashboard = buildDashboard(launch, songs, artwork, videos);
  if (!dashboard.counts.deliverables) throw new Error("No Urbanus Launch Plan deliverables were returned.");
  if (dashboard.production.tracks !== 12) throw new Error(`Expected 12 songs, received ${dashboard.production.tracks}.`);
  await mkdir("launch", { recursive: true });
  await writeFile("launch/data.enc.json", `${JSON.stringify(encryptDashboard(dashboard, key))}\n`, { mode: 0o600 });
  console.log(`Encrypted launch dashboard written from ${dashboard.counts.deliverables} deliverables.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
