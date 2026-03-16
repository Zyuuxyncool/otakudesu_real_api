const axios = require('axios');
const cheerio = require('cheerio');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://otakudesu.best';
const SOURCE_BASE_URLS = [
  BASE_URL,
  'https://otakudesu.cloud',
  'https://otakudesu.blog'
];

function isBlockedHtml(html = '') {
  const sample = String(html || '').slice(0, 5000).toLowerCase();
  return (
    sample.includes('attention required') ||
    sample.includes('cloudflare') ||
    sample.includes('captcha') ||
    sample.includes('access denied') ||
    sample.includes('forbidden')
  );
}

async function fetchPathWithFallback(path, isValidHtml) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  let lastError = null;

  for (const baseUrl of SOURCE_BASE_URLS) {
    const targetUrl = `${baseUrl}${normalizedPath}`;

    for (let i = 0; i < 2; i++) {
      try {
        const response = await axios.get(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 15000
        });

        const html = response.data || '';
        if (!html || isBlockedHtml(html)) {
          throw new Error(`Blocked or invalid HTML from ${baseUrl}`);
        }

        if (typeof isValidHtml === 'function' && !isValidHtml(html)) {
          throw new Error(`Unexpected page markup from ${baseUrl}`);
        }

        return { html, sourceBaseUrl: baseUrl };
      } catch (error) {
        lastError = error;
        if (i < 1) {
          await new Promise((r) => setTimeout(r, 700));
        }
      }
    }
  }

  throw lastError || new Error('Failed fetching from all source domains');
}

function toAbsoluteUrl(url = '') {
  if (!url) return '';
  return url.startsWith('http') ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

function extractAnimeSlug(url = '') {
  const full = toAbsoluteUrl(url);
  return full.split('/anime/')[1]?.split('/')[0]?.trim() || '';
}

function extractEpisodeSlug(url = '') {
  const full = toAbsoluteUrl(url);
  return full.split('/episode/')[1]?.split('/')[0]?.trim() || '';
}

function parseInfoLabelValue(text = '') {
  const parts = text.split(':');
  if (parts.length < 2) return { label: '', value: text.trim() };
  const label = parts.shift().trim().toLowerCase();
  const value = parts.join(':').trim();
  return { label, value };
}

function getStartWith(title = '') {
  const firstChar = (title || '').trim().charAt(0);
  if (!firstChar) return ' ';
  if (firstChar === '#') return '#';
  if (/\d/.test(firstChar)) return firstChar;
  if (/[A-Za-z]/.test(firstChar)) return firstChar.toUpperCase();
  return ' ';
}

function sortStartWith(a, b) {
  if (a === b) return 0;
  if (a === '#') return -1;
  if (b === '#') return 1;

  const aNum = /^\d$/.test(a);
  const bNum = /^\d$/.test(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1;
  if (bNum) return 1;

  const aLetter = /^[A-Z]$/.test(a);
  const bLetter = /^[A-Z]$/.test(b);
  if (aLetter && bLetter) return a.localeCompare(b);
  if (aLetter) return -1;
  if (bLetter) return 1;

  return a.localeCompare(b);
}

// Helper function untuk scraping dengan timeout & retry
async function fetchWithRetry(url, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 15000
      });
      return response.data;
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(r => setTimeout(r, 1000)); // Wait before retry
    }
  }
}

async function buildPosterMap() {
  const posterMap = new Map();
  const pages = [`${BASE_URL}/ongoing-anime/`, `${BASE_URL}/complete-anime/`];

  for (const pageUrl of pages) {
    try {
      const html = await fetchWithRetry(pageUrl);
      const $ = cheerio.load(html);

      $('div.venz ul li').each((idx, el) => {
        const $el = $(el);
        const href = $el.find('a').first().attr('href') || '';
        const poster =
          $el.find('img.wp-post-image').attr('src') ||
          $el.find('img').attr('src') ||
          '';

        const slug = href.split('/anime/')[1]?.replace(/\/$/, '') || '';
        if (slug && poster && !posterMap.has(slug)) {
          posterMap.set(slug, poster);
        }
      });
    } catch (error) {
      // Ignore poster map failure per page; schedule data still should be returned.
    }
  }

  return posterMap;
}

async function getPosterFromAnimePage(slug) {
  try {
    const { html } = await fetchPathWithFallback(`/anime/${slug}/`, (body) => body.includes('img') && body.includes('/anime/'));
    const $ = cheerio.load(html);
    return (
      $('div.fotoanime img').first().attr('src') ||
      $('div.cukder img').first().attr('src') ||
      $('img.wp-post-image').first().attr('src') ||
      $('img').first().attr('src') ||
      ''
    );
  } catch (error) {
    return '';
  }
}

// Scrape ongoing anime dengan pagination
async function getOngoing(page = 1) {
  try {
    const pagePath = page === 1 ? '/ongoing-anime/' : `/ongoing-anime/page/${page}/`;
    const { html } = await fetchPathWithFallback(pagePath, (body) => body.includes('venz'));
    const $ = cheerio.load(html);
    const anime = [];

    $('div.venz ul li').each((idx, el) => {
      const $el = $(el);
      const linkEl = $el.find('a').first();
      const title = $el.find('h2.jdlflm').text().trim() || linkEl.text().trim();
      const href = linkEl.attr('href') || '';
      const poster = $el.find('img.wp-post-image').attr('src') || $el.find('img').attr('src') || '';
      const animeId = href.split('/anime/')[1]?.replace(/\/$/, '') || '';
      
      // Get episode info
      const epText = $el.find('div.epz').text().trim() || $el.find('.epz').text().trim() || '';
      const episodes = parseInt(epText.match(/\d+/)?.[0]) || 0;
      
      // Get release day
      const dayText = $el.find('div.epztipe').text().trim() || '';
      const releaseDay = dayText || 'None';

      // Get latest release date from web
      const latestReleaseDate = $el.find('div.newnime').text().trim() || '';

      if (title && animeId) {
        anime.push({
          title,
          poster,
          episodes,
          releaseDay,
          latestReleaseDate,
          animeId,
          href: `/anime/anime/${animeId}`,
          otakudesuUrl: href
        });
      }
    });

    // Get pagination info (tanpa nilai kira-kira)
    const totalPages = Math.max(
      ...$('a.page-numbers')
        .toArray()
        .map((el) => parseInt($(el).text().trim(), 10))
        .filter((n) => Number.isFinite(n)),
      page,
      1
    );

    const hasPrevPage = page > 1;
    const hasNextPage = page < totalPages;

    return {
      animeList: anime,
      pagination: {
        currentPage: page,
        hasPrevPage,
        prevPage: hasPrevPage ? page - 1 : null,
        hasNextPage,
        nextPage: hasNextPage ? page + 1 : null,
        totalPages
      }
    };
  } catch (error) {
    console.error('Error scraping ongoing:', error.message);
    return {
      animeList: [],
      pagination: {
        currentPage: page,
        hasPrevPage: page > 1,
        prevPage: page > 1 ? page - 1 : null,
        hasNextPage: false,
        nextPage: null,
        totalPages: 1
      }
    };
  }
}

