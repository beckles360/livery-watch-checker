// Livery Watch — GitHub Actions half.
// Runs every 5 minutes (see .github/workflows/check.yml), fetches the
// watch list from the Cloudflare Worker, checks each aircraft's live
// position across several community ADS-B sources (airplanes.live,
// adsb.fi, adsb.one, OpenSky — tried in order until one has data), and
// reports any state change back to the Worker to save it. Notifications
// are sent directly from here (not via the Worker) because ntfy.sh
// rate-limits Cloudflare's shared IP pool.
//
// Landing detection is deliberately independent of earlier sightings:
//   1. If the aircraft is seen on the ground near ANY airport in its leg
//      list, that counts as an arrival (even if we never saw it airborne,
//      and even if it skipped the leg we were "waiting" on).
//   2. If it was last seen low and close to its target airport and then
//      the signal vanished for a while, we send a "probably landed" alert.

const WORKER_URL = process.env.WORKER_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const AIRPORT_RADIUS_KM = 15;

// "Probably landed" heuristic: signal lost for this long...
const PROBABLE_LANDING_GAP_MIN = 20;
// ...after last being seen within this distance of the target airport...
const PROBABLE_LANDING_KM = 50;
// ...and below this altitude (feet).
const PROBABLE_LANDING_MAX_ALT_FT = 6000;

async function main() {
  if (!WORKER_URL || !ADMIN_TOKEN) {
    throw new Error("WORKER_URL and ADMIN_TOKEN must be set as repository secrets.");
  }

  const watches = await fetchJson(WORKER_URL + "/api/watches");
  if (!Array.isArray(watches)) {
    throw new Error("Could not read watch list from the Worker: " + JSON.stringify(watches));
  }
  if (watches.length === 0) {
    console.log("No watches configured yet.");
    return;
  }

  for (const watch of watches) {
    try {
      await checkWatch(watch);
    } catch (e) {
      console.error(watch.registration + ": check failed — " + e);
    }
  }
}

function airportLabel(watch, idx) {
  const code = watch.legs[idx];
  const name = watch.legNames && watch.legNames[idx];
  return name && name !== code ? name + " (" + code + ")" : code;
}

