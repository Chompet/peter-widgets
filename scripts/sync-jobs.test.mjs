import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { buildDashboard, encryptDashboard } from "./sync-jobs.mjs";

const rich = value => ({ type: "rich_text", rich_text: value ? [{ plain_text: value }] : [] });
const title = value => ({ type: "title", title: value ? [{ plain_text: value }] : [] });
const select = value => ({ type: "select", select: value ? { name: value } : null });
const status = value => ({ type: "status", status: value ? { name: value } : null });
const number = value => ({ type: "number", number: value });
const date = value => ({ type: "date", date: value ? { start: value } : null });

function application(name, role, area, stage, fit, applied, nextAction, salary = null, location = "London hybrid") {
  return { properties: {
    Application: title(name), Position: rich(role), Area: select(area), Status: status(stage),
    "Fit Score": number(fit), Applied: date(applied), "Next Action": date(nextAction),
    Salary: number(salary), Location: rich(location), "CV Version": select(area.includes("IT") ? "IT Support" : "Hospitality"),
    Notes: rich("PRIVATE interview notes"), Recruiter: { relation: [{ id: "private-contact" }] },
    "Source Email": { url: "https://mail.example/private" }, "Job URL": { url: "https://job.example/private" },
    "Fit Rationale": rich("PRIVATE personal rationale")
  } };
}

test("builds an action-oriented dashboard and excludes sensitive properties", () => {
  const pages = [
    application("Support Analyst — Acme", "Support Analyst", "💻 IT", "🟡 Applied", 88, "2026-07-16", "2026-07-17", 35000),
    application("General Manager — Bistro", "General Manager", "🍽 Hospitality", "🟠 First Interview", 92, "2026-07-14", "2026-07-18", 3000, "10 Private Street, London"),
    application("Service Desk — Example", "Service Desk", "💻 IT", "Not started", 95, null, "2026-07-16"),
    application("Old role — Closed", "Old role", "💻 IT", "🔴 Rejected", 70, "2026-07-01", null),
    application("New Application", "", "🍽 Hospitality", "Not started", null, null, null)
  ];
  const potential = [{ properties: { Name: title("Desktop Support — ExampleCo"), Source: select("LinkedIn"), Received: date("2026-07-17"), Status: status("New"), Link: { url: "https://private.example" }, "Email Subject": rich("private email") } }];
  const result = buildDashboard(pages, potential, new Date("2026-07-17T12:00:00Z"));
  assert.equal(result.counts.tracked, 4);
  assert.equal(result.counts.active, 3);
  assert.equal(result.counts.interviews, 1);
  assert.equal(result.counts.potential, 1);
  assert.equal(result.salary.median, 35500);
  assert.equal(result.priority[0].action, "Prepare interview");
  assert.equal(result.priority.some(item => item.overdue), true);
  assert.equal(result.areas.find(item => item.area === "IT").total, 3);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("https://"), false);
  assert.equal(JSON.stringify(result).includes("private-contact"), false);
  assert.equal(JSON.stringify(result).includes("Private Street"), false);
});

test("encrypts with AES-256-GCM", () => {
  const key = randomBytes(32);
  const data = { counts: { active: 12 }, priority: [{ role: "Support Analyst" }] };
  const payload = encryptDashboard(data, key.toString("base64url"));
  const bytes = Buffer.from(payload.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  const clear = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(clear.toString("utf8")), data);
});