// Scrape anime list A-Z dari web asli
async function getAnimeListGrouped() {
  try {
    const { html } = await fetchPathWithFallback('/anime-list/', (body) => body.includes('venser') || body.includes('/anime/'));
    const $ = cheerio.load(html);
    const posterMap = await buildPosterMap();
    const enrichmentLimit = Number(process.env.ANIME_LIST_POSTER_ENRICH_LIMIT || 140);
    const enrichmentConcurrency = Number(process.env.ANIME_LIST_POSTER_ENRICH_CONCURRENCY || 8);

    const grouped = new Map();

    $('div.venser ul li a').each((_, el) => {
      const $a = $(el);
      const title = $a.text().trim();
      const rawHref = $a.attr('href') || '';
      const otakudesuUrl = toAbsoluteUrl(rawHref);
      const animeId = extractAnimeSlug(otakudesuUrl);

      if (!title || !animeId) return;

      const startWith = getStartWith(title);
      if (!grouped.has(startWith)) grouped.set(startWith, []);

      grouped.get(startWith).push({
        title,
        poster: posterMap.get(animeId) || '',
        animeId,
        href: `/anime/anime/${animeId}`,
        otakudesuUrl
      });
    });

    // Enrich missing posters from anime detail pages (controlled to avoid overloading)
    const missingPosterTargets = [];
    for (const animeList of grouped.values()) {
      for (const anime of animeList) {
        if (!anime.poster && anime.animeId) {
          missingPosterTargets.push(anime);
        }
      }
    }

    if (missingPosterTargets.length > 0 && enrichmentLimit > 0) {
      const targets = missingPosterTargets.slice(0, enrichmentLimit);
      for (let i = 0; i < targets.length; i += enrichmentConcurrency) {
        const batch = targets.slice(i, i + enrichmentConcurrency);
        const posters = await Promise.all(
          batch.map((anime) => getPosterFromAnimePage(anime.animeId))
        );

        posters.forEach((poster, idx) => {
          if (poster) batch[idx].poster = poster;
        });
      }
    }

    const list = [...grouped.entries()]
      .sort(([a], [b]) => sortStartWith(a, b))
      .map(([startWith, animeList]) => ({
        startWith,
        animeList: animeList.sort((x, y) => x.title.localeCompare(y.title, 'id', { sensitivity: 'base' }))
      }));

    return list;
  } catch (error) {
    console.error('Error scraping anime list:', error.message);
    return [];
  }
}

// Scrape completed anime dengan pagination
async function getCompleted(page = 1) {
  try {
    const pagePath = page === 1 ? '/complete-anime/' : `/complete-anime/page/${page}/`;
    const { html } = await fetchPathWithFallback(pagePath, (body) => body.includes('venz'));
    const $ = cheerio.load(html);
    const anime = [];

    $('div.venz ul li').each((idx, el) => {
      const $el = $(el);
      const linkEl = $el.find('a').first();
      const title = $el.find('h2.jdlflm').text().trim() || linkEl.text().trim();
      const href = linkEl.attr('href') || '';
      const poster = $el.find('img.wp-post-image').attr('src') || $el.find('img').attr('src') || '';
      const animeId = href.split('/anime/')[1]?.replace(/\/$/, '') || '';
      
      // Get episode info
      const epText = $el.find('div.epz').text().trim() || $el.find('.epz').text().trim() || '';
      const episodes = parseInt(epText.match(/\d+/)?.[0]) || 0;
      
      // Get score dan tanggal rilis dari elemen web
      const scoreText = $el.find('div.epztipe').text().trim() || '';
      const lastReleaseDate = $el.find('div.newnime').text().trim() || '';

      if (title && animeId) {
        anime.push({
          title,
          poster,
          episodes,
          score: scoreText,
          lastReleaseDate,
          animeId,
          href: `/anime/anime/${animeId}`,
          otakudesuUrl: href
        });
      }
    });

    // Get pagination info
    const totalPages = Math.max(
      ...$('a.page-numbers')
        .toArray()
        .map((el) => parseInt($(el).text().trim(), 10))
        .filter((n) => Number.isFinite(n)),
      page,
      1
    );

    const hasPrevPage = page > 1;
    const hasNextPage = page < totalPages;

    return {
      animeList: anime,
      pagination: {
        currentPage: page,
        hasPrevPage,
        prevPage: hasPrevPage ? page - 1 : null,
        hasNextPage,
        nextPage: hasNextPage ? page + 1 : null,
        totalPages
      }
    };
  } catch (error) {
    console.error('Error scraping completed:', error.message);
    return {
      animeList: [],
      pagination: {
        currentPage: page,
        hasPrevPage: page > 1,
        prevPage: page > 1 ? page - 1 : null,
        hasNextPage: false,
        nextPage: null,
        totalPages: 1
      }
    };
  }
}

