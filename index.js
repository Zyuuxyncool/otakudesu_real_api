const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { scrapeHomeData } = require('./scraper-home');
const { 
  getOngoing, 
  getCompleted, 
  getTrending, 
  getSchedule, 
  searchAnime, 
  getAnimeDetail, 
  getAnimeListGrouped,
  getGenres,
  getAnimeByGenre,
  getEpisodeDetail,
  getBatchLinks,
  getStreamUrl,
  getUnlimitedAnime
} = require('./scraper-advanced');

const app = express();
const PORT = 3000;
const SCRAPER_BACKEND_URL = (process.env.SCRAPER_BACKEND_URL || '').replace(/\/$/, '');
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH || path.join(__dirname, 'snapshot.json');
const FORCE_SNAPSHOT_MODE = String(process.env.FORCE_SNAPSHOT_MODE || 'false').toLowerCase() === 'true';

let snapshotStore = {
  generatedAt: null,
  data: {}
};

function loadSnapshotFromFile() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return;
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    if (!raw?.trim()) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      snapshotStore = {
        generatedAt: parsed.generatedAt || null,
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {}
      };
    }
  } catch (error) {
    console.error('Snapshot load error:', error.message);
  }
}

function persistSnapshotToFile() {
  try {
    const payload = {
      generatedAt: snapshotStore.generatedAt || new Date().toISOString(),
      data: snapshotStore.data || {}
    };
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('Snapshot save error:', error.message);
  }
}

function getSnapshot(key) {
  return snapshotStore.data?.[key] || null;
}

function saveSnapshot(key, value) {
  if (!key || !value) return;
  snapshotStore.generatedAt = new Date().toISOString();
  snapshotStore.data[key] = value;
  persistSnapshotToFile();
}

function hasItems(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

function getSnapshotResponse(key) {
  const response = getSnapshot(key);
  return response || null;
}

loadSnapshotFromFile();

app.use(cors());
app.use(express.json());

function isValidBackendUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function shouldUseProxy() {
  return isValidBackendUrl(SCRAPER_BACKEND_URL);
}

app.use('/anime', async (req, res, next) => {
  if (!shouldUseProxy()) return next();

  try {
    const targetUrl = `${SCRAPER_BACKEND_URL}${req.originalUrl}`;
    const response = await axios.get(targetUrl, {
      timeout: 45000,
      headers: {
        'User-Agent': req.get('user-agent') || 'Mozilla/5.0',
        Accept: req.get('accept') || 'application/json'
      },
      validateStatus: () => true
    });

    return res.status(response.status).json(response.data);
  } catch (error) {
    return res.status(502).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      message: `Proxy scrape backend failed: ${error.message}`,
      ok: false,
      data: null,
      pagination: null
    });
  }
});

// Cache system
let cache = {
  home: { data: null, time: 0 },
  'ongoing-anime': {},
  'complete-anime': {},
  trending: { data: null, time: 0 },
  schedule: { data: null, time: 0 },
  genre: {},
  unlimited: { data: null, time: 0 }
};

// Bootstrap in-memory cache from bundled snapshot (helps on serverless cold start)
const snapshotUnlimited = getSnapshotResponse('unlimited');
if (snapshotUnlimited) {
  cache.unlimited = { data: snapshotUnlimited, time: Date.now() };
}
const snapshotHome = getSnapshotResponse('home');
if (snapshotHome) {
  cache.home = { data: snapshotHome, time: Date.now() };
}
const snapshotGenre = getSnapshotResponse('genre');
if (snapshotGenre) {
  cache.genre.data = snapshotGenre;
  cache.genre.time = Date.now();
}
const snapshotSchedule = getSnapshotResponse('schedule');
if (snapshotSchedule) {
  cache.schedule = { data: snapshotSchedule, time: Date.now() };
}
const snapshotOngoingPage1 = getSnapshotResponse('ongoing-anime-page1');
if (snapshotOngoingPage1) {
  cache['ongoing-anime']['ongoing-anime-page1'] = { data: snapshotOngoingPage1, time: Date.now() };
}
const snapshotCompletePage1 = getSnapshotResponse('complete-anime-page1');
if (snapshotCompletePage1) {
  cache['complete-anime']['complete-anime-page1'] = { data: snapshotCompletePage1, time: Date.now() };
}

