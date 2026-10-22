import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_COUNTRIES } from '../build.mjs';
import { countryOfEpgId } from '../lib/epg.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const fixtures = join(here, 'fixtures');
const FIXED_NOW = '2026-01-01T16:00:00Z';

/** Ephemeral work root outside the repository: nothing the tests write outlives the run. */
let workRoot;
let outDir;
let run;

const readOut = file => readFileSync(join(outDir, file), 'utf8');

/** Every `<channel id="...">` declared by the generated guide. */
const guideChannelIds = xml => [...xml.matchAll(/<channel id="([^"]*)"/g)].map(match => match[1]);
/** Every `tvg-id="..."` carried by the generated playlist. */
const playlistIds = m3u => [...m3u.matchAll(/tvg-id="([^"]*)"/g)].map(match => match[1]);

function runGenerator(args, cwd = repoRoot) {
  return spawnSync(process.execPath, [join(repoRoot, 'tools', 'build.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    // No network is reachable on purpose: fixture mode must never fetch.
    env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' },
  });
}

before(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'nuvio-iptv-test-'));
  outDir = join(workRoot, 'out');
  run = runGenerator([
    '--fixture', fixtures,
    '--aliases', join(fixtures, 'aliases.json'),
    '--countries', 'sv,gt,ar',
    '--now', FIXED_NOW,
    '--out', outDir,
  ]);
});

after(() => {
  if (workRoot !== undefined) rmSync(workRoot, { recursive: true, force: true });
});

describe('playlist output', () => {
  it('starts with a header that advertises the guide url', () => {
    assert.equal(run.status, 0, run.stderr);
    const first = readOut('esencial.m3u').split('\n')[0];
    assert.equal(first, '#EXTM3U url-tvg="https://esenciable.github.io/nuvio-iptv/epg.xml"');
  });

  it('gives a tvg-id only to the channels it resolved', () => {
    const playlist = readOut('esencial.m3u');
    const ids = playlistIds(playlist);
    assert.deepEqual(ids.sort(), ['Canal2.sv', 'Canal2.sv', 'ESPN.sv', 'TyCSports.ar']);

    const unknown = playlist.split('\n').find(line => line.endsWith(',Totally Unknown Channel'));
    assert.ok(unknown !== undefined, 'unknown channel must still be listed');
    assert.equal(unknown.includes('tvg-id='), false, 'unresolved channel must not carry a tvg-id');

    const mystery = playlist.split('\n').find(line => line.endsWith(',Mystery Sports Net'));
    assert.ok(mystery !== undefined);
    assert.equal(mystery.includes('tvg-id='), false);
  });

  it('keeps names, groups, logos, stream urls and playlist options verbatim', () => {
    const playlist = readOut('esencial.m3u');
    assert.match(playlist, /tvg-logo="http:\/\/example\.test\/canal2\.png" group-title="El Salvador - TCS",Canal 2 TCS SD\n/);
    assert.ok(playlist.includes('#EXTVLCOPT:http-user-agent=TestAgent/1.0\nhttp://stream.test/canal2.m3u8\n'));
    assert.ok(playlist.includes('http://stream.test/canal2-opc2.m3u8'));
    assert.ok(playlist.includes(',Canal 2 TCS SD [Opc.2]'));
  });

  it('drops a feed tvg-id that the guide cannot back', () => {
    assert.equal(readOut('esencial.m3u').includes('animextv'), false);
  });

  it('lets variants of one channel share the resolved id', () => {
    const lines = readOut('esencial.m3u').split('\n').filter(line => line.includes('Canal 2 TCS SD'));
    assert.equal(lines.length, 2);
    for (const line of lines) assert.ok(line.includes('tvg-id="Canal2.sv"'), line);
  });

  it('makes an alias win over plain name matching', () => {
    const playlist = readOut('esencial.m3u');
    assert.ok(playlist.includes('tvg-id="TyCSports.ar"'));
    assert.equal(playlist.includes('TyCSports.gt'), false);
    // And the programmes come from the pinned country, not from the file that matched first.
    const guide = readOut('epg.xml');
    assert.ok(guide.includes('<title>TyC Sports Central</title>'));
    assert.equal(guide.includes('Wrong Country Programme'), false);
  });

  it('honours a blocked alias: no id, and no auto-match behind it', () => {
    const playlist = readOut('esencial.m3u');
    // "Canal 4" is in the table as "!". It would otherwise auto-match Canal4.sv.
    assert.equal(playlist.includes('tvg-id="Canal4.sv"'), false, 'a blocked name was auto-matched');
    assert.equal(playlist.includes('tvg-id="!"'), false, 'the block marker leaked as an id');
    assert.equal(readOut('epg.xml').includes('Canal4.sv'), false, 'a blocked id got a grid');
  });
});