// Scrape trending anime
async function getTrending() {
  try {
    const html = await fetchWithRetry(`${BASE_URL}/`);
    const $ = cheerio.load(html);
    const anime = [];

    // Look for trending/popular section
    $('div.post-item').slice(0, 10).each((idx, el) => {
      const $el = $(el);
      const title = $el.find('h3 a').text().trim();
      const href = $el.find('h3 a').attr('href') || '';
      const poster = $el.find('img').attr('src') || '';
      const animeId = href.split('/anime/')[1]?.replace(/\/$/, '') || '';

      if (title && animeId) {
        anime.push({
          title,
          poster,
          animeId,
          href: `/anime/anime/${animeId}`,
          otakudesuUrl: href,
          rank: idx + 1
        });
      }
    });

    return anime;
  } catch (error) {
    console.error('Error scraping trending:', error.message);
    return [];
  }
}

// Scrape schedule
async function getSchedule() {
  try {
    const html = await fetchWithRetry(`${BASE_URL}/jadwal-rilis/`);
    const $ = cheerio.load(html);
    const posterMap = await buildPosterMap();
    const schedule = [];

    $('.kglist321').each((idx, el) => {
      const $el = $(el);
      const day = $el.find('h2').first().text().trim();
      if (!day) return;

      const anime_list = [];
      $el.find('ul li a').each((i, a) => {
        const $a = $(a);
        const title = $a.text().trim();
        const animeUrl = $a.attr('href') || '';
        const slug = animeUrl.split('/anime/')[1]?.replace(/\/$/, '') || '';

        if (!title || !slug) return;

        anime_list.push({
          title,
          slug,
          url: `/anime/anime/${slug}`,
          poster: posterMap.get(slug) || ''
        });
      });

      schedule.push({ day, anime_list });
    });

    // Fallback poster enrichment from anime detail pages when poster is missing
    const missingSlugs = [];
    for (const dayData of schedule) {
      for (const anime of dayData.anime_list) {
        if (!anime.poster && anime.slug) {
          missingSlugs.push(anime.slug);
        }
      }
    }

    const uniqueMissingSlugs = [...new Set(missingSlugs)];
    for (const slug of uniqueMissingSlugs) {
      const poster = await getPosterFromAnimePage(slug);
      if (poster) posterMap.set(slug, poster);
    }

    for (const dayData of schedule) {
      for (const anime of dayData.anime_list) {
        if (!anime.poster) {
          anime.poster = posterMap.get(anime.slug) || '';
        }
      }
    }

    return schedule;
  } catch (error) {
    console.error('Error scraping schedule:', error.message);
    return [];
  }
}

// Search anime
async function searchAnime(query) {
  try {
    const html = await fetchWithRetry(`${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=anime`);
    const $ = cheerio.load(html);
    const results = [];

    $('.chivsrc li').each((_, el) => {
      const $el = $(el);
      const $titleLink = $el.find('h2 a').first();
      const title = $titleLink.text().trim();
      const otakudesuUrl = toAbsoluteUrl($titleLink.attr('href') || '');
      const animeId = extractAnimeSlug(otakudesuUrl);
      const poster = ($el.find('img').first().attr('src') || '').trim();

      if (!title || !animeId) return;

      const statusText = $el.find('.set').filter((__, s) => /Status/i.test($(s).text())).first().text();
      const status = statusText.split(':')[1]?.trim() || '';

      const ratingText = $el.find('.set').filter((__, s) => /Rating/i.test($(s).text())).first().text();
      const score = ratingText.split(':')[1]?.trim() || '';

      const genreList = [];
      $el.find('a[href*="/genres/"]').each((__, a) => {
        const $a = $(a);
        const genreTitle = $a.text().trim();
        const genreOtakudesuUrl = toAbsoluteUrl($a.attr('href') || '');
        const genreId = genreOtakudesuUrl.split('/genres/')[1]?.split('/')[0]?.trim() || '';
        if (!genreTitle || !genreId) return;

        genreList.push({
          title: genreTitle,
          genreId,
          href: `/anime/genre/${genreId}`,
          otakudesuUrl: genreOtakudesuUrl
        });
      });

      results.push({
        title,
        poster,
        status,
        score,
        animeId,
        href: `/anime/anime/${animeId}`,
        otakudesuUrl,
        genreList
      });
    });

    return results;
  } catch (error) {
    console.error('Error searching anime:', error.message);
    return [];
  }
}

