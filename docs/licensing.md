# Licensing

This is a practical summary, not legal advice. If you run a public service or distribute binaries, check the terms yourself or ask a lawyer.

## This project: AGPL-3.0-only

astrolog-mcp's source is licensed under the [GNU Affero General Public License v3](../LICENSE). Copyright (C) 2026 0xctx.

The AGPL is the same as the GPL with one addition: if you modify the program and let people use it over a network, you must offer those users the source of your modified version. If you run it unmodified, there is nothing extra to offer beyond pointing to this repository.

## Why AGPL

The server's engine is Astrolog with the Swiss Ephemeris, and Swiss Ephemeris is dual-licensed: AGPL, or a paid Professional licence. Using it under the AGPL means the software built on it is AGPL too. Publishing this server under the AGPL is the straightforward way to meet that. On the AGPL route no Professional licence is needed, provided you meet the AGPL's terms.

The server runs Astrolog as a separate program through its command line and does not modify it. That arm's-length boundary is also why the server could in principle carry its own licence. AGPL was chosen anyway, to remove any doubt about the combined service.

## Third-party components

| Component | Licence | What to know |
| --- | --- | --- |
| **Astrolog** (Walter Pullen) | GNU GPL v2 or later | The installer builds it from the official source and checks its SHA-256. Distributing the binary, for example inside a container image, carries GPL obligations, including making the corresponding source available. Credits are in [NOTICE](../NOTICE). |
| **Swiss Ephemeris** (Astrodienst AG) | AGPL or Professional licence | Compiled into Astrolog, plus the `.se1` data files the installer fetches. |
| **GeoNames** | CC BY 4.0 | Place data, downloaded by the installer; credit GeoNames when you use it (<https://www.geonames.org/export/>). |

### Swiss Ephemeris

The [Swiss Ephemeris licence page](https://www.astro.com/swisseph/swephinfo_e.htm) says it is "made available by its authors under a dual licensing system", and that the developer "must choose between one of the two license models, which are a) GNU Affero General Public License (AGPL) b) Swiss Ephemeris Professional License".

- **AGPL:** "he or she must fulfill the conditions of that license, which includes the obligation to place his or her whole software project under the AGPL or a compatible license."
- **Professional:** "purchase the Swiss Ephemeris Professional Edition from Astrodienst and sign the corresponding license contract."
- **Timing:** "The choice must be made before the software developer distributes software containing parts of Swiss Ephemeris to others, and before any public service using the developed software is activated."

So a public endpoint that runs this software can be a "public service" for these purposes: whether a given service is a public service is for the operator to decide (see [NOTICE](../NOTICE)). The choice applies before you switch it on.

## What this means for you

- **Using it locally or privately** (your own machine, your own stdio client): nothing special beyond keeping the notices.
- **Running a public endpoint:** you are using Swiss Ephemeris under the AGPL by default. Keep the source of any changes you make available to your users. If you want to run it closed-source, you need the Professional licence from Astrodienst.
- **Publishing a container image or archive:** it contains the Astrolog binary (GPL, source must be available) and the Swiss Ephemeris files (AGPL or Professional). This repository does not publish an image. If you do, ship the corresponding source and the notices.
- **Building something else on top:** a closed-source product that bundles this server needs the Professional licence.

## Compatibility

Astrolog's licence says: "either version 2 of the License, or (at your option) any later version." Because it is GPL version 2 **or later**, it can be used under GPL version 3, and GPL version 3 code may be combined with AGPL version 3 code. That is the path that lets Astrolog and the AGPL Swiss Ephemeris sit together in one build, and it is consistent with this project being AGPL-3.0-only.

Whether a particular deployment counts as one combined work is a legal question, and the conservative answer is the one this project takes: AGPL for everything you control. When in doubt, email Astrodienst or ask a licensing lawyer.
