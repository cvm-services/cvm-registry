# TDD evidence — catalog-constrained renderer (ADR-0005 phase-0)

Run: 2026-10-07T09:10:10Z  host: CobradorWave

## RED — tests/render_spec_test.ts with site/render/ absent
```
[0m[1mTS2307 [0m[ERROR]: Cannot find module 'file://~/worktrees/cvm-catalog-render/site/render/spec.js'.
    at [0m[36mfile://~/worktrees/cvm-catalog-render/tests/render_spec_test.ts[0m:[0m[33m24[0m:[0m[33m96[0m

[0m[1mTS2307 [0m[ERROR]: Cannot find module 'file://~/worktrees/cvm-catalog-render/site/render/catalog.js'.
    at [0m[36mfile://~/worktrees/cvm-catalog-render/tests/render_spec_test.ts[0m:[0m[33m25[0m:[0m[33m81[0m

Found 2 errors.

[0m[1m[31merror[0m: Type checking failed.

  [33minfo:[39m The program failed type-checking, but it still might work correctly.
  [36mhint:[39m Re-run with [4m--no-check[24m to skip type-checking.
```

## GREEN — same command, implementation restored
```
[0m[38;5;245mrunning 10 tests from ./tests/render_spec_test.ts[0m
the fixture is a real capture, not invented data ... [0m[32mok[0m [0m[38;5;245m(7ms)[0m
the catalog keeps the spec surface to what the brief defines ... [0m[32mok[0m [0m[38;5;245m(335µs)[0m
buildServiceSpec is a pure function of served data ... [0m[32mok[0m [0m[38;5;245m(19ms)[0m
the doppelt spec fits the renderer's size cap ... [0m[32mok[0m [0m[38;5;245m(1ms)[0m
one MenuItem and one PriceRow per served item, and the count matches the fixture ... [0m[32mok[0m [0m[38;5;245m(1ms)[0m
every price in the spec IS a served price — and an injected one is detected ... [0m[32mok[0m [0m[38;5;245m(130ms)[0m
the spec contains no URL at all ... [0m[32mok[0m [0m[38;5;245m(1ms)[0m
OrderAction needs the declared tool; HandoffAction needs the published URL ... [0m[32mok[0m [0m[38;5;245m(77ms)[0m
the order payload identifies items the way the tool requires ... [0m[32mok[0m [0m[38;5;245m(795µs)[0m
the renderer's own source keeps the hard rules (static) ... [0m[32mok[0m [0m[38;5;245m(1ms)[0m

[0m[32mok[0m | 10 passed | 0 failed [0m[38;5;245m(597ms)[0m

```

## FULL SUITE GREEN
```

[0m[32mok[0m | 112 passed | 0 failed [0m[38;5;245m(8s)[0m

```

## E2E (real chromium, real DOM, real clicks)
```
  "verdict": "PASS — 76 menu items from the served fixture, 76 prices matched, 13 fail-closed cases",
  "failures": []
}
```