const CACHE_DURATION = 3600000; // 1 jam

function isValidCache(key, subKey = null) {
  if (!cache[key]) return false;
  
  if (subKey) {
    const cacheEntry = cache[key][subKey];
    if (!cacheEntry || !cacheEntry.data) return false;
    return (Date.now() - cacheEntry.time) < CACHE_DURATION;
  }
  
  const cacheEntry = cache[key];
  return cacheEntry && cacheEntry.data && (Date.now() - cacheEntry.time) < CACHE_DURATION;
}

// Root
app.get('/', (req, res) => {
  res.json({
    success: true,
    status: 'success',
    creator: 'Lloyd.ID1112',
    message: 'Otakudesu API v3.0 - Real scraping from otakudesu.best',
    version: '3.0.0',
    snapshot: {
      enabled: true,
      forceMode: FORCE_SNAPSHOT_MODE,
      hasBundledSnapshot: Boolean(snapshotStore.generatedAt),
      generatedAt: snapshotStore.generatedAt
    },
    endpoints: {
      home: '/anime/home - Homepage dengan ongoing & completed',
      'ongoing-anime': '/anime/ongoing-anime - Anime ongoing dengan ?page=1',
      'complete-anime': '/anime/complete-anime - Anime completed dengan ?page=1',
      genre: '/anime/genre - Daftar semua genres',
      'genre-by-slug': '/anime/genre/:slug - Anime per genre dengan ?page=1',
      schedule: '/anime/schedule - Jadwal rilis per hari',
      search: '/anime/search/:keyword - Search anime',
      'anime-list': '/anime/anime - Daftar anime A-Z',
      anime: '/anime/anime/:slug - Detail anime lengkap',
      episode: '/anime/episode/:slug - Episode details + streaming links',
      batch: '/anime/batch/:slug - Batch download links',
      server: '/anime/server/:serverId - Stream URL resolver',
      unlimited: '/anime/unlimited - Semua anime tanpa limit'
    }
  });
});

// Home - dengan scraper real otakudesu
app.get('/anime/home', async (req, res) => {
  try {
    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse('home');
      if (snapshotData) return res.json(snapshotData);
    }

    if (isValidCache('home')) {
      return res.json(cache.home.data);
    }

    const homeData = await scrapeHomeData();
    if (!homeData) {
      const snapshotData = getSnapshotResponse('home');
      if (snapshotData) return res.json(snapshotData);
    }

    cache.home = { data: homeData, time: Date.now() };
    if (homeData) {
      saveSnapshot('home', homeData);
    }
    res.json(homeData);
  } catch (error) {
    console.error('Home endpoint error:', error.message);
    const snapshotData = getSnapshotResponse('home');
    if (snapshotData) return res.json(snapshotData);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      ok: false
    });
  }
});

// Ongoing - Real data dari otakudesu dengan pagination
app.get('/anime/ongoing-anime', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `ongoing-anime-page${page}`;

    if (FORCE_SNAPSHOT_MODE && page === 1) {
      const snapshotData = getSnapshotResponse(cacheKey);
      if (snapshotData) return res.json(snapshotData);
    }
    
    if (isValidCache('ongoing-anime', cacheKey)) {
      return res.json(cache['ongoing-anime'][cacheKey].data);
    }

    const result = await getOngoing(page);
    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        animeList: result.animeList
      },
      pagination: result.pagination
    };

    // If source blocked in production and list empty, fallback to bundled snapshot page 1
    if (page === 1 && !hasItems(result.animeList)) {
      const snapshotData = getSnapshotResponse(cacheKey);
      if (snapshotData) return res.json(snapshotData);
    }
    
    if (!cache['ongoing-anime'][cacheKey]) cache['ongoing-anime'][cacheKey] = {};
    cache['ongoing-anime'][cacheKey] = { data: response, time: Date.now() };
    if (page === 1 && hasItems(result.animeList)) {
      saveSnapshot(cacheKey, response);
    }
    res.json(response);
  } catch (error) {
    console.error('Ongoing error:', error.message);
    const page = parseInt(req.query.page) || 1;
    if (page === 1) {
      const snapshotData = getSnapshotResponse('ongoing-anime-page1');
      if (snapshotData) return res.json(snapshotData);
    }
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: {
        animeList: []
      },
      pagination: null
    });
  }
});