async function checkWatch(watch) {
  // No airports entered: free-roam watch, alert on every takeoff and landing.
  if (!watch.legs || watch.legs.length === 0) return checkFreeWatch(watch);

  const icao24 = await getIcao24(watch.registration);
  const state = watch.state || { legIndex: 0, phase: "idle" };
  const flight = icao24 ? await getFlightState(icao24) : null;

  if (!flight) {
    console.log(watch.registration + (icao24 ? " (" + icao24 + ")" : "") + ": no current position from any source");
    await checkProbableArrival(watch, state);
    return;
  }

  const targetAirport = watch.legs[state.legIndex];
  const targetPos = await getAirportPos(targetAirport);
  const routeConfirmed =
    !watch.callsignPrefix || (flight.callsign && flight.callsign.startsWith(watch.callsignPrefix));

  // On the ground, or effectively so (very low and slow). Some feeders
  // report a numeric altitude instead of "ground" while taxiing.
  const groundLike =
    flight.onGround ||
    (flight.altFt != null && flight.altFt <= 200 && flight.velocity != null && flight.velocity < 80);

  // Is it on the ground near ANY of its leg airports? Check the current
  // target first, then later legs in order (wrapping), so a missed
  // intermediate landing doesn't strand the state machine.
  const landedIdx = groundLike ? await findArrivalLeg(watch, state, flight) : -1;

  console.log(
    watch.registration + ": phase=" + state.phase +
    " target=" + targetAirport +
    " callsign=" + (flight.callsign || "?") +
    " onGround=" + flight.onGround +
    " groundLike=" + groundLike +
    " landedAt=" + (landedIdx >= 0 ? watch.legs[landedIdx] : "-") +
    " routeConfirmed=" + routeConfirmed
  );

  let newState = state;
  let notify = null;
  let changed = false;
  const nowIso = new Date().toISOString();

  if (landedIdx >= 0) {
    const code = watch.legs[landedIdx];
    // Alert if we were tracking it in the air (inbound), or if it was
    // previously known to be somewhere else. If it's idle and we have no
    // record of where it was (first sighting of a parked aircraft), just
    // record the location without alerting.
    const shouldAlert =
      state.phase === "inbound" || (state.atAirport !== undefined && state.atAirport !== code);

    if (shouldAlert) {
      newState = {
        legIndex: (landedIdx + 1) % watch.legs.length,
        phase: "idle",
        atAirport: code,
        updatedAt: nowIso
      };
      notify = {
        title: watch.registration + " has landed at " + airportLabel(watch, landedIdx),
        message: watch.livery || "Touched down just now."
      };
      changed = true;
    } else if (state.atAirport !== code) {
      newState = { ...state, atAirport: code };
      changed = true;
    }
  } else {
    let next = state;
    // No longer parked at a tracked airport: forget where it was.
    if (state.atAirport) next = { ...next, atAirport: null };

    if (state.phase === "idle" && !groundLike && routeConfirmed) {
      next = { ...next, phase: "inbound", atAirport: null, updatedAt: nowIso };
      notify = {
        title: watch.registration + " is in the air",
        message: "Heading toward " + airportLabel(watch, state.legIndex) + ". Callsign " + (flight.callsign || "unknown") + "."
      };
    }
    if (next !== state) {
      newState = next;
      changed = true;
    }
  }

  // While inbound, refresh progress/distance/ETA and the last-seen
  // position every check — this drives the page's progress bar and the
  // "probably landed" heuristic. Progress is a straight-line estimate.
  if (newState.phase === "inbound") {
    newState = {
      ...newState,
      lastSeen: { lat: flight.lat, lon: flight.lon, altFt: flight.altFt, at: nowIso }
    };
    changed = true;

    const originCode = newState.legIndex === 0 ? watch.origin : watch.legs[newState.legIndex - 1];
    const originPos = originCode ? await getAirportPos(originCode) : null;
    const newTargetPos = await getAirportPos(watch.legs[newState.legIndex]);
    if (originPos && newTargetPos) {
      const totalKm = haversineKm(originPos.lat, originPos.lon, newTargetPos.lat, newTargetPos.lon);
      const remainingKm = haversineKm(flight.lat, flight.lon, newTargetPos.lat, newTargetPos.lon);
      const traveledKm = Math.max(0, totalKm - remainingKm);
      const progressPercent = totalKm > 0 ? (traveledKm / totalKm) * 100 : null;
      const speedKmh = flight.velocity ? flight.velocity * 1.852 : null; // knots -> km/h
      const etaMinutes = speedKmh && speedKmh > 5 ? (remainingKm / speedKmh) * 60 : null;
      newState = { ...newState, progressPercent, distanceRemainingKm: remainingKm, etaMinutes };
    }
  }

  if (changed) {
    if (notify) await sendNtfy(notify.title, notify.message);
    await postState(watch.id, newState, null);
    if (newState.phase !== state.phase) console.log(watch.registration + ": " + state.phase + " -> " + newState.phase);
  }
}

// Index of the leg airport the aircraft is currently on the ground at,
// searching from the current target onward (wrapping), or -1.
async function findArrivalLeg(watch, state, flight) {
  for (let i = 0; i < watch.legs.length; i++) {
    const idx = (state.legIndex + i) % watch.legs.length;
    const pos = await getAirportPos(watch.legs[idx]);
    if (pos && isNear(flight.lat, flight.lon, pos, AIRPORT_RADIUS_KM)) return idx;
  }
  return -1;
}

// No position from any source right now. If it was inbound and last seen
// low and close to its target, then went quiet, assume it landed in a
// coverage hole (receivers often lose aircraft on the ground).
async function checkProbableArrival(watch, state) {
  if (state.phase !== "inbound" || !state.lastSeen) return;

  const ageMin = (Date.now() - Date.parse(state.lastSeen.at)) / 60000;
  if (!(ageMin >= PROBABLE_LANDING_GAP_MIN)) return;

  const idx = state.legIndex;
  const pos = await getAirportPos(watch.legs[idx]);
  if (!pos) return;

  const distKm = haversineKm(state.lastSeen.lat, state.lastSeen.lon, pos.lat, pos.lon);
  const lowEnough = state.lastSeen.altFt == null || state.lastSeen.altFt <= PROBABLE_LANDING_MAX_ALT_FT;
  if (distKm > PROBABLE_LANDING_KM || !lowEnough) return;

  console.log(
    watch.registration + ": signal lost " + Math.round(ageMin) + " min ago, " +
    Math.round(distKm) + " km from " + watch.legs[idx] + " — assuming probable landing"
  );

  const newState = {
    legIndex: (idx + 1) % watch.legs.length,
    phase: "idle",
    atAirport: watch.legs[idx],
    updatedAt: new Date().toISOString()
  };
  await sendNtfy(
    watch.registration + " has probably landed at " + airportLabel(watch, idx),
    "Lost signal on approach (" + Math.round(distKm) + " km out, " + Math.round(ageMin) + " min ago). " +
      (watch.livery || "")
  );
  await postState(watch.id, newState, null);
}

