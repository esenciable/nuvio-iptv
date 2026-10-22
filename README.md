# nuvio-iptv

Static IPTV playlist and XMLTV guide for Nuvio, published from GitHub Pages.

Our Android app can only place a live match on a channel when that channel carries a guide id
(`tvg-id`), and the third-party IPTV feed we use carries almost none. This repository regenerates
the feed with real guide ids and publishes a matching guide next to it. Both files are static: there
is no server of ours, GitHub Pages serves them from the repository root.

## Public URLs

- Playlist: <https://esenciable.github.io/nuvio-iptv/esencial.m3u>
- Guide: <https://esenciable.github.io/nuvio-iptv/epg.xml>

## Add it to the app

1. Open the live TV section and add a playlist from a URL; paste
   `https://esenciable.github.io/nuvio-iptv/esencial.m3u`.
2. The guide is picked up from the playlist header (`#EXTM3U url-tvg="..."`), so usually there is
   nothing else to do. If your version asks for it, add a named EPG source pointing at
   `https://esenciable.github.io/nuvio-iptv/epg.xml`.
3. Channels with a guide id show programme data; the rest still play, they just have no grid.

## What the generator does

`node tools/build.mjs` (Node 22+, built-ins only, no dependencies, no lockfile):

1. Downloads the feed with a Chrome user agent and parses every `#EXTINF` entry.
2. Downloads one XMLTV file per country from `https://iptv-epg.org/files/epg-<cc>.xml` and caches it
   under `.cache/epg/` (git-ignored; the CI caches it too).
3. Matches each feed channel to an epg id: curated alias first, then strict name matching. A
   channel whose name claims a country only matches that country's file, so `ESPN (Perú)` stays
   empty instead of borrowing another country's grid.
4. Writes `esencial.m3u` with the original name, `group-title`, `tvg-logo`, stream URL and
   `#EXTVLCOPT` lines untouched, adding `tvg-id` only where an id was resolved. Variants of the same
   channel (`[Opc.2]`, `[Opc.3]`) keep their own entries and share the id resolved for the base name.
5. Writes `epg.xml` with only the resolved ids, programmes clipped to the window `now - 2h` ..
   `now + 36h`, and prints a run summary with the sports channels and their ids.

Two details worth knowing:

- **The `+0000` lie.** iptv-epg.org writes each country's local wall-clock time but labels it
  `+0000`. Every programme is re-based to real UTC with `sourceZone(country)`, so `12:00 +0000` in
  El Salvador is published as `18:00 +0000`.
- **Strict matching.** Loose matching wins more channels but attaches someone else's guide
  (`America TV Peru` landed on `AmericaTV.ar`). An empty grid is honest; a wrong grid is not. That is
  why `tools/aliases.json` exists.

## Measured coverage

Run of 2026-10-21 against the live feed and the 14 default country files:

| Metric | Value |
| --- | --- |
| Feed entries | 1869 |
| Entries with a `tvg-id` | 348 (18.6%) |
| Distinct ids | 132 |
| Channels in `epg.xml` | 132 |
| Programmes in `epg.xml` | 5598 |
| Sports channels listed | 176 (56 resolved, 120 without id) |

Five of those 132 ids resolve but the source publishes only `No Data` for them inside the window
(the `DIRECTVSports` signals and two Mexican channels at the time of writing), so they appear in the
guide without programmes. The feed is third-party and changes daily, so the numbers move between
runs; the CI summary on a workflow run is the current value.

A few rows from the sports table:

| Feed name | Resolved id |
| --- | --- |
| `TyC Sports`, `TyC Sports AR`, `TyC Sports [Opc.2]` | `TyCSports.ar` |
| `TNT Sports`, `TNT Sports[Opc.2]` | `TNTSports.ar` |
| `DSports [Opc. 1]` | `DIRECTVSports.uy` |
| `DSports (ECU) [Opc. 5]` | `DIRECTVSports.ec` |
| `ESPN HD` | `ESPN.sv` |
| `FOX Sports` | `FOXSports.sv` |
| `beIN Sports (ES)`, `UFC (EE.UU.) [EN]`, `TNT Sports Premium` | `—` (no id exists for them) |

## Alias table

`tools/aliases.json` maps an exact feed name to an epg id and is consulted before name matching:

```json
{
  "// Keys are the feed name exactly as it is published (spaces trimmed).": "",
  "TyC Sports": "TyCSports.ar",
  "DSports (ECU) [Opc. 5]": "DIRECTVSports.ec"
}
```

- Keys are matched **exactly** against the name that ends up in `esencial.m3u`, after trimming
  leading/trailing spaces. A key that does not match anything is silently unused.
- Keys starting with `//` are comments; the loader skips them. Use them to record why a name is
  pinned, and why a candidate was deliberately left unmapped.
- Only add a value after grepping the country files to prove the id exists
  (`grep '<channel id="' .cache/epg/*.xml`). Never invent an id: a made-up id is a channel with no
  grid at all.
- Prefer an alias over loosening the matcher. Plain name matching picks the wrong country for names
  that exist in several files (`TyC Sports` resolves to `TyCSports.gt` without one), and the alias is
  where a human makes that call.

Aliases are per feed name, so a variant that needs a different id needs its own key
(`TyC Sports (Internacional)`).

## Run locally

```sh
node tools/build.mjs                 # full rebuild, writes esencial.m3u and epg.xml
node tools/build.mjs --dry-run       # print the summary, write nothing
node tools/build.mjs --refresh       # ignore the download cache
node tools/build.mjs --include-us    # also fetch epg-us.xml (497 MB, opt-in)
node tools/build.mjs --countries sv,gt,cr --out /tmp/out
node tools/build.mjs --fixture tools/test/fixtures --dry-run   # offline, no network
```

Tests (offline, no network, fixture-based):

```sh
node --test tools/test/
```

The tests cover the header `url-tvg`, `tvg-id` only on resolved channels, `epg.xml` never declaring
a channel the playlist does not resolve, real-UTC re-basing of the `+0000` lie, aliases winning over
name matching, the `--dry-run` mode and the "feed is too short" guard.

## CI

`.github/workflows/refresh.yml` runs every 12 hours, on `workflow_dispatch`, and on pushes that
touch `tools/**`. It:

- runs the tests,
- caches the downloaded epg sources under a date-hour key,
- runs the generator,
- commits **only** `esencial.m3u` and `epg.xml` with `[skip ci]`,
- fails the job when the feed is unreachable or parses fewer than 1000 entries, and uses a
  `concurrency` group so two runs never push at once.

## Provenance

- The channel list and stream URLs come from the third-party feed
  [`JMigue85/IPTV-SV`](https://github.com/JMigue85/IPTV-SV). **We do not host or rebroadcast those
  streams.** This repository only rewrites the playlist text and adds guide ids.
- Guide data comes from [iptv-epg.org](https://iptv-epg.org), a free third-party XMLTV source.
- The matching code in `tools/lib/epg.mjs` is copied from our own `kino-light-addon`
  (`src/epg.ts`), converted to plain ESM.

If you are a rights holder and want a channel removed, open an issue and it will be removed from the
feed we republish (or from the alias table).

## Layout

```text
esencial.m3u                 published playlist
epg.xml                      published XMLTV guide
tools/build.mjs              entry point and CLI
tools/feed.mjs               playlist parsing, rendering, sports classification
tools/guide.mjs              alias loading, id resolution, programme collection
tools/lib/epg.mjs            matching/time helpers copied from kino-light-addon
tools/aliases.json           curated alias table
tools/test/                  offline fixture tests
.github/workflows/refresh.yml  12-hour refresh
```