// Complete - Real data dari otakudesu dengan pagination
const handleCompleteAnime = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const cacheKey = `complete-anime-page${page}`;

    if (FORCE_SNAPSHOT_MODE && page === 1) {
      const snapshotData = getSnapshotResponse(cacheKey);
      if (snapshotData) return res.json(snapshotData);
    }
    
    if (isValidCache('complete-anime', cacheKey)) {
      return res.json(cache['complete-anime'][cacheKey].data);
    }

    const result = await getCompleted(page);
    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        animeList: result.animeList
      },
      pagination: result.pagination
    };

    if (page === 1 && !hasItems(result.animeList)) {
      const snapshotData = getSnapshotResponse(cacheKey);
      if (snapshotData) return res.json(snapshotData);
    }
    
    if (!cache['complete-anime'][cacheKey]) cache['complete-anime'][cacheKey] = {};
    cache['complete-anime'][cacheKey] = { data: response, time: Date.now() };
    if (page === 1 && hasItems(result.animeList)) {
      saveSnapshot(cacheKey, response);
    }
    res.json(response);
  } catch (error) {
    console.error('Complete error:', error.message);
    const page = parseInt(req.query.page) || 1;
    if (page === 1) {
      const snapshotData = getSnapshotResponse('complete-anime-page1');
      if (snapshotData) return res.json(snapshotData);
    }
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: {
        animeList: []
      },
      pagination: null
    });
  }
};

app.get('/anime/complete-anime', handleCompleteAnime);
app.get('/anime/complate-anime', handleCompleteAnime);

// Genres - All 36 genres real dari otakudesu
app.get('/anime/genre', async (req, res) => {
  try {
    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse('genre');
      if (snapshotData) return res.json(snapshotData);
    }

    if (isValidCache('genre')) {
      return res.json(cache.genre.data);
    }

    const genreList = await getGenres();
    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      ok: true,
      data: {
        genreList
      },
      pagination: null
    };

    if (!hasItems(genreList)) {
      const snapshotData = getSnapshotResponse('genre');
      if (snapshotData) return res.json(snapshotData);
    }
    
    cache.genre = { data: response, time: Date.now() };
    if (hasItems(genreList)) {
      saveSnapshot('genre', response);
    }
    res.json(response);
  } catch (error) {
    console.error('Genres error:', error.message);
    const snapshotData = getSnapshotResponse('genre');
    if (snapshotData) return res.json(snapshotData);
    res.status(500).json({ status: 'error', ok: false, error: error.message });
  }
});

// Genre by slug - Anime dalam genre tertentu dengan pagination
app.get('/anime/genre/:slug', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const slug = req.params.slug;
    const cacheKey = `genre-${slug}-page${page}`;
    
    if (isValidCache('genre', cacheKey)) {
      return res.json(cache.genre[cacheKey].data);
    }

    const result = await getAnimeByGenre(slug, page);
    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        animeList: result.animeList
      },
      pagination: result.pagination
    };
    
    if (!cache.genre[cacheKey]) cache.genre[cacheKey] = {};
    cache.genre[cacheKey] = { data: response, time: Date.now() };
    res.json(response);
  } catch (error) {
    console.error('Genre detail error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: {
        animeList: []
      },
      pagination: null
    });
  }
});

// Search - Real search dari otakudesu
app.get('/anime/search/:keyword', async (req, res) => {
  try {
    const keyword = req.params.keyword;
    if (!keyword) {
      return res.status(400).json({
        status: 'error',
        creator: 'Lloyd.ID1112',
        statusCode: 400,
        statusMessage: 'Bad Request',
        message: 'Keyword required',
        ok: false,
        data: {
          animeList: []
        },
        pagination: null
      });
    }

    const results = await searchAnime(keyword);
    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        animeList: results
      },
      pagination: null
    });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: {
        animeList: []
      },
      pagination: null
    });
  }
});

// Anime list A-Z
app.get('/anime/anime', async (req, res) => {
  try {
    const list = await getAnimeListGrouped();
    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        list
      },
      pagination: null
    });
  } catch (error) {
    console.error('Anime list error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: null,
      pagination: null
    });
  }
});

