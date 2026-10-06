/**
 * app.js — the cvm-registry dashboard.
 *
 * Hard rules (contextvm-services ADR-0001):
 *   - the page is a CACHE reader: it fetches one static catalog.json and never
 *     opens a relay connection, never makes a per-service CVM call
 *   - the allow-list is applied by the collector, not here, but the page
 *     re-checks it: an entry whose npub is not in the published allow-list is
 *     dropped client-side too (defence in depth, fail closed)
 *   - stale disables: past the freshness ttl nothing is presented as live, and
 *     past the hard limit the catalog is disabled and no entry is rendered
 */
"use strict";

const POLICY_FALLBACK = { fresh_ttl_seconds: 900, max_age_seconds: 21600, clock_skew_seconds: 120 };
const TIER_RANKS = { none: 0, financial: 1, contact: 2, fulfilment: 3, legal: 4, sensitive: 5 };
const TIER_SHORTHAND = {
  no_personal_data: ["none", "financial"],
  contact_only: ["none", "financial", "contact"],
};

let CATALOG = null;
let RELOAD_TIMER = null;
const UI = { classFilter: new Set(), shorthand: null, geo: "", fields: new Set() };

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------- policy ----

function cacheState(generatedAt, nowSeconds, p) {
  const skew = p.clock_skew_seconds ?? 120;
  if (generatedAt === null || generatedAt === undefined || !Number.isFinite(generatedAt) || generatedAt <= 0) {
    return { state: "invalid", age_seconds: null, reason: "generated_at is missing or unparseable" };
  }
  if (generatedAt > nowSeconds + skew) {
    return { state: "invalid", age_seconds: null, reason: "generated_at is future-dated beyond the clock-skew limit" };
  }
  const age = Math.max(0, Math.round(nowSeconds - generatedAt));
  if (age <= p.fresh_ttl_seconds) return { state: "fresh", age_seconds: age, reason: "cache is " + humanAge(age) + " old" };
  if (age <= p.max_age_seconds) {
    return { state: "stale", age_seconds: age, reason: "cache is " + humanAge(age) + " old, past the " + humanAge(p.fresh_ttl_seconds) + " freshness ttl" };
  }
  return { state: "expired", age_seconds: age, reason: "cache is " + humanAge(age) + " old, past the " + humanAge(p.max_age_seconds) + " hard limit" };
}

function humanAge(s) {
  if (s === null) return "unknown";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return m ? h + "h" + m + "m" : h + "h";
}

function renderDecision(v) {
  switch (v.state) {
    case "fresh":
      return { renderEntries: true, disabled: false, banner: null, live_claims: true };
    case "stale":
      return {
        renderEntries: true, disabled: false, live_claims: false,
        banner: "STALE CACHE — " + v.reason + ". Showing a cached snapshot only; nothing here is live and no entry may be used as current.",
      };
    case "expired":
      return { renderEntries: false, disabled: true, live_claims: false, banner: "CACHE EXPIRED — " + v.reason + ". The catalog is disabled until the collector runs again." };
    default:
      return { renderEntries: false, disabled: true, live_claims: false, banner: "CACHE UNAVAILABLE — " + v.reason + ". The catalog is disabled (fail closed)." };
  }
}

// --------------------------------------------------------------- filtering ----

function entryDeclaredFields(e) {
  return new Set([...(e.requirements.required || []), ...(e.requirements.optional || [])]);
}

function passesFilters(e) {
  if (UI.classFilter.size) {
    const hit = (e.classes || []).some((c) => UI.classFilter.has(c));
    if (!hit) return false;
  }
  if (UI.shorthand) {
    const allowed = TIER_SHORTHAND[UI.shorthand];
    if (e.requirements.unclassified) return false;
    if (e.tier.recomputed === null || !allowed.includes(e.tier.recomputed)) return false;
  }
  if (UI.geo) {
    const g = (e.geohashes || []).join(" ");
    if (!g.toLowerCase().includes(UI.geo.toLowerCase())) return false;
  }
  if (UI.fields.size) {
    const declared = entryDeclaredFields(e);
    for (const f of UI.fields) if (!declared.has(f)) return false;
    // an unknown declared field fails the field-level AND by default, loudly
    if ((e.requirements.unknown || []).length) return false;
  }
  return true;
}

// --------------------------------------------------------------- services ----
// CEP-6 kinds are FACETS of ONE service: 11316 server announcement, 11317
// tools, 11318 resources, 11319 templates, 11320 prompts. Identity is
// (pubkey, d). The collector already collapses them into `services`; this
// fallback does the same for an older cache so the page can never again paint
// one card per announcement (which showed a service twice and counted it twice).
const KIND_LABEL = {
  11316: "server announcement",
  11317: "tools",
  11318: "resources",
  11319: "templates",
  11320: "prompts",
};

