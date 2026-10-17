import { AstroError, type Latitude, type Longitude } from "../types.js";

// The coordinates as astrolog's -qa line takes them: degrees, minutes and seconds, each with its
// letter. Astrolog reads an unsigned decimal as west, so the letter is always written. The line
// takes longitude before latitude, so the two are returned as separate fields.
export interface AstrologCoord {
  latitude: string;
  longitude: string;
}

export function astrologCoord(latitude: Latitude, longitude: Longitude): AstrologCoord {
  return {
    latitude: lettered(latitude.degrees, 90, "latitude", latitude.hemisphere, ["N", "S"]),
    longitude: lettered(longitude.degrees, 180, "longitude", longitude.hemisphere, ["E", "W"]),
  };
}

// Signed decimal degrees, north and east positive, as GeoNames and JSON carry them. A stated letter
// must agree with the sign. Zero has no sign, so it takes the stated letter or N and E.
export function latitudeFromSigned(degrees: number, hemisphere?: "N" | "S"): Latitude {
  const signed = fromSigned(degrees, 90, "latitude", hemisphere, "N", "S");
  return { degrees: signed.degrees, hemisphere: signed.hemisphere };
}

export function longitudeFromSigned(degrees: number, hemisphere?: "E" | "W"): Longitude {
  const signed = fromSigned(degrees, 180, "longitude", hemisphere, "E", "W");
  return { degrees: signed.degrees, hemisphere: signed.hemisphere };
}

function lettered(
  degrees: number,
  max: number,
  axis: string,
  letter: string,
  letters: readonly string[],
): string {
  if (typeof degrees !== "number" || !Number.isFinite(degrees) || degrees < 0 || degrees > max) {
    throw new AstroError(
      `${axis} must be unsigned degrees from 0 to ${max}, got ${degrees}`,
      `Give the ${axis} as unsigned degrees from 0 to ${max}, with its letter ${letters.join(" or ")}.`,
    );
  }
  if (!letters.includes(letter)) {
    throw new AstroError(
      `${axis} letter must be ${letters.join(" or ")}, got ${letter}`,
      `Set the ${axis} hemisphere to ${letters.join(" or ")}.`,
    );
  }
  return `${formatDms(degrees)}${letter}`;
}

function fromSigned<L extends string>(
  degrees: number,
  max: number,
  axis: string,
  stated: L | undefined,
  positive: L,
  negative: L,
): { degrees: number; hemisphere: L } {
  if (typeof degrees !== "number" || !Number.isFinite(degrees) || Math.abs(degrees) > max) {
    throw new AstroError(
      `${axis} must be a number from -${max} to ${max}, got ${degrees}`,
      `Give the ${axis} as signed decimal degrees, from -${max} to ${max}.`,
    );
  }
  const derived = degrees < 0 ? negative : positive;
  if (stated !== undefined && degrees !== 0 && stated !== derived) {
    throw new AstroError(
      `${axis} ${degrees} is ${formatDms(degrees)}${derived}, but ${stated} was given`,
      `Make the sign of the ${axis} match ${stated}, or drop the ${stated} letter.`,
    );
  }
  return { degrees: Math.abs(degrees), hemisphere: stated ?? derived };
}

// Whole seconds first, so 9.99999 degrees carries to 10:00:00 and never reads 9:60:00.
function formatDms(degrees: number): string {
  const total = Math.round(Math.abs(degrees) * 3600);
  const whole = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${whole}:${pad2(minutes)}:${pad2(seconds)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
