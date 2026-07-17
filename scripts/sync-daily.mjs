import { createCipheriv, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NOTION_VERSION = "2026-03-11";
const TASKS_DATA_SOURCE_ID = "391ac314-c1c8-80a7-845c-000b56cefd5f";
const EVENTS_DATA_SOURCE_ID = "397ac314-c1c8-8008-95c7-000bb11d2e04";
const WORK_LOG_DATA_SOURCE_ID = "392ac314-c1c8-8093-976d-000be6594180";
const TIME_ZONE = "Europe/London";

function base64url(buffer) { return Buffer.from(buffer).toString("base64url"); }
function decodeKey(value) {
  const key = Buffer.from(String(value || ""), "base64url");
  if (key.length !== 32) throw new Error("DAILY_DASHBOARD_KEY must be a base64url-encoded 32-byte key.");
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
function select(page, name) { const value = property(page, name); return value?.select?.name || value?.status?.name || ""; }
function multi(page, name) { return (property(page, name)?.multi_select || []).map(item => cleanLabel(item.name)); }
function checkbox(page, name) { return property(page, name)?.checkbox === true; }
function date(page, name) { return property(page, name)?.date?.start || null; }
function cleanLabel(value) { return String(value || "").replace(/^[^A-Za-z0-9]+/, "").replace(/\s+/g, " ").trim(); }

function dayKey(value, timeZone = TIME_ZONE) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(parsed);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}
function addDays(day, amount) { const value = new Date(`${day}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + amount); return value.toISOString().slice(0, 10); }
function dayDiff(later, earlier) { return Math.round((new Date(`${later}T00:00:00Z`) - new Date(`${earlier}T00:00:00Z`)) / 86400000); }
function formatDay(day, includeWeekday = false) {
  if (!day) return "No date";
  return new Intl.DateTimeFormat("en-GB", { timeZone:"UTC", ...(includeWeekday ? { weekday:"short" } : {}), day:"numeric", month:"short" }).format(new Date(`${day}T00:00:00Z`));
}
function formatTime(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.valueOf()) ? new Intl.DateTimeFormat("en-GB", { timeZone:TIME_ZONE, hour:"2-digit", minute:"2-digit", hour12:false }).format(parsed) : "All day";
}
function estimateMinutes(value) { return ({ "5 min":5, "15 min":15, "30 min":30, "1 hour":60, "2+ hours":120 })[cleanLabel(value)] || 0; }
function priorityRank(value) { return ({ Critical:4, High:3, Normal:2, Low:1 })[cleanLabel(value)] || 0; }
function taskScore(task, today) {
  const overdueDays = task.due && task.due < today ? Math.min(30, dayDiff(today, task.due)) : 0;
  return (task.mission ? 120 : 0) + (task.nextAction ? 75 : 0) + (task.status === "In Progress" ? 65 : 0) + priorityRank(task.priority) * 14 + overdueDays * 5 + (task.due === today ? 45 : 0) + (task.due === addDays(today, 1) ? 15 : 0);
}
function durationMinutes(start, finish, now) {
  const from = start ? new Date(start) : null;
  const to = finish ? new Date(finish) : now;
  if (!from || Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) return 0;
  return Math.max(0, Math.min(720, Math.round((to - from) / 60000)));
}

export function buildDashboard(taskPages, eventPages, workPages, now = new Date()) {
  const today = dayKey(now.toISOString());
  const tasks = taskPages.map(page => ({
    name: title(page, "Task") || "Untitled task",
    status: cleanLabel(select(page, "Status")) || "Not Started",
    priority: cleanLabel(select(page, "Priority")) || "Normal",
    area: cleanLabel(select(page, "Area")) || "Unassigned",
    estimate: cleanLabel(select(page, "Estimate")) || "Not estimated",
    energy: cleanLabel(select(page, "Energy")) || "Not set",
    due: dayKey(date(page, "Due")),
    completedOn: dayKey(date(page, "Completed On")),
    mission: checkbox(page, "Mission"),
    nextAction: checkbox(page, "Next Action")
  })).filter(task => task.name !== "Untitled task");
  const active = tasks.filter(task => !["Done", "Cancelled"].includes(task.status));
  const overdue = active.filter(task => task.due && task.due < today);
  const dueToday = active.filter(task => task.due === today);
  const completedToday = tasks.filter(task => task.status === "Done" && task.completedOn === today);
  const ranked = [...active].sort((a, b) => taskScore(b, today) - taskScore(a, today) || (a.due || "9999").localeCompare(b.due || "9999"));
  const queue = ranked.slice(0, 8).map(task => ({
    name: task.name, status: task.status, priority: task.priority, area: task.area, estimate: task.estimate,
    energy: task.energy, due: task.due, dueLabel: task.due ? formatDay(task.due) : "No date",
    overdue: Boolean(task.due && task.due < today), mission: task.mission, nextAction: task.nextAction
  }));
  const focusTask = ranked[0];
  const focus = focusTask ? {
    title: focusTask.name,
    detail: `${focusTask.mission ? "Mission · " : focusTask.nextAction ? "Next action · " : ""}${focusTask.priority} · ${focusTask.area} · ${focusTask.estimate}${focusTask.due ? ` · ${focusTask.due < today ? "overdue " : "due "}${formatDay(focusTask.due)}` : ""}`
  } : { title:"The deck is clear", detail:"No active task is currently competing for attention." };

  const energyOrder = ["Deep Focus", "Normal", "Easy", "Not set"];
  const energy = energyOrder.map(label => {
    const rows = active.filter(task => task.energy === label);
    return { label, count:rows.length, tasks:rows.sort((a,b) => taskScore(b,today)-taskScore(a,today)).slice(0,3).map(task => task.name) };
  });
  const todaySet = new Set([...overdue, ...dueToday, ...active.filter(task => task.mission || task.nextAction)]);
  const workloadMinutes = [...todaySet].reduce((sum, task) => sum + estimateMinutes(task.estimate), 0);

  const events = eventPages.map(page => ({
    name:title(page,"Name") || "Untitled event", start:date(page,"When"), end:property(page,"When")?.date?.end || null,
    day:dayKey(date(page,"When")), area:cleanLabel(select(page,"Area")) || "Other",
    type:cleanLabel(select(page,"Event Type")) || "Event", confirmed:checkbox(page,"Confirmed"), completed:checkbox(page,"Completed")
  })).filter(event => event.name !== "Untitled event" && !event.completed);
  const todayEvents = events.filter(event => event.day === today).sort((a,b) => String(a.start).localeCompare(String(b.start))).map(event => ({ name:event.name, time:formatTime(event.start), end:event.end ? formatTime(event.end) : null, area:event.area, type:event.type, confirmed:event.confirmed }));
  const weekEnd = addDays(today, 7);
  const upcoming = events.filter(event => event.day && event.day > today && event.day <= weekEnd).sort((a,b) => String(a.start).localeCompare(String(b.start))).slice(0,8).map(event => ({ name:event.name, day:formatDay(event.day,true), time:formatTime(event.start), area:event.area, type:event.type, confirmed:event.confirmed }));

  const sessions = workPages.map(page => {
    const started = property(page,"Started")?.created_time || date(page,"Started") || null;
    const finished = date(page,"Finished");
    return { name:title(page,"Title") || "Untitled session", started, finished, day:dayKey(started), area:cleanLabel(select(page,"Area")) || "General", categories:multi(page,"Category"), status:cleanLabel(select(page,"Status")) || "", goal:checkbox(page,"Goal of the session achieved?"), minutes:durationMinutes(started,finished,now) };
  }).filter(session => session.day === today && session.name !== "Untitled session");
  const workMinutes = sessions.reduce((sum, session) => sum + session.minutes, 0);
  const areas = [...new Set(sessions.map(session => session.area))].map(area => ({ area, minutes:sessions.filter(session => session.area === area).reduce((sum,session)=>sum+session.minutes,0) })).sort((a,b)=>b.minutes-a.minutes);
  const recentSessions = [...sessions].sort((a,b)=>String(b.started).localeCompare(String(a.started))).slice(0,5).map(session => ({ name:session.name, area:session.area, minutes:session.minutes, goal:session.goal, running:!session.finished && session.status === "Running", started:formatTime(session.started) }));

  const updated = new Intl.DateTimeFormat("en-GB", { timeZone:TIME_ZONE, day:"numeric", month:"short", hour:"2-digit", minute:"2-digit", hour12:false }).format(now);
  return {
    mode:"live", today, dateLabel:new Intl.DateTimeFormat("en-GB", { timeZone:TIME_ZONE, weekday:"long", day:"numeric", month:"long" }).format(now), updated:`${updated} UK`, focus,
    counts:{ active:active.length, overdue:overdue.length, dueToday:dueToday.length, inProgress:active.filter(task=>task.status==="In Progress").length, missions:active.filter(task=>task.mission).length, nextActions:active.filter(task=>task.nextAction).length, completedToday:completedToday.length },
    workload:{ minutes:workloadMinutes, label:workloadMinutes ? `${Math.floor(workloadMinutes/60)}h ${workloadMinutes%60}m`.replace(/^0h /,"") : "0m" },
    queue, energy, schedule:{ today:todayEvents, upcoming },
    work:{ minutes:workMinutes, label:`${Math.floor(workMinutes/60)}h ${workMinutes%60}m`.replace(/^0h /,""), sessions:sessions.length, goals:sessions.filter(session=>session.goal).length, running:sessions.filter(session=>!session.finished && session.status==="Running").length, areas, recent:recentSessions },
    quality:{ missingDue:active.filter(task=>!task.due).length, missingEstimate:active.filter(task=>task.estimate==="Not estimated").length, missingEnergy:active.filter(task=>task.energy==="Not set").length, unselected:active.filter(task=>!task.mission&&!task.nextAction).length }
  };
}

async function queryDataSource(token, id) {
  const pages=[]; let cursor;
  do {
    const response=await fetch(`https://api.notion.com/v1/data_sources/${id}/query`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Notion-Version":NOTION_VERSION,"Content-Type":"application/json"},body:JSON.stringify({page_size:100,...(cursor?{start_cursor:cursor}:{})})});
    if(!response.ok) throw new Error(`Notion query failed for ${id} (${response.status}): ${(await response.text()).slice(0,500)}`);
    const result=await response.json(); pages.push(...result.results); cursor=result.has_more?result.next_cursor:undefined;
  } while(cursor);
  return pages;
}
async function main(){
  const token=process.env.DAILY_NOTION_TOKEN; const key=process.env.DAILY_DASHBOARD_KEY;
  if(!token) throw new Error("DAILY_NOTION_TOKEN is required."); decodeKey(key);
  const [tasks,events,work]=await Promise.all([queryDataSource(token,TASKS_DATA_SOURCE_ID),queryDataSource(token,EVENTS_DATA_SOURCE_ID),queryDataSource(token,WORK_LOG_DATA_SOURCE_ID)]);
  const dashboard=buildDashboard(tasks,events,work);
  await mkdir("daily",{recursive:true}); await writeFile("daily/data.enc.json",`${JSON.stringify(encryptDashboard(dashboard,key))}\n`,{mode:0o600});
  console.log(`Encrypted Daily Mission Control written from ${tasks.length} tasks, ${events.length} events and ${work.length} work sessions.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(error=>{console.error(error.message);process.exitCode=1;});}