// Get anime detail
async function getAnimeDetail(slug) {
  try {
    const { html } = await fetchPathWithFallback(
      `/anime/${slug}/`,
      (body) => body.includes('infozingle') || body.includes('/episode/') || body.includes('/batch/')
    );
    const $ = cheerio.load(html);

    const title = (
      $('h1.entry-title').first().text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      ''
    ).replace(/\s+Subtitle Indonesia$/i, '').trim();

    const poster =
      $('div.fotoanime img').first().attr('src') ||
      $('div.cukder img').first().attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      '';

    const infoMap = {};
    $('div.infozingle p').each((_, el) => {
      const text = $(el).text().trim();
      const { label, value } = parseInfoLabelValue(text);
      if (label) infoMap[label] = value;
    });

    const totalEpisodes = parseInt((infoMap['total episode'] || '').match(/\d+/)?.[0] || '0', 10) || 0;

    const genreList = [];
    $('div.infozingle a[href*="/genres/"]').each((_, el) => {
      const $a = $(el);
      const genreTitle = $a.text().trim();
      const rawHref = $a.attr('href') || '';
      const otakudesuUrl = toAbsoluteUrl(rawHref);
      const genreId = otakudesuUrl.split('/genres/')[1]?.split('/')[0]?.trim() || '';
      if (!genreTitle || !genreId) return;

      genreList.push({
        title: genreTitle,
        genreId,
        href: `/anime/genre/${genreId}`,
        otakudesuUrl
      });
    });

    const episodeList = [];
    const seenEpisode = new Set();

    // Try multiple selectors to find episode lists
    const episodeSelectors = [
      'div.episodelist ul li',
      'div.eplister ul li',
      'div.venser ul li',
      'div.epslis ul li',
      'div.epstab ul li',
      'div[class*="episode"] ul li',
      'div[class*="eplister"] ul li',
      'ul.eplister li',
      'ul.episodes li'
    ];

    for (const selector of episodeSelectors) {
      if (episodeList.length > 0) break;

      $(selector).each((_, el) => {
        const $el = $(el);
        const $a = $el.find('a[href*="/episode/"]').first();
        const epTitle = $a.text().trim();
        const epUrl = toAbsoluteUrl($a.attr('href') || '');
        const episodeId = extractEpisodeSlug(epUrl);
        if (!epTitle || !episodeId) return;
        if (seenEpisode.has(episodeId)) return;
        seenEpisode.add(episodeId);

        const eps = parseInt(epTitle.match(/episode\s*(\d+)/i)?.[1] || epTitle.match(/\d+/)?.[0] || '0', 10) || 0;
        const date = $el.find('span.zeebr, span.date, span[class*="date"]').first().text().trim() || '';

        episodeList.push({
          title: epTitle,
          eps,
          date,
          episodeId,
          href: `/anime/episode/${episodeId}`,
          otakudesuUrl: epUrl
        });
      });
    }

    // Fallback: find episodes from pagination links
    if (episodeList.length === 0) {
      const paginationLinks = [];
      $('a[href*="/episode/"]').each((_, a) => {
        const $a = $(a);
        const epTitle = $a.text().trim();
        const epUrl = toAbsoluteUrl($a.attr('href') || '');
        const isInPagination = $a.closest('nav, .pagination, [class*="pagination"]').length > 0;
        
        if (isInPagination) {
          paginationLinks.push({ epTitle, epUrl, $a });
        }
      });

      // If we found pagination, use those as fallback
      if (paginationLinks.length > 0) {
        for (const { epTitle, epUrl } of paginationLinks) {
          const episodeId = extractEpisodeSlug(epUrl);
          if (!epTitle || !episodeId) continue;
          if (seenEpisode.has(episodeId)) continue;
          seenEpisode.add(episodeId);

          const eps = parseInt(epTitle.match(/episode\s*(\d+)/i)?.[1] || epTitle.match(/\d+/)?.[0] || '0', 10) || 0;
          episodeList.push({
            title: epTitle,
            eps,
            date: '',
            episodeId,
            href: `/anime/episode/${episodeId}`,
            otakudesuUrl: epUrl
          });
        }
      }
    }

    // Final fallback: extract all episode links from page
    if (episodeList.length === 0) {
      $('a[href*="/episode/"]').each((_, a) => {
        const $a = $(a);
        const epTitle = $a.text().trim();
        const epUrl = toAbsoluteUrl($a.attr('href') || '');
        const episodeId = extractEpisodeSlug(epUrl);
        if (!epTitle || !episodeId) return;
        if (seenEpisode.has(episodeId)) return;
        // In fallback mode, be more lenient and also accept links that don't look like episodes
        const lengthThreshold = epTitle.length < 100; // Skip very long text
        if (!lengthThreshold) return;
        seenEpisode.add(episodeId);

        const eps = parseInt(epTitle.match(/episode\s*(\d+)/i)?.[1] || epTitle.match(/\d+/)?.[0] || '0', 10) || 0;
        episodeList.push({
          title: epTitle,
          eps,
          date: '',
          episodeId,
          href: `/anime/episode/${episodeId}`,
          otakudesuUrl: epUrl
        });
      });
    }

    const recommendedAnimeList = [];
    $('div.isi-recommend-anime-series div.isi-konten').each((_, el) => {
      const $item = $(el);
      const $a = $item.find('a[href*="/anime/"]').first();
      const recTitle = $item.find('span.judul-anime a').first().text().trim() || $a.text().trim();
      const recUrl = toAbsoluteUrl($a.attr('href') || '');
      const recPoster = $item.find('img').first().attr('src') || '';
      const animeId = extractAnimeSlug(recUrl);
      if (!recTitle || !animeId) return;

      recommendedAnimeList.push({
        title: recTitle,
        poster: recPoster,
        animeId,
        href: `/anime/anime/${animeId}`,
        otakudesuUrl: recUrl
      });
    });

    const synopsisParagraphs = [];
    const synopsisConnections = [];
    $('div.sinopc p, div.sinopsis p').each((_, el) => {
      const text = $(el).text().trim();
      if (text) synopsisParagraphs.push(text);
      $(el).find('a[href*="/anime/"]').each((__, a) => {
        const cTitle = $(a).text().trim();
        const cUrl = toAbsoluteUrl($(a).attr('href') || '');
        const cAnimeId = extractAnimeSlug(cUrl);
        if (!cTitle || !cAnimeId) return;
        synopsisConnections.push({
          title: cTitle,
          animeId: cAnimeId,
          href: `/anime/anime/${cAnimeId}`,
          otakudesuUrl: cUrl
        });
      });
    });

    const batchAnchor = $('a[href*="/batch/"]').first();
    const batchUrl = toAbsoluteUrl(batchAnchor.attr('href') || '');
    const batchId = batchUrl.split('/batch/')[1]?.split('/')[0]?.trim() || '';

    const batch = batchId
      ? {
          title: 'Batch Download',
          batchId,
          href: `/anime/batch/${batchId}`,
          otakudesuUrl: batchUrl
        }
      : null;

    return {
      title,
      poster,
      japanese: infoMap['japanese'] || '',
      score: infoMap['skor'] || infoMap['score'] || '',
      producers: infoMap['produser'] || infoMap['producer'] || '',
      type: infoMap['tipe'] || infoMap['type'] || '',
      status: infoMap['status'] || '',
      episodes: totalEpisodes,
      duration: infoMap['durasi'] || infoMap['duration'] || '',
      aired: infoMap['tanggal rilis'] || infoMap['aired'] || '',
      studios: infoMap['studio'] || infoMap['studios'] || '',
      batch,
      synopsis: {
        paragraphs: synopsisParagraphs,
        connections: synopsisConnections
      },
      genreList,
      episodeList,
      recommendedAnimeList
    };
  } catch (error) {
    console.error('Error scraping anime detail:', error.message);
    return null;
  }
}

