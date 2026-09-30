// Livery Watch — GitHub Actions half.
// Runs every 5 minutes (see .github/workflows/check.yml), fetches the
// watch list from the Cloudflare Worker, checks each aircraft's live
// position across several community ADS-B sources (airplanes.live,
// adsb.fi, adsb.one, OpenSky — tried in order until one has data), and
// reports any state change back to the Worker to save it. Notifications
// are sent directly from here (not via the Worker) because ntfy.sh
// rate-limits Cloudflare's shared IP pool.

const WORKER_URL = process.env.WORKER_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const AIRPORT_RADIUS_KM = 15;

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

async function checkWatch(watch) {
  const icao24 = await getIcao24(watch.registration);
  if (!icao24) {
    console.log(watch.registration + ": could not resolve ICAO24 (adsbdb.com lookup failed)");
    return;
  }

  const flight = await getFlightState(icao24);
  if (!flight) {
    console.log(watch.registration + " (" + icao24 + "): no current position from any source");
    return;
  }

  const state = watch.state || { legIndex: 0, phase: "idle" };
  const targetAirport = watch.legs[state.legIndex];
  const airportPos = await getAirportPos(targetAirport);
  const near = airportPos && isNear(flight.lat, flight.lon, airportPos, AIRPORT_RADIUS_KM);
  const routeConfirmed =
    !watch.callsignPrefix || (flight.callsign && flight.callsign.startsWith(watch.callsignPrefix));

  console.log(
    watch.registration + ": phase=" + state.phase +
    " target=" + targetAirport +
    " callsign=" + (flight.callsign || "?") +
    " onGround=" + flight.onGround +
    " near=" + near +
    " routeConfirmed=" + routeConfirmed
  );

  let newState = state;
  let notify = null;

  if (state.phase === "idle" && !flight.onGround && routeConfirmed) {
    newState = { ...state, phase: "inbound", updatedAt: new Date().toISOString() };
    notify = {
      title: watch.registration + " is in the air",
      message: "Heading toward " + targetAirport + ". Callsign " + (flight.callsign || "unknown") + "."
    };
  } else if (state.phase === "inbound" && flight.onGround && near) {
    const nextIndex = (state.legIndex + 1) % watch.legs.length;
    newState = { legIndex: nextIndex, phase: "idle", updatedAt: new Date().toISOString() };
    notify = {
      title: watch.registration + " has landed at " + targetAirport,
      message: watch.livery || "Touched down just now."
    };
  }

  // While inbound, refresh progress/distance/ETA every check, even when
  // the phase itself hasn't changed — this is what drives the page's
  // progress bar. Uses the current position vs. a straight-line route
  // from the departure airport, so it's an estimate, not exact.
  let changed = newState !== state;
  if (newState.phase === "inbound") {
    const originCode = newState.legIndex === 0 ? watch.origin : watch.legs[newState.legIndex - 1];
    const originPos = originCode ? await getAirportPos(originCode) : null;
    if (originPos && airportPos) {
      const totalKm = haversineKm(originPos.lat, originPos.lon, airportPos.lat, airportPos.lon);
      const remainingKm = haversineKm(flight.lat, flight.lon, airportPos.lat, airportPos.lon);
      const traveledKm = Math.max(0, totalKm - remainingKm);
      const progressPercent = totalKm > 0 ? (traveledKm / totalKm) * 100 : null;
      const speedKmh = flight.velocity ? flight.velocity * 1.852 : null; // knots -> km/h
      const etaMinutes = speedKmh && speedKmh > 5 ? (remainingKm / speedKmh) * 60 : null;
      newState = { ...newState, progressPercent, distanceRemainingKm: remainingKm, etaMinutes };
      changed = true;
    }
  }

  if (changed) {
    if (notify) await sendNtfy(notify.title, notify.message);
    await postState(watch.id, newState, null);
    if (newState.phase !== state.phase) console.log(watch.registration + ": " + state.phase + " -> " + newState.phase);
  }
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

async function getIcao24(registration) {
  const data = await fetchJson("https://api.adsbdb.com/v0/aircraft/" + encodeURIComponent(registration));
  const a = data && data.response && data.response.aircraft;
  return a && a.mode_s ? a.mode_s.toLowerCase() : null;
}

async function getAirportPos(icaoCode) {
  const data = await fetchJson("https://hexdb.io/api/v1/airport/icao/" + encodeURIComponent(icaoCode));
  if (!data || data.latitude == null) return null;
  return { lat: parseFloat(data.latitude), lon: parseFloat(data.longitude) };
}

async function getFlightState(icao24) {
  const sources = [
    { name: "airplanes.live", url: "https://api.airplanes.live/v2/hex/" + icao24 },
    { name: "adsb.fi", url: "https://opendata.adsb.fi/api/v2/hex/" + icao24 },
    { name: "adsb.one", url: "https://api.adsb.one/v2/hex/" + icao24 }
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
      const ac = data.ac && data.ac[0];
      if (!ac) {
        console.log("  " + name + ": reached OK, but no aircraft in response (ac: " + JSON.stringify(data.ac) + ")");
        continue;
      }
      console.log("  (source: " + name + ")");
      return {
        callsign: (ac.flight || "").trim(),
        lon: ac.lon,
        lat: ac.lat,
        onGround: ac.alt_baro === "ground",
        velocity: ac.gs,
        source: name
      };
    } catch (e) {
      console.log("  " + name + ": request failed — " + e);
    }
  }
  const fromOpenSky = await getFlightStateFromOpenSky(icao24, true).catch((e) => {
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
  return { callsign: (row[1] || "").trim(), lon: row[5], lat: row[6], onGround: row[8], velocity: row[9] };
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
