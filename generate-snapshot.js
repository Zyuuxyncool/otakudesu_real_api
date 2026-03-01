const fs = require('fs');
const path = require('path');
const { scrapeHomeData } = require('./scraper-home');
const {
  getOngoing,
  getCompleted,
  getUnlimitedAnime,
  getGenres,
  getSchedule
} = require('./scraper-advanced');

const SNAPSHOT_PATH = path.join(__dirname, 'snapshot.json');

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

(async () => {
  const snapshot = {
    generatedAt: new Date().toISOString(),
    data: {}
  };

  const [home, ongoing, complete, unlimited, genres, schedule] = await Promise.all([
    safeRun('home', () => scrapeHomeData()),
    safeRun('ongoing page 1', () => getOngoing(1)),
    safeRun('complete page 1', () => getCompleted(1)),
    safeRun('unlimited', () => getUnlimitedAnime()),
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

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`[snapshot] generated: ${SNAPSHOT_PATH}`);
  console.log(`[snapshot] keys: ${Object.keys(snapshot.data).join(', ') || '(none)'}`);
})();
