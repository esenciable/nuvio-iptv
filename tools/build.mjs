#!/usr/bin/env node
/**
 * Entry point: rebuild `esencial.m3u` and `epg.xml` from the third-party feed plus iptv-epg.org.
 *
 * Everything is static: GitHub Pages serves the two files from the repository root, there is no
 * server of ours and no runtime dependency (Node built-ins only, global fetch).
 *
 * Usage:
 *   node tools/build.mjs                     # full rebuild against the network
 *   node tools/build.mjs --include-us        # also download the 497 MB epg-us.xml
 *   node tools/build.mjs --fixture test/fixtures --dry-run --countries sv,gt,ar
 *
 * Exit codes: 0 ok, 1 fetch/parse/guard failure, 2 bad usage.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { epgSourceUrl, renderXmltv } from './lib/epg.mjs';
import { isSportsEntry, parsePlaylist, renderPlaylist } from './feed.mjs';
import { loadAliases, resolveGuide } from './guide.mjs';

export const FEED_URL = 'https://raw.githubusercontent.com/JMigue85/IPTV-SV/refs/heads/main/IPTVSV.m3u';
export const EPG_URL = 'https://esenciable.github.io/nuvio-iptv/epg.xml';

/** Countries downloaded by default. `us` is deliberately opt-in: its file is 497 MB. */
export const DEFAULT_COUNTRIES = ['sv', 'gt', 'cr', 'pa', 'mx', 'co', 'ec', 'bo', 'py', 'uy', 'ar', 've', 'do', 'es'];

/** The feed is served from raw.githubusercontent.com and answers without a UA, but iptv-epg.org
 *  sits behind a bot filter, so a browser UA is used for both downloads. */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** A silent empty guide is worse than an old one: refuse to publish a feed this short. */
export const DEFAULT_MIN_ENTRIES = 1000;

const WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000;
const WINDOW_AFTER_MS = 36 * 60 * 60 * 1000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage: node tools/build.mjs [options]

  --out <dir>          output directory (default: repository root)
  --countries <list>   comma separated country codes (default: ${DEFAULT_COUNTRIES.join(',')})
  --include-us         append us to the country list (497 MB download)
  --cache <dir>        download cache for the epg sources (default: .cache/epg)
  --refresh            ignore cached epg sources and download again
  --aliases <path>     curated alias table (default: tools/aliases.json)
  --feed <url>         feed url (default: ${FEED_URL})
  --fixture <dir>      read feed.m3u and epg-<cc>.xml from a local directory, no network
  --now <iso>          freeze the clock (window and output are deterministic)
  --min-entries <n>    refuse to publish below this many feed entries (default: ${DEFAULT_MIN_ENTRIES}, 0 in fixture mode)
  --dry-run            print the summary, write nothing
  --help               this text
