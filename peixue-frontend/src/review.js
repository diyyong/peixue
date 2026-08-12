export const REVIEW_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Return review candidates ordered from highest to lowest priority.
// A recently missed item cools down for 12 hours, while a deliberately
// shelved item stays out of automatic review until a parent reactivates it.
export function pickReviewCandidates(moments, now = Date.now()) {
  return moments
    .filter((moment) => moment.analysis)
    .filter((moment) => moment.status !== "暂搁")
    .filter((moment) => {
      const lastWrongAt = moment.lastWrongAt;
      return !(
        lastWrongAt &&
        now - lastWrongAt < REVIEW_COOLDOWN_MS
      );
    })
    .map((moment) => {
      const stats = calcMemoryStats(moment, now);
      const { ageDays, interval, retention } = stats;

      if (moment.status === "需复习") {
        return {
          moment,
          priority: 1000 + ageDays,
          age: ageDays,
          retention,
          interval,
        };
      }

      if (moment.status === "已记录" || ageDays < interval) return null;

      const priority =
        (1 - retention) * 100 + Math.min(ageDays, 30) * 0.1;
      return { moment, priority, age: ageDays, retention, interval };
    })
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority);
}

export function nextInterval(currentInterval, isCorrect) {
  const current = Number.isFinite(currentInterval) ? currentInterval : 1;
  if (!isCorrect) return 1;
  return Math.min(Math.max(current * 2, 2), 90);
}

export function calcMemoryStats(moment, now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  const lastTouch = moment.updatedAt || moment.createdAt;
  const ageDays = (now - lastTouch) / day;
  const interval = Number.isFinite(moment.intervalDays)
    ? moment.intervalDays
    : 1;
  const stability = Math.max(interval, 1);
  const retention = Math.exp(-ageDays / stability);
  const dueDays = interval - ageDays;
  const inCooldown = Boolean(
    moment.lastWrongAt && now - moment.lastWrongAt < REVIEW_COOLDOWN_MS,
  );

  let level;
  if (inCooldown) level = "due";
  else if (moment.status === "需复习" || dueDays <= 0) level = "overdue";
  else if (retention < 0.6) level = "due";
  else level = "fresh";

  return { ageDays, interval, retention, dueDays, level, inCooldown };
}