function groupEntriesAsServices(entries) {
  const byKey = new Map();
  for (const e of entries) {
    const k = (e.pubkey || "") + ":" + (e.d || "");
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const out = [];
  for (const [key, group] of byKey) {
    const sorted = [...group].sort((a, b) => (a.kind || 0) - (b.kind || 0));
    const firstOf = (f) => {
      for (const e of sorted) {
        const v = f(e);
        if (v !== null && v !== undefined && v !== "") return v;
      }
      return null;
    };
    const s = sorted[0];
    out.push({
      service_key: key,
      pubkey: s.pubkey,
      npub: s.npub,
      d: s.d,
      kinds: sorted.map((e) => e.kind),
      facets: sorted.map((e) => ({ kind: e.kind, event_id: e.event_id, created_at: e.created_at })),
      name: firstOf((e) => e.name),
      about: firstOf((e) => e.about),
      website: firstOf((e) => e.website),
      links: [...new Set(sorted.flatMap((e) => e.links || []))].sort(),
      geohashes: [...new Set(sorted.flatMap((e) => e.geohashes || []))].sort(),
      classes: [...new Set(sorted.flatMap((e) => e.classes || []))].sort(),
      caps: s.caps || [],
      tier: s.tier,
      requirements: s.requirements,
      created_at: Math.max(...sorted.map((e) => e.created_at || 0)),
      link_status: null,
    });
  }
  return out.sort((a, b) => a.pubkey.localeCompare(b.pubkey) || (a.d || "").localeCompare(b.d || ""));
}

// ---------------------------------------------------------------- render ----

function render() {
  const host = $("#app");
  host.textContent = "";
  if (!CATALOG) {
    host.append(el("p", "banner disabled", "No catalog loaded."));
    return;
  }
  const policy = CATALOG.policy?.freshness ?? POLICY_FALLBACK;
  const now = Math.floor(Date.now() / 1000);
  const verdict = cacheState(CATALOG.generated_at, now, policy);
  const decision = renderDecision(verdict);
  const allow = new Set((CATALOG.allowlist?.curators ?? []).map((c) => c.npub));

  // header
  const header = el("header");
  header.append(el("h1", null, "ContextVM services"));
  const sub = el("p", "sub");
  sub.append(el("span", "host", CATALOG.allowlist?.dashboard_host ?? location.host));
  sub.append(document.createTextNode(" — allow-list driven cache. Collector snapshot "));
  sub.append(el("strong", null, CATALOG.generated_at_iso ?? "unknown"));
  sub.append(document.createTextNode(" (" + humanAge(verdict.age_seconds) + " old, " + verdict.state + ")"));
  sub.append(document.createTextNode(". This page reads a static cache; it never contacts a relay."));
  header.append(sub);
  header.append(statusPill(verdict, decision));

  if (decision.banner) {
    header.append(el("p", "banner " + (decision.disabled ? "disabled" : "stale"), decision.banner));
  }
  host.append(header);

  if (!decision.renderEntries) {
    host.append(controls(verdict, decision, []));
    const empty = el("p", "banner disabled");
    empty.textContent = "Catalog disabled (" + verdict.state + "). No announcements are rendered.";
    host.append(empty);
    return;
  }

  // allow-list re-check: defence in depth
  const allowedEntries = (CATALOG.entries || []).filter((e) => allow.has(e.npub));
  const dropped = (CATALOG.entries || []).length - allowedEntries.length;

  // group into SERVICES before anything is rendered or counted
  const allowedServices = (Array.isArray(CATALOG.services) && CATALOG.services.length)
    ? CATALOG.services.filter((s) => allow.has(s.npub))
    : groupEntriesAsServices(allowedEntries);
  const signers = new Set(allowedServices.map((s) => s.npub));

  host.append(controls(verdict, decision, allowedServices));

  const visible = allowedServices.filter(passesFilters);
  const groups = new Map();
  for (const e of visible) {
    const key = e.requirements.unclassified ? "(unclassified — no input declaration)" : ((e.classes || []).join(", ") || "(no class tag)");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const summary = el("p", "summary");
  summary.textContent =
    allowedServices.length + " service(s) from " + signers.size + " allow-listed signer(s) (" +
    allowedEntries.length + " announcement(s) — CEP-6 facets collapse per service), " +
    visible.length + " shown after filters, " + (CATALOG.counts?.dropped_not_allowlisted ?? 0) +
    " dropped by the allow-list at collect time" + (dropped ? ", " + dropped + " dropped by the client re-check" : "") + ".";
  host.append(summary);

  if (!visible.length) {
    host.append(el("p", "banner", allowedEntries.length ? "No service matches the current filters." : "The allow-list is empty or none of its curators has announced a service (fail closed: nothing is rendered)."));
    return;
  }

  for (const [name, items] of [...groups.entries()].sort()) {
    const section = el("section", "group");
    section.append(el("h2", null, name));
    const list = el("div", "cards");
    for (const e of items.sort((a, b) => (a.name ?? a.d).localeCompare(b.name ?? b.d))) list.append(card(e, verdict, decision));
    section.append(list);
    host.append(section);
  }
}

function statusPill(v, d) {
  const span = el("span", "pill " + v.state);
  span.textContent = v.state === "fresh" ? "live cache" : v.state;
  span.title = v.reason;
  if (!d.live_claims) span.textContent = v.state + " (not live)";
  return span;
}

function controls(verdict, decision, entries) {
  const box = el("div", "controls");
  const classes = new Set();
  const fields = new Set();
  for (const e of entries) {
    for (const c of e.classes || []) classes.add(c);
    for (const f of [...(e.requirements.required || []), ...(e.requirements.optional || [])]) fields.add(f);
  }

  const shorthand = el("div", "control-group");
  shorthand.append(el("span", "label", "Input appetite:"));
  const mkBtn = (label, key) => {
    const b = el("button", "chip" + (UI.shorthand === key ? " on" : ""), label);
    b.onclick = () => { UI.shorthand = UI.shorthand === key ? null : key; render(); };
    return b;
  };
  shorthand.append(mkBtn("any", null));
  shorthand.append(mkBtn("no personal data", "no_personal_data"));
  shorthand.append(mkBtn("contact only", "contact_only"));
  box.append(shorthand);

  const classGroup = el("div", "control-group");
  classGroup.append(el("span", "label", "Class:"));
  for (const c of [...classes].sort()) {
    const b = el("button", "chip" + (UI.classFilter.has(c) ? " on" : ""), c);
    b.onclick = () => { UI.classFilter.has(c) ? UI.classFilter.delete(c) : UI.classFilter.add(c); render(); };
    classGroup.append(b);
  }
  box.append(classGroup);

  const fieldGroup = el("div", "control-group");
  fieldGroup.append(el("span", "label", "Requires (AND):"));
  for (const f of [...fields].sort()) {
    const b = el("button", "chip" + (UI.fields.has(f) ? " on" : ""), f);
    b.onclick = () => { UI.fields.has(f) ? UI.fields.delete(f) : UI.fields.add(f); render(); };
    fieldGroup.append(b);
  }
  box.append(fieldGroup);

  const geo = el("div", "control-group");
  geo.append(el("span", "label", "Geohash contains:"));
  const input = el("input");
  input.type = "text";
  input.value = UI.geo;
  input.placeholder = "u33d";
  input.oninput = () => { UI.geo = input.value.trim(); render(); };
  geo.append(input);
  box.append(geo);

  const reset = el("button", "chip reset", "reset filters");
  reset.onclick = () => { UI.classFilter.clear(); UI.fields.clear(); UI.shorthand = null; UI.geo = ""; render(); };
  box.append(reset);

  const refresh = el("button", "chip", "reload cache");
  refresh.onclick = load;
  if (!decision.live_claims) {
    // never offer a "make it live" affordance while the cache is not live
    refresh.title = "the cache is " + verdict.state + "; reloading does not make it fresh";
  }
  box.append(refresh);
  return box;
}

function card(e, verdict, decision) {
  const c = el("article", "card" + (decision.live_claims ? "" : " cached-only"));
  const h = el("h3");
  h.append(el("span", "name", e.name ?? e.d ?? "(unnamed)"));
  if (e.requirements.unclassified) h.append(badge("unclassified", "warn"));
  if (e.tier.recomputed) h.append(badge("tier: " + e.tier.recomputed, "tier"));
  c.append(h);

  if (e.about) c.append(el("p", "about", e.about));

  const facts = el("ul", "facts");
  const kinds = e.kinds || (e.kind ? [e.kind] : []);
  const labels = kinds.map((k) => KIND_LABEL[k] || String(k)).join(", ");
  facts.append(factItem("CEP-6", kinds.length + " announcement(s): " + (labels || "—")));
  facts.append(factItem("class", (e.classes || []).join(", ") || "—"));
  facts.append(factItem("service id", e.d || "—"));
  if (e.website) {
    const li = el("li");
    li.append(el("span", "k", "website"));
    const a = el("a", null, e.website);
    a.href = e.website; a.rel = "noopener noreferrer"; a.target = "_blank";
    li.append(a);
    // The collector HEADed this URL when it ran. A dead declared URL is a fact
    // about the declaration, not a verdict on the service — so it is annotated,
    // never hidden, and a check that did not run is never drawn as a pass.
    const st = e.link_status;
    if (st && st.ok === false) {
      const b = badge(st.reason === "timeout" ? "no reply" : "unreachable", "warn");
      b.title = "collector check at " + new Date((st.checked_at || 0) * 1000).toISOString() +
        " — " + st.reason + (st.http_status ? " (HTTP " + st.http_status + ")" : "");
      li.append(b);
    } else if (st && st.checked === false) {
      const b = badge("not checked", "tier");
      b.title = "the collector did not check this URL (" + st.reason + ")";
      li.append(b);
    }
    facts.append(li);
  }
  // ---- the provider's own links: for a venue, the ordering deep-link --------
  if ((e.links || []).length) {
    const li = el("li");
    li.append(el("span", "k", "order"));
    for (const [i, url] of e.links.entries()) {
      if (i) li.append(document.createTextNode("  "));
      const a = el("a", "deep-link", url);
      a.href = url; a.rel = "noopener noreferrer"; a.target = "_blank";
      li.append(a);
    }
    facts.append(li);
  }
  if ((e.geohashes || []).length) facts.append(factItem("geohash", e.geohashes.join(", ")));
  facts.append(factItem("announced", new Date(e.created_at * 1000).toISOString()));
  facts.append(factItem("curator", e.npub));
  c.append(facts);

  if ((e.caps || []).length) {
    const ul = el("ul", "caps");
    for (const cap of e.caps) ul.append(el("li", null, cap.tool + " — " + cap.amount + " " + cap.unit));
    c.append(el("h4", null, "Declared price per tool (call price, not settlement)"));
    c.append(ul);
  }

  // ---- what it asks of YOU: the declaration, never an audit badge ----
  const req = e.requirements;
  const reqBox = el("div", "reqs");
  reqBox.append(el("h4", null, "Declared input appetite"));
  if (req.unclassified) {
    reqBox.append(el("p", "warn", "Unclassified: no cvm:req:*/cvm:opt:* tag at all. Absent is not none — treat as undeclared."));
  } else {
    if (req.none_sentinel) reqBox.append(el("p", "ok", "Declares cvm:req:none (no personal data beyond settlement)."));
    if ((req.required || []).length) reqBox.append(el("p", null, "Required: " + req.required.join(", ")));
    if ((req.optional || []).length) reqBox.append(el("p", null, "Optional: " + req.optional.join(", ")));
    if (!req.none_sentinel && !(req.required || []).length && !(req.optional || []).length) {
      reqBox.append(el("p", "warn", "No requirement tags beyond the tier claim."));
    }
  }
  if ((req.unknown || []).length) {
    reqBox.append(el("p", "loud", "UNKNOWN requirement(s), not counted as none: " + req.unknown.join(", ")));
  }
  if (e.tier.mismatch) {
    reqBox.append(el("p", "loud", "Tier mismatch: published " + (e.tier.declared.join(", ") || "(none)") + ", recomputed " + (e.tier.recomputed ?? "(unclassified)") + ". The recomputed value is used."));
  }
  const note = el("p", "fineprint");
  note.textContent = "This is the provider's own declaration on public tags — a declaration, not an audited fact.";
  reqBox.append(note);
  c.append(reqBox);

  if (!decision.live_claims) {
    c.append(el("p", "fineprint", "Cached snapshot: this entry is not being shown as live."));
  }
  return c;
}

function factItem(k, v) {
  const li = el("li");
  li.append(el("span", "k", k));
  li.append(document.createTextNode(" " + v));
  return li;
}

function badge(text, cls) {
  return el("span", "badge " + cls, text);
}

// ------------------------------------------------------------------ load ----

async function load() {
  try {
    const res = await fetch("catalog.json", { cache: "no-store" });
    if (!res.ok) throw new Error("catalog.json -> HTTP " + res.status);
    CATALOG = await res.json();
  } catch (err) {
    CATALOG = null;
    const host = $("#app");
    host.textContent = "";
    host.append(el("p", "banner disabled", "CACHE UNAVAILABLE — could not read catalog.json (" + err.message + "). Disabled (fail closed)."));
    return;
  }
  render();
  // re-evaluate the freshness state on a timer: a page left open must go stale
  if (RELOAD_TIMER) clearInterval(RELOAD_TIMER);
  RELOAD_TIMER = setInterval(render, 30_000);
}

document.addEventListener("DOMContentLoaded", load);
