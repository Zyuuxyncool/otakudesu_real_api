const fs = require('fs');
const path = require('path');
const { scrapeHomeData } = require('./scraper-home');
const {
  getOngoing,
  getCompleted,
  getUnlimitedAnime,
  getAnimeListGrouped,
  getGenres,
  getSchedule,
  getAnimeByGenre,
  getAnimeDetail,
  getEpisodeDetail,
  getBatchLinks,
  searchAnime
} = require('./scraper-advanced');

const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.json');
const SNAPSHOT_MANIFEST_PATH = path.join(__dirname, 'snapshot-manifest.json');
const SNAPSHOT_CHUNKS_DIR = path.join(__dirname, 'snapshots');

const SNAPSHOT_MAX_CHUNK_BYTES = Number(process.env.SNAPSHOT_MAX_CHUNK_BYTES || 95 * 1024 * 1024);
const SNAPSHOT_FETCH_RETRY = Number(process.env.SNAPSHOT_FETCH_RETRY || 3);
const SNAPSHOT_FETCH_RETRY_DELAY_MS = Number(process.env.SNAPSHOT_FETCH_RETRY_DELAY_MS || 900);
const SNAPSHOT_WRITE_RETRY = Number(process.env.SNAPSHOT_WRITE_RETRY || 6);
const SNAPSHOT_WRITE_RETRY_DELAY_MS = Number(process.env.SNAPSHOT_WRITE_RETRY_DELAY_MS || 800);

const SNAPSHOT_ONGOING_MAX_PAGES = Math.max(1, Number(process.env.SNAPSHOT_ONGOING_MAX_PAGES || 8));
const SNAPSHOT_COMPLETE_MAX_PAGES = Math.max(1, Number(process.env.SNAPSHOT_COMPLETE_MAX_PAGES || 8));
const SNAPSHOT_GENRE_MAX_PAGES = Math.max(1, Number(process.env.SNAPSHOT_GENRE_MAX_PAGES || 4));
const SNAPSHOT_GENRE_LIMIT = Number(process.env.SNAPSHOT_GENRE_LIMIT || 0);
const SNAPSHOT_ANIME_DETAIL_LIMIT = Math.max(1, Number(process.env.SNAPSHOT_ANIME_DETAIL_LIMIT || 1500));
const SNAPSHOT_EPISODES_PER_ANIME = Number(process.env.SNAPSHOT_EPISODES_PER_ANIME || 240);
const SNAPSHOT_TOTAL_EPISODES_LIMIT = Number(process.env.SNAPSHOT_TOTAL_EPISODES_LIMIT || 4500);
const SNAPSHOT_BATCH_LIMIT = Math.max(1, Number(process.env.SNAPSHOT_BATCH_LIMIT || 700));
const SNAPSHOT_SEARCH_SEED_LIMIT = Math.max(1, Number(process.env.SNAPSHOT_SEARCH_SEED_LIMIT || 150));

