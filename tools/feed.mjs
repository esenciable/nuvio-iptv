/**
 * Playlist (.m3u) reading and rewriting.
 *
 * The feed we regenerate is third-party and changes without notice, so we parse it defensively and
 * keep every line we do not need to understand: the `#EXTVLCOPT` lines (user agent / referrer) and
 * the stream URL are copied verbatim, because rewriting them would break streams that only answer
 * to those headers.
 */

/** Attributes we keep on the emitted `#EXTINF` line, in this order. */
const KEPT_ATTRIBUTES = ['tvg-logo', 'group-title'];

/** Reads the value of `key="value"` inside an `#EXTINF` line, or '' when absent. */
function attributeOf(line, key) {
  const match = line.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`));
  return match === null ? '' : match[1];
}

/** Splits `#EXTINF:<duration> <attrs>,<name>` at the first comma that is not inside quotes. */
function splitExtinf(line) {
  let inQuotes = false;
  let commaAt = line.indexOf(',');
  if (commaAt === -1) return { attributes: line.slice(8), name: '' };
  for (let index = 8; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      commaAt = index;
      break;
    }
  }
  return { attributes: line.slice(8, commaAt), name: line.slice(commaAt + 1).trim() };
}

/**
 * Parses the playlist into entries.
 * `lines` keeps every line of the entry (`#EXTINF`, any `#EXTVLCOPT`, the stream URL) so the
 * renderer can reproduce the stream block unchanged.
 */
export function parsePlaylist(text) {
  const entries = [];
  const input = text.split(/\r?\n/);
  let current = null;
  for (const raw of input) {
    const line = raw.trimEnd();
    if (line.trim() === '') continue;
    if (line.startsWith('#EXTINF:')) {
      const { name } = splitExtinf(line);
      current = {
        name,
        logo: attributeOf(line, 'tvg-logo'),
        group: attributeOf(line, 'group-title'),
        lines: [],
        url: '',
      };
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('#')) {
      current.lines.push(line);
      continue;
    }
    current.url = line.trim();
    entries.push(current);
    current = null;
  }
  return entries;
}

/** Rebuilds the playlist with a stable header and an optional `tvg-id` per entry. */
export function renderPlaylist(entries, options) {
  const epgUrl = options.epgUrl;
  const ids = options.ids ?? [];
  const blocks = entries.map((entry, index) => {
    const attributes = [];
    const id = ids[index] ?? null;
    if (id !== null) attributes.push(`tvg-id="${id}"`);
    for (const key of KEPT_ATTRIBUTES) {
      const value = key === 'tvg-logo' ? entry.logo : entry.group;
      if (value !== '') attributes.push(`${key}="${value}"`);
    }
    const prefix = attributes.length === 0 ? '#EXTINF:-1' : `#EXTINF:-1 ${attributes.join(' ')}`;
    return [`${prefix},${entry.name}`, ...entry.lines, entry.url].filter(line => line !== '').join('\n');
  });
  return ['#EXTM3U url-tvg="' + epgUrl + '"', '', ...blocks.map(block => `${block}\n`), '']
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** Groups that are about sport, whatever the channel name says. */
const SPORTS_GROUP = /\b(deportes?|sports?|espn|futbol|fútbol|dsports)\b/i;
/** Channel names that are about sport even inside a country group (`Deportes TVC`, `Canal del Futbol`). */
const SPORTS_NAME = /\b(deportes|sports?|espn|futbol|fútbol|ufc|bein|dazn|tyc|directv sports|claro sports|tigo sports|win sports|movistar deportes|fifa)\b/i;

/** True for the entries the run summary lists in the sports table. */
export function isSportsEntry(entry) {
  return SPORTS_GROUP.test(entry.group) || SPORTS_NAME.test(entry.name);
}
