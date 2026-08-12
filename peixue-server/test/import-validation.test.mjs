import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { validateImportPayload } from "../db.mjs";

const validPayload = () => ({
  kids: [{ id: "kid-a", name: "示例孩子" }],
  moments: [
    {
      id: "moment-a",
      kidId: "kid-a",
      problem: "1 + 1 = ?",
    },
  ],
  activeKidId: "kid-a",
});

test("accepts a self-contained synthetic family export", () => {
  const payload = validPayload();
  assert.deepEqual(validateImportPayload(payload), {
    kids: payload.kids,
    moments: payload.moments,
  });
});

test("rejects a moment that references a child outside the import", () => {
  const payload = validPayload();
  payload.moments[0].kidId = "kid-from-another-family";

  assert.throws(() => validateImportPayload(payload), /导入包之外的孩子/);
});

test("rejects an active child outside the import", () => {
  const payload = validPayload();
  payload.activeKidId = "kid-from-another-family";

  assert.throws(() => validateImportPayload(payload), /activeKidId/);
});

test("rejects duplicate identifiers", () => {
  const payload = validPayload();
  payload.kids.push({ id: "kid-a", name: "另一个示例" });

  assert.throws(() => validateImportPayload(payload), /id 重复/);
});

test("the published demo backup is valid and synthetic", () => {
  const demo = JSON.parse(
    readFileSync(new URL("../../examples/demo-backup.json", import.meta.url), "utf8")
  );

  assert.doesNotThrow(() => validateImportPayload(demo));
  assert.match(demo.kids[0].name, /示例/);
  assert.equal(JSON.stringify(demo).includes("demo"), true);
});
