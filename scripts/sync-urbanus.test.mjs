import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { buildDashboard, encryptDashboard } from "./sync-urbanus.mjs";

const rich = value => ({ type: "rich_text", rich_text: value ? [{ plain_text: value }] : [] });
const title = value => ({ type: "title", title: [{ plain_text: value }] });
const select = value => ({ type: "select", select: { name: value } });
const number = value => ({ type: "number", number: value });
const formula = value => ({ type: "formula", formula: { type: "number", number: value } });
const page = (trackNumber, name, mix, master, art, video) => ({ properties: {
  "Track Number": number(trackNumber), Title: title(name), "Current Mix Version": rich("RC1"),
  "Main Status": select("🟡In Progress"), "Review Status": select("⚪ Not checked"),
  "Mix Status": select(mix), "Master Status": select(master), "Artwork Status": select(art), "Video Status": select(video),
  "Mix Score": formula(mix.includes("Done") ? 1 : .5), "Master Score ": formula(master.includes("Done") ? 1 : 0),
  "Artwork Score": formula(art.includes("Done") ? 1 : 0), "Production %": formula(.5),
  Notes: rich("private notes"), "Latest Mix File": rich("private-file.wav")
} });

test("builds the album dashboard without private notes or file references", () => {
  const pages = Array.from({ length: 12 }, (_, index) => page(index + 1, `Track ${index + 1}`,
    index === 0 ? "🟢Done" : "🟡In Progress", index === 0 ? "🟢Done" : "🟠Not Started Yet",
    index < 2 ? "🟢Done" : "🟠Not Started Yet", index === 0 ? "🟢Done" : "🟠Not Started Yet"));
  const result = buildDashboard(pages, new Date("2026-07-17T12:00:00Z"));
  assert.equal(result.counts.tracks, 12);
  assert.equal(result.counts.mixed, 1);
  assert.equal(result.counts.mastered, 1);
  assert.equal(result.overall, 50);
  assert.equal(result.focus.label, "Finish all mixes");
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("encrypts with AES-256-GCM", () => {
  const key = randomBytes(32);
  const data = { album: "Urbanus Fabulae", overall: 42 };
  const payload = encryptDashboard(data, key.toString("base64url"));
  const bytes = Buffer.from(payload.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  const clear = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]);
  assert.deepEqual(JSON.parse(clear.toString("utf8")), data);
});
