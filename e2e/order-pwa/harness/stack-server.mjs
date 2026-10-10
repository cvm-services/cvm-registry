// stack-server.mjs — boot the local stack and hold it open, so the LIVE spec can
// be pointed at something other than the deploy.
//
//   node e2e/order-pwa/harness/stack-server.mjs
//   [stack] site=http://127.0.0.1:44227 orders=http://127.0.0.1:35273 mint=... cvm-orders=1ebe0dc (clone of main)
//   [stack] E2E_LIVE=1 E2E_LIVE_BASE=http://127.0.0.1:44227 npx playwright test --project=live
//
// Why this exists: the live spec is the one that asserts the invoice the customer
// is asked to pay, and on any given day the deploy may be red for reasons that
// have nothing to do with the spec (a stale client, a stale service). Pointing it
// at a stack of THIS branch is how its own assertions are shown to execute instead
// of being assumed to — see docs/e2e/order-pwa/live-run.log, "LOCAL-BASE RUNS".
//
// The hermetic project runs the same journey; this entry point exists for the live
// spec's code path, not as a second happy path. It is a server: it does not exit,
// and it prints the two lines above when it is ready. Ctrl-C stops the stack.
import { startStack } from "./stack.mjs";

const stack = await startStack();
console.log(
  `[stack] site=${stack.site} orders=${stack.orders} mint=${stack.mint} ` +
    `cvm-orders=${stack.ordersCommit} (${stack.ordersSource})`,
);
console.log(`[stack] E2E_LIVE=1 E2E_LIVE_BASE=${stack.site} npx playwright test --project=live`);

const stop = async () => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
