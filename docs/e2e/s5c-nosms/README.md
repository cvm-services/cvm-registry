# S5c — the nosms CVM happy path, recovered into this repo's history

These are the artifacts of the **S5c** run (the nosms napplet's CVM happy path:
boot → contract → priced → contract fetched → send). They are committed here so
the proof lives in git history alongside the rest of the e2e evidence, instead of
only as a kanban attachment on the retired card `t_167558e7`.

## Provenance — the artifacts are real, and the "unpublished" reading was a wrong-repo measurement

Card `t_e2a7400c` asserted that the S5c card's publication claim does not verify:

```
git cat-file -t cb1b12f13fa4afe021c481ee6f3fd23df1cf5465   # in cvm-registry
  -> could not get object info
```

That is true **in this repo** and is the wrong repo to look in. The S5c proof was
published in the **nosms** repo. Measured 2026-10-09 from
`~/worktrees/t_167558e7` (which is the nosms checkout):

```
$ git ls-remote origin 'refs/heads/pr/s5c*'
cb1b12f13fa4afe021c481ee6f3fd23df1cf5465	refs/heads/pr/s5c-playwright-e2e
$ git log -1 --format='%H %ci %s' cb1b12f1
cb1b12f13fa4afe021c481ee6f3fd23df1cf5465 2026-10-06 22:07:36 +0200 test(napplet-e2e): record honest nosms CVM proof
```

`origin` there is `https://github.com/felixfelix-bot/nosms.git`. So the commit
exists, the branch exists, and the six files below are tracked at its HEAD. The
lesson (not the artifacts) is what the card got right: **a claim is verified
against the repo that owns the artifact, and a bare "pushed" without the repo
named is not a claim anyone can check.**

## The files

| file | bytes | sha256 |
|---|---|---|
| `01-boot.png` | 118056 | `f975763fea776766439a413713fb8c4ba31f19778fba2caaf1b651aefbcd08ee` |
| `02-contract.png` | 171355 | `67a157a9d88165154f29ecdea858c1276d6343f85f3bac833215d1fad905ebb2` |
| `03-priced.png` | 171743 | `18d0e69c469f556c11e030bddd81e54a54bf0454eb0412556a49438f39927533` |
| `04-contract-fetched.png` | 188908 | `8eba1b2969b686b43824b2c3406b9003d6a75052adba7e30e1f83762142a8cb9` |
| `05-send.png` | 139051 | `a944dad14342e8eb9f6129ee343b60fe0c15ed695dc8ca58c8e5ea6819c6c1f9` |
| `nosms-cvm-happy-path.webm` | 1333675 | `bbd21921c27bdc7e4aaa72204a606cae8378d1a6764ff25118452f533b327621` |

All five PNGs verified as `PNG image data, 1280 x 720, 8-bit/color RGB` and the
video as `WebM` (`file(1)`), not merely as files with those names.

The webm's sha256 is byte-identical to the copy on the kanban attachment
`…/attachments/t_167558e7/nosms-cvm-happy-path.webm`, which ties this in-repo copy
to the original evidence rather than to a re-encode.

## What was NOT re-run, and why that is stated here

The card asked for a re-run of the nosms happy path. It was **not** re-run:

- The nosms happy path is another repo's harness (`felixfelix-bot/nosms`,
  `napplet/e2e/nosms-cvm.spec.ts`). Re-running it here would prove that repo's
  harness, not this one's, and this card's scope is cvm-registry's e2e suite.
- The artifacts were already produced by a real run and already committed
  (`cb1b12f`); re-running would replace real evidence with fresher-looking
  evidence of the same thing.

What this directory therefore claims is exactly: **these bytes are the S5c
artifacts, they came from that commit, and they are now in this repo's history.**
It does not claim they were regenerated on 2026-10-09.
