import test from "node:test";
import assert from "node:assert/strict";

import { validateNewFamilyPassword } from "../db.mjs";

test("accepts a long synthetic family passphrase", () => {
  assert.equal(
    validateNewFamilyPassword("maple-river-lantern-42"),
    "maple-river-lantern-42"
  );
});

test("rejects short and unchanged example passwords", () => {
  assert.throws(() => validateNewFamilyPassword("too-short"), /12 个字符/);
  assert.throws(
    () => validateNewFamilyPassword("replace-with-a-strong-password"),
    /示例密码/
  );
});