// Get all genres
async function getGenres() {
  try {
    const html = await fetchWithRetry(`${BASE_URL}/genre-list/`);
    const $ = cheerio.load(html);
    const genres = [];

    // Otakudesu genre links typically use /genres/{slug}/
    $('a[href*="/genres/"]').each((idx, el) => {
      const $el = $(el);
      const title = $el.text().trim();
      const rawHref = $el.attr('href') || '';
      const otakudesuUrl = rawHref.startsWith('http')
        ? rawHref
        : `${BASE_URL}${rawHref.startsWith('/') ? '' : '/'}${rawHref}`;

      if (!title || !otakudesuUrl) return;

      const genreId = otakudesuUrl
        .split('/genres/')[1]
        ?.split('/')[0]
        ?.trim();

      if (!genreId) return;

      genres.push({
        title,
        genreId,
        href: `/anime/genre/${genreId}`,
        otakudesuUrl
      });
    });

    // Remove duplicates by genreId while preserving original order
    const uniqueGenres = [];
    const seen = new Set();
    for (const genre of genres) {
      if (!seen.has(genre.genreId)) {
        seen.add(genre.genreId);
        uniqueGenres.push(genre);
      }
    }

    return uniqueGenres;
  } catch (error) {
    console.error('Error scraping genres:', error.message);
    return [];
  }
}

// Get anime by genre dengan pagination
async function getAnimeByGenre(genreSlug, page = 1) {
  try {
    const pagePath = page === 1
      ? `/genres/${genreSlug}/`
      : `/genres/${genreSlug}/page/${page}/`;

    const { html } = await fetchPathWithFallback(
      pagePath,
      (body) => body.includes('col-anime') || body.includes('/anime/')
    );

    const $ = cheerio.load(html);
    const anime = [];

    // Selector utama + fallback selector jika markup berubah
    const animeNodes = $('div.col-md-4.col-anime-con div.col-anime');
    const nodesToParse = animeNodes.length > 0
      ? animeNodes
      : $('div.col-anime-con div.col-anime, div.col-anime, div.venz ul li');

    nodesToParse.each((_, el) => {
      const $el = $(el);

      const $titleLink = $el.find('div.col-anime-title a, h2.jdlflm a, a').first();
      const title = $titleLink.text().trim();
      const otakudesuUrl = toAbsoluteUrl($titleLink.attr('href') || '');
      const animeId = extractAnimeSlug(otakudesuUrl);

      if (!title || !animeId) return;

      const poster = $el.find('div.col-anime-cover img, img.wp-post-image, img').first().attr('src') || '';
      const studios = $el.find('div.col-anime-studio').first().text().trim() || '';
      const score = $el.find('div.col-anime-rating').first().text().trim() || '';
      const season = $el.find('div.col-anime-date').first().text().trim() || '';

      const epsText = $el.find('div.col-anime-eps').first().text().trim();
      const epsMatch = epsText.match(/(\d+)/);
      const episodes = epsMatch ? parseInt(epsMatch[1], 10) : null;

      const synopsisParagraphs = [];
      $el.find('div.col-synopsis p').each((__, p) => {
        const raw = $(p).text().replace(/\u00a0/g, ' ');
        if (raw === '') return;

        const normalized = raw.replace(/\s+/g, ' ');
        if (normalized.trim() === '' && normalized.includes(' ')) {
          synopsisParagraphs.push(' ');
          return;
        }

        const cleaned = normalized.trim();
        if (cleaned) synopsisParagraphs.push(cleaned);
      });

      const genreList = [];
      $el.find('div.col-anime-genre a[href*="/genres/"]').each((__, a) => {
        const $a = $(a);
        const genreTitle = $a.text().trim();
        const genreOtakudesuUrl = toAbsoluteUrl($a.attr('href') || '');
        const genreId = genreOtakudesuUrl.split('/genres/')[1]?.split('/')[0]?.trim() || '';

        if (!genreTitle || !genreId) return;

        genreList.push({
          title: genreTitle,
          genreId,
          href: `/anime/genre/${genreId}`,
          otakudesuUrl: genreOtakudesuUrl
        });
      });

      anime.push({
        title,
        poster,
        studios,
        score,
        episodes,
        season,
        animeId,
        href: `/anime/anime/${animeId}`,
        otakudesuUrl,
        synopsis: {
          paragraphs: synopsisParagraphs
        },
        genreList
      });
    });

    // Get pagination info (tanpa nilai kira-kira)
    const totalPages = Math.max(
      ...$('a.page-numbers, span.page-numbers')
        .toArray()
        .map((el) => parseInt($(el).text().trim(), 10))
        .filter((n) => Number.isFinite(n)),
      page,
      1
    );

    const hasPrevPage = page > 1;
    const hasNextPage = page < totalPages;

    return {
      animeList: anime,
      pagination: {
        currentPage: page,
        hasPrevPage,
        prevPage: hasPrevPage ? page - 1 : null,
        hasNextPage,
        nextPage: hasNextPage ? page + 1 : null,
        totalPages
      }
    };
  } catch (error) {
    console.error('Error scraping genre:', error.message);
    return {
      animeList: [],
      pagination: {
        currentPage: page,
        hasPrevPage: page > 1,
        prevPage: page > 1 ? page - 1 : null,
        hasNextPage: false,
        nextPage: null,
        totalPages: 1
      }
    };
  }
}

