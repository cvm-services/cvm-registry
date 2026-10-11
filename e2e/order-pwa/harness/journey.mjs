// journey.mjs — the fixture identities and the money the happy path is written in.
//
// One order: a Cheeseburger (sku 331227) with bacon, pickup, from Doppelt Käse
// Laubacher Straße. Every number is DERIVED, not observed:
//
//   unit  8.90 EUR pickup (site/menu.json, cvm-orders config/venues.json)
//   +150 sats bacon (client app.js +0.15 EUR; service option_surcharges_sats)
//   = 9 050 sats line subtotal
//   +724 sats 8% facilitator fee (floor(9050 * 800 / 10000))
//   = 9 774 sats grand total
//
// Both specs assert these, so a price table drifting on either side of the wire
// fails the suite instead of being forgiven.
export const VENUE_SLUG = "doppelt-kaese-berlin";
export const VENUE_NAME = "Doppelt Käse Laubacher Straße";
export const ITEM_SKU = "331227";
export const ITEM_NAME = "Cheeseburger";
/**
 * A contact value. The service's PAN test exempts anything starting with "+", and
 * the journey does not care about the digits — this is deliberately not a
 * real-looking subscriber number.
 */
export const PHONE = "+491****0000";

export const MONEY = {
  unitPickup: 8900,
  unitDelivery: 9500,
  baconSats: 150,
  cheeseSats: 120,
  line: 9050,
  subtotal: 9050,
  fee: 724,
  total: 9774,
};

/** The client's own display format, so assertions read like the screen does. */
export const SATS = (n) => `${n.toLocaleString("en-US").replaceAll(",", " ")} sats`;
export const EUR = (n) => `${n.toFixed(2)} €`;

/** A named section out of a decoded BOLT11 invoice. */
export const section = (decoded, name) => decoded.sections.find((s) => s.name === name)?.value;