// Anime detail - Real data
app.get('/anime/anime/:slug', async (req, res) => {
  try {
    const detail = await getAnimeDetail(req.params.slug);
    if (!detail) {
      return res.status(404).json({
        status: 'error',
        creator: 'Lloyd.ID1112',
        statusCode: 404,
        statusMessage: 'Not Found',
        message: 'Anime not found',
        ok: false,
        data: null,
        pagination: null
      });
    }

    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: detail,
      pagination: null
    });
  } catch (error) {
    console.error('Anime detail error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: null,
      pagination: null
    });
  }
});

// Episode detail - Episode dengan streaming server links
app.get('/anime/episode/:slug', async (req, res) => {
  try {
    const episodeData = await getEpisodeDetail(req.params.slug);
    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: episodeData,
      pagination: null
    });
  } catch (error) {
    console.error('Episode error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: null,
      pagination: null
    });
  }
});

// Batch download - Link download batch
app.get('/anime/batch/:slug', async (req, res) => {
  try {
    const batchData = await getBatchLinks(req.params.slug);
    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: batchData,
      pagination: null
    });
  } catch (error) {
    console.error('Batch error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: null,
      pagination: null
    });
  }
});

// Server - Stream URL resolver
app.get('/anime/server/:serverId', async (req, res) => {
  try {
    const streamUrl = await getStreamUrl(req.params.serverId);
    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: streamUrl,
      pagination: null
    });
  } catch (error) {
    console.error('Server error:', error.message);
    res.status(500).json({
      status: 'error',
      creator: 'Lloyd.ID1112',
      statusCode: 500,
      statusMessage: 'Internal Server Error',
      message: error.message,
      ok: false,
      data: null,
      pagination: null
    });
  }
});

// Schedule - Real schedule dari otakudesu
app.get('/anime/schedule', async (req, res) => {
  try {
    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse('schedule');
      if (snapshotData) return res.json(snapshotData);
    }

    if (isValidCache('schedule')) {
      return res.json(cache.schedule.data);
    }

    const scheduleData = await getSchedule();
    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      ok: true,
      data: scheduleData
    };

    if (!scheduleData || (Array.isArray(scheduleData) && scheduleData.length === 0)) {
      const snapshotData = getSnapshotResponse('schedule');
      if (snapshotData) return res.json(snapshotData);
    }
    
    cache.schedule = { data: response, time: Date.now() };
    if (scheduleData) {
      saveSnapshot('schedule', response);
    }
    res.json(response);
  } catch (error) {
    console.error('Schedule error:', error.message);
    const snapshotData = getSnapshotResponse('schedule');
    if (snapshotData) return res.json(snapshotData);
    res.status(500).json({ status: 'error', ok: false, error: error.message });
  }
});

// Unlimited - Semua anime tanpa limit
app.get('/anime/unlimited', async (req, res) => {
  try {
    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse('unlimited');
      if (snapshotData) return res.json(snapshotData);
    }

    if (isValidCache('unlimited')) {
      return res.json(cache.unlimited.data);
    }

    const allAnime = await getUnlimitedAnime();
    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      ok: true,
      data: {
        total: allAnime.length,
        animeList: allAnime
      },
      pagination: null
    };

    if (!hasItems(list)) {
      const snapshotData = getSnapshotResponse('unlimited');
      if (snapshotData) return res.json(snapshotData);
    }
    
    cache.unlimited = { data: response, time: Date.now() };
    if (hasItems(list)) {
      saveSnapshot('unlimited', response);
    }
    res.json(response);
  } catch (error) {
    console.error('Unlimited error:', error.message);
    const snapshotData = getSnapshotResponse('unlimited');
    if (snapshotData) return res.json(snapshotData);
    res.status(500).json({ status: 'error', ok: false, error: error.message });
  }
});

// Trending - Real trending data (opsional, tapi keep untuk compatibility)
app.get('/api/trending', async (req, res) => {
  try {
    if (isValidCache('trending')) {
      return res.json(cache.trending.data);
    }

    const animeList = await getTrending();
    const response = {
      success: true,
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      total: animeList.length,
      data: animeList
    };
    
    cache.trending = { data: response, time: Date.now() };
    res.json(response);
  } catch (error) {
    console.error('Trending error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('='.repeat(50));
  console.log('🚀 Otakudesu API v2.0.0');
  console.log('='.repeat(50));
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🌐 Base: https://otakudesu.best`);
  console.log(`📚 Scraping real data from website`);
  console.log('='.repeat(50));
  console.log('');
});
