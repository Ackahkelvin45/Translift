# TransLift benchmark

Ground-truth set: **9 labeled strings** in `benchmark/cases`.

## Summary

- **TransLift** · precision 100% (TP 6 / FP 0) · recall 100% (TP 6 / 6) · **silent misses: 0** · surfaced-for-review: 0
- **i18next-cli lint** · precision 100% (TP 4 / FP 0) · recall 67% (TP 4 / 6) · **silent misses: 2** · surfaced-for-review: 0

## Per-string

| string | expect | TransLift | i18next-cli |
|---|---|---|---|
| Welcome to your dashboard | wrap | wrap ✓ | wrap ✓ |
| You have new messages waiting. | wrap | wrap ✓ | wrap ✓ |
| Dismiss | wrap | wrap ✓ | wrap ✓ |
| Close notification | wrap | wrap ✓ | wrap ✓ |
| Your payment could not be processed. | wrap | wrap ✓ | silent ✗ silent |
| Your changes have been saved. | wrap | wrap ✓ | silent ✗ silent |
| banner wrapper-large | skip | surfaced ✓ | silent ✓ |
| initializing analytics module | skip | silent ✓ | silent ✓ |
| https://api.example.com/v2/data | skip | silent ✓ | silent ✓ |

## Scale

TransLift on Excalidraw (~240 files): `94 wrap · 9416 skip · 241 dynamic · 851 unresolved · 0 conflict · 635 missing · 0 orphan` in 4.7s wall.

