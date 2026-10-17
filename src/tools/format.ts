import type { AngleCode, Latitude, Longitude, ObjectCode } from "../types.js";

export const SIGNS = [
  "Aries",
  "Taurus",
  "Gemini",
  "Cancer",
  "Leo",
  "Virgo",
  "Libra",
  "Scorpio",
  "Sagittarius",
  "Capricorn",
  "Aquarius",
  "Pisces",
] as const;

export const BODY_NAMES: Record<ObjectCode, string> = {
  Sun: "Sun",
  Moo: "Moon",
  Mer: "Mercury",
  Ven: "Venus",
  Mar: "Mars",
  Jup: "Jupiter",
  Sat: "Saturn",
  Ura: "Uranus",
  Nep: "Neptune",
  Plu: "Pluto",
  Chi: "Chiron",
  Nor: "Mean North Node",
  Cer: "Ceres",
  Pal: "Pallas",
  Jun: "Juno",
  Ves: "Vesta",
  Eri: "Eris",
  Hau: "Haumea",
  Mak: "Makemake",
  Sed: "Sedna",
};

export const ANGLE_NAMES: Record<AngleCode, string> = {
  ASC: "Ascendant",
  MC: "Midheaven",
  DSC: "Descendant",
  IC: "Imum Coeli",
};

// A longitude in sign, degree and whole minute. The total is rounded to the arcminute first, so
// 29°59.7′ reads as 0°00′ of the next sign and never as 30°.
export interface SignPosition {
  sign: string;
  degree: number;
  minute: number;
  text: string;
}

export function formatLongitude(longitude: number): SignPosition {
  const arcminutes = Math.round(longitude * 60) % (360 * 60);
  const signIndex = Math.floor(arcminutes / (30 * 60));
  const within = arcminutes % (30 * 60);
  const degree = Math.floor(within / 60);
  const minute = within % 60;
  const sign = SIGNS[signIndex] ?? SIGNS[0];
  return { sign, degree, minute, text: `${degree}°${pad2(minute)}′ ${sign}` };
}

// Degrees and minutes, such as 97°44′. Rounded to the arcminute first, like formatLongitude.
export function formatDegreesMinutes(degrees: number): string {
  const arcminutes = Math.round(degrees * 60);
  return `${Math.floor(arcminutes / 60)}°${pad2(arcminutes % 60)}′`;
}

// Latitude or longitude with its hemisphere letter, such as 30°16′N or 97°44′W. The letter is
// always written, so a reader never has to guess the sign.
export function formatLatitude(latitude: Latitude): string {
  return `${formatDegreesMinutes(latitude.degrees)}${latitude.hemisphere}`;
}

export function formatLongitudeCoordinate(longitude: Longitude): string {
  return `${formatDegreesMinutes(longitude.degrees)}${longitude.hemisphere}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
