# vendored vocab

`service-inputs.json` is a **verbatim copy** of `vocab/service-inputs.json` from the
`contextvm-services` repo (ADR-0001 D14: "the register is shared vocabulary, so the
kit and the registry both read `vocab/service-inputs.json`").

This repo reads the vendored copy so a deploy does not depend on a second checkout.
It is **never hand-edited here** — it is re-copied and the hash below updated.

| field | value |
| --- | --- |
| source repo | `cvm-services/contextvm-services` |
| source path | `vocab/service-inputs.json` |
| source commit | `3f93093edde8f76c202bbeac30e1a7211133ccee` |
| copied on | 2026-10-05 |
| sha256 | see `sha256sum vocab/service-inputs.json` (recorded in the commit that vendored it) |

To refresh:

```sh
cp <contextvm-services>/vocab/service-inputs.json vocab/service-inputs.json
sha256sum vocab/service-inputs.json
```
