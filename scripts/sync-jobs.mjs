import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NOTION_VERSION = "2026-03-11";
const APPLICATIONS_DATA_SOURCE_ID = "391ac314-c1c8-807b-b921-000bb4d312fa";
const POTENTIAL_DATA_SOURCE_ID = "39dac314-c1c8-8099-945f-000b10563910";
const TIME_ZONE = "Europe/London";

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32) throw new Error("JOBS_DASHBOARD_KEY must be a base64url-encoded 32-byte key.");
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

function plain(items) {
  return (items || []).map(item => item.plain_text || item.text?.content || "").join("").trim();
}

function title(page, name) {
  return plain(property(page, name)?.title);
}

function text(page, name) {
  return plain(property(page, name)?.rich_text);
}

function select(page, name) {
  const value = property(page, name);
  return value?.select?.name || value?.status?.name || "";
}

function number(page, name) {
  const candidate = property(page, name)?.number;
  return Number.isFinite(Number(candidate)) ? Number(candidate) : null;
}

function date(page, name) {
  return property(page, name)?.date?.start || null;
}

function cleanLabel(value) {
  return String(value || "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function broadLocation(value) {
  const location = String(value || "").toLowerCase();
  if (!location) return "Not stated";
  const remote = location.includes("remote");
  const hybrid = location.includes("hybrid");
  const london = location.includes("london") || location.includes("city of london");
  if (remote && london) return "London / remote";
  if (hybrid && london) return "London hybrid";
  if (remote) return "Remote UK";
  if (hybrid) return "Hybrid UK";
  if (london) return "London";
  return "UK / other";
}

function splitApplication(application, position) {
  const separator = application.lastIndexOf(" — ");
  return {
    role: position || (separator >= 0 ? application.slice(0, separator) : application) || "Untitled role",
    company: separator >= 0 ? application.slice(separator + 3) : "Company not stated"
  };
}

function statusBucket(status) {
  const value = cleanLabel(status).toLowerCase();
  if (value.includes("offer")) return "offer";
  if (value.includes("rejected") || value.includes("withdrawn") || value === "done") return "closed";
  if (value.includes("interview") || value.includes("test") || value.includes("trial")) return "interview";
  if (value.includes("recruiter") || value === "in progress") return "response";
  if (value.includes("applied")) return value.includes("partially") ? "prospect" : "applied";
  return "prospect";
}

function dayValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function londonDay(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(`${map.year}-${map.month}-${map.day}T00:00:00Z`);
}

function daysBetween(later, earlier) {
  return Math.floor((later - earlier) / 86400000);
}

function monday(dateValue) {
  const date = new Date(dateValue);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function annualSalary(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 100) return Math.round(value * 40 * 52);
  if (value < 10000) return Math.round(value * 12);
  return Math.round(value);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function actionFor(job, today) {
  const next = dayValue(job.nextAction);
  const overdue = next && next < today;
  if (job.bucket === "offer") return "Review offer";
  if (job.bucket === "interview") return "Prepare interview";
  if (job.bucket === "response") return "Reply / prepare";
  if (job.bucket === "applied") return overdue ? "Follow up now" : "Follow up";
  if ((job.fitScore || 0) >= 90) return "Apply today";
  return "Review and apply";
}

function priorityScore(job, today) {
  const next = dayValue(job.nextAction);
  const overdueDays = next && next < today ? Math.min(30, daysBetween(today, next)) : 0;
  const dueSoon = next && next >= today ? Math.max(0, 14 - daysBetween(next, today)) : 0;
  const stage = { offer: 75, interview: 70, response: 55, applied: 35, prospect: 25 }[job.bucket] || 0;
  return stage + (job.fitScore || 0) * .45 + overdueDays * 4 + dueSoon * 2;
}

function formatDay(value) {
  const parsed = dayValue(value);
  if (!parsed) return "No date";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(parsed);
}

export function buildDashboard(applicationPages, potentialPages, now = new Date()) {
  const today = londonDay(now);
  const jobs = applicationPages.map(page => {
    const application = title(page, "Application");
    const roleCompany = splitApplication(application, text(page, "Position"));
    const status = cleanLabel(select(page, "Status")) || "Not started";
    return {
      application,
      ...roleCompany,
      area: cleanLabel(select(page, "Area")) || "Other",
      status,
      bucket: statusBucket(status),
      salary: annualSalary(number(page, "Salary")),
      location: broadLocation(text(page, "Location")),
      applied: date(page, "Applied"),
      nextAction: date(page, "Next Action"),
      cv: select(page, "CV Version") || "Not selected",
      fitScore: number(page, "Fit Score")
    };
  }).filter(job => job.application && job.application.toLowerCase() !== "new application");

  const active = jobs.filter(job => job.bucket !== "closed");
  const meaningfulPotential = potentialPages.map(page => ({
    name: title(page, "Name"),
    source: select(page, "Source") || "Not stated",
    received: date(page, "Received"),
    status: cleanLabel(select(page, "Status")) || "New"
  })).filter(item => item.name);

  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 6);
  const overdue = active.filter(job => dayValue(job.nextAction) && dayValue(job.nextAction) < today);
  const interviews = active.filter(job => job.bucket === "interview");
  const offers = active.filter(job => job.bucket === "offer");
  const applied7d = jobs.filter(job => {
    const applied = dayValue(job.applied);
    return applied && applied >= sevenDaysAgo && applied <= today;
  });

  const priority = active
    .filter(job => job.bucket !== "prospect" || (job.fitScore || 0) >= 80)
    .sort((a, b) => priorityScore(b, today) - priorityScore(a, today))
    .slice(0, 7)
    .map(job => ({
      role: job.role,
      company: job.company,
      area: job.area,
      status: job.status,
      fitScore: job.fitScore,
      nextAction: formatDay(job.nextAction),
      action: actionFor(job, today),
      overdue: Boolean(dayValue(job.nextAction) && dayValue(job.nextAction) < today)
    }));

  const pipelineOrder = ["prospect", "applied", "response", "interview", "offer"];
  const pipelineLabels = { prospect: "Ready to apply", applied: "Applied", response: "Recruiter response", interview: "Interview / test", offer: "Offer" };
  const pipeline = pipelineOrder.map(key => ({ key, label: pipelineLabels[key], count: active.filter(job => job.bucket === key).length }));

  const weekStart = monday(today);
  const weekly = Array.from({ length: 8 }, (_, index) => {
    const start = new Date(weekStart);
    start.setUTCDate(start.getUTCDate() - (7 * (7 - index)));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return {
      label: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(start),
      count: jobs.filter(job => {
        const applied = dayValue(job.applied);
        return applied && applied >= start && applied < end;
      }).length
    };
  });

  const areas = [...new Set(jobs.map(job => job.area))].map(area => {
    const rows = jobs.filter(job => job.area === area);
    const scored = rows.map(job => job.fitScore).filter(Number.isFinite);
    return {
      area,
      total: rows.length,
      active: rows.filter(job => job.bucket !== "closed").length,
      interviews: rows.filter(job => job.bucket === "interview").length,
      offers: rows.filter(job => job.bucket === "offer").length,
      averageFit: scored.length ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null
    };
  }).sort((a, b) => b.total - a.total);

  const cvPerformance = [...new Set(jobs.map(job => job.cv))].map(cv => {
    const rows = jobs.filter(job => job.cv === cv);
    return {
      cv,
      applications: rows.filter(job => job.applied || job.bucket !== "prospect").length,
      progressed: rows.filter(job => ["response", "interview", "offer"].includes(job.bucket)).length
    };
  }).filter(item => item.applications).sort((a, b) => b.applications - a.applications);

  const salaries = active.map(job => job.salary).filter(Number.isFinite);
  const highChance = active.filter(job => (job.fitScore || 0) >= 80)
    .sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0))
    .slice(0, 6)
    .map(job => ({ role: job.role, company: job.company, area: job.area, status: job.status, fitScore: job.fitScore }));

  const upcoming = active.filter(job => dayValue(job.nextAction) && dayValue(job.nextAction) >= today)
    .sort((a, b) => dayValue(a.nextAction) - dayValue(b.nextAction))
    .slice(0, 6)
    .map(job => ({ role: job.role, company: job.company, status: job.status, nextAction: formatDay(job.nextAction) }));

  const missing = {
    fitScore: active.filter(job => job.fitScore === null).length,
    nextAction: active.filter(job => !job.nextAction).length,
    salary: active.filter(job => job.salary === null).length,
    location: active.filter(job => job.location === "Not stated").length
  };

  const focus = overdue.length
    ? { title: "Clear overdue actions", detail: `${overdue.length} application${overdue.length === 1 ? " needs" : "s need"} attention before adding more roles.` }
    : interviews.length
      ? { title: "Prepare the live opportunities", detail: `${interviews.length} interview or assessment stage${interviews.length === 1 ? " is" : "s are"} currently open.` }
      : active.some(job => job.bucket === "prospect" && (job.fitScore || 0) >= 90)
        ? { title: "Apply to the strongest matches", detail: "There are 90+ Fit Score roles ready for a focused application." }
        : { title: "Build response momentum", detail: "Follow up active applications and add a small number of high-fit roles." };

  const updated = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(now);

  return {
    mode: "live",
    updated: `${updated} UK`,
    focus,
    counts: {
      tracked: jobs.length,
      active: active.length,
      applied7d: applied7d.length,
      interviews: interviews.length,
      offers: offers.length,
      overdue: overdue.length,
      potential: meaningfulPotential.filter(item => item.status.toLowerCase() !== "done").length
    },
    pipeline,
    weekly,
    areas,
    cvPerformance,
    salary: { median: median(salaries), known: salaries.length, active: active.length },
    priority,
    highChance,
    upcoming,
    potential: meaningfulPotential.slice(0, 5),
    missing
  };
}

async function queryDataSource(token, dataSourceId, sorts = []) {
  const pages = [];
  let startCursor;
  do {
    const response = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
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
  const token = process.env.JOBS_NOTION_TOKEN;
  const key = process.env.JOBS_DASHBOARD_KEY;
  if (!token) throw new Error("JOBS_NOTION_TOKEN is required.");
  decodeKey(key);
  const [applications, potential] = await Promise.all([
    queryDataSource(token, APPLICATIONS_DATA_SOURCE_ID, [{ property: "Applied", direction: "descending" }]),
    queryDataSource(token, POTENTIAL_DATA_SOURCE_ID, [{ property: "Received", direction: "descending" }])
  ]);
  const dashboard = buildDashboard(applications, potential);
  if (!dashboard.counts.tracked) throw new Error("No non-placeholder Job Applications were returned.");
  await mkdir("jobs", { recursive: true });
  await writeFile("jobs/data.enc.json", `${JSON.stringify(encryptDashboard(dashboard, key))}\n`, { mode: 0o600 });
  console.log(`Encrypted job-search dashboard written from ${dashboard.counts.tracked} applications.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