// Get episode detail dengan streaming server links
async function getEpisodeDetail(episodeSlug) {
  try {
    const { html } = await fetchPathWithFallback(
      `/episode/${episodeSlug}/`,
      (body) => {
        const normalized = String(body || '').toLowerCase();
        const hasPrimaryStreamMarkers =
          normalized.includes('mirrorstream')
          || normalized.includes('lightsvideo')
          || normalized.includes('responsive-embed-stream')
          || normalized.includes('data-content=');

        const hasEpisodeStructure =
          normalized.includes('/episode/')
          && (
            normalized.includes('div class="download"')
            || normalized.includes('infozingle')
            || normalized.includes('keyingpost')
          );

        // Reject thin/placeholder pages so fetchPathWithFallback can try the next domain.
        return hasPrimaryStreamMarkers || hasEpisodeStructure;
      }
    );
    const $ = cheerio.load(html);

    const title = $('h1.entry-title, h1').first().text().trim();

    const animeAnchor = $('a[href*="/anime/"]').first();
    const animeId = extractAnimeSlug(animeAnchor.attr('href') || '');

    const releaseText = $('div.venutama, div.posttl').first().text().replace(/\s+/g, ' ');
    const releaseTimeMatch = releaseText.match(/Release\s+on\s*([0-9]{1,2}:[0-9]{2}\s*(?:am|pm))/i);
    const releaseGenericMatch = releaseText.match(/Release\s+on\s*(.*?)(?:Pilih\s+Episode|Previous\s+Eps\.|Next\s+Eps\.|$)/i);
    const releaseValue = releaseTimeMatch?.[1] || releaseGenericMatch?.[1]?.trim() || '';
    const releaseTime = releaseValue ? `Release on ${releaseValue}` : '';

    const defaultStreamingUrl = (
      $('#lightsVideo iframe, .responsive-embed-stream iframe, .pemain iframe, iframe').first().attr('src') || ''
    ).trim();

    const buildServerId = (encodedData = '', quality = '', index = 0) => {
      try {
        const decoded = Buffer.from(encodedData, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed?.id !== undefined && parsed?.i !== undefined && parsed?.q) {
          return `${parsed.id}-${parsed.i}-${parsed.q}`;
        }
      } catch (_) {
        // ignore decode error and fallback below
      }
      return encodedData || `${quality}-${index}`;
    };

    const normalizeQuality = (q = '') => String(q || '').trim().toLowerCase();

    const qualityMap = new Map();
    $('div.mirrorstream ul').each((_, ul) => {
      const $ul = $(ul);
      const cls = $ul.attr('class') || '';
      const qualityFromClass = cls.match(/m(\d{3,4})p/i)?.[1];
      let qualityTitle = qualityFromClass ? `${qualityFromClass}p` : '';

      const serverList = [];
      $ul.find('li').each((idx, li) => {
        const $li = $(li);
        const $a = $li.find('a').first();
        const encodedContent = ($a.attr('data-content') || '').trim();
        const name = $li.text().trim();
        if (!name) return;

        if (!qualityTitle && encodedContent) {
          try {
            const decoded = Buffer.from(encodedContent, 'base64').toString('utf8');
            const parsed = JSON.parse(decoded);
            if (parsed?.q) qualityTitle = normalizeQuality(parsed.q);
          } catch (_) {
            // ignore
          }
        }

        const serverId = buildServerId(encodedContent, qualityTitle || 'unknown', idx);
        serverList.push({
          title: name,
          serverId,
          href: `/anime/server/${encodeURIComponent(serverId)}`
        });
      });

      const normalizedTitle = normalizeQuality(qualityTitle) || 'unknown';
      if (!qualityMap.has(normalizedTitle)) {
        qualityMap.set(normalizedTitle, []);
      }
      qualityMap.get(normalizedTitle).push(...serverList);
    });

    const preferredQualityOrder = ['360p', '480p', '720p', '1080p'];
    const existingQualityTitles = [...qualityMap.keys()];
    const sortedQualityTitles = [
      ...preferredQualityOrder.filter((q) => qualityMap.has(q)),
      ...existingQualityTitles.filter((q) => !preferredQualityOrder.includes(q))
    ];

    const server = {
      qualities: sortedQualityTitles
        .map((q) => ({
          title: q,
          serverList: qualityMap.get(q) || []
        }))
        .filter((q) => Array.isArray(q.serverList) && q.serverList.length > 0)
    };

    let resolvedDefaultStreamingUrl = defaultStreamingUrl;
    if (!resolvedDefaultStreamingUrl && server.qualities.length > 0) {
      const firstServerId = server.qualities[0]?.serverList?.[0]?.serverId;
      if (firstServerId) {
        const resolved = await getStreamUrl(firstServerId);
        if (resolved?.resolved && resolved?.embedUrl) {
          resolvedDefaultStreamingUrl = resolved.embedUrl;
        }
      }
    }

    const downloadUrl = {
      qualities: []
    };

    $('div.download ul li').each((_, li) => {
      const $li = $(li);
      const quality = $li.find('strong').first().text().trim();
      const size = $li.find('i').first().text().trim();
      if (!quality) return;

      const urls = [];
      $li.find('a').each((__, a) => {
        const $a = $(a);
        const linkTitle = $a.text().trim();
        const url = ($a.attr('href') || '').trim();
        if (!linkTitle || !url) return;

        urls.push({
          title: linkTitle,
          url
        });
      });

      downloadUrl.qualities.push({
        title: quality,
        size,
        urls
      });
    });

    const prevAnchor = $('.flir a, .naveps a').filter((_, a) => /prev|previous/i.test($(a).text())).first();
    const nextAnchor = $('.flir a, .naveps a').filter((_, a) => /next/i.test($(a).text())).first();

    const prevUrl = toAbsoluteUrl(prevAnchor.attr('href') || '');
    const nextUrl = toAbsoluteUrl(nextAnchor.attr('href') || '');
    const prevEpisodeId = extractEpisodeSlug(prevUrl);
    const nextEpisodeId = extractEpisodeSlug(nextUrl);

    const infoMap = {};
    $('div.cukder div.infozingle p, div.infozingle p').each((_, p) => {
      const text = $(p).text().trim();
      const { label, value } = parseInfoLabelValue(text);
      if (!label) return;
      infoMap[label] = value;
    });

    const genreList = [];
    $('div.cukder div.infozingle a[href*="/genres/"], div.infozingle a[href*="/genres/"]').each((_, a) => {
      const $a = $(a);
      const genreTitle = $a.text().trim();
      const genreOtakudesuUrl = toAbsoluteUrl($a.attr('href') || '');
      const genreId = genreOtakudesuUrl.split('/genres/')[1]?.split('/')[0]?.trim() || '';
      if (!genreTitle || !genreId) return;

      genreList.push({
        title: genreTitle,
        genreId,
        href: `/anime/genre/${genreId}`,
        otakudesuUrl: genreOtakudesuUrl
      });
    });

    const episodeList = [];
    $('div.keyingpost li a[href*="/episode/"]').each((_, a) => {
      const $a = $(a);
      const epTitle = $a.text().trim();
      const epUrl = toAbsoluteUrl($a.attr('href') || '');
      const episodeId = extractEpisodeSlug(epUrl);
      if (!epTitle || !episodeId) return;

      const eps = parseInt(epTitle.match(/(\d+)/)?.[1] || '0', 10) || 0;
      episodeList.push({
        title: epTitle,
        eps,
        date: '',
        episodeId,
        href: `/anime/episode/${episodeId}`,
        otakudesuUrl: epUrl
      });
    });

    return {
      title,
      animeId,
      releaseTime,
      defaultStreamingUrl: resolvedDefaultStreamingUrl,
      hasPrevEpisode: Boolean(prevEpisodeId),
      prevEpisode: prevEpisodeId
        ? {
            title: 'Prev',
            episodeId: prevEpisodeId,
            href: `/anime/episode/${prevEpisodeId}`,
            otakudesuUrl: prevUrl
          }
        : null,
      hasNextEpisode: Boolean(nextEpisodeId),
      nextEpisode: nextEpisodeId
        ? {
            title: 'Next',
            episodeId: nextEpisodeId,
            href: `/anime/episode/${nextEpisodeId}`,
            otakudesuUrl: nextUrl
          }
        : null,
      server,
      downloadUrl,
      info: {
        credit: infoMap['credit'] || '',
        encoder: infoMap['encoder'] || '',
        duration: infoMap['duration'] || infoMap['durasi'] || '',
        type: infoMap['tipe'] || infoMap['type'] || '',
        genreList,
        episodeList
      }
    };
  } catch (error) {
    console.error('Error scraping episode detail:', error.message);
    return {
      title: '',
      animeId: '',
      releaseTime: '',
      defaultStreamingUrl: '',
      hasPrevEpisode: false,
      prevEpisode: null,
      hasNextEpisode: false,
      nextEpisode: null,
      server: {
        qualities: []
      },
      downloadUrl: {
        qualities: []
      },
      info: {
        credit: '',
        encoder: '',
        duration: '',
        type: '',
        genreList: [],
        episodeList: []
      }
    };
  }
}

