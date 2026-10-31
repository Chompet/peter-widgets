import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { buildSummary, buildHistory, encryptSummary } from "./sync-fitness.mjs";

const number = value => ({ type: "number", number: value });
const checkbox = value => ({ type: "checkbox", checkbox: value });
const date = value => ({ type: "date", date: { start: value, end: null } });
const page = (day, properties = {}) => ({ properties: { Date: date(day), ...properties } });

test("builds only privacy-safe weekly fitness aggregates", () => {
  const gym = [page("2026-07-15", {
    "Rowing Time (min)": number(10),
    "Running Time (min)": number(15),
    "Strength Duration (min)": number(30),
    "Rowing Distance (km)": number(2),
    "Running Distance (km)": number(3),
    "Leg Press (Kg)": number(50),
    "Leg Press Sets": number(3),
    "Leg Press Reps": number(10),
    "Body Weight (kg)": number(999)
  })];
  const daily = [page("2026-07-16", {
    Running: checkbox(true),
    "Running (min)": number(20),
    "Running Distance (km)": number(4),
    Mood: { type: "select", select: { name: "Private" } },
    Notes: { type: "rich_text", rich_text: [{ plain_text: "Private" }] }
  })];
  const result = buildSummary(gym, daily, new Date("2026-07-17T12:00:00Z"));

  assert.equal(result.summary.cardioEquivalentMinutes, 80);
  assert.equal(result.summary.strengthDays, 1);
  assert.equal(result.summary.activeDays, 2);
  assert.equal(result.summary.strengthVolumeKg, 1500);
  assert.equal(result.distance.runningKm, 7);
  assert.equal(JSON.stringify(result).includes("Private"), false);
  assert.equal(JSON.stringify(result).includes("999"), false);
});

test("AES-256-GCM payload decrypts only with the dashboard key", () => {
  const key = randomBytes(32);
  const summary = { mode: "live", summary: { activeDays: 3 } };
  const payload = encryptSummary(summary, key.toString("base64url"));
  const ciphertext = Buffer.from(payload.ciphertext, "base64url");
  const encrypted = ciphertext.subarray(0, -16);
  const tag = ciphertext.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  assert.deepEqual(JSON.parse(decrypted.toString("utf8")), summary);
  assert.equal(payload.alg, "A256GCM");
});

test("history splits cross-month weeks and excludes future entries", () => {
 const result = buildHistory([page("2025-12-31"),page("2026-01-01"),page("2026-10-30"),page("2027-01-01")],[],new Date("2026-10-31T12:00:00Z"));
 assert.equal(result.periods.find(p=>p.key==="2026" && p.kind==="year").summary.gymSessions,2);
 assert.equal(result.periods.find(p=>p.key==="2025-12").summary.gymSessions,1);
 assert.equal(result.periods.some(p=>p.key==="2027"),false);
 assert.equal(result.history.reduce((n,p)=>n+p.summary.gymSessions,0),3);
});
