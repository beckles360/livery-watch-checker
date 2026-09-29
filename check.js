// Livery Watch — GitHub Actions half.
// Runs every 5 minutes (see .github/workflows/check.yml), fetches the
// watch list from the Cloudflare Worker, checks each aircraft's live
// position via adsb.one, and reports any state change back to the
// Worker (which sends the ntfy.sh notification).

const WORKER_URL = process.env.WORKER_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
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
    console.log(watch.registration + " (" + icao24 + "): no current position from adsb.one");
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

  if (newState !== state) {
    await postState(watch.id, newState, notify);
    console.log(watch.registration + ": " + state.phase + " -> " + newState.phase);
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
  const resp = await fetch("https://api.adsb.one/v2/hex/" + icao24, {
    headers: { "User-Agent": "LiveryWatch/1.0 (personal aircraft tracker, run via GitHub Actions)" }
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const ac = data.ac && data.ac[0];
  if (!ac) return null;
  return {
    callsign: (ac.flight || "").trim(),
    lon: ac.lon,
    lat: ac.lat,
    onGround: ac.alt_baro === "ground",
    velocity: ac.gs
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
