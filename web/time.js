function dateParts(formatter, date) {
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

export function activityTimeToIso(localValue, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
  if (!match) throw new Error("請輸入有效的活動日期與時間。");

  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const expected = {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
  };
  const wallClock = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
  );
  const check = new Date(wallClock);
  if (
    check.getUTCFullYear() !== expected.year
    || check.getUTCMonth() + 1 !== expected.month
    || check.getUTCDate() !== expected.day
    || expected.hour > 23
    || expected.minute > 59
  ) {
    throw new Error("請輸入有效的活動日期與時間。");
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error("請輸入有效的 IANA 活動時區，例如 Asia/Taipei。");
  }

  let timestamp = wallClock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = dateParts(formatter, new Date(timestamp));
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const difference = wallClock - representedAsUtc;
    timestamp += difference;
    if (difference === 0) break;
  }
  const resolved = dateParts(formatter, new Date(timestamp));
  if (
    resolved.year !== expected.year
    || resolved.month !== expected.month
    || resolved.day !== expected.day
    || resolved.hour !== expected.hour
    || resolved.minute !== expected.minute
  ) {
    throw new Error("此日期時間在所選時區不存在，請改選其他時間。");
  }
  return new Date(timestamp).toISOString();
}
