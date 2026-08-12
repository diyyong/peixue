import test from "node:test";
import assert from "node:assert/strict";

import { createAuthCacheKey } from "../db.mjs";

test("authentication cache keys use the complete password", () => {
  const first = createAuthCacheKey("same-prefix-password-one");
  const second = createAuthCacheKey("same-prefix-password-two");

  assert.notEqual(first, second);
  assert.equal(first.length, 43);
  assert.equal(second.length, 43);
});

test("authentication cache keys do not contain plaintext", () => {
  const password = "synthetic-family-password";
  const key = createAuthCacheKey(password);

  assert.equal(key.includes(password), false);
});
