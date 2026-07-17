interface CronSchedule {
  minute: CronField;
  hour: CronField;
  day: CronField;
  month: CronField;
  weekday: CronField;
}

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}

export function nextCronDate(
  expression: string,
  timezone: string,
  after: Date,
): Date {
  const schedule = parseCron(expression);
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let attempt = 0; attempt < 366 * 24 * 60; attempt += 1) {
    const parts = zonedParts(candidate, timezone);
    if (
      schedule.minute.values.has(parts.minute) &&
      schedule.hour.values.has(parts.hour) &&
      schedule.month.values.has(parts.month) &&
      dayMatches(schedule, parts.day, parts.weekday)
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error("Cron expression has no occurrence within one year");
}

export function millisecondsUntilNextCron(
  expression: string,
  timezone: string,
  now: Date,
): number {
  return Math.max(
    0,
    nextCronDate(expression, timezone, now).getTime() - now.getTime(),
  );
}

function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("Reader cron must contain five fields");
  }
  return {
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    day: parseField(fields[2]!, 1, 31, "day"),
    month: parseField(fields[3]!, 1, 12, "month"),
    weekday: parseField(fields[4]!, 0, 6, "weekday"),
  };
}

function parseField(
  value: string,
  minimum: number,
  maximum: number,
  name: string,
): CronField {
  const result = new Set<number>();
  for (const token of value.split(",")) {
    const [rangePart, stepPart] = token.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Cron ${name} step must be a positive integer`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = minimum;
      end = maximum;
    } else if (rangePart?.includes("-")) {
      const [left, right] = rangePart.split("-");
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      throw new Error(`Cron ${name} must stay from ${minimum} to ${maximum}`);
    }
    for (let item = start; item <= end; item += step) result.add(item);
  }
  if (!result.size) throw new Error(`Cron ${name} must not be empty`);
  return { values: result, wildcard: value === "*" };
}

function dayMatches(
  schedule: CronSchedule,
  day: number,
  weekday: number,
): boolean {
  const dayMatch = schedule.day.values.has(day);
  const weekdayMatch = schedule.weekday.values.has(weekday);
  if (!schedule.day.wildcard && !schedule.weekday.wildcard) {
    return dayMatch || weekdayMatch;
  }
  return dayMatch && weekdayMatch;
}

function zonedParts(
  date: Date,
  timezone: string,
): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  if (timezone === "local") {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay(),
    };
  }
  if (timezone === "UTC") {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdays: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdays[values.weekday ?? ""];
  if (weekday === undefined) {
    throw new Error(`Unable to resolve timezone weekday: ${timezone}`);
  }
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    day: Number(values.day),
    month: Number(values.month),
    weekday,
  };
}
