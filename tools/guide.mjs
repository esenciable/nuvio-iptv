/**
 * Guide building: which feed channel gets which epg id, and the programmes that back it.
 *
 * The order of the country files is the fallback tie-breaker for names that carry no country hint
 * (`ESPN HD` exists in many files). Aliases are resolved once, up front, because they are exact
 * feed names and do not depend on which file is being read; then every file is scanned for the
 * programmes of every id resolved so far. That way an aliased id gets its programmes from its own
 * country file instead of being marked "matched" (and empty) by the first file that happens to be
 * read.
 */
import { readFileSync } from 'node:fs';
import { buildChannelIndex, collectProgrammes, matchEpgChannel, sourceZone } from './lib/epg.mjs';

/**
 * Mirror/decorations a feed appends to a channel that is the SAME stream: `[Opc.2]`, `(Opc. 3)`,
 * `- (Opc.3)`, `[No 24/7]`, `[Inestable]`, `[SUB]`, `[1080p]`. Removing them lets the variants of
 * one channel share the guide id resolved for the base name. Country/feed variants such as
 * `(Perú)` or `(Internacional)` are NOT removed here: those are different signals and belong in the
 * alias table, where a human decides.
 */
const VARIANT_TAG = /\s*(?:[-–]\s*)?[[(]\s*(?:opc\.?\s*\d+|opci[oó]n\s*\d+|no\s*24\/7|not\s*24\/7|24\/7|inestable|sub|geo-?blocked|multi|backup|\d{3,4}p)\s*[\])]\s*$/i;

/** The feed name with trailing variant tags removed, or null when nothing was removed. */
export function stripVariantTags(name) {
  let text = name;
  let previous;
  do {
    previous = text;
    text = text.replace(VARIANT_TAG, '');
  } while (text !== previous);
  const stripped = text.trim();
  return stripped === name.trim() || stripped === '' ? null : stripped;
}

/** Reads the curated alias table. Keys starting with `//` are documentation, not aliases. */
export function loadAliases(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`alias table is unreadable JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`alias table must be a JSON object: ${path}`);
  }
  const aliases = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('//')) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`alias "${key}" must map to a non-empty string id`);
    }
    aliases[key] = value.trim();
  }
  return aliases;
}

/** Programs that start before the window are left out; one that ends after it is clipped. */
function clipProgrammes(list, to) {
  const clipped = [];
  for (const programme of list) {
    if (programme.stop <= programme.start) continue;
    clipped.push({ ...programme, stop: Math.min(programme.stop, to) });
  }
  return clipped;
}

/**
 * Resolves one epg id per feed entry and collects the programmes behind it.
 *
 * `loadEpg(country)` returns the XML of that country or null when the source is unavailable; a
 * failed source only loses its own channels.
 */
export async function resolveGuide(options) {
  const entries = options.entries;
  const aliases = options.aliases ?? {};
  const order = options.order ?? options.countries;
  const ids = entries.map(() => null);
  const pending = [];

  entries.forEach((entry, index) => {
    const alias = aliases[entry.name];
    if (alias !== undefined && alias !== '') ids[index] = alias;
    else pending.push(index);
  });

  const programmes = {};
  const failedCountries = [];
  let pendingIndexes = pending;
  let scannedCountries = 0;

  for (const country of options.countries) {
    let xml = null;
    try {
      xml = await options.loadEpg(country);
    } catch (error) {
      failedCountries.push({ country, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (xml === null || xml === undefined) {
      failedCountries.push({ country, reason: 'no content' });
      continue;
    }
    scannedCountries += 1;

    const index = await buildChannelIndex([{ country, xml }]);
    const stillPending = [];
    for (const entryIndex of pendingIndexes) {
      const name = entries[entryIndex].name;
      const stripped = stripVariantTags(name);
      // A variant tag is a mirror marker, so its base name is the trustworthy one: matching
      // '[Opc.2]' first would read that 2 as a channel number ('FOX Sports' -> FOXSports2).
      let id = matchEpgChannel(stripped ?? name, index, { aliases, order });
      if (id === null && stripped !== null) id = matchEpgChannel(name, index, { aliases, order });
      if (id === null) stillPending.push(entryIndex);
      else ids[entryIndex] = id;
    }
    pendingIndexes = stillPending;

    const wanted = new Set(ids.filter(id => id !== null));
    if (wanted.size === 0) continue;
    const collected = await collectProgrammes(xml, wanted, {
      from: options.from,
      to: options.to,
      zone: sourceZone(country) ?? undefined,
    });
    for (const [id, list] of collected) {
      programmes[id] = clipProgrammes(list, options.to);
    }
  }

  // Channel elements follow the playlist order, so the output is stable between runs.
  const channels = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    const id = ids[index];
    if (id === null || seen.has(id)) return;
    seen.add(id);
    const channel = { code: id, name: entry.name.trim() };
    if (entry.logo !== '') channel.logo = entry.logo;
    channels.push(channel);
  });

  return { ids, channels, programmes, failedCountries, scannedCountries };
}