`;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

export function parseArgs(argv) {
  const options = {
    outDir: repoRoot,
    countries: [...DEFAULT_COUNTRIES],
    includeUs: false,
    cacheDir: join(repoRoot, '.cache', 'epg'),
    refresh: false,
    aliasesPath: join(repoRoot, 'tools', 'aliases.json'),
    feedUrl: FEED_URL,
    fixture: null,
    now: null,
    minEntries: null,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) fail(`${flag} needs a value`, 2);
      index += 1;
      return next;
    };
    switch (flag) {
      case '--out': options.outDir = resolve(value()); break;
      case '--countries': options.countries = value().split(',').map(code => code.trim().toLowerCase()).filter(Boolean); break;
      case '--include-us': options.includeUs = true; break;
      case '--cache': options.cacheDir = resolve(value()); break;
      case '--refresh': options.refresh = true; break;
      case '--aliases': options.aliasesPath = resolve(value()); break;
      case '--feed': options.feedUrl = value(); break;
      case '--fixture': options.fixture = resolve(value()); break;
      case '--now': options.now = value(); break;
      case '--min-entries': {
        const raw = value();
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed < 0) fail(`--min-entries expects a number, got "${raw}"`, 2);
        options.minEntries = parsed;
        break;
      }
      case '--dry-run': options.dryRun = true; break;
      case '--help': case '-h': options.help = true; break;
      default: fail(`unknown option: ${flag}\n\n${USAGE}`, 2);
    }
  }
  if (options.includeUs && !options.countries.includes('us')) options.countries.push('us');
  options.countries = [...new Set(options.countries)];
  return options;
}

/** Fetches text with the browser UA, following redirects, with a hard timeout. */
async function fetchText(url, timeoutMs = 180_000) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': CHROME_UA, accept: '*/*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  const text = await response.text();
  if (text.trim() === '') throw new Error(`empty response for ${url}`);
  return text;
}

/** Reads an epg source from the local cache, downloading and caching it on a miss. */
async function downloadEpg(country, options, log) {
  if (options.fixture !== null) {
    const path = join(options.fixture, `epg-${country}.xml`);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8');
  }
  const cached = join(options.cacheDir, `epg-${country}.xml`);
  if (!options.refresh && existsSync(cached) && statSync(cached).size > 1024) {
    log(`epg ${country}: cache hit`);
    return readFileSync(cached, 'utf8');
  }
  const url = epgSourceUrl(country);
  log(`epg ${country}: downloading ${url}`);
  const xml = await fetchText(url);
  mkdirSync(options.cacheDir, { recursive: true });
  writeFileSync(cached, xml);
  log(`epg ${country}: ${(xml.length / 1_048_576).toFixed(1)} MB`);
  return xml;
}

function percentage(part, total) {
  if (total === 0) return '0.0';
  return ((part / total) * 100).toFixed(1);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = message => process.stderr.write(`${message}\n`);
  const now = options.now === null ? Date.now() : Date.parse(options.now);
  if (Number.isNaN(now)) fail(`--now is not a date: ${options.now}`, 2);

  const minEntries = options.minEntries ?? (options.fixture === null ? DEFAULT_MIN_ENTRIES : 0);
  if (options.fixture !== null && !existsSync(join(options.fixture, 'feed.m3u'))) {
    fail(`fixture has no feed.m3u: ${options.fixture}`);
  }

  const aliases = loadAliases(options.aliasesPath);
  const feedText = options.fixture !== null
    ? readFileSync(join(options.fixture, 'feed.m3u'), 'utf8')
    : await fetchText(options.feedUrl);
  const entries = parsePlaylist(feedText);
  if (entries.length < minEntries) {
    fail(`only ${entries.length} entries parsed (floor is ${minEntries}): the feed looks unreachable or truncated, refusing to publish`);
  }
  log(`feed: ${entries.length} entries`);

  const from = now - WINDOW_BEFORE_MS;
  const to = now + WINDOW_AFTER_MS;
  const guide = await resolveGuide({
    entries,
    countries: options.countries,
    aliases,
    order: options.countries,
    from,
    to,
    loadEpg: country => downloadEpg(country, options, log),
  });

  for (const failure of guide.failedCountries) log(`warning: epg source ${failure.country} unavailable: ${failure.reason}`);
  if (guide.scannedCountries === 0) fail('no epg source could be read: refusing to publish an empty guide');

  const withId = guide.ids.filter(id => id !== null).length;
  const distinctIds = new Set(guide.ids.filter(id => id !== null)).size;
  const programmeCount = Object.values(guide.programmes).reduce((total, list) => total + list.length, 0);

  const playlist = renderPlaylist(entries, { epgUrl: EPG_URL, ids: guide.ids });
  const guideXml = renderXmltv(guide.channels, guide.programmes);

  const lines = [
    `entries: ${entries.length}`,
    `with id: ${withId} (${percentage(withId, entries.length)}%)`,
    `distinct ids: ${distinctIds}`,
    `guide channels: ${guide.channels.length}`,
    `guide programmes: ${programmeCount}`,
    `window: ${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`,
  ];

  const sports = entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => isSportsEntry(entry));
  lines.push('', `sports channels (${sports.length}):`);
  for (const { entry, index } of sports) {
    lines.push(`  ${entry.name} -> ${guide.ids[index] ?? '—'}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  if (options.dryRun) {
    log('dry run: no files written');
    return 0;
  }
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(join(options.outDir, 'esencial.m3u'), playlist);
  writeFileSync(join(options.outDir, 'epg.xml'), guideXml);
  log(`wrote ${join(options.outDir, 'esencial.m3u')} (${(playlist.length / 1024).toFixed(0)} KB)`);
  log(`wrote ${join(options.outDir, 'epg.xml')} (${(guideXml.length / 1024).toFixed(0)} KB)`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Error && typeof error.exitCode === 'number' ? error.exitCode : 1;
  });
}