// Get batch download links
async function getBatchLinks(animeSlug) {
  try {
    const html = await fetchWithRetry(`${BASE_URL}/batch/${animeSlug}/`);
    const $ = cheerio.load(html);

    const infosHtml = $('.animeinfo .infos').first().html() || '';
    const extractInfo = (label) => {
      const regex = new RegExp(`<b>\\s*${label}\\s*<\\/b>\\s*:\\s*([\\s\\S]*?)(?:<br\\s*\\/?>|$)`, 'i');
      const match = infosHtml.match(regex);
      if (!match?.[1]) return '';
      return cheerio.load(`<div>${match[1]}</div>`)('div').text().trim();
    };

    const title = extractInfo('Judul') || $('h1.entry-title, h1').first().text().replace(/\s*\[BATCH\]\s*Subtitle Indonesia/i, '').trim();
    const poster = $('.animeinfo .imganime img, .animeinfo img').first().attr('src') || '';

    const animeLink = $('.animeinfo .totalepisode a[href*="/anime/"]').first().attr('href')
      || $('a[href*="/anime/"]').first().attr('href')
      || '';
    const animeId = extractAnimeSlug(animeLink);

    const score = extractInfo('Rating');
    const episodes = parseInt((extractInfo('Episodes') || '').match(/\d+/)?.[0] || '0', 10) || 0;

    const genreList = [];
    $('.animeinfo .infos a[href*="/genres/"]').each((_, a) => {
      const $a = $(a);
      const genreTitle = $a.text().trim();
      const genreOtakudesuUrl = toAbsoluteUrl($a.attr('href') || '');
      const genreId = genreOtakudesuUrl.split('/genres/')[1]?.split('/')[0]?.trim() || '';
      if (!genreTitle || !genreId) return;

      genreList.push({
        title: genreTitle,
        genreId,
        href: `/anime/genre/${genreId}`,
        otakudesuUrl: genreOtakudesuUrl
      });
    });

    const formats = [];
    $('div.batchlink').each((_, box) => {
      const $box = $(box);
      const formatTitle = $box.find('h4').first().text().trim();
      const qualities = [];

      $box.find('ul li').each((__, li) => {
        const $li = $(li);
        const qualityTitle = $li.find('strong').first().text().trim();
        const size = $li.find('i').first().text().trim();
        if (!qualityTitle) return;

        const urls = [];
        $li.find('a').each((___, a) => {
          const $a = $(a);
          const hostTitle = $a.text().trim();
          const url = ($a.attr('href') || '').trim();
          if (!hostTitle || !url) return;
          urls.push({ title: hostTitle, url });
        });

        qualities.push({
          title: qualityTitle,
          size,
          urls
        });
      });

      if (formatTitle || qualities.length) {
        formats.push({
          title: formatTitle,
          qualities
        });
      }
    });

    return {
      title,
      animeId,
      poster,
      japanese: extractInfo('Japanese'),
      type: extractInfo('Type'),
      score,
      episodes,
      duration: extractInfo('Duration'),
      studios: extractInfo('Studios'),
      producers: extractInfo('Producers'),
      aired: extractInfo('Aired'),
      credit: extractInfo('Credit'),
      genreList,
      downloadUrl: {
        formats
      }
    };
  } catch (error) {
    console.error('Error scraping batch links:', error.message);
    return {
      title: '',
      animeId: '',
      poster: '',
      japanese: '',
      type: '',
      score: '',
      episodes: 0,
      duration: '',
      studios: '',
      producers: '',
      aired: '',
      credit: '',
      genreList: [],
      downloadUrl: {
        formats: []
      }
    };
  }
}