describe('guide output', () => {
  it('declares only channels that the playlist resolves', () => {
    const guide = readOut('epg.xml');
    const declared = guideChannelIds(guide);
    assert.deepEqual(declared.sort(), ['Canal2.sv', 'ESPN.sv', 'TyCSports.ar']);
    for (const id of declared) {
      assert.ok(playlistIds(readOut('esencial.m3u')).includes(id), `${id} missing from playlist`);
    }
  });

  it('re-bases the fake +0000 wall clock to real utc and clips the window', () => {
    const guide = readOut('epg.xml');
    // 12:00 in El Salvador (UTC-6) is 18:00 UTC, whatever the source suffix claims.
    assert.match(guide, /<programme start="20260101180000 \+0000" stop="20260101190000 \+0000" channel="Canal2\.sv">/);
    assert.ok(guide.includes('<title>Noticiero</title>'));
    // A programme that starts inside the window is clipped at its end (23:00 local -> 05:00 UTC,
    // clipped to the window end at 04:00 UTC).
    assert.match(guide, /<programme start="20260103030000 \+0000" stop="20260103040000 \+0000" channel="Canal2\.sv">/);
    assert.ok(guide.includes('<title>Clipped At The Edge</title>'));
    assert.equal(guide.includes('Before Window'), false);
    assert.equal(guide.includes('After Window'), false);
  });

  it('skips placeholder-only programmes', () => {
    const guide = readOut('epg.xml');
    // Titles the sources publish instead of listings. A gap is honest, filler is a lie: the
    // player shows a filled grid that matches nothing on screen.
    for (const filler of ['No Data', 'Paid Programming', 'Programa pagado', 'SIGN OFF', 'No Match Today']) {
      assert.equal(guide.includes(filler), false, `filler reached the guide: ${filler}`);
    }
    // And the real neighbours of that filler still survive, so the filter is not dropping rows.
    assert.ok(guide.includes('<title>Noticiero</title>'));
  });

  it('reports the run summary on stdout', () => {
    assert.match(run.stdout, /entries:\s*7/);
    assert.match(run.stdout, /with id:\s*4/);
    assert.match(run.stdout, /distinct ids:\s*3/);
    assert.match(run.stdout, /TyC Sports\s*->\s*TyCSports\.ar/);
    assert.match(run.stdout, /Totally Unknown Channel\s*->\s*—/);
  });
});

describe('dry run and feed guards', () => {
  it('writes nothing and still prints the summary', () => {
    const dryOut = join(workRoot, 'dry');
    const dryRun = runGenerator([
      '--fixture', fixtures,
      '--aliases', join(fixtures, 'aliases.json'),
      '--countries', 'sv,gt,ar',
      '--now', FIXED_NOW,
      '--out', dryOut,
      '--dry-run',
    ]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /entries:\s*7/);
    assert.equal(existsSync(dryOut) ? readdirSync(dryOut).length : 0, 0);
  });

  it('fails loudly when the feed is smaller than the floor', () => {
    const guarded = runGenerator([
      '--fixture', fixtures,
      '--aliases', join(fixtures, 'aliases.json'),
      '--countries', 'sv,gt,ar',
      '--now', FIXED_NOW,
      '--out', join(workRoot, 'guard'),
      '--min-entries', '1000',
    ]);
    assert.notEqual(guarded.status, 0);
    assert.match(guarded.stderr, /only 7 entries/);
  });
});

describe('curated alias table', () => {
  const table = JSON.parse(readFileSync(join(repoRoot, 'tools', 'aliases.json'), 'utf8'));
  const aliases = Object.entries(table).filter(([key]) => !key.startsWith('//'));
  const published = [...readFileSync(join(repoRoot, 'esencial.m3u'), 'utf8').split('\n')]
    .filter(line => line.startsWith('#EXTINF'))
    .map(line => line.split(',').pop().trim());
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'refresh.yml'), 'utf8');

  // The countries the nightly job really downloads. Read from the command it runs, so the
  // table cannot pin a country the build stopped fetching.
  const scanned = new Set(DEFAULT_COUNTRIES);
  if (/--include-us/.test(workflow)) scanned.add('us');

  it('keys name channels of the playlist we publish', () => {
    const names = new Set(published);
    for (const [name] of aliases) {
      assert.ok(names.has(name), `"${name}" is not a channel of esencial.m3u: the pin is dead text`);
    }
  });

  it('values name a country the nightly build downloads', () => {
    for (const [name, id] of aliases) {
      const country = countryOfEpgId(id);
      // Provider-labelled ids (.peacocktv) carry no country, so nothing can be proven from the
      // id alone; the alias comments say which file publishes them.
      if (country === null) continue;
      assert.ok(
        scanned.has(country),
        `"${name}" pins ${id} from '${country}', which the build never downloads: the playlist `
        + `would advertise an id with no programmes, an empty grid that looks like the source's fault`,
      );
    }
  });
});
