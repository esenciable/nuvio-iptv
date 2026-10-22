/**
 * EPG (electronic programme guide) helpers for live TV.
 *
 * Our app only maps a live match to a channel when the channel carries a guide id, and the
 * third-party IPTV feed we regenerate carries almost none. So we match every feed channel by
 * name against the ids published by a free XMLTV source (iptv-epg.org, no API key) and emit a
 * guide that uses those ids. This file is a plain-ESM copy of the matching code we already run in
 * `kino-light-addon-nuvio-xmltv` (src/epg.ts), kept semantically identical on purpose: two copies
 * that match differently would publish a guide nobody can reproduce.
 *
 * Two decisions worth keeping:
 *   - Matching is STRICT. Relaxing it wins more channels but attaches somebody else's guide
 *     (`America TV Peru` landed on `AmericaTV.ar`, `Gol Peru` on `GOL.es`). A channel with no
 *     guide looks empty; a channel with another country's guide lies.
 *   - A source that fails only loses its own channels; it never empties the whole guide.
 */

export const IPTV_EPG_BASE = 'https://iptv-epg.org/files';

/** An alias value that means "this name must never carry a guide", not even by auto-matching. */
export const NO_GUIDE = '!';

/** What the source writes when it has no data. Showing "No Data" in the grid looks broken:
 *  a gap is better, because the player already knows how to draw one.
 *  The sports channels are the worst offenders: beIN runs "Paid Programming"/"Programa pagado"
 *  in nearly every slot and the per-team LaLiga channels run "No Game Today"/"SIGN OFF".
 *  Every phrase here was read in a published file, not guessed. */
const PLACEHOLDER_TITLES = /^(no data|no informado|sin datos|sin informacion|sin información|n\/a|na|to be announced|tba|por confirmar|a confirmar|paid programming|programa pagado|sign off|signing off|no match today|no game today)$/i;

/** Quality codes and decorations that do not identify the channel. */
const NOISE = /\b(fhd|uhd|4k|hd|sd|hevc|h265|h264|1080p|720p|576p|480p|multi|dual|plus|opc|backup)\b/;
/** Country hints that appear in the channel name itself. */
const COUNTRY_HINTS = {
  us: 'us', usa: 'us', 'ee uu': 'us', espana: 'es', esp: 'es', spain: 'es',
  mexico: 'mx', mex: 'mx', mx: 'mx', peru: 'pe', pe: 'pe',
  guate: 'gt', guatemala: 'gt', chile: 'cl', cl: 'cl',
  argentina: 'ar', arg: 'ar', ar: 'ar', venezuela: 've', ve: 've',
  colombia: 'co', col: 'co', co: 'co', ecuador: 'ec', ec: 'ec',
  bolivia: 'bo', bo: 'bo', paraguay: 'py', py: 'py', uruguay: 'uy', uy: 'uy',
  panama: 'pa', pa: 'pa', centroamerica: 'cr', cr: 'cr',
};

export function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

export function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "12. A&E FHD" -> "a e"; "AXN ESPAÑA HD" -> "axn espana" (the country hint is resolved apart). */
export function normalizeChannelName(name) {
  let text = decodeXmlEntities(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  text = text.toLowerCase();
  text = text.replace(/^\s*\d+\s*[.)-]\s*/, ''); // "12. "
  text = text.replace(NOISE, ' ');
  text = text.replace(/[^a-z0-9+]+/g, ' ');
  return text.split(' ').filter(Boolean).join(' ').trim();
}

/** The country the channel name itself declares, if it declares one. */
export function epgCountryHint(name) {
  const tokens = normalizeChannelName(name).split(' ');
  for (const token of tokens) {
    const country = COUNTRY_HINTS[token];
    if (country !== undefined) return country;
  }
  return null;
}

/** "Caracol.co" -> "co". An id without a country suffix returns null. */
export function countryOfEpgId(id) {
  const match = id.match(/\.([a-z]{2})$/);
  return match?.[1] ?? null;
}

export function epgSourceUrl(country) {
  return `${IPTV_EPG_BASE}/epg-${country.toLowerCase()}.xml`;
}

/** iptv-epg.org writes the country's LOCAL wall-clock time with a "+0000" suffix (a lie from
 *  the generator, verified 2026-09-22): every source has to be re-based to UTC with the real
 *  zone of the country. */
