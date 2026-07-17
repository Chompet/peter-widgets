import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { buildDashboard, encryptDashboard } from "./sync-launch.mjs";

const rich = value => ({ type:"rich_text", rich_text:value ? [{ plain_text:value }] : [] });
const title = value => ({ type:"title", title:value ? [{ plain_text:value }] : [] });
const select = value => ({ type:"select", select:value ? { name:value } : null });
const number = value => ({ type:"number", number:value });
const checkbox = value => ({ type:"checkbox", checkbox:value });
const date = value => ({ type:"date", date:value ? { start:value } : null });
const multi = values => ({ type:"multi_select", multi_select:values.map(name => ({ name })) });

function deliverable(name, status, required, weight, priority = "🟠 High") {
  return { properties:{ Name:title(name), Category:select("Video & Teasers"), Status:select(status), Priority:select(priority), Phase:select("Pre-launch"), Required:checkbox(required), Weight:number(weight), Due:date(null), Channel:multi(["Instagram"]), Notes:rich("PRIVATE launch note"), "Working Link":{ url:"https://private.example" }, "Definition of Done":rich("PRIVATE detail") } };
}
function song(mix, master, art, video) { return { properties:{ "Mix Status":select(mix), "Master Status":select(master), "Artwork Status":select(art), "Video Status":select(video), Title:title("PRIVATE song title"), Notes:rich("PRIVATE song note") } }; }
function asset(nameProp, name, status) { return { properties:{ [nameProp]:title(name), Status:select(status), Notes:rich("PRIVATE asset note"), "File Location":rich("PRIVATE file path") } }; }

test("optional media never lowers readiness and private fields are excluded", () => {
  const launch = [
    deliverable("Required teaser", "✅ Complete", true, 10),
    deliverable("Optional music videos", "⚪ Planned", false, 100)
  ];
  const songs = Array.from({length:12}, () => song("🟢Done", "🟢Done", "🟢Done", "🟠Not Started Yet"));
  const result = buildDashboard(launch, songs, [asset("Artwork", "Cover", "✅ Finished")], [asset("Video", "Trailer", "💭 Idea")], new Date("2026-07-17T12:00:00Z"));
  assert.equal(result.readiness, 100);
  assert.equal(result.production.overall, 100);
  assert.equal(result.assets.video.optional, true);
  assert.equal(result.counts.optional, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("https://"), false);
});

test("uses weighted required gates and revision-aware production scores", () => {
  const launch = [deliverable("Critical gate", "🔵 In Progress", true, 9, "🔴 Critical"), deliverable("Small gate", "✅ Complete", true, 1)];
  const songs = Array.from({length:12}, () => song("🔴Revision needed", "🟠Not Started Yet", "🟠Not Started Yet", "🟢Done"));
  const result = buildDashboard(launch, songs, [], [], new Date("2026-07-17T12:00:00Z"));
  assert.equal(result.readiness, 55);
  assert.equal(result.production.mixing, 75);
  assert.equal(result.production.overall, 34);
  assert.equal(result.actions[0].name, "Critical gate");
});

test("encrypts with AES-256-GCM", () => {
  const key = randomBytes(32);
  const data = { readiness:42, focus:{ title:"Finish masters" } };
  const payload = encryptDashboard(data, key.toString("base64url"));
  const bytes = Buffer.from(payload.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  const clear = Buffer.concat([decipher.update(bytes.subarray(0,-16)), decipher.final()]);
  assert.deepEqual(JSON.parse(clear.toString("utf8")), data);
});