// ---- Free-roam watches ---------------------------------------------------
// No route: track a tail number and/or callsign and alert on every takeoff
// and landing, naming the nearest airport. Phases: unknown | ground | air.

const STALE_AIR_HOURS = 6;

async function nearestAirport(lat, lon, radiusKm) {
  if (lat == null || lon == null) return null;
  const data = await fetchJson(
    WORKER_URL + "/api/airports/nearest?lat=" + lat + "&lon=" + lon + "&km=" + radiusKm
  );
  return data && data.icao ? data : null;
}

async function checkFreeWatch(watch) {
  const tail = watch.registration || "";
  const callsign = (watch.callsignPrefix || "").toUpperCase();
  const name = tail || callsign;

  let flight = null;
  if (tail) {
    const icao24 = await getIcao24(tail);
    flight = icao24 ? await getFlight("hex", icao24) : null;
    if (flight && callsign && !(flight.callsign || "").toUpperCase().startsWith(callsign)) {
      console.log(name + ": flying as " + (flight.callsign || "?") + ", not " + callsign + " — ignoring");
      return;
    }
  } else {
    flight = await getFlight("callsign", callsign);
  }

  const raw = watch.state && watch.state.mode === "free" ? watch.state : null;
  let state = raw || { mode: "free", phase: "unknown", atAirport: null };
  // Last seen airborne many hours ago: it has certainly landed somewhere unseen.
  if (state.phase === "air" && state.lastSeen &&
      Date.now() - Date.parse(state.lastSeen.at) > STALE_AIR_HOURS * 3600 * 1000) {
    state = { ...state, phase: "unknown", atAirport: null, atAirportName: null };
  }

  if (!flight) {
    console.log(name + ": no current position from any source (phase=" + state.phase + ")");
    await checkFreeProbableLanding(watch, state, name);
    return;
  }

  const nowIso = new Date().toISOString();
  const groundLike =
    flight.onGround ||
    (flight.altFt != null && flight.altFt <= 200 && flight.velocity != null && flight.velocity < 80);

  const next = {
    mode: "free",
    hex: flight.hex,
    lastSeen: { lat: flight.lat, lon: flight.lon, altFt: flight.altFt, at: nowIso },
    updatedAt: state.updatedAt || nowIso
  };
  const who = flight.registration && !tail ? " (" + flight.registration + ")" : "";
  const details = "Callsign " + (flight.callsign || "unknown") + who + "." + (watch.livery ? " " + watch.livery : "");
  let notify = null;

  if (groundLike) {
    const airport = await nearestAirport(flight.lat, flight.lon, AIRPORT_RADIUS_KM);
    if (state.phase === "air") {
      notify = {
        title: name + " has landed" + (airport ? " at " + airport.label : ""),
        message: details
      };
    }
    next.phase = "ground";
    next.atAirport = airport ? airport.icao : null;
    next.atAirportName = airport ? airport.label : null;
  } else {
    if (state.phase !== "air") {
      let from = null;
      if (state.phase === "ground" && state.atAirport) {
        const here = await nearestAirport(flight.lat, flight.lon, 40);
        if (here && here.icao === state.atAirport) from = state.atAirportName || here.label;
      }
      notify = {
        title: name + (from ? " has departed " + from : " is in the air"),
        message: details
      };
    }
    next.phase = "air";
    next.atAirport = null;
    next.atAirportName = null;
  }

  console.log(
    name + ": phase " + state.phase + " -> " + next.phase +
    " callsign=" + (flight.callsign || "?") + " onGround=" + flight.onGround +
    (next.atAirportName ? " at=" + next.atAirportName : "")
  );

  if (notify) next.updatedAt = nowIso;

  // Save on any change; while airborne also refresh the last-seen position
  // (used for the probable-landing check). Parked and unchanged: no write.
  const changed =
    !raw || notify || next.phase !== state.phase ||
    next.atAirport !== (state.atAirport || null) || next.phase === "air";
  if (changed) {
    if (notify) await sendNtfy(notify.title, notify.message);
    await postState(watch.id, next, null);
  }
}

