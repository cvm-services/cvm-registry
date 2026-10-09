import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = Deno.readTextFileSync("site/order/app.js");
const page = Deno.readTextFileSync("site/order/index.html");

Deno.test("customer order route is a standalone six-screen client", () => {
  assert(page.includes('src="app.js"'));
  for (const marker of ["venueList", "menu", "itemSheet", "basket", "pay", "status"]) {
    assert(source.includes(`function ${marker}`), `${marker} screen exists`);
  }
  assert(source.includes("site/order") === false, "client does not hard-code its deployment path");
});

Deno.test("order client is catalog-constrained and renders declared inputs", () => {
  assert(source.includes('fetch("../menu.json")'));
  assert(source.includes('fetch(ORDER_INPUT_REGISTER_URL)'));
  assert(source.includes("state.inputRegister?.fields"));
  assert(source.includes('name === "contact.phone"'));
  assert(source.includes("data-input=\\\"contact.phone\\\"" ) === false, "inputs are generated rather than hard-coded");
});

Deno.test("payment and status use service endpoints and never fabricate an invoice", () => {
  assert(source.includes('fetch("/api/orders"'));
  assert(source.includes("/invoice"));
  assert(source.includes("!state.invoice.bolt11||!state.invoice.qr"));
  assert(source.includes("/api/orders/${encodeURIComponent(state.order.id)}"));
  assert(source.includes("setInterval"));
  assertEquals(source.includes("lnbc-real-invoice-returned-by-order-service"), false);
});

Deno.test("sold-out catalog entries are disabled", () => {
  assert(source.includes("i.available===false?'disabled':''"));
  assert(source.includes("i.available===false?'dead':''"));
});