export const SOURCE_ZONES = {
  ar: 'America/Argentina/Buenos_Aires', bo: 'America/La_Paz', cl: 'America/Santiago',
  co: 'America/Bogota', cr: 'America/Costa_Rica', do: 'America/Santo_Domingo',
  ec: 'America/Guayaquil', es: 'Europe/Madrid', gt: 'America/Guatemala',
  hn: 'America/Tegucigalpa', mx: 'America/Mexico_City', ni: 'America/Managua',
  pa: 'America/Panama', pe: 'America/Lima', pr: 'America/Puerto_Rico',
  py: 'America/Asuncion', sv: 'America/El_Salvador', uy: 'America/Montevideo',
  us: 'America/New_York', ve: 'America/Caracas',
};

export function sourceZone(country) {
  return SOURCE_ZONES[country.toLowerCase()] ?? null;
}

/**
 * Hands the event loop back its turn.
 *
 * Building a guide walks XMLTV files of tens of megabytes with synchronous regular expressions.
 * Without this the process stops answering while it parses. `setImmediate` (not `setTimeout(0)`)
 * returns the turn to I/O that is already ready instead of to the timer queue.
 */
const yieldToLoop = () => new Promise(resolve => {
  setImmediate(resolve);
});

/** How often to yield. The numbers follow the weight of each item: a channel builds several
 *  normalized candidates and one Set each, a programme is a handful of regexes over a short
 *  slice. At 1000 programmes per turn the longest block is measured in milliseconds. */
const CHANNEL_YIELD_EVERY = 200;
const PROGRAMME_YIELD_EVERY = 1000;

/**
 * Guide index: normalized name -> country -> id. Built from the `<channel>` elements of one file.
 * The same name can exist in several countries (`A&E` is in .co and in .cl) and the id keeps that
 * suffix, so we store them all and choose with the name hint.
 */
export async function buildChannelIndex(files) {
  const index = new Map();
  for (const file of files) {
    let scanned = 0;
    for (const [rawId, body] of channelEntries(file.xml)) {
      const id = decodeXmlEntities(rawId);
      const country = countryOfEpgId(id) ?? file.country;
      const names = displayNames(body);
      const candidates = new Set();
      const withoutSuffix = id.replace(/\.[a-z]{2}$/, '');
      candidates.add(withoutSuffix);
      for (const name of names) {
        candidates.add(name);
        candidates.add(name.replace(/^[A-Z]{2}\s*-\s*/, ''));
      }
      for (const candidate of candidates) {
        const key = normalizeChannelName(candidate);
        if (key.length < 2) continue;
        const byCountry = index.get(key) ?? new Map();
        if (!byCountry.has(country)) byCountry.set(country, id);
        index.set(key, byCountry);
      }
      scanned += 1;
      if (scanned % CHANNEL_YIELD_EVERY === 0) await yieldToLoop();
    }
  }
  return index;
}

/** Strict matching: manual alias, then exact name; the country wins over everything else. */
export function matchEpgChannel(name, index, options = {}) {
  const aliases = options.aliases ?? {};
  const order = options.order ?? [];
  const direct = aliases[name] ?? aliases[normalizeChannelName(name)];
  if (direct !== undefined) return direct === NO_GUIDE ? null : direct;

  const key = normalizeChannelName(name);
  const hint = epgCountryHint(name);
  const stripped = key
    .split(' ')
    .filter(token => COUNTRY_HINTS[token] === undefined || COUNTRY_HINTS[token] === '')
    .join(' ')
    .trim();
  const byCountry = index.get(key) ?? index.get(stripped);
  if (byCountry === undefined) return null;

  if (hint !== null) return byCountry.get(hint) ?? null;
  // Without a hint, the order of the configured sources decides.
  for (const country of order) {
    const found = byCountry.get(country);
    if (found !== undefined) return found;
  }
  return null;
}

export function parseXmltvTime(text) {
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const offsetMinutes = zone === undefined ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return utc - offsetMinutes * 60_000;
}