// No position right now. If it was last seen low and close to an airport and
// then went quiet, assume it landed in a coverage hole.
async function checkFreeProbableLanding(watch, state, name) {
  if (state.phase !== "air" || !state.lastSeen) return;
  const ageMin = (Date.now() - Date.parse(state.lastSeen.at)) / 60000;
  if (!(ageMin >= PROBABLE_LANDING_GAP_MIN)) return;
  if (state.lastSeen.altFt != null && state.lastSeen.altFt > PROBABLE_LANDING_MAX_ALT_FT) return;

  const airport = await nearestAirport(state.lastSeen.lat, state.lastSeen.lon, PROBABLE_LANDING_KM);
  if (!airport) return;

  console.log(name + ": signal lost " + Math.round(ageMin) + " min ago near " + airport.label + " — assuming probable landing");
  const nowIso = new Date().toISOString();
  await sendNtfy(
    name + " has probably landed at " + airport.label,
    "Lost signal on approach (" + Math.round(ageMin) + " min ago). " + (watch.livery || "")
  );
  await postState(watch.id, {
    mode: "free",
    hex: state.hex,
    phase: "ground",
    atAirport: airport.icao,
    atAirportName: airport.label,
    lastSeen: state.lastSeen,
    updatedAt: nowIso
  }, null);
}

async function sendNtfy(title, message) {
  if (!NTFY_TOPIC) {
    console.log("  NTFY_TOPIC not set as a GitHub secret — skipping notification: " + title);
    return;
  }
  try {
    const resp = await fetch("https://ntfy.sh/" + NTFY_TOPIC, {
      method: "POST",
      headers: { Title: title },
      body: message
    });
    console.log("  ntfy: " + (resp.ok ? "sent" : "HTTP " + resp.status));
  } catch (e) {
    console.log("  ntfy send failed: " + e);
  }
}

// Registration -> ICAO24 hex. adsbdb.com first; it can be missing newly
// registered aircraft, so fall back to asking the live ADS-B sources, which
// know the registration of anything currently transmitting.
async function getIcao24(registration) {
  try {
    const resp = await fetch("https://api.adsbdb.com/v0/aircraft/" + encodeURIComponent(registration));
    if (resp.ok) {
      const data = await resp.json();
      const a = data && data.response && data.response.aircraft;
      if (a && a.mode_s) return a.mode_s.toLowerCase();
    }
    console.log("  adsbdb.com: no ICAO24 for " + registration + " (HTTP " + resp.status + ") — trying live sources");
  } catch (e) {
    console.log("  adsbdb.com: request failed — " + e + " — trying live sources");
  }
  const live = await getFlight("reg", registration.toUpperCase());
  if (live && live.hex) {
    console.log("  resolved " + registration + " to " + live.hex + " via " + live.source);
    return live.hex.toLowerCase();
  }
  console.log("  could not resolve ICAO24 for " + registration + " (not in adsbdb and not currently transmitting)");
  return null;
}

// Cached per run so checking every leg for every watch stays cheap.
const airportPosCache = new Map();

async function getAirportPos(icaoCode) {
  if (airportPosCache.has(icaoCode)) return airportPosCache.get(icaoCode);
  const data = await fetchJson("https://hexdb.io/api/v1/airport/icao/" + encodeURIComponent(icaoCode));
  const pos = !data || data.latitude == null
    ? null
    : { lat: parseFloat(data.latitude), lon: parseFloat(data.longitude) };
  airportPosCache.set(icaoCode, pos);
  return pos;
}

async function getFlightState(icao24) {
  return getFlight("hex", icao24);
}

