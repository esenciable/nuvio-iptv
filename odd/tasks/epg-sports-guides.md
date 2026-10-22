# EPG: guías deportivas curadas (Opción A)

Goal: make the sports channels in `esencial.m3u` carry a real TV guide, so the app's
Sports hub can find matches in our own EPG instead of reporting "Not found in your channels yet".

## Why this shape

47 sports channels in the generated playlist have no `tvg-id`. The existing mechanism for
that is `tools/aliases.json`: a curated table, one entry per channel, each value verified
with `grep` against the files we actually download. No new schema and no new merge layer —
the table already is the curated override layer, and inventing a second one would fork the
decision logic.

## Evidence gathered (iptv-epg.org, 2026-10-21)

| feed name | pinned id | source | programmes | sample title |
| --- | --- | --- | --- | --- |
| `Sky Sports LaLiga` (+ `[Opc.2]`..`[Opc.7]`) | `M+LaLigaTV.es` | es | 191 | `LALIGA EA SPORTS (T26/27): Villarreal CF - Elche CF` |
| `Sky Sports F1` | `DAZNF1.es` | es | 117 | `Mundial F1 - GP de Países Bajos : Carrera` |
| `Movistar Deportes` (+`[Opc.2]`,`[Opc.3]`) | `M+Deportes.es` | es | 111 | `Euroliga de baloncesto (T26/27): Valencia Basket - ...` |
| `TyC Sports (Internacional)`, `TyC Sports SD (Internacional)` | `TyCSportsInt.us` | us | 108 | `Fútbol Argentino Primera División` |
| `Telemundo Deportes Ahora (Internacional)` (+`[1080p]`,`[720p]`) | `TelemundoDeportesAhora.peacocktv` | us | 75 | — |

Rejected pins, with the reason (these are traps, not oversights):

- `beINSports.us` (193) and `beINSportsEnEspanol.us` (177): filler — `Paid Programming` /
  `Programa pagado`. The Spanish feed is filler for essentially every slot.
- `DAZNLaLiga.es` (116 in a grep count, 0 in the strict scan): `M+LaLigaTV.es` is richer.
- `LaLigaTVBAR.es` (79): titles repeat the channel name, so they match nothing.
- `Tigo Sports` (BO/PY): no `Tigo` id in any default country file, only `TigoSports.py`,
  a different country's signal.

## Corrections to earlier claims

- **The TyC "duplicate id" was not a bug.** AR publishes only `TyCSports.ar` (101) and
  `TyCSports2.ar` (15). The six feed entries pointing at `TyCSports.ar` are mirrors of one
  signal, which is correct. The genuine gap was the **International** feed, which has its
  own id `TyCSportsInt.us` — reachable only through the `us` source.
- **`--include-us` is not free.** `epg-us.xml` is 497 MB and the host ignores `Range`
  requests, so it is a full download per run. `build.mjs` holds one country at a time
  (`let xml` inside the loop), so peak RSS is one file, not the sum.

## Non-goals

- No changes to how the app reads the guide (`SportsMatcher`, `guideEvents()` untouched).
- No new EPG source host; iptv-epg.org stays the only upstream.
- No translation of Sports hub strings.

## Tasks

- [x] 1. Add the verified pins to `tools/aliases.json`, replacing the "NOT pinned, by
  decision" note for the ones we now resolve and keeping the rejected ones documented.
- [x] 2. Activate `--include-us` in `.github/workflows/refresh.yml`.
- [x] 3. Test: every alias value's country suffix must be a country the build downloads.
  A pin to an undownloaded country silently produces an empty guide and looks like the
  source's fault.
- [x] 4. Run the generator with a warm local cache, confirm coverage rises and no
  previously resolved id changes.
- [ ] 5. Work-unit commit on a feature branch, push, confirm Pages republishes.

## Acceptance

- `node --test tools/test/*.test.mjs` green.
- Sports channels with a guide go from 16 to at least 24 of the 63 sports entries.
- Zero regressions: ids already resolved stay identical.

## Relevant files

- `tools/aliases.json`, `tools/build.mjs`, `tools/guide.mjs`, `tools/lib/epg.mjs`
- `.github/workflows/refresh.yml`, `tools/test/build.test.mjs`

## Observed result (2026-10-22, real feed, warm cache, `--include-us`)

- Channels with a guide: **361 → 382** of 1869 (19.4% → 20.5%), 145 distinct ids, 6178 programmes.
- **0 regressions**: no id that the 14-country build already resolved changed.
- Build time with a warm cache: 15 s.
- The `FOX` block removed all 10 `FOX4K.us` matches from one table entry, because the
  `[Opc.N]` variants are stripped before the table is consulted again.
- Guide content on the pinned channels: 61 of 67 programmes on `M+LaLigaTV.es` read like
  fixtures (`LALIGA EA SPORTS (T26/27): CA Osasuna - R. Racing Club`), 13 of 27 on
  `DAZNF1.es` name a Grand Prix, `TyCSportsInt.us` carries 26 rows of Argentine football.

## Follow-up, not taken here

`us` also auto-matched entertainment names (E! Entertainment, BabyFirst, USA Network,
Azteca Internacional, Retro TV) to their US grids. Those are the same brand but a different
regional feed; they are not in the sports path, and each one needs a human call about
whether a US grid is better than no grid. Same block marker (`"!"`) does it when decided.