export function formatXmltvTime(epochMs) {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)} +0000`;
}

/** Offset (ms) of an IANA zone at a given instant, using Intl (no dependencies). */
export function zoneOffsetMs(zone, epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = type => Number(parts.find(part => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - epochMs;
}

/** Wall-clock time written by the source -> true UTC epoch. Two passes in case the daylight
 *  saving change falls inside the day. */
export function wallClockToEpoch(zone, text) {
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second] = match;
  const naive = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  let epoch = naive - zoneOffsetMs(zone, naive);
  epoch = naive - zoneOffsetMs(zone, epoch);
  return epoch;
}

/**
 * Source time -> UTC epoch. With a configured zone: a suffix other than "+0000" is a feed that is
 * really zoned and is respected; "+0000" or no suffix is the local wall-clock time iptv-epg.org
 * publishes, so it is re-based with the real zone of the country. Without a zone, historical
 * behaviour (parseXmltvTime).
 */
function parseSourceTime(text, zone) {
  if (zone === undefined) return parseXmltvTime(text);
  const offset = text.match(/^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}\s*([+-]\d{4})/)?.[1] ?? null;
  if (offset !== null && offset !== '+0000') return parseXmltvTime(text);
  return wallClockToEpoch(zone, text);
}

function* channelEntries(xml) {
  const pattern = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    yield [match[1] ?? '', match[2] ?? ''];
    match = pattern.exec(xml);
  }
}

function displayNames(body) {
  const names = [];
  const pattern = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
  let match = pattern.exec(body);
  while (match !== null) {
    const value = (match[1] ?? '').trim();
    if (value !== '') names.push(value);
    match = pattern.exec(body);
  }
  return names;
}

/**
 * Walks the XMLTV once and keeps the programmes of the requested channels inside the window.
 * It scans by index instead of with one regex over the whole file: the United States files carry
 * over a million programmes and materializing them all does not fit in 4 GB.
 */
export async function collectProgrammes(xml, wanted, options) {
  const perChannelLimit = options.perChannelLimit ?? 400;
  const found = new Map();
  const openTag = /<programme\s+([^>]*)>/g;
  let match = openTag.exec(xml);
  let scanned = 0;
  while (match !== null) {
    const attributes = match[1] ?? '';
    const channel = decodeXmlEntities(attributes.match(/channel="([^"]*)"/)?.[1] ?? '');
    if (wanted.has(channel)) {
      const start = parseSourceTime(attributes.match(/start="([^"]*)"/)?.[1] ?? '', options.zone);
      const stop = parseSourceTime(attributes.match(/stop="([^"]*)"/)?.[1] ?? '', options.zone);
      const closeAt = xml.indexOf('</programme>', openTag.lastIndex);
      const body = closeAt === -1 ? '' : xml.slice(openTag.lastIndex, closeAt);
      const title = decodeXmlEntities(body.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '');
      const category = decodeXmlEntities(body.match(/<category[^>]*>([\s\S]*?)<\/category>/)?.[1]?.trim() ?? '');
      const usableTitle = title !== '' && !PLACEHOLDER_TITLES.test(title);
      if (start !== null && stop !== null && start >= options.from && start <= options.to && usableTitle) {
        const list = found.get(channel) ?? [];
        if (list.length < perChannelLimit) {
          list.push({ start, stop, title, ...(category === '' || category === 'default' ? {} : { category }) });
          found.set(channel, list);
        }
      }
    }
    scanned += 1;
    if (scanned % PROGRAMME_YIELD_EVERY === 0) await yieldToLoop();
    match = openTag.exec(xml);
  }
  for (const list of found.values()) list.sort((left, right) => left.start - right.start);
  return found;
}

/** XMLTV that uses the ids the playlist already publishes, so the player matches with no setup. */
export function renderXmltv(channels, programmes) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE tv SYSTEM "xmltv.dtd">',
    '<tv generator-info-name="nuvio-iptv">',
  ];
  for (const channel of channels) {
    const label = channel.number !== undefined && channel.number > 0 ? `${channel.number}. ${channel.name}` : channel.name;
    const icon = channel.logo === undefined || channel.logo === '' ? '' : `<icon src="${escapeXml(channel.logo)}"/>`;
    lines.push(`  <channel id="${escapeXml(channel.code)}"><display-name>${escapeXml(label)}</display-name>${icon}</channel>`);
  }
  for (const channel of channels) {
    for (const programme of programmes[channel.code] ?? []) {
      lines.push(`  <programme start="${formatXmltvTime(programme.start)}" stop="${formatXmltvTime(programme.stop)}" channel="${escapeXml(channel.code)}">`);
      if (programme.category !== undefined) lines.push(`    <category>${escapeXml(programme.category)}</category>`);
      lines.push(`    <title>${escapeXml(programme.title)}</title>`);
      lines.push('  </programme>');
    }
  }
  lines.push('</tv>');
  return lines.join('\n') + '\n';
}