// kind is "hex" (ICAO24 address) or "callsign". Callsign lookups skip
// OpenSky, which can't search by callsign.
async function getFlight(kind, value) {
  // kind: "hex" | "callsign" | "reg". The registration endpoint is named
  // differently on different services.
  const seg = (longReg) =>
    kind === "callsign" ? "/callsign/" : kind === "reg" ? (longReg ? "/registration/" : "/reg/") : "/hex/";
  const q = encodeURIComponent(value);
  const sources = [
    { name: "adsb.fi", url: "https://opendata.adsb.fi/api/v2" + seg(true) + q },
    { name: "adsb.lol", url: "https://api.adsb.lol/v2" + seg(true) + q },
    { name: "airplanes.live", url: "https://api.airplanes.live/v2" + seg(false) + q },
    { name: "adsb.one", url: "https://api.adsb.one/v2" + seg(false) + q }
  ];
  for (const { name, url } of sources) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "LiveryWatch/1.0 (personal aircraft tracker, run via GitHub Actions)" }
      });
      if (!resp.ok) {
        console.log("  " + name + ": HTTP " + resp.status + " " + resp.statusText);
        continue;
      }
      const data = await resp.json();
      const list = (data.ac || []).filter((a) => a.lat != null && a.lon != null);
      const ac = kind === "callsign"
        ? list.find((a) => (a.flight || "").trim().toUpperCase() === value) || null
        : kind === "reg"
          ? list.find((a) => (a.r || "").toUpperCase() === value) || null
          : list[0] || (data.ac && data.ac[0]);
      if (!ac) {
        console.log("  " + name + ": reached OK, but no aircraft in response (ac: " + JSON.stringify(data.ac) + ")");
        continue;
      }
      if (ac.lat == null || ac.lon == null) {
        console.log("  " + name + ": aircraft listed but without a position");
        continue;
      }
      console.log("  (source: " + name + ")");
      return {
        hex: ac.hex,
        registration: ac.r || null,
        callsign: (ac.flight || "").trim(),
        lon: ac.lon,
        lat: ac.lat,
        onGround: ac.alt_baro === "ground",
        altFt: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
        velocity: ac.gs, // knots
        source: name
      };
    } catch (e) {
      console.log("  " + name + ": request failed — " + e);
    }
  }
  if (kind !== "hex") return null;
  const fromOpenSky = await getFlightStateFromOpenSky(value, true).catch((e) => {
    console.log("  OpenSky: request failed — " + e);
    return null;
  });
  if (fromOpenSky) {
    console.log("  (source: OpenSky)");
    return { ...fromOpenSky, source: "OpenSky" };
  }
  return null;
}

async function getFlightStateFromOpenSky(icao24, verbose) {
  const resp = await fetch("https://opensky-network.org/api/states/all?icao24=" + icao24, {
    headers: { "User-Agent": "LiveryWatch/1.0 (personal aircraft tracker, run via GitHub Actions)" }
  });
  if (!resp.ok) {
    if (verbose) console.log("  OpenSky: HTTP " + resp.status + " " + resp.statusText);
    return null;
  }
  const data = await resp.json();
  const row = data.states && data.states[0];
  if (!row) {
    if (verbose) console.log("  OpenSky: reached OK, but no state vector (states: " + JSON.stringify(data.states) + ")");
    return null;
  }
  if (row[5] == null || row[6] == null) {
    if (verbose) console.log("  OpenSky: state vector without a position");
    return null;
  }
  return {
    hex: row[0],
    callsign: (row[1] || "").trim(),
    lon: row[5],
    lat: row[6],
    onGround: row[8],
    altFt: row[7] != null ? row[7] * 3.28084 : null, // metres -> feet
    velocity: row[9] != null ? row[9] * 1.94384 : null // m/s -> knots (matches the other sources)
  };
}

function isNear(lat, lon, pos, radiusKm) {
  if (lat == null || lon == null) return false;
  return haversineKm(lat, lon, pos.lat, pos.lon) <= radiusKm;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return resp.json();
}

async function postState(id, state, notify) {
  const resp = await fetch(WORKER_URL + "/api/state/" + id, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + ADMIN_TOKEN },
    body: JSON.stringify({ state, notify })
  });
  if (!resp.ok) {
    console.error("Failed to update state on Worker: " + resp.status + " " + (await resp.text()));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
