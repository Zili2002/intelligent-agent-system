import assert from "node:assert/strict";
import test from "node:test";
import { millisecondsUntilNextCron, nextCronDate } from "../src/index.js";

test("cron schedules daily work in UTC without minute-boundary amplification", () => {
  const now = new Date("2026-07-16T08:58:30.000Z");
  assert.equal(
    nextCronDate("5 9 * * *", "UTC", now).toISOString(),
    "2026-07-16T09:05:00.000Z",
  );
  assert.equal(millisecondsUntilNextCron("5 9 * * *", "UTC", now), 390_000);
});

test("cron validates ranges and supports lists, ranges, and steps", () => {
  const now = new Date("2026-07-16T09:00:00.000Z");
  assert.equal(
    nextCronDate("*/15 9-10 * * 1-5", "UTC", now).toISOString(),
    "2026-07-16T09:15:00.000Z",
  );
  assert.throws(() => nextCronDate("0 25 * * *", "UTC", now), /hour/);
  assert.throws(() => nextCronDate("invalid", "UTC", now), /five fields/);
  assert.equal(
    nextCronDate(
      "0 0 1 * 1",
      "UTC",
      new Date("2026-01-02T00:00:00.000Z"),
    ).toISOString(),
    "2026-01-05T00:00:00.000Z",
  );
});
