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
  searchAnime
} = require('./scraper-advanced');

const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.json');
const EXTRA_EPISODE_IDS = [
  'sd-p2-episode-10-sub-indo',
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

const SNAPSHOT_EPISODES_PER_ANIME = Number(process.env.SNAPSHOT_EPISODES_PER_ANIME || 999);

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

async function buildEpisodeSnapshots(snapshot, ongoingResult, completeResult) {
  const animeCandidates = [
    ...(ongoingResult?.animeList || []).slice(0, 25).map((a) => a?.animeId).filter(Boolean),
    ...(completeResult?.animeList || []).slice(0, 25).map((a) => a?.animeId).filter(Boolean)
  ];

  const uniqueAnimeSlugs = [...new Set(animeCandidates)];
  const episodeCandidates = [];

  for (const animeSlug of uniqueAnimeSlugs) {
    const animeDetail = await safeRun(`anime detail ${animeSlug}`, () => getAnimeDetail(animeSlug));
    if (animeDetail.ok && hasAnimeDetail(animeDetail.result)) {
      snapshot.data[`anime-detail-${animeSlug}`] = successEnvelope({
        data: {
          detail: animeDetail.result,
          episodeList: Array.isArray(animeDetail.result.episodeList) ? animeDetail.result.episodeList : []
        },
        pagination: null
      });
    }

    if (!animeDetail.ok || !Array.isArray(animeDetail.result?.episodeList) || animeDetail.result.episodeList.length === 0) {
      continue;
    }

    const episodeList = animeDetail.result.episodeList;
    const limitedEpisodes = Number.isFinite(SNAPSHOT_EPISODES_PER_ANIME) && SNAPSHOT_EPISODES_PER_ANIME > 0
      ? episodeList.slice(0, SNAPSHOT_EPISODES_PER_ANIME)
      : episodeList;

    for (const ep of limitedEpisodes) {
      if (ep?.episodeId) {
        episodeCandidates.push(ep.episodeId);
      }
    }
  }

  const uniqueEpisodeIds = [...new Set([...episodeCandidates, ...EXTRA_EPISODE_IDS])];

  for (const animeSlug of EXTRA_ANIME_DETAIL_SLUGS) {
    const detailPayload = snapshot.data?.[`anime-detail-${animeSlug}`]?.data;
    const detailEpisodeList = Array.isArray(detailPayload?.episodeList) ? detailPayload.episodeList : [];
    for (const ep of detailEpisodeList) {
      if (ep?.episodeId) uniqueEpisodeIds.push(ep.episodeId);
    }
  }
//
  const finalEpisodeIds = [...new Set(uniqueEpisodeIds)];

  for (const episodeId of finalEpisodeIds) {
    const episodeData = await safeRun(`episode ${episodeId}`, () => getEpisodeDetail(episodeId));
    if (!episodeData.ok || !hasEpisodeStream(episodeData.result)) {
      continue;
    }

    snapshot.data[`episode-${episodeId}`] = successEnvelope({
      data: episodeData.result,
      pagination: null
    });
  }
}

async function buildGenreSnapshots(snapshot, genresResult) {
  const genreCandidates = [
    ...EXTRA_GENRE_SLUGS,
    ...((genresResult || []).slice(0, 10).map((g) => g?.genreId).filter(Boolean))
  ];

  const uniqueGenreSlugs = [...new Set(genreCandidates)];

  for (const genreSlug of uniqueGenreSlugs) {
    const genreData = await safeRun(`genre ${genreSlug} page1`, () => getAnimeByGenre(genreSlug, 1));
    if (!genreData.ok || !Array.isArray(genreData.result?.animeList) || genreData.result.animeList.length === 0) {
      continue;
    }

    snapshot.data[`genre-${genreSlug}-page1`] = successEnvelope({
      data: {
        animeList: genreData.result.animeList
      },
      pagination: genreData.result.pagination
    });
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

  const listLimit = Number(process.env.SNAPSHOT_ANIME_DETAIL_LIMIT || 800);
  const candidates = [
    ...EXTRA_ANIME_DETAIL_SLUGS,
    ...animeFromList.slice(0, listLimit)
  ];

  const uniqueSlugs = [...new Set(candidates)];
  for (const animeSlug of uniqueSlugs) {
    const key = `anime-detail-${animeSlug}`;
    if (snapshot.data[key]) continue;

    const animeDetail = await safeRun(`anime detail extra ${animeSlug}`, () => getAnimeDetail(animeSlug));
    if (!animeDetail.ok || !hasAnimeDetail(animeDetail.result)) continue;

    snapshot.data[key] = successEnvelope({
      data: {
        detail: animeDetail.result,
        episodeList: Array.isArray(animeDetail.result.episodeList) ? animeDetail.result.episodeList : []
      },
      pagination: null
    });
  }
}

async function buildSearchKeywordDetailSnapshots(snapshot) {
  const keywords = [...new Set(EXTRA_SEARCH_KEYWORDS.filter(Boolean))];

  for (const keyword of keywords) {
    const searchResult = await safeRun(`search ${keyword}`, () => searchAnime(keyword));
    if (!searchResult.ok || !Array.isArray(searchResult.result) || searchResult.result.length === 0) {
      continue;
    }

    for (const anime of searchResult.result.slice(0, 25)) {
      const animeSlug = anime?.animeId;
      if (!animeSlug) continue;

      const key = `anime-detail-${animeSlug}`;
      if (snapshot.data[key]) continue;

      const animeDetail = await safeRun(`anime detail search ${animeSlug}`, () => getAnimeDetail(animeSlug));
      if (!animeDetail.ok || !hasAnimeDetail(animeDetail.result)) continue;

      snapshot.data[key] = successEnvelope({
        data: {
          detail: animeDetail.result,
          episodeList: Array.isArray(animeDetail.result.episodeList) ? animeDetail.result.episodeList : []
        },
        pagination: null
      });
    }
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

  if (ongoing.ok && Array.isArray(ongoing.result?.animeList) && ongoing.result.animeList.length > 0) {
    snapshot.data['ongoing-anime-page1'] = successEnvelope({
      data: { animeList: ongoing.result.animeList },
      pagination: ongoing.result.pagination
    });
  }

  if (complete.ok && Array.isArray(complete.result?.animeList) && complete.result.animeList.length > 0) {
    snapshot.data['complete-anime-page1'] = successEnvelope({
      data: { animeList: complete.result.animeList },
      pagination: complete.result.pagination
    });
  }

  if (unlimited.ok && Array.isArray(unlimited.result) && unlimited.result.length > 0) {
    snapshot.data.unlimited = successEnvelope({
      creator: 'Sanka Vollerei',
      data: { list: unlimited.result },
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

  await buildEpisodeSnapshots(snapshot, ongoing.result, complete.result);

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`[snapshot] generated: ${SNAPSHOT_PATH}`);
  console.log(`[snapshot] keys: ${Object.keys(snapshot.data).join(', ') || '(none)'}`);
})();
