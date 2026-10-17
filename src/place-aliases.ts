// A fixed shorthand -> place table. Each entry maps a plain shorthand or the old name of a renamed
// city to one GeoNames place, by its geonameId (the GeoNames primary key). Targeting by id means an
// alias can never be ambiguous and is never hijacked by a more populous city of the same name: the
// id pins the exact row that supplies the coordinates, region and time zone.
//
// Coordinates, regions and time zones still come only from the GeoNames rows; an alias only names a
// place, it never supplies numbers. The name and country code are checked against the row the id
// returns, so a GeoNames release that moves an id to another place makes the alias refuse, not
// resolve to the wrong city.
//
// The alias is looked up only when the exact-name lookup finds no place at all. Every input that
// resolves by name resolves exactly as it did before the table existed, and an ambiguous name stays
// ambiguous. So an old name that already matches a GeoNames place is not aliased: "Bombay" is the
// town in New Zealand, "Madras" is the town in Oregon, and "Calcutta" names four places and resolves
// to the one in South Africa by population. For those cities the names to give are "Mumbai", "Kolkata"
// and "Chennai", which resolve by name.
//
// "NYC", "New York", "LA", "L.A.", "SF", "San Fran", "DC", "Philly", "Vegas", "Peking" and "Saigon"
// match no place name in cities500, so the name lookup finds nothing for them and the alias applies.
// "NY" is a state code, not a city, and is not aliased: it is unsupported, and "New York" or "NYC"
// must be written instead. "Washington, DC" already resolves on its own, so it is not aliased, and
// Chi-town is excluded.
export interface PlaceAlias {
  // How the shorthand is written. Normalised before matching, so "LA" and "L.A." agree.
  alias: string;
  // The GeoNames geonameId of the place it names (unique per place in cities500).
  geonameId: number;
  // The row's primary name and ISO country code, which the row returned for the id must match.
  name: string;
  countryCode: string;
}

// GeoNames geonameIds are stable across releases; each is verified to occur once in cities500.
export const PLACE_ALIASES: readonly PlaceAlias[] = [
  { alias: "NYC", geonameId: 5128581, name: "New York City", countryCode: "US" },
  { alias: "New York", geonameId: 5128581, name: "New York City", countryCode: "US" },
  { alias: "LA", geonameId: 5368361, name: "Los Angeles", countryCode: "US" },
  { alias: "L.A.", geonameId: 5368361, name: "Los Angeles", countryCode: "US" },
  { alias: "SF", geonameId: 5391959, name: "San Francisco", countryCode: "US" },
  { alias: "San Fran", geonameId: 5391959, name: "San Francisco", countryCode: "US" },
  { alias: "DC", geonameId: 4140963, name: "Washington", countryCode: "US" },
  { alias: "Philly", geonameId: 4560349, name: "Philadelphia", countryCode: "US" },
  { alias: "Vegas", geonameId: 5506956, name: "Las Vegas", countryCode: "US" },
  { alias: "Peking", geonameId: 1816670, name: "Beijing", countryCode: "CN" },
  { alias: "Saigon", geonameId: 1566083, name: "Ho Chi Minh City", countryCode: "VN" },
];
