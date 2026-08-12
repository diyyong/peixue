import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_COOLDOWN_MS,
  calcMemoryStats,
  nextInterval,
  pickReviewCandidates,
} from "../src/review.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 12, 12);

function moment(overrides = {}) {
  return {
    id: "synthetic-moment",
    analysis: { misconception: "synthetic" },
    status: "已掌握",
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 2 * DAY,
    intervalDays: 1,
    ...overrides,
  };
}

test("nextInterval resets misses, doubles successes, and caps at 90 days", () => {
  assert.equal(nextInterval(8, false), 1);
  assert.equal(nextInterval(8, true), 16);
  assert.equal(nextInterval(60, true), 90);
  assert.equal(nextInterval(Number.NaN, true), 2);
});

test("calcMemoryStats reports due state and cooldown consistently", () => {
  const fresh = calcMemoryStats(
    moment({ updatedAt: NOW - 2 * DAY, intervalDays: 4 }),
    NOW,
  );
  assert.equal(fresh.ageDays, 2);
  assert.equal(fresh.dueDays, 2);
  assert.equal(fresh.level, "fresh");
  assert.ok(Math.abs(fresh.retention - Math.exp(-0.5)) < 1e-12);

  const coolingDown = calcMemoryStats(
    moment({
      status: "需复习",
      lastWrongAt: NOW - REVIEW_COOLDOWN_MS + 1,
    }),
    NOW,
  );
  assert.equal(coolingDown.inCooldown, true);
  assert.equal(coolingDown.level, "due");
});

test("pickReviewCandidates filters unsafe timing and prioritizes requested review", () => {
  const candidates = pickReviewCandidates(
    [
      moment({ id: "no-analysis", analysis: null }),
      moment({ id: "shelved", status: "暂搁" }),
      moment({ id: "cooldown", lastWrongAt: NOW - 60 * 60 * 1000 }),
      moment({ id: "not-due", updatedAt: NOW - DAY, intervalDays: 4 }),
      moment({ id: "overdue", updatedAt: NOW - 5 * DAY, intervalDays: 2 }),
      moment({ id: "requested", status: "需复习", updatedAt: NOW - DAY }),
    ],
    NOW,
  );

  assert.deepEqual(
    candidates.map(({ moment: item }) => item.id),
    ["requested", "overdue"],
  );
});