// Get stream URL dari server ID
async function getStreamUrl(serverId, options = {}) {
  try {
    const episodeSlug = String(options?.episodeSlug || '').trim();
    const buildCookieHeader = (setCookie = []) => {
      if (!Array.isArray(setCookie) || setCookie.length === 0) return '';
      return setCookie
        .map((item) => String(item || '').split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
    };

    const parseServerId = (raw = '') => {
      const cleaned = decodeURIComponent(String(raw || '').trim());

      // Format internal API saat ini: "{id}-{index}-{quality}" contoh: 186664-0-480p
      const directMatch = cleaned.match(/^(\d+)-(\d+)-(.+)$/);
      if (directMatch) {
        return {
          id: Number(directMatch[1]),
          i: Number(directMatch[2]),
          q: directMatch[3]
        };
      }

      // Fallback: bisa juga kirim raw data-content base64 dari situs
      // contoh: eyJpZCI6MTg2NjY0LCJpIjowLCJxIjoiNDgwcCJ9
      try {
        const padded = cleaned.padEnd(cleaned.length + ((4 - (cleaned.length % 4)) % 4), '=');
        const normalized = padded.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = Buffer.from(normalized, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);

        if (parsed?.id !== undefined && parsed?.i !== undefined && parsed?.q) {
          return {
            id: Number(parsed.id),
            i: Number(parsed.i),
            q: String(parsed.q)
          };
        }
      } catch (_) {
        // ignore fallback decode error
      }

      return null;
    };

    const parsedServer = parseServerId(serverId);
    if (!parsedServer) {
      return {
        serverId,
        resolved: false,
        embedUrl: null,
        iframeHtml: null,
        message: 'Format serverId tidak valid.'
      };
    }

    let lastMessage = 'Nonce tidak ditemukan dari server.';

    for (const baseUrl of SOURCE_BASE_URLS) {
      try {
        const refererUrl = episodeSlug ? `${baseUrl}/episode/${encodeURIComponent(episodeSlug)}/` : `${baseUrl}/`;
        let cookieHeader = '';
        try {
          const bootstrap = await axios.get(refererUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
              Connection: 'keep-alive'
            },
            timeout: 15000
          });
          cookieHeader = buildCookieHeader(bootstrap?.headers?.['set-cookie']);
        } catch (_) {
          cookieHeader = '';
        }

        const noncePayload = new URLSearchParams();
        noncePayload.append('action', 'aa1208d27f29ca340c92c66d1926f13f');

        const nonceResponse = await axios.post(`${baseUrl}/wp-admin/admin-ajax.php`, noncePayload.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            Origin: baseUrl,
            Referer: refererUrl,
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          },
          timeout: 15000
        });

        const nonce = nonceResponse?.data?.data;
        if (!nonce) {
          lastMessage = `Nonce tidak ditemukan dari ${baseUrl}`;
          continue;
        }

        const streamPayload = new URLSearchParams();
        streamPayload.append('id', String(parsedServer.id));
        streamPayload.append('i', String(parsedServer.i));
        streamPayload.append('q', String(parsedServer.q));
        streamPayload.append('nonce', String(nonce));
        streamPayload.append('action', '2a3505c93b0035d3f455df82bf976b84');

        const streamResponse = await axios.post(`${baseUrl}/wp-admin/admin-ajax.php`, streamPayload.toString(), {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            Origin: baseUrl,
            Referer: refererUrl,
            ...(cookieHeader ? { Cookie: cookieHeader } : {})
          },
          timeout: 15000
        });

        const encodedIframeHtml = streamResponse?.data?.data || '';
        const iframeHtml = encodedIframeHtml
          ? Buffer.from(encodedIframeHtml, 'base64').toString('utf8')
          : '';

        const $$ = cheerio.load(iframeHtml || '');
        const embedUrl = $$('iframe').first().attr('src') || '';

        if (embedUrl) {
          return {
            serverId,
            resolved: true,
            embedUrl,
            iframeHtml: iframeHtml || null,
            request: {
              id: parsedServer.id,
              i: parsedServer.i,
              q: parsedServer.q
            },
            sourceBaseUrl: baseUrl
          };
        }

        lastMessage = `Embed URL kosong dari ${baseUrl}`;
      } catch (error) {
        lastMessage = error.message;
      }
    }

    return {
      serverId,
      resolved: false,
      embedUrl: null,
      iframeHtml: null,
      message: lastMessage
    };
  } catch (error) {
    console.error('Error resolving stream URL:', error.message);
    return {
      serverId,
      resolved: false,
      embedUrl: null,
      iframeHtml: null,
      message: error.message
    };
  }
}

// Get unlimited anime (all anime without pagination)
async function getUnlimitedAnime() {
  try {
    const allAnime = [];
    let page = 1;
    let hasMore = true;

    // Fetch ongoing anime all pages
    while (hasMore && page <= 50) { // Limit to 50 pages to prevent infinite loop
      try {
        const result = await getOngoing(page);
        if (result.animeList && result.animeList.length > 0) {
          allAnime.push(...result.animeList);
          page++;
          if (result.pagination.total_pages === page - 1) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      } catch (err) {
        hasMore = false;
      }
    }

    // Fetch completed anime all pages
    page = 1;
    hasMore = true;
    while (hasMore && page <= 50) {
      try {
        const result = await getCompleted(page);
        if (result.animeList && result.animeList.length > 0) {
          allAnime.push(...result.animeList);
          page++;
          if (result.pagination.total_pages === page - 1) {
            hasMore = false;
          }
        } else {
          hasMore = false;
        }
      } catch (err) {
        hasMore = false;
      }
    }

    return allAnime;
  } catch (error) {
    console.error('Error fetching unlimited anime:', error.message);
    return [];
  }
}

module.exports = {
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
};
