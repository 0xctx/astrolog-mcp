import { DateTime, IANAZone } from "luxon";
import { AstroError, type LocalMoment, type UtcMoment } from "./types.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

// Converts a clock time in an IANA zone to UT. luxon moves a time that does not exist forward and
// picks one of two repeated times without saying so, so both cases throw here instead.
export function toUtc(local: LocalMoment): UtcMoment {
  if (typeof local !== "object" || local === null) {
    throw new AstroError(
      `local moment must be an object with date, time and timezone, got ${String(local)}`,
      'Pass { date: "1990-06-15", time: "14:30", timezone: "America/Chicago" }.',
    );
  }
  const { date, time, timezone } = local;
  if (typeof timezone !== "string" || !IANAZone.isValidZone(timezone)) {
    throw new AstroError(
      `the time zone ${JSON.stringify(timezone)} is not an IANA zone name`,
      'Use an IANA zone name such as "America/Chicago" or "Asia/Kolkata".',
    );
  }
  const wall = wallClock(date, time);
  const zone = IANAZone.create(timezone);
  const [instant, ...others] = instantsOf(wall, zone);
  if (instant === undefined) {
    throw new AstroError(
      `${date} ${time} does not exist in ${timezone}: its clocks skip that time`,
      "Use a clock time just before or after the skipped hour, and check the date.",
    );
  }
  if (others.length > 0) {
    throw new AstroError(
      `${date} ${time} occurs twice in ${timezone}: its clocks repeat that time`,
      "Use a clock time outside the repeated hour.",
    );
  }
  return formatUtc(instant);
}

// The wall-clock fields, checked as a UTC calendar so that February 30 and hour 24 are rejected.
function wallClock(date: unknown, time: unknown): number {
  const dateParts = typeof date === "string" ? DATE_PATTERN.exec(date) : null;
  if (dateParts === null) {
    throw new AstroError(
      `date must be YYYY-MM-DD, got ${JSON.stringify(date)}`,
      'Write the birth date as "1990-06-15".',
    );
  }
  const timeParts = typeof time === "string" ? TIME_PATTERN.exec(time) : null;
  if (timeParts === null) {
    throw new AstroError(
      `time must be HH:MM or HH:MM:SS, got ${JSON.stringify(time)}`,
      'Write the birth time as "14:30" or "14:30:00".',
    );
  }
  const fields = {
    year: Number(dateParts[1]),
    month: Number(dateParts[2]),
    day: Number(dateParts[3]),
    hour: Number(timeParts[1]),
    minute: Number(timeParts[2]),
    second: Number(timeParts[3] ?? 0),
  };
  // luxon rolls an hour of 24 into the next day without complaint, so the ranges are checked here.
  const inRange = fields.hour <= 23 && fields.minute <= 59 && fields.second <= 59;
  const wall = DateTime.fromObject(fields, { zone: "utc" });
  if (!inRange || !wall.isValid) {
    throw new AstroError(
      `${date} ${time} is not a real date and time`,
      "Check the date: February 29 needs a leap year, and hours run from 00 to 23.",
    );
  }
  return wall.toMillis();
}

// The UT instants at which the zone's clock reads the wall-clock time. An offset is kept only when
// it holds at the instant it implies, so a gap gives none and a repeated time gives two. The offsets
// are sampled a day either side, which covers every change a zone makes in one step.
function instantsOf(wallMs: number, zone: IANAZone): number[] {
  const offsets = new Set(
    [wallMs - MS_PER_DAY, wallMs, wallMs + MS_PER_DAY].map((at) => offsetMs(zone, at)),
  );
  const instants: number[] = [];
  for (const offset of offsets) {
    const instant = wallMs - offset;
    if (offsetMs(zone, instant) === offset) {
      instants.push(instant);
    }
  }
  return instants;
}

// Historical offsets can carry seconds, such as New York's -4:56:02 before 1883, and luxon reports
// them in fractional minutes. Whole milliseconds keep the comparison exact.
function offsetMs(zone: IANAZone, at: number): number {
  return Math.round(zone.offset(at) * MS_PER_MINUTE);
}

function formatUtc(instant: number): UtcMoment {
  const utc = DateTime.fromMillis(instant, { zone: "utc" });
  const parts = [String(utc.year).padStart(4, "0"), pad2(utc.month), pad2(utc.day)].join("-");
  const clock = [pad2(utc.hour), pad2(utc.minute), pad2(utc.second)].join(":");
  return `${parts}T${clock}Z` as UtcMoment;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
