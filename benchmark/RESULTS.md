# TransLift benchmark

Ground-truth set: **13 labeled strings** in `benchmark/cases`.

## Summary

- **TransLift** · precision 100% (TP 7 / FP 0) · recall 100% (TP 7 / 7) · **silent misses: 0** · surfaced-for-review: 0
- **i18next-cli lint** · precision 100% (TP 4 / FP 0) · recall 57% (TP 4 / 7) · **silent misses: 3** · surfaced-for-review: 0

## Per-string

| string | expect | TransLift | i18next-cli |
|---|---|---|---|
| Welcome to your dashboard | wrap | wrap ✓ | wrap ✓ |
| You have new messages waiting. | wrap | wrap ✓ | wrap ✓ |
| Dismiss | wrap | wrap ✓ | wrap ✓ |
| Close notification | wrap | wrap ✓ | wrap ✓ |
| Your payment could not be processed. | wrap | wrap ✓ | silent ✗ silent |
| Your changes have been saved. | wrap | wrap ✓ | silent ✗ silent |
| Shade | wrap | wrap ✓ | silent ✗ silent |
| banner wrapper-large | skip | surfaced ✓ | silent ✓ |
| initializing analytics module | skip | silent ✓ | silent ✓ |
| https://api.example.com/v2/data | skip | silent ✓ | silent ✓ |
| 0 0 24 24 | skip | silent ✓ | silent ✓ |
| M4 4h16v16H4z | skip | silent ✓ | silent ✓ |
| translate(2 2) | skip | silent ✓ | silent ✓ |

## Recall (pre-i18n checkout)

Pre-i18n **excalidraw** (`ff7a340d^`, 29 hardcoded strings the team later translated):

- wrapped (recall): **79%** (23/29)  ·  surfaced for review: 1  ·  silent miss: 5
- remaining silent misses: `Code`, `Copy Styles`, `Normal`, `Paste Styles`, `Select All`
  (documented file-coverage / data-key limitations — see `recall-excalidraw.json`)

## Scale

TransLift on Excalidraw (~240 files): `101 wrap · 10000 skip · 241 dynamic · 260 unresolved · 0 conflict · 635 missing · 0 orphan` in 4.5s wall.