const EXTRA_EPISODE_IDS = [
  'sd-p2-episode-10-sub-indo',
  'sbyscwm-episode-1-sub-indo',
  ...(process.env.SNAPSHOT_EXTRA_EPISODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
];

const EXTRA_GENRE_SLUGS = [
  'ecchi',
  ...(process.env.SNAPSHOT_EXTRA_GENRES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
];

const EXTRA_ANIME_DETAIL_SLUGS = [
  'acca-13-ku-kansatsu-ka-sub-indo',
  'acca-13-kansatsu-subtitle-indonesia',
  'eiyu-tenseisu-sub-indo',
  'kizoku-tensei-subtitle-indonesia',
  'tensei-shi-slime-sub-indo',
  'tensei-slime-s2-sub-indo',
  'mushoku-tensei-sub-indo',
  'mushoku-ni-tensei-s2-sub-indo',
  'mushoku-tensi-s2-sub-indo',
  'seishun-buta-yarou-wa-santa-claus-sub-indo',
  ...(process.env.SNAPSHOT_EXTRA_ANIME_SLUGS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
];

const EXTRA_SEARCH_KEYWORDS = [
  'tensei',
  ...(process.env.SNAPSHOT_EXTRA_SEARCH_KEYWORDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeSnapshotSafely(snapshot) {
  const payload = JSON.stringify(snapshot, null, 2);
  const tempPath = `${SNAPSHOT_PATH}.tmp`;

  for (let attempt = 1; attempt <= Math.max(1, SNAPSHOT_WRITE_RETRY); attempt += 1) {
    try {
      fs.writeFileSync(tempPath, payload, 'utf8');
      fs.renameSync(tempPath, SNAPSHOT_PATH);
      return;
    } catch (error) {
      if (attempt >= SNAPSHOT_WRITE_RETRY) throw error;
      await sleep(SNAPSHOT_WRITE_RETRY_DELAY_MS);
    }
  }
}

function getSnapshotFeatureByKey(key = '') {
  const value = String(key || '').trim();
  if (!value) return 'misc';

  if (value === 'home') return 'home';
  if (value === 'schedule') return 'schedule';
  if (value === 'genre') return 'genre';
  if (value === 'unlimited') return 'unlimited';
  if (value === 'anime-list-grouped') return 'anime-list';
  if (value.startsWith('ongoing-anime-')) return 'ongoing';
  if (value.startsWith('complete-anime-')) return 'complete';
  if (value.startsWith('genre-')) return 'genre';
  if (value.startsWith('anime-detail-')) return 'anime-detail';
  if (value.startsWith('episode-')) return 'episode';
  if (value.startsWith('batch-')) return 'batch';
  return 'misc';
}

function getFeatureOrder(feature = '') {
  const order = [
    'home',
    'ongoing',
    'complete',
    'genre',
    'schedule',
    'unlimited',
    'anime-list',
    'anime-detail',
    'episode',
    'batch',
    'misc'
  ];

  const idx = order.indexOf(feature);
  return idx >= 0 ? idx : order.length;
}

function splitSnapshotByFeatureAndSize(snapshot) {
  const data = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  const grouped = new Map();

  for (const [key, value] of Object.entries(data)) {
    const feature = getSnapshotFeatureByKey(key);
    if (!grouped.has(feature)) grouped.set(feature, []);
    grouped.get(feature).push({ key, value });
  }

  const featureNames = [...grouped.keys()].sort((a, b) => getFeatureOrder(a) - getFeatureOrder(b));
  const chunks = [];
  const keyMap = {};

  for (const feature of featureNames) {
    const items = grouped.get(feature) || [];
    let index = 1;
    let currentData = {};
    let currentBytes = 0;

    const flush = () => {
      const keys = Object.keys(currentData);
      if (keys.length === 0) return;

      const fileName = `snapshot-${feature}-${index}.json`;
      const relativePath = `snapshots/${fileName}`;
      const payload = {
        generatedAt: snapshot.generatedAt,
        feature,
        chunkIndex: index,
        data: currentData
      };

      const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      chunks.push({
        file: relativePath,
        feature,
        chunkIndex: index,
        bytes,
        keys
      });

      for (const key of keys) keyMap[key] = relativePath;

      index += 1;
      currentData = {};
      currentBytes = 0;
    };

    for (const item of items) {
      const entryBytes = Buffer.byteLength(JSON.stringify({ [item.key]: item.value }), 'utf8');
      if (Object.keys(currentData).length > 0 && currentBytes + entryBytes > SNAPSHOT_MAX_CHUNK_BYTES) {
        flush();
      }

      currentData[item.key] = item.value;
      currentBytes += entryBytes;
    }

    flush();
  }

  return {
    manifest: {
      version: 1,
      generatedAt: snapshot.generatedAt,
      chunkSizeLimitBytes: SNAPSHOT_MAX_CHUNK_BYTES,
      totalKeys: Object.keys(data).length,
      keyMap,
      chunks
    },
    chunks
  };
}

async function writeSplitSnapshotSafely(snapshot) {
  const { manifest, chunks } = splitSnapshotByFeatureAndSize(snapshot);
  fs.mkdirSync(SNAPSHOT_CHUNKS_DIR, { recursive: true });

  for (const file of fs.readdirSync(SNAPSHOT_CHUNKS_DIR)) {
    if (/^snapshot-.*\.json$/i.test(file)) fs.unlinkSync(path.join(SNAPSHOT_CHUNKS_DIR, file));
  }

  for (const chunk of chunks) {
    const filePath = path.join(__dirname, chunk.file);
    const tempPath = `${filePath}.tmp`;
    const payload = {
      generatedAt: snapshot.generatedAt,
      feature: chunk.feature,
      chunkIndex: chunk.chunkIndex,
      data: chunk.keys.reduce((acc, key) => {
        acc[key] = snapshot.data[key];
        return acc;
      }, {})
    };

    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  }

  const manifestTempPath = `${SNAPSHOT_MANIFEST_PATH}.tmp`;
  fs.writeFileSync(manifestTempPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(manifestTempPath, SNAPSHOT_MANIFEST_PATH);

  return manifest;
}

function successEnvelope({ creator = 'Lloyd.ID1112', data, pagination = null }) {
  return {
    status: 'success',
    creator,
    statusCode: 200,
    statusMessage: 'OK',
    message: '',
    ok: true,
    data,
    pagination
  };
}

async function safeRun(label, fn) {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (error) {
    console.error(`[snapshot] ${label} failed:`, error.message);
    return { ok: false, result: null };
  }
}

async function runWithRetries(label, fn, validator = () => true, attempts = SNAPSHOT_FETCH_RETRY) {
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await safeRun(`${label} (attempt ${attempt})`, fn);
    if (outcome.ok && validator(outcome.result)) return outcome.result;

    lastResult = outcome?.result || lastResult;
    if (attempt < maxAttempts) await sleep(SNAPSHOT_FETCH_RETRY_DELAY_MS);
  }

  return lastResult;
}

function hasEpisodeStream(episodeData) {
  if (!episodeData || typeof episodeData !== 'object') return false;
  if (episodeData.defaultStreamingUrl) return true;
  const qualities = episodeData.server?.qualities;
  return Array.isArray(qualities) && qualities.some((q) => Array.isArray(q?.serverList) && q.serverList.length > 0);
}

function hasAnimeDetail(detailData) {
  if (!detailData || typeof detailData !== 'object') return false;
  if (detailData.title) return true;
  return Array.isArray(detailData.episodeList) && detailData.episodeList.length > 0;
}

function hasBatchData(batchData) {
  if (!batchData || typeof batchData !== 'object') return false;
  const formats = batchData?.downloadUrl?.formats;
  return Array.isArray(formats) && formats.some((f) => Array.isArray(f?.qualities) && f.qualities.length > 0);
}

function enrichGroupedListWithPoster(groupedList, unlimitedList) {
  if (!Array.isArray(groupedList)) return groupedList;

  const posterMap = new Map();
  if (Array.isArray(unlimitedList)) {
    for (const item of unlimitedList) {
      const animeId = item?.animeId;
      const poster = item?.poster;
      if (animeId && poster && !posterMap.has(animeId)) {
        posterMap.set(animeId, poster);
      }
    }
  }

  return groupedList.map((group) => ({
    ...group,
    animeList: Array.isArray(group?.animeList)
      ? group.animeList.map((anime) => ({
          ...anime,
          poster: anime?.poster || posterMap.get(anime?.animeId) || ''
        }))
      : []
  }));
}

function collectAnimeSlugsFromSnapshot(snapshot) {
  const slugs = new Set();

  for (const [key, payload] of Object.entries(snapshot.data || {})) {
    if (key.startsWith('anime-detail-')) slugs.add(key.replace(/^anime-detail-/, ''));

    const animeList = payload?.data?.animeList;
    if (Array.isArray(animeList)) {
      for (const item of animeList) {
        const animeId = String(item?.animeId || '').trim();
        if (animeId) slugs.add(animeId);
      }
    }

    const grouped = payload?.data?.list;
    if (Array.isArray(grouped)) {
      for (const group of grouped) {
        for (const item of group?.animeList || []) {
          const animeId = String(item?.animeId || '').trim();
          if (animeId) slugs.add(animeId);
        }
      }
    }
  }

  return [...slugs];
}

async function buildPaginatedAnimeListSnapshots({ snapshot, prefix, maxPages, firstPageResult, fetcher }) {
  const normalizedMaxPages = Math.max(1, Number(maxPages) || 1);

  if (Array.isArray(firstPageResult?.animeList) && firstPageResult.animeList.length > 0) {
    snapshot.data[`${prefix}-page1`] = successEnvelope({
      data: { animeList: firstPageResult.animeList },
      pagination: firstPageResult.pagination
    });
  }

  let emptyStreak = 0;
  for (let page = 2; page <= normalizedMaxPages; page += 1) {
    const pageResult = await runWithRetries(
      `${prefix} page ${page}`,
      () => fetcher(page),
      (result) => Array.isArray(result?.animeList) && result.animeList.length > 0
    );

    if (!Array.isArray(pageResult?.animeList) || pageResult.animeList.length === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 2) break;
      continue;
    }

    emptyStreak = 0;
    snapshot.data[`${prefix}-page${page}`] = successEnvelope({
      data: { animeList: pageResult.animeList },
      pagination: pageResult.pagination
    });
  }
}

async function buildGenreSnapshots(snapshot, genresResult) {
  const baseGenreCandidates = [
    ...EXTRA_GENRE_SLUGS,
    ...((genresResult || []).map((g) => g?.genreId).filter(Boolean))
  ];

  const genreCandidates = Number.isFinite(SNAPSHOT_GENRE_LIMIT) && SNAPSHOT_GENRE_LIMIT > 0
    ? baseGenreCandidates.slice(0, SNAPSHOT_GENRE_LIMIT)
    : baseGenreCandidates;

  const uniqueGenreSlugs = [...new Set(genreCandidates)];

  for (const genreSlug of uniqueGenreSlugs) {
    const page1 = await runWithRetries(
      `genre ${genreSlug} page1`,
      () => getAnimeByGenre(genreSlug, 1),
      (result) => Array.isArray(result?.animeList) && result.animeList.length > 0
    );

    if (!Array.isArray(page1?.animeList) || page1.animeList.length === 0) continue;

    snapshot.data[`genre-${genreSlug}-page1`] = successEnvelope({
      data: { animeList: page1.animeList },
      pagination: page1.pagination
    });

    let emptyStreak = 0;
    for (let page = 2; page <= SNAPSHOT_GENRE_MAX_PAGES; page += 1) {
      const pageResult = await runWithRetries(
        `genre ${genreSlug} page${page}`,
        () => getAnimeByGenre(genreSlug, page),
        (result) => Array.isArray(result?.animeList) && result.animeList.length > 0
      );

      if (!Array.isArray(pageResult?.animeList) || pageResult.animeList.length === 0) {
        emptyStreak += 1;
        if (emptyStreak >= 2) break;
        continue;
      }

      emptyStreak = 0;
      snapshot.data[`genre-${genreSlug}-page${page}`] = successEnvelope({
        data: { animeList: pageResult.animeList },
        pagination: pageResult.pagination
      });
    }
  }
}

async function buildAdditionalAnimeDetailSnapshots(snapshot, animeListGroupedResult) {
  const animeFromList = [];
  if (Array.isArray(animeListGroupedResult)) {
    for (const group of animeListGroupedResult) {
      for (const anime of group?.animeList || []) {
        if (anime?.animeId) animeFromList.push(anime.animeId);
      }
    }
  }

  const candidates = [
    ...EXTRA_ANIME_DETAIL_SLUGS,
    ...animeFromList.slice(0, SNAPSHOT_ANIME_DETAIL_LIMIT),
    ...collectAnimeSlugsFromSnapshot(snapshot).slice(0, SNAPSHOT_ANIME_DETAIL_LIMIT)
  ];

  const uniqueSlugs = [...new Set(candidates.filter(Boolean))];
  for (const animeSlug of uniqueSlugs) {
    const key = `anime-detail-${animeSlug}`;
    if (snapshot.data[key]) continue;

    const animeDetailResult = await runWithRetries(
      `anime detail ${animeSlug}`,
      () => getAnimeDetail(animeSlug),
      (result) => hasAnimeDetail(result)
    );
    if (!hasAnimeDetail(animeDetailResult)) continue;

    snapshot.data[key] = successEnvelope({
      data: {
        detail: animeDetailResult,
        episodeList: Array.isArray(animeDetailResult.episodeList) ? animeDetailResult.episodeList : []
      },
      pagination: null
    });
  }
}

async function buildSearchKeywordDetailSnapshots(snapshot) {
  const generatedKeywords = [];
  for (const slug of collectAnimeSlugsFromSnapshot(snapshot).slice(0, SNAPSHOT_SEARCH_SEED_LIMIT)) {
    const token = slug.split('-').find((t) => t && t.length >= 4) || '';
    if (token) generatedKeywords.push(token);
  }

  const keywords = [...new Set([...EXTRA_SEARCH_KEYWORDS, ...generatedKeywords].filter(Boolean))];

  for (const keyword of keywords) {
    const searchResult = await safeRun(`search ${keyword}`, () => searchAnime(keyword));
    if (!searchResult.ok || !Array.isArray(searchResult.result) || searchResult.result.length === 0) continue;

    for (const anime of searchResult.result.slice(0, 30)) {
      const animeSlug = anime?.animeId;
      if (!animeSlug) continue;

      const key = `anime-detail-${animeSlug}`;
      if (snapshot.data[key]) continue;

      const animeDetailResult = await runWithRetries(
        `anime detail search ${animeSlug}`,
        () => getAnimeDetail(animeSlug),
        (result) => hasAnimeDetail(result)
      );
      if (!hasAnimeDetail(animeDetailResult)) continue;

      snapshot.data[key] = successEnvelope({
        data: {
          detail: animeDetailResult,
          episodeList: Array.isArray(animeDetailResult.episodeList) ? animeDetailResult.episodeList : []
        },
        pagination: null
      });
    }
  }
}

async function buildEpisodeSnapshots(snapshot, animeCandidates = []) {
  const uniqueAnimeSlugs = [...new Set((animeCandidates || []).filter(Boolean))];
  const episodeCandidates = [];

  for (const animeSlug of uniqueAnimeSlugs) {
    const detailPayload = snapshot.data?.[`anime-detail-${animeSlug}`]?.data;
    const detail = detailPayload?.detail || detailPayload || null;

    const episodeList = Array.isArray(detail?.episodeList)
      ? detail.episodeList
      : Array.isArray(detailPayload?.episodeList)
        ? detailPayload.episodeList
        : [];

    const limitedEpisodes = Number.isFinite(SNAPSHOT_EPISODES_PER_ANIME) && SNAPSHOT_EPISODES_PER_ANIME > 0
      ? episodeList.slice(0, SNAPSHOT_EPISODES_PER_ANIME)
      : episodeList;

    for (const ep of limitedEpisodes) {
      if (ep?.episodeId) episodeCandidates.push(ep.episodeId);
    }
  }

  const finalEpisodeIds = [...new Set([...episodeCandidates, ...EXTRA_EPISODE_IDS])].slice(0, SNAPSHOT_TOTAL_EPISODES_LIMIT);

  for (const episodeId of finalEpisodeIds) {
    const episodeDetailResult = await runWithRetries(
      `episode ${episodeId}`,
      () => getEpisodeDetail(episodeId),
      (result) => hasEpisodeStream(result)
    );

    if (!hasEpisodeStream(episodeDetailResult)) continue;

    snapshot.data[`episode-${episodeId}`] = successEnvelope({
      data: episodeDetailResult,
      pagination: null
    });
  }
}

async function buildBatchSnapshots(snapshot, animeCandidates = []) {
  const uniqueAnimeSlugs = [...new Set((animeCandidates || []).filter(Boolean))].slice(0, SNAPSHOT_BATCH_LIMIT);

  for (const animeSlug of uniqueAnimeSlugs) {
    const batchKey = `batch-${animeSlug}`;
    if (snapshot.data[batchKey]) continue;

    const detailPayload = snapshot.data?.[`anime-detail-${animeSlug}`]?.data;
    const detail = detailPayload?.detail || detailPayload || null;
    const batchSlugCandidates = [
      String(detail?.batch?.batchId || '').trim(),
      animeSlug
    ].filter(Boolean);

    let batchData = null;
    for (const batchSlug of [...new Set(batchSlugCandidates)]) {
      const result = await runWithRetries(
        `batch ${animeSlug} via ${batchSlug}`,
        () => getBatchLinks(batchSlug),
        (value) => hasBatchData(value),
        2
      );

      if (hasBatchData(result)) {
        batchData = result;
        break;
      }
    }

    if (!hasBatchData(batchData)) continue;

    snapshot.data[batchKey] = successEnvelope({
      data: batchData,
      pagination: null
    });
  }
}

(async () => {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    data: {}
  };

  const [home, ongoing, complete, unlimited, animeListGrouped, genres, schedule] = await Promise.all([
    safeRun('home', () => scrapeHomeData()),
    safeRun('ongoing page 1', () => getOngoing(1)),
    safeRun('complete page 1', () => getCompleted(1)),
    safeRun('unlimited', () => getUnlimitedAnime()),
    safeRun('anime list grouped', () => getAnimeListGrouped()),
    safeRun('genres', () => getGenres()),
    safeRun('schedule', () => getSchedule())
  ]);

  if (home.ok && home.result) {
    snapshot.data.home = home.result;
  }

  await buildPaginatedAnimeListSnapshots({
    snapshot,
    prefix: 'ongoing-anime',
    maxPages: SNAPSHOT_ONGOING_MAX_PAGES,
    firstPageResult: ongoing.result,
    fetcher: (page) => getOngoing(page)
  });

  await buildPaginatedAnimeListSnapshots({
    snapshot,
    prefix: 'complete-anime',
    maxPages: SNAPSHOT_COMPLETE_MAX_PAGES,
    firstPageResult: complete.result,
    fetcher: (page) => getCompleted(page)
  });

  if (unlimited.ok && Array.isArray(unlimited.result) && unlimited.result.length > 0) {
    snapshot.data.unlimited = successEnvelope({
      creator: 'Sanka Vollerei',
      data: {
        total: unlimited.result.length,
        animeList: unlimited.result
      },
      pagination: null
    });
  }

  if (animeListGrouped.ok && Array.isArray(animeListGrouped.result) && animeListGrouped.result.length > 0) {
    const enrichedList = enrichGroupedListWithPoster(animeListGrouped.result, unlimited.result);
    snapshot.data['anime-list-grouped'] = successEnvelope({
      data: { list: enrichedList },
      pagination: null
    });
  }

  if (genres.ok && Array.isArray(genres.result) && genres.result.length > 0) {
    snapshot.data.genre = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      ok: true,
      data: {
        genreList: genres.result
      },
      pagination: null
    };
  }

  if (schedule.ok && schedule.result) {
    snapshot.data.schedule = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      ok: true,
      data: schedule.result
    };
  }

  await buildAdditionalAnimeDetailSnapshots(snapshot, animeListGrouped.result);
  await buildSearchKeywordDetailSnapshots(snapshot);
  await buildGenreSnapshots(snapshot, genres.result);

  const animeCandidates = collectAnimeSlugsFromSnapshot(snapshot);
  await buildBatchSnapshots(snapshot, animeCandidates);
  await buildEpisodeSnapshots(snapshot, animeCandidates);

  const manifest = await writeSplitSnapshotSafely(snapshot);
  console.log(`[snapshot] generated manifest: ${SNAPSHOT_MANIFEST_PATH}`);
  console.log(`[snapshot] chunk dir: ${SNAPSHOT_CHUNKS_DIR}`);
  console.log(`[snapshot] chunks: ${manifest.chunks.length}`);
  console.log(`[snapshot] keys: ${manifest.totalKeys}`);

  if (String(process.env.WRITE_LEGACY_SNAPSHOT || 'false').toLowerCase() === 'true') {
    await writeSnapshotSafely(snapshot);
    console.log(`[snapshot] legacy generated: ${SNAPSHOT_PATH}`);
  }
})();
