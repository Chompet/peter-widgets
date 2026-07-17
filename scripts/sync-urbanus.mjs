import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NOTION_VERSION = "2026-03-11";
const SONGS_DATA_SOURCE_ID = "392ac314-c1c8-805a-9b84-000b3fd94e85";
const TIME_ZONE = "Europe/London";

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32) throw new Error("URBANUS_DASHBOARD_KEY must be a base64url-encoded 32-byte key.");
  return key;
}

export function encryptDashboard(data, encodedKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(encodedKey), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "A256GCM",
    iv: base64url(iv),
    ciphertext: base64url(Buffer.concat([encrypted, cipher.getAuthTag()]))
  };
}

function property(page, name) {
  return page?.properties?.[name];
}

function title(page) {
  return (property(page, "Title")?.title || []).map(item => item.plain_text || item.text?.content || "").join("");
}

function text(page, name) {
  return (property(page, name)?.rich_text || []).map(item => item.plain_text || item.text?.content || "").join("");
}

function select(page, name) {
  return property(page, name)?.select?.name || "";
}

function number(page, name) {
  const value = property(page, name);
  const candidate = value?.number ?? value?.formula?.number ?? value?.rollup?.number;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
}

function cleanStatus(value) {
  return String(value || "Not Started")
    .replace(/^[^A-Za-z]+/, "")
    .replace(/\s+Yet$/i, "")
    .replace(/^Needs Revision$/i, "Revision needed");
}

function fallbackScore(status) {
  const value = cleanStatus(status).toLowerCase();
  if (value === "done" || value === "released" || value === "approved") return 100;
  if (value === "in progress" || value === "ready to check" || value === "notes recorded") return 50;
  if (value.includes("revision")) return 25;
  return 0;
}

function score(page, formulaName, statusName) {
  const formula = number(page, formulaName);
  if (formula === null) return fallbackScore(select(page, statusName));
  return Math.round(Math.max(0, Math.min(100, formula <= 1 ? formula * 100 : formula)));
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function nextFocus(tracks, progress) {
  const revisions = tracks.filter(track => Object.values(track.status).some(value => value === "Revision needed"));
  if (revisions.length) return { label: "Resolve revisions", detail: revisions.map(track => track.title).join(", ") };
  if (progress.mixing < 100) return { label: "Finish all mixes", detail: `${tracks.filter(track => track.status.mix !== "Done").length} tracks still in the mixing stage` };
  if (tracks.some(track => track.review !== "Approved")) return { label: "Final listening pass", detail: "Approve all twelve mixes before mastering" };
  if (progress.mastering < 100) return { label: "Master the album", detail: `${tracks.filter(track => track.status.master !== "Done").length} masters remaining` };
  if (progress.artwork < 100) return { label: "Finish the artwork", detail: `${tracks.filter(track => track.status.artwork !== "Done").length} artwork items remaining` };
  if (progress.video < 100) return { label: "Complete the visuals", detail: `${tracks.filter(track => track.status.video !== "Done").length} video items remaining` };
  return { label: "Release ready", detail: "Production stages are complete" };
}

export function buildDashboard(pages, now = new Date()) {
  const tracks = pages.map(page => ({
    number: number(page, "Track Number") || 0,
    title: title(page) || "Untitled",
    version: text(page, "Current Mix Version"),
    main: cleanStatus(select(page, "Main Status")),
    review: cleanStatus(select(page, "Review Status")),
    status: {
      mix: cleanStatus(select(page, "Mix Status")),
      master: cleanStatus(select(page, "Master Status")),
      artwork: cleanStatus(select(page, "Artwork Status")),
      video: cleanStatus(select(page, "Video Status"))
    },
    scores: {
      mix: score(page, "Mix Score", "Mix Status"),
      master: score(page, "Master Score ", "Master Status"),
      artwork: score(page, "Artwork Score", "Artwork Status")
    }
  })).sort((a, b) => a.number - b.number);

  const progress = {
    mixing: average(tracks.map(track => track.scores.mix)),
    mastering: average(tracks.map(track => track.scores.master)),
    artwork: average(tracks.map(track => track.scores.artwork)),
    video: average(tracks.map(track => fallbackScore(track.status.video)))
  };
  const productionScores = pages.map(page => number(page, "Production %")).filter(value => value !== null).map(value => value <= 1 ? value * 100 : value);
  const overall = productionScores.length ? average(productionScores) : average([progress.mixing, progress.mastering, progress.artwork]);
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
    album: "Urbanus Fabulae",
    subtitle: "A 12-track journey through life",
    updated: `${updated} UK`,
    overall,
    progress,
    counts: {
      tracks: tracks.length,
      mixed: tracks.filter(track => track.status.mix === "Done").length,
      mastered: tracks.filter(track => track.status.master === "Done").length,
      artwork: tracks.filter(track => track.status.artwork === "Done").length,
      released: tracks.filter(track => track.main === "Released").length
    },
    focus: nextFocus(tracks, progress),
    tracks: tracks.map(({ scores, ...track }) => track)
  };
}

async function querySongs(token) {
  const pages = [];
  let startCursor;
  do {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${SONGS_DATA_SOURCE_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        page_size: 100,
        sorts: [{ property: "Track Number", direction: "ascending" }],
        ...(startCursor ? { start_cursor: startCursor } : {})
      })
    });
    if (!response.ok) throw new Error(`Notion query failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const result = await response.json();
    pages.push(...result.results);
    startCursor = result.has_more ? result.next_cursor : undefined;
  } while (startCursor);
  return pages;
}

async function main() {
  const token = process.env.URBANUS_NOTION_TOKEN;
  const key = process.env.URBANUS_DASHBOARD_KEY;
  if (!token) throw new Error("URBANUS_NOTION_TOKEN is required.");
  decodeKey(key);
  const pages = await querySongs(token);
  const dashboard = buildDashboard(pages);
  if (dashboard.counts.tracks !== 12) throw new Error(`Expected 12 tracks, received ${dashboard.counts.tracks}.`);
  await mkdir("urbanus", { recursive: true });
  await writeFile("urbanus/data.enc.json", `${JSON.stringify(encryptDashboard(dashboard, key))}\n`, { mode: 0o600 });
  console.log(`Encrypted Urbanus dashboard written from ${dashboard.counts.tracks} tracks.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
