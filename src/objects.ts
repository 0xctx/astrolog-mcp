import { HOUSE_SYSTEMS, OBJECT_CODES, type HouseSystem, type ObjectCode } from "./types.js";

// Astrolog's own name for each object, used in `-R0 <name>` and in `O_<name>` expressions. They
// match the contract's codes one for one; keeping the table here means a renamed code fails the
// type checker instead of silently dropping out of the pin list.
export const ASTROLOG_NAME: Record<ObjectCode, string> = {
  Sun: "Sun",
  Moo: "Moo",
  Mer: "Mer",
  Ven: "Ven",
  Mar: "Mar",
  Jup: "Jup",
  Sat: "Sat",
  Ura: "Ura",
  Nep: "Nep",
  Plu: "Plu",
  Chi: "Chi",
  Nor: "Nor",
  Cer: "Cer",
  Pal: "Pal",
  Jun: "Jun",
  Ves: "Ves",
  Eri: "Eri",
  Hau: "Hau",
  Mak: "Mak",
  Sed: "Sed",
};

// The `-c` number for a house system. Reads the contract's table; nothing else hard-codes these.
export function houseNumber(system: HouseSystem): number {
  return HOUSE_SYSTEMS[system];
}

export const ALL_OBJECTS: readonly ObjectCode[] = OBJECT_CODES;
