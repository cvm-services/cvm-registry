"use strict";
const root = document.querySelector("#console");
const age = (s) => { const n = Math.max(0, Math.floor(Date.now()/1000 - s)); return n < 3600 ? Math.floor(n/60)+"m" : Math.floor(n/3600)+"h"; };
function render(catalog) {
  root.textContent = "";
  root.append(Object.assign(document.createElement("h1"), { textContent: "Curator requests" }));
  root.append(Object.assign(document.createElement("p"), { textContent: "Private review queue. A request never grants access; edit curators.json and commit to approve." }));
  const list = document.createElement("section"); list.className = "requests";
  const requests = Array.isArray(catalog.requests) ? catalog.requests.slice(0, 100) : [];
  if (!requests.length) { list.append(Object.assign(document.createElement("p"), { textContent: "No access requests." })); root.append(list); return; }
  for (const r of requests) {
    const card = document.createElement("article"); card.className = "card request"; card.dataset.npub = r.npub;
    const h = document.createElement("h2"); h.textContent = r.npub; card.append(h);
    const facts = document.createElement("p"); facts.textContent = `${age(r.first_seen)} old · ${r.service_class || "class undeclared"} · status: ${r.status}`; card.append(facts);
    if (r.contact) card.append(Object.assign(document.createElement("p"), { textContent: "Contact: " + r.contact }));
    if (r.evidence) { const a = document.createElement("a"); a.href = r.evidence; a.textContent = "Evidence"; a.target = "_blank"; a.rel = "noopener noreferrer"; card.append(a); }
    const actions = document.createElement("p");
    const copy = document.createElement("button"); copy.textContent = "Copy allow-list line"; copy.onclick = async () => { await navigator.clipboard.writeText(`{\"npub\":\"${r.npub}\",\"role\":\"provider\"}`); copy.textContent = "Copied"; }; actions.append(copy);
    const dismiss = document.createElement("button"); dismiss.textContent = "Dismiss"; dismiss.onclick = () => card.remove(); actions.append(dismiss);
    card.append(actions); list.append(card);
  }
  root.append(list);
}
fetch("../catalog.json", { cache: "no-store" }).then((r) => r.json()).then(render).catch((e) => { root.textContent = ""; root.append(Object.assign(document.createElement("p"), { className: "banner disabled", textContent: "Catalog unavailable: " + e.message })); });
