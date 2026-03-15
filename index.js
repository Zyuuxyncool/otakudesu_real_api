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

function hasEpisodeStreamData(episodeData) {
  if (!episodeData || typeof episodeData !== 'object') return false;
  if (episodeData.defaultStreamingUrl) return true;
  const qualities = episodeData.server?.qualities;
  return Array.isArray(qualities) && qualities.some((q) => Array.isArray(q?.serverList) && q.serverList.length > 0);
}

function createDirectServerId(url, quality = 'default', index = 0) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return '';

  const payload = {
    url: rawUrl,
    quality: String(quality || 'default'),
    index: Number(index) || 0
  };

  return `direct-${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
}

function decodeDirectServerId(serverId) {
  const value = String(serverId || '');
  if (!value.startsWith('direct-')) return null;

  try {
    const encoded = value.slice('direct-'.length);
    if (!encoded) return null;
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const url = String(decoded?.url || '').trim();
    if (!url) return null;
    return {
      url,
      quality: String(decoded?.quality || 'default'),
      index: Number(decoded?.index) || 0
    };
  } catch (_) {
    return null;
  }
}

function createRetryEpisodeServerId(episodeSlug) {
  const slug = String(episodeSlug || '').trim();
  if (!slug) return '';
  return `retry-episode-${encodeURIComponent(slug)}`;
}

function decodeRetryEpisodeServerId(serverId) {
  const value = String(serverId || '');
  if (!value.startsWith('retry-episode-')) return '';
  const encodedSlug = value.slice('retry-episode-'.length);
  if (!encodedSlug) return '';

  try {
    return decodeURIComponent(encodedSlug);
  } catch (_) {
    return encodedSlug;
  }
}

function normalizeEmbedUrlForFallback(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';

  if (/^https?:\/\/mega\.nz\/file\//i.test(raw)) {
    return raw.replace('/file/', '/embed/');
  }

  if (/^https?:\/\/(?:www\.)?solidfiles\.com\/v\//i.test(raw)) {
    return raw.replace('/v/', '/e/');
  }

  return raw;
}

function findQualityMatchingDownloadUrl(episodeData, preferredQuality = '') {
  if (!episodeData || !Array.isArray(episodeData.downloadUrl?.qualities)) return null;

  const qualityNeedle = String(preferredQuality || '').trim().toLowerCase();
  if (!qualityNeedle || qualityNeedle === 'default') return null;

  const qualities = episodeData.downloadUrl.qualities;

  const rankProvider = (title = '', url = '') => {
    const t = String(title || '').toLowerCase();
    const u = String(url || '').toLowerCase();
    if (t.includes('acefile') || u.includes('acefile.co')) return 100;
    if (t.includes('gofile') || u.includes('gofile.io')) return 90;
    if (t.includes('vidhide') || u.includes('vidhide')) return 80;
    if (t.includes('mega') || u.includes('mega.nz')) return 30;
    if (t.includes('odfiles') || u.includes('otakufiles.net')) return 10;
    return 1;
  };

  for (const quality of qualities) {
    const title = String(quality?.title || '').toLowerCase();
    if (!title.includes(qualityNeedle) || !Array.isArray(quality?.urls) || quality.urls.length === 0) continue;

    const candidates = quality.urls
      .map((urlObj) => {
        const rawUrl = urlObj?.url || '';
        const embedUrl = normalizeEmbedUrlForFallback(rawUrl);
        return {
          provider: String(urlObj?.title || ''),
          embedUrl,
          score: rankProvider(urlObj?.title || '', rawUrl)
        };
      })
      .filter((item) => item.embedUrl && isEmbeddableFallbackUrl(item.embedUrl))
      .sort((a, b) => b.score - a.score);

    if (candidates.length > 0) {
      console.log(`Found quality-matching download URL for [${preferredQuality}]: ${quality.title} -> ${candidates[0].provider}`);
      return candidates[0].embedUrl;
    }
  }

  return null;
}

function isEmbeddableFallbackUrl(url = '') {
  const lowered = String(url || '').toLowerCase();
  if (!lowered) return false;

  if (lowered.includes('zippyshare.com')) return false;
  if (lowered.includes('/embed/') || lowered.includes('/dstream/') || lowered.includes('/stream/')) return true;
  if (lowered.includes('otakuwatch') || lowered.includes('odstream') || lowered.includes('vidhide')) return true;
  if (lowered.includes('solidfiles.com/e/')) return true;
  if (lowered.includes('mega.nz/embed/')) return true;
  if (lowered.includes('acefile.co/')) return true;
  if (lowered.includes('gofile.io/')) return true;

  return false;
}

function injectQualityToEmbedUrl(embedUrl, quality = '') {
  const url = String(embedUrl || '').trim();
  const qualityValue = String(quality || '').trim().toLowerCase();
  
  if (!url || !qualityValue) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return url;

  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    
    // List of hostnames yang support quality parameter
    const supportsQualityParam = [
      'desustream', 'desustrem', 'odstream', 'otakuwatch', 
      'dstream', 'vidhide', 'filemoon', 'filedown',
      'misskopayashi.me'
    ];
    
    const hostnameSupportsQuality = supportsQualityParam.some(h => hostname.includes(h));
    
    if (hostnameSupportsQuality) {
      // Don't add if quality parameter already exists
      if (!parsed.searchParams.has('quality')) {
        parsed.searchParams.set('quality', qualityValue);
      }
      
      // Some players also check 'q' parameter
      if (!parsed.searchParams.has('q')) {
        parsed.searchParams.set('q', qualityValue);
      }
      
      // Some players check 'res' for resolution
      if (!parsed.searchParams.has('res')) {
        const resMap = { '360p': '360', '480p': '480', '720p': '720', '1080p': '1080' };
        const resValue = resMap[qualityValue] || qualityValue;
        if (resValue) parsed.searchParams.set('res', resValue);
      }
      
      const result = parsed.toString();
      console.log(`Quality injected [${qualityValue}] to ${hostname}`);
      return result;
    }
    
    return url;
  } catch (_) {
    return url;
  }
}

function getBestEmbedUrlFromEpisodeData(episodeData, preferredQuality = '') {
  if (!episodeData || typeof episodeData !== 'object') return '';

  const qualityNeedle = String(preferredQuality || '').toLowerCase();
  const qualityItems = Array.isArray(episodeData.downloadUrl?.qualities) ? episodeData.downloadUrl.qualities : [];

  const exactQualityItems = qualityNeedle
    ? qualityItems.filter((q) => {
        const title = String(q?.title || '').toLowerCase();
        return title === qualityNeedle || title.includes(qualityNeedle);
      })
    : [];

  const fallbackQualityItems = qualityNeedle
    ? qualityItems.filter((q) => {
        const title = String(q?.title || '').toLowerCase();
        return !(title === qualityNeedle || title.includes(qualityNeedle));
      })
    : qualityItems;

  for (const quality of exactQualityItems) {
    for (const u of quality?.urls || []) {
      const normalized = normalizeEmbedUrlForFallback(u?.url || '');
      if (normalized && isEmbeddableFallbackUrl(normalized)) {
        return normalized;
      }
    }
  }

  const normalizedDefault = normalizeEmbedUrlForFallback(episodeData.defaultStreamingUrl || '');

  // For requested quality, try other quality buckets first before falling back to default stream.
  for (const quality of fallbackQualityItems) {
    for (const u of quality?.urls || []) {
      const normalized = normalizeEmbedUrlForFallback(u?.url || '');
      if (normalized && isEmbeddableFallbackUrl(normalized)) {
        return normalized;
      }
    }
  }

  if (normalizedDefault && isEmbeddableFallbackUrl(normalizedDefault)) {
    if (/720p|1080p/i.test(qualityNeedle) && /\/otakuwatch\d+\/(?:hd\/)?v2\//i.test(normalizedDefault)) {
      return normalizedDefault.replace(/\/otakuwatch(\d+)\/(?:hd\/)?v2\//i, '/otakuwatch$1/hd/v2/');
    }
    if (/360p|480p/i.test(qualityNeedle) && /\/otakuwatch\d+\/(?:hd\/)?v2\//i.test(normalizedDefault)) {
      return normalizedDefault.replace(/\/otakuwatch(\d+)\/(?:hd\/)?v2\//i, '/otakuwatch$1/v2/');
    }
    return normalizedDefault;
  }

  return normalizedDefault || '';
}

function withRetryEpisodeServerFallback(episodeData, episodeSlug) {
  const normalized = normalizeEpisodeStreamData(episodeData);
  if (!normalized || typeof normalized !== 'object') return normalized;

  if (hasEpisodeStreamData(normalized)) {
    return normalized;
  }

  const retryServerId = createRetryEpisodeServerId(episodeSlug);
  if (!retryServerId) return normalized;

  return {
    ...normalized,
    server: {
      ...(normalized.server || {}),
      qualities: [
        {
          title: 'Auto',
          quality: 'Auto',
          serverList: [
            {
              title: 'auto-retry',
              serverId: retryServerId,
              href: `/anime/server/${retryServerId}`
            }
          ]
        }
      ]
    }
  };
}

function hasRealEpisodeStreamData(episodeData) {
  if (!episodeData || typeof episodeData !== 'object') return false;
  if (episodeData.defaultStreamingUrl) return true;

  const qualities = episodeData.server?.qualities;
  if (!Array.isArray(qualities)) return false;

  return qualities.some((quality) =>
    Array.isArray(quality?.serverList)
    && quality.serverList.some((server) => {
      const id = String(server?.serverId || '').trim();
      return id && !id.startsWith('retry-episode-');
    })
  );
}

function normalizeEpisodeStreamData(episodeData) {
  if (!episodeData || typeof episodeData !== 'object') return episodeData;

  const normalized = {
    ...episodeData,
    server: {
      ...(episodeData.server || {}),
      qualities: Array.isArray(episodeData.server?.qualities)
        ? episodeData.server.qualities.map((qualityItem) => {
            const title = String(qualityItem?.title || qualityItem?.quality || 'Default').trim();
            const serverList = Array.isArray(qualityItem?.serverList)
              ? qualityItem.serverList.map((server) => ({ ...server }))
              : [];
            return {
              ...qualityItem,
              title,
              quality: qualityItem?.quality || title,
              serverList
            };
          })
        : []
    }
  };

  const existingIds = new Set();
  for (const qualityItem of normalized.server.qualities) {
    for (const server of qualityItem.serverList || []) {
      const id = String(server?.serverId || '').trim();
      if (id) existingIds.add(id);
    }
  }

  for (const qualityItem of normalized.server.qualities) {
    const qualityTitle = String(qualityItem?.quality || qualityItem?.title || '').trim() || 'Default';
    const qualityEmbed = getBestEmbedUrlFromEpisodeData(normalized, qualityTitle);
    if (!qualityEmbed) continue;

    const qualityDirectId = createDirectServerId(qualityEmbed, qualityTitle, 0);
    if (!qualityDirectId || existingIds.has(qualityDirectId)) continue;

    const directServer = {
      title: `direct-${qualityTitle}`,
      serverId: qualityDirectId,
      href: `/anime/server/${qualityDirectId}`
    };

    qualityItem.serverList = [directServer, ...(Array.isArray(qualityItem.serverList) ? qualityItem.serverList : [])];
    existingIds.add(qualityDirectId);
  }

  const defaultUrl = String(normalized.defaultStreamingUrl || '').trim();
  if (defaultUrl) {
    const directServerId = createDirectServerId(defaultUrl, 'Default', 0);
    if (directServerId && !existingIds.has(directServerId)) {
      const fallbackServer = {
        title: 'default-stream',
        serverId: directServerId,
        href: `/anime/server/${directServerId}`
      };

      const defaultQualityIndex = normalized.server.qualities.findIndex(
        (q) => String(q?.title || q?.quality || '').toLowerCase() === 'default'
      );

      if (defaultQualityIndex >= 0) {
        normalized.server.qualities[defaultQualityIndex].serverList.push(fallbackServer);
      } else {
        normalized.server.qualities.unshift({
          title: 'Default',
          quality: 'Default',
          serverList: [fallbackServer]
        });
      }

      existingIds.add(directServerId);
    }
  }

  return normalized;
}

function normalizeEpisodeSnapshotResponse(snapshotResponse) {
  if (!snapshotResponse || typeof snapshotResponse !== 'object') return snapshotResponse;
  if (!snapshotResponse.data || typeof snapshotResponse.data !== 'object') return snapshotResponse;

  return {
    ...snapshotResponse,
    data: normalizeEpisodeStreamData(snapshotResponse.data)
  };
}

function getSnapshotResponse(key) {
  const response = getSnapshot(key);
  return response || null;
}

function findServerFallbackFromSnapshot(serverId, options = {}) {
  const targetServerId = String(serverId || '').trim();
  if (!targetServerId) return null;

  const serverIdMatch = targetServerId.match(/^(\d+)-(\d+)-(.+)$/);
  const requestedServerIndex = Number.parseInt(serverIdMatch?.[2] || '-1', 10);
  const requestedQuality = options?.quality
    ? String(options.quality).toLowerCase()
    : serverIdMatch?.[3]
      ? String(serverIdMatch[3]).toLowerCase()
      : '';
  const requestedHost = options?.host ? String(options.host).toLowerCase() : '';

  const blockedEmbedHosts = ['callistanise.com', 'desudrive.com', 'otakufiles.net', 'krakenfiles.com', 'pixeldrain.com'];
  const isBlockedEmbedHost = (url = '') => {
    const lowered = String(url || '').toLowerCase();
    return blockedEmbedHosts.some((host) => lowered.includes(host));
  };

  const normalizeEmbedUrl = (url = '') => {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (isBlockedEmbedHost(raw)) return '';

    // Convert Mega file link -> Mega embed link
    // Example: https://mega.nz/file/<id>#<key> => https://mega.nz/embed/<id>#<key>
    if (/^https?:\/\/mega\.nz\/file\//i.test(raw)) {
      return raw.replace('/file/', '/embed/');
    }

    // Convert Solidfiles share URL -> embed URL
    // Example: https://www.solidfiles.com/v/<id> => https://www.solidfiles.com/e/<id>
    if (/^https?:\/\/(?:www\.)?solidfiles\.com\/v\//i.test(raw)) {
      return raw.replace('/v/', '/e/');
    }

    return raw;
  };

  const isLikelyEmbeddable = (url = '') => {
    const lowered = String(url || '').toLowerCase();
    return (
      lowered.includes('/embed/') ||
      lowered.includes('/dstream/') ||
      lowered.includes('/stream/') ||
      lowered.includes('otakuwatch') ||
      lowered.includes('odstream') ||
      lowered.includes('vidhide') ||
      lowered.includes('mega.nz/embed/') ||
      lowered.includes('solidfiles.com/e/')
    );
  };

  const deriveQualityFromDefaultStream = (defaultUrl = '', quality = '') => {
    const normalizedDefault = normalizeEmbedUrl(defaultUrl);
    if (!normalizedDefault) return '';

    let result = normalizedDefault;
    const isHdReq = /720p|1080p/i.test(quality);
    const isSdReq = /360p|480p/i.test(quality);

    if (/\/otakuwatch\d+\/(?:hd\/)?v2\//i.test(result)) {
      if (isHdReq) {
        result = result.replace(/\/otakuwatch(\d+)\/(?:hd\/)?v2\//i, '/otakuwatch$1/hd/v2/');
      } else if (isSdReq) {
        result = result.replace(/\/otakuwatch(\d+)\/(?:hd\/)?v2\//i, '/otakuwatch$1/v2/');
      }
    }

    return isLikelyEmbeddable(result) ? result : '';
  };

  const pickQualityDownloadUrl = (episodeData, quality, serverIndex = -1, host = '') => {
    if (!quality) return '';

    const qualityItems = episodeData?.downloadUrl?.qualities;
    if (!Array.isArray(qualityItems)) return '';

    const qualityEntry = qualityItems.find((item) => String(item?.title || '').toLowerCase() === quality);
    if (!qualityEntry || !Array.isArray(qualityEntry.urls)) return '';

    if (Number.isInteger(serverIndex) && serverIndex >= 0 && serverIndex < qualityEntry.urls.length) {
      const byIndex = normalizeEmbedUrl(qualityEntry.urls[serverIndex]?.url || '');
      if (byIndex && isLikelyEmbeddable(byIndex)) return byIndex;
    }

    if (host) {
      const hostHit = qualityEntry.urls.find(
        (u) => String(u?.title || '').toLowerCase().includes(host) && u?.url && !isBlockedEmbedHost(u.url)
      );
      if (hostHit?.url) {
        const normalized = normalizeEmbedUrl(hostHit.url);
        if (normalized && isLikelyEmbeddable(normalized)) return normalized;
      }
    }

    const preferredHosts = ['solidfiles', 'otakuwatch', 'odstream', 'vidhide', 'mega', 'otakufiles', 'kraken', 'pdrain'];
    for (const host of preferredHosts) {
      const hit = qualityEntry.urls.find(
        (u) => String(u?.title || '').toLowerCase().includes(host) && u?.url && !isBlockedEmbedHost(u.url)
      );
      if (hit?.url) {
        const normalized = normalizeEmbedUrl(hit.url);
        if (normalized && isLikelyEmbeddable(normalized)) return normalized;
      }
    }

    const embeddableAny = qualityEntry.urls
      .map((u) => normalizeEmbedUrl(u?.url || ''))
      .find((u) => u && isLikelyEmbeddable(u));

    return embeddableAny || '';
  };

  const entries = Object.entries(snapshotStore.data || {});
  for (const [key, payload] of entries) {
    if (!key.startsWith('episode-')) continue;

    const episodeData = payload?.data;
    const qualities = episodeData?.server?.qualities;
    if (!Array.isArray(qualities)) continue;

    const hasServerId = qualities.some((q) =>
      Array.isArray(q?.serverList) && q.serverList.some((s) => String(s?.serverId || '') === targetServerId)
    );

    if (!hasServerId) continue;

    const qualityBasedUrl = pickQualityDownloadUrl(episodeData, requestedQuality, requestedServerIndex, requestedHost);
    const defaultQualityUrl = deriveQualityFromDefaultStream(episodeData?.defaultStreamingUrl || '', requestedQuality);
    const defaultUrl = normalizeEmbedUrl(episodeData?.defaultStreamingUrl || '');
    const embedUrl = qualityBasedUrl || defaultQualityUrl || defaultUrl || '';
    if (!embedUrl) continue;

    const hasRequestedQuality = Boolean(requestedQuality);
      const source = qualityBasedUrl
        ? 'snapshot-quality-match'
      : defaultQualityUrl
          ? (hasRequestedQuality ? 'snapshot-quality-derived' : 'snapshot-default-quality-fallback')
        : defaultUrl
          ? (hasRequestedQuality ? 'snapshot-quality-derived' : 'snapshot-fallback')
          : 'snapshot-fallback';

    return {
      serverId: targetServerId,
      resolved: true,
      embedUrl,
      iframeHtml: null,
      source,
      snapshotEpisodeId: key.replace(/^episode-/, '')
    };
  }

  return null;
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

function normalizeTitleForCompare(title = '') {
  return String(title || '')
    .toLowerCase()
    .replace(/subtitle\s*indonesia|sub\s*indo/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreSearchMatch(query, candidate = {}) {
  const normalizedQuery = normalizeTitleForCompare(query);
  const normalizedTitle = normalizeTitleForCompare(candidate?.title || '');
  const normalizedSlug = normalizeTitleForCompare(candidate?.animeId || candidate?.slug || '');

  if (!normalizedQuery || (!normalizedTitle && !normalizedSlug)) return 0;
  if (normalizedTitle === normalizedQuery || normalizedSlug === normalizedQuery) return 100;

  let score = 0;
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  for (const token of tokens) {
    if (normalizedTitle.includes(token)) score += 4;
    if (normalizedSlug.includes(token)) score += 3;
  }

  if (normalizedTitle.includes(normalizedQuery)) score += 20;
  if (normalizedSlug.includes(normalizedQuery)) score += 15;

  return score;
}

function pushSearchCandidate(pool, item = {}) {
  const animeId = String(item?.animeId || item?.slug || '').trim();
  const title = String(item?.title || '').trim();
  if (!animeId || !title) return;
  if (pool.has(animeId)) return;

  pool.set(animeId, {
    title,
    poster: item?.poster || item?.image || item?.thumbnail || '',
    status: item?.status || item?.releaseDay || '',
    score: item?.score || '',
    animeId,
    href: item?.href || `/anime/anime/${animeId}`,
    otakudesuUrl: item?.otakudesuUrl || '',
    genreList: Array.isArray(item?.genreList) ? item.genreList : []
  });
}

function getSnapshotSearchResults(query) {
  const pool = new Map();

  const unlimitedSnapshot = getSnapshotResponse('unlimited');
  const unlimitedList = unlimitedSnapshot?.data?.animeList || [];
  for (const item of unlimitedList) {
    pushSearchCandidate(pool, item);
  }

  const animeListSnapshot = getSnapshotResponse('anime-list-grouped');
  const groupedList = animeListSnapshot?.data?.list || [];
  for (const group of groupedList) {
    for (const item of group?.animeList || []) {
      pushSearchCandidate(pool, item);
    }
  }

  for (const [key, payload] of Object.entries(snapshotStore.data || {})) {
    if (!key.startsWith('anime-detail-')) continue;
    const detail = payload?.data?.detail || payload?.data || null;
    if (!detail || typeof detail !== 'object') continue;

    pushSearchCandidate(pool, {
      title: detail.title,
      poster: detail.poster,
      status: detail.status,
      score: detail.score,
      animeId: key.replace(/^anime-detail-/, ''),
      genreList: detail.genreList,
      otakudesuUrl: detail.otakudesuUrl || ''
    });
  }

  return [...pool.values()]
    .map((item) => ({ item, score: scoreSearchMatch(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20)
    .map((entry) => entry.item);
}

function dedupeEpisodeList(episodeList = []) {
  if (!Array.isArray(episodeList)) return [];
  const seen = new Set();
  const result = [];

  for (const item of episodeList) {
    const episodeId = String(item?.episodeId || '').trim();
    const key = episodeId || `${String(item?.title || '').trim()}-${String(item?.href || '').trim()}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function getAnimeDetailFromSnapshotBySlug(slug) {
  const snapshotData = getSnapshotResponse(`anime-detail-${slug}`);
  if (!snapshotData?.data) return null;

  const detail = snapshotData.data.detail || snapshotData.data || null;
  const episodeList = snapshotData.data.episodeList
    || snapshotData.data.detail?.episodeList
    || detail?.episodeList
    || [];

  if (!detail || typeof detail !== 'object') return null;
  return {
    detail,
    episodeList: dedupeEpisodeList(episodeList)
  };
}

function enrichAnimeDetailWithSnapshotEpisodes(detail, candidateSlugs = [], titleHint = '') {
  if (!detail || typeof detail !== 'object') return detail;

  const existingEpisodes = dedupeEpisodeList(detail.episodeList || []);
  if (existingEpisodes.length > 0) {
    return {
      ...detail,
      episodeList: existingEpisodes
    };
  }

  for (const slug of candidateSlugs) {
    const normalizedSlug = String(slug || '').trim();
    if (!normalizedSlug) continue;

    const snap = getAnimeDetailFromSnapshotBySlug(normalizedSlug);
    if (snap?.episodeList?.length) {
      return {
        ...detail,
        episodeList: snap.episodeList
      };
    }
  }

  const normalizedTitle = normalizeTitleForCompare(titleHint || detail.title || '');
  if (!normalizedTitle) return detail;

  const entries = Object.entries(snapshotStore.data || {});
  for (const [key, payload] of entries) {
    if (!key.startsWith('anime-detail-')) continue;

    const snapData = payload?.data;
    const snapDetail = snapData?.detail || snapData;
    const snapEpisodes = dedupeEpisodeList(
      snapData?.episodeList
      || snapData?.detail?.episodeList
      || snapDetail?.episodeList
      || []
    );
    if (!snapEpisodes.length) continue;

    const snapTitle = normalizeTitleForCompare(snapDetail?.title || '');
    if (!snapTitle) continue;
    if (snapTitle !== normalizedTitle) continue;

    return {
      ...detail,
      episodeList: snapEpisodes
    };
  }

  return detail;
}

async function resolveAnimeDetailWithAlias(slug) {
  const originalSlug = String(slug || '').trim();
  if (!originalSlug) {
    return { detail: null, resolvedSlug: '', aliasUsed: false };
  }

  const primaryDetailRaw = await getAnimeDetail(originalSlug);
  const primaryDetail = enrichAnimeDetailWithSnapshotEpisodes(primaryDetailRaw, [originalSlug], primaryDetailRaw?.title || '');
  const primaryOk = primaryDetail && (
    primaryDetail.title ||
    (Array.isArray(primaryDetail.episodeList) && primaryDetail.episodeList.length > 0)
  );

  if (primaryOk) {
    return { detail: primaryDetail, resolvedSlug: originalSlug, aliasUsed: false };
  }

  const primarySnapshot = getSnapshotResponse(`anime-detail-${originalSlug}`);
  if (primarySnapshot?.data?.detail) {
    const primarySnapshotDetail = enrichAnimeDetailWithSnapshotEpisodes(
      primarySnapshot.data.detail,
      [originalSlug],
      primarySnapshot.data.detail?.title || ''
    );
    return { detail: primarySnapshotDetail, resolvedSlug: originalSlug, aliasUsed: false };
  }

  const query = originalSlug
    .replace(/-subtitle-indonesia|-sub-indo/gi, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!query) {
    return { detail: primaryDetail || null, resolvedSlug: originalSlug, aliasUsed: false };
  }

  let candidates = [];
  try {
    candidates = await searchAnime(query);
  } catch (_) {
    return { detail: primaryDetail || null, resolvedSlug: originalSlug, aliasUsed: false };
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { detail: primaryDetail || null, resolvedSlug: originalSlug, aliasUsed: false };
  }

  const slugTokens = new Set(query.toLowerCase().split(' ').filter(Boolean));
  const scoreCandidate = (candidate) => {
    const id = String(candidate?.animeId || '').toLowerCase();
    const title = String(candidate?.title || '').toLowerCase();
    let score = 0;
    for (const token of slugTokens) {
      if (id.includes(token)) score += 2;
      if (title.includes(token)) score += 1;
    }
    return score;
  };

  const ranked = [...candidates]
    .map((c) => ({ c, score: scoreCandidate(c) }))
    .sort((a, b) => b.score - a.score);

  for (const { c } of ranked.slice(0, 5)) {
    const candidateSlug = String(c?.animeId || '').trim();
    if (!candidateSlug) continue;

    const candidateSnapshot = getSnapshotResponse(`anime-detail-${candidateSlug}`);
    if (candidateSnapshot?.data?.detail) {
      const candidateSnapshotDetail = enrichAnimeDetailWithSnapshotEpisodes(
        candidateSnapshot.data.detail,
        [candidateSlug, originalSlug],
        candidateSnapshot.data.detail?.title || c?.title || ''
      );
      return { detail: candidateSnapshotDetail, resolvedSlug: candidateSlug, aliasUsed: candidateSlug !== originalSlug };
    }

    const detailRaw = await getAnimeDetail(candidateSlug);
    const detail = enrichAnimeDetailWithSnapshotEpisodes(detailRaw, [candidateSlug, originalSlug], c?.title || detailRaw?.title || '');
    const ok = detail && (
      detail.title ||
      (Array.isArray(detail.episodeList) && detail.episodeList.length > 0)
    );
    if (ok) {
      return { detail, resolvedSlug: candidateSlug, aliasUsed: candidateSlug !== originalSlug };
    }
  }

  const fallbackDetail = enrichAnimeDetailWithSnapshotEpisodes(primaryDetail || null, [originalSlug], primaryDetail?.title || '');
  return { detail: fallbackDetail || null, resolvedSlug: originalSlug, aliasUsed: false };
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
  animeList: { data: null, time: 0 },
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
const snapshotAnimeList = getSnapshotResponse('anime-list-grouped');
if (snapshotAnimeList) {
  cache.animeList = { data: snapshotAnimeList, time: Date.now() };
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

    if (FORCE_SNAPSHOT_MODE && page === 1) {
      const snapshotData = getSnapshotResponse(cacheKey);
      if (snapshotData) return res.json(snapshotData);
    }
    
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

    if (page === 1 && !hasItems(result.animeList)) {
      const snapshotData = getSnapshotResponse(cacheKey);
      if (snapshotData) return res.json(snapshotData);
    }
    
    if (!cache.genre[cacheKey]) cache.genre[cacheKey] = {};
    cache.genre[cacheKey] = { data: response, time: Date.now() };
    if (page === 1 && hasItems(result.animeList)) {
      saveSnapshot(cacheKey, response);
    }
    res.json(response);
  } catch (error) {
    console.error('Genre detail error:', error.message);
    const page = parseInt(req.query.page) || 1;
    const slug = req.params.slug;
    if (page === 1) {
      const snapshotData = getSnapshotResponse(`genre-${slug}-page1`);
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

    let results = await searchAnime(keyword);
    if (!hasItems(results)) {
      results = getSnapshotSearchResults(keyword);
    }

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
    const keyword = req.params.keyword;
    const fallbackResults = getSnapshotSearchResults(keyword);
    if (hasItems(fallbackResults)) {
      return res.json({
        status: 'success',
        creator: 'Lloyd.ID1112',
        statusCode: 200,
        statusMessage: 'OK',
        message: 'Served from bundled snapshot fallback',
        ok: true,
        data: {
          animeList: fallbackResults
        },
        pagination: null
      });
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

// Anime list A-Z
app.get('/anime/anime', async (req, res) => {
  try {
    const querySlug = String(req.query.slug || req.query.animeId || req.query.id || '').trim();

    // Compatibility mode: /anime/anime?slug=<anime-slug>
    if (querySlug) {
      const snapshotKey = `anime-detail-${querySlug}`;

      if (FORCE_SNAPSHOT_MODE) {
        const snapshotData = getSnapshotResponse(snapshotKey);
        if (snapshotData) {
          const snapshotDetail = snapshotData.data?.detail || snapshotData.data || null;
          const mergedDetail = enrichAnimeDetailWithSnapshotEpisodes(snapshotDetail, [querySlug], snapshotDetail?.title || '');
          return res.json({
            ...snapshotData,
            data: {
              detail: mergedDetail,
              episodeList: Array.isArray(mergedDetail?.episodeList) ? mergedDetail.episodeList : []
            }
          });
        }
      }

      const { detail, resolvedSlug, aliasUsed } = await resolveAnimeDetailWithAlias(querySlug);
      const hasDetail = detail && (detail.title || (Array.isArray(detail.episodeList) && detail.episodeList.length > 0));

      if (!hasDetail) {
        const snapshotData = getSnapshotResponse(snapshotKey);
        if (snapshotData) {
          const snapshotDetail = snapshotData.data?.detail || snapshotData.data || null;
          const mergedDetail = enrichAnimeDetailWithSnapshotEpisodes(snapshotDetail, [querySlug], snapshotDetail?.title || '');
          return res.json({
            ...snapshotData,
            data: {
              detail: mergedDetail,
              episodeList: Array.isArray(mergedDetail?.episodeList) ? mergedDetail.episodeList : []
            }
          });
        }

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

      const response = {
        status: 'success',
        creator: 'Lloyd.ID1112',
        statusCode: 200,
        statusMessage: 'OK',
        message: aliasUsed ? `Slug normalized to ${resolvedSlug}` : '',
        ok: true,
        data: {
          detail,
          episodeList: Array.isArray(detail.episodeList) ? detail.episodeList : []
        },
        pagination: null
      };

      saveSnapshot(snapshotKey, response);
      return res.json(response);
    }

    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse('anime-list-grouped');
      if (snapshotData) return res.json(snapshotData);
    }

    if (isValidCache('animeList')) {
      return res.json(cache.animeList.data);
    }

    const list = await getAnimeListGrouped();
    const response = {
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
    };

    if (!hasItems(list)) {
      const snapshotData = getSnapshotResponse('anime-list-grouped');
      if (snapshotData) return res.json(snapshotData);
    }

    cache.animeList = { data: response, time: Date.now() };
    if (hasItems(list)) {
      saveSnapshot('anime-list-grouped', response);
    }

    res.json(response);
  } catch (error) {
    console.error('Anime list error:', error.message);
    const snapshotData = getSnapshotResponse('anime-list-grouped');
    if (snapshotData) return res.json(snapshotData);
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
    const slug = req.params.slug;
    const snapshotKey = `anime-detail-${slug}`;

    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse(snapshotKey);
      if (snapshotData) {
        const snapshotDetail = snapshotData.data?.detail || snapshotData.data || null;
        const mergedDetail = enrichAnimeDetailWithSnapshotEpisodes(snapshotDetail, [slug], snapshotDetail?.title || '');
        return res.json({
          ...snapshotData,
          data: mergedDetail
        });
      }
    }

    const { detail, resolvedSlug, aliasUsed } = await resolveAnimeDetailWithAlias(slug);
    const hasDetail = detail && (detail.title || (Array.isArray(detail.episodeList) && detail.episodeList.length > 0));

    if (!hasDetail) {
      const snapshotData = getSnapshotResponse(snapshotKey);
      if (snapshotData) {
        const snapshotDetail = snapshotData.data?.detail || snapshotData.data || null;
        const mergedDetail = enrichAnimeDetailWithSnapshotEpisodes(snapshotDetail, [slug], snapshotDetail?.title || '');
        return res.json({
          ...snapshotData,
          data: mergedDetail
        });
      }

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

    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: aliasUsed ? `Slug normalized to ${resolvedSlug}` : '',
      ok: true,
      data: {
        ...detail,
        detail: detail,
        episodeList: Array.isArray(detail.episodeList) ? detail.episodeList : []
      },
      pagination: null
    };

    saveSnapshot(snapshotKey, {
      ...response,
      data: {
        detail,
        episodeList: Array.isArray(detail.episodeList) ? detail.episodeList : []
      }
    });

    res.json(response);
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
    const slug = req.params.slug;
    const snapshotKey = `episode-${slug}`;

    if (FORCE_SNAPSHOT_MODE) {
      const snapshotData = getSnapshotResponse(snapshotKey);
      if (snapshotData) return res.json(normalizeEpisodeSnapshotResponse(snapshotData));
    }

    const episodeDataRaw = await getEpisodeDetail(slug);
    const episodeData = normalizeEpisodeStreamData(episodeDataRaw);

    if (!hasEpisodeStreamData(episodeData)) {
      const snapshotData = getSnapshotResponse(snapshotKey);
      if (snapshotData) return res.json(normalizeEpisodeSnapshotResponse(snapshotData));
    }

    const responseData = withRetryEpisodeServerFallback(episodeData, slug);

    const response = {
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: responseData,
      pagination: null
    };

    if (hasRealEpisodeStreamData(episodeData)) {
      saveSnapshot(snapshotKey, response);
    }

    res.json({
      ...response
    });
  } catch (error) {
    console.error('Episode error:', error.message);
    const slug = req.params.slug;
    const snapshotData = getSnapshotResponse(`episode-${slug}`);
    if (snapshotData) return res.json(normalizeEpisodeSnapshotResponse(snapshotData));
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

function parseServerRequestMeta(serverId) {
  const value = String(serverId || '').trim();
  const classic = value.match(/^(\d+)-(\d+)-(.+)$/);
  const direct = decodeDirectServerId(value);
  const retryEpisodeSlug = decodeRetryEpisodeServerId(value);

  return {
    serverId: value,
    type: retryEpisodeSlug ? 'retry-episode' : direct ? 'direct' : classic ? 'classic' : 'unknown',
    quality: direct?.quality || (classic?.[3] ? String(classic[3]) : retryEpisodeSlug ? 'Auto' : ''),
    providerIndex: classic?.[2] ? Number.parseInt(classic[2], 10) : null,
    retryEpisodeSlug: retryEpisodeSlug || null
  };
}

async function resolveServerStream(serverId, options = {}) {
  const retryEpisodeSlug = decodeRetryEpisodeServerId(serverId);
  if (retryEpisodeSlug) {
    const snapshotEpisode = normalizeEpisodeSnapshotResponse(getSnapshotResponse(`episode-${retryEpisodeSlug}`));
    const snapshotData = snapshotEpisode?.data;

    const pickRealServerId = (episodeData) => {
      const qualities = episodeData?.server?.qualities;
      if (!Array.isArray(qualities)) return '';

      for (const quality of qualities) {
        for (const server of quality?.serverList || []) {
          const id = String(server?.serverId || '').trim();
          if (!id || id.startsWith('retry-episode-') || id.startsWith('direct-')) continue;
          return id;
        }
      }

      return '';
    };

    const resolveFromEpisodeData = async (episodeData) => {
      if (!episodeData) return null;

      const directEmbed = getBestEmbedUrlFromEpisodeData(episodeData);
      if (directEmbed) {
        return {
          serverId,
          resolved: true,
          embedUrl: directEmbed,
          iframeHtml: `<iframe src="${directEmbed}" allowfullscreen="true"></iframe>`,
          source: 'retry-episode-direct'
        };
      }

      const realServerId = pickRealServerId(episodeData);
      if (realServerId) {
        const resolved = await getStreamUrl(realServerId, options);
        if (resolved?.resolved && resolved?.embedUrl) {
          return {
            ...resolved,
            serverId,
            source: 'retry-episode-resolved'
          };
        }
      }

      return null;
    };

    const resolvedFromSnapshot = await resolveFromEpisodeData(snapshotData);
    if (resolvedFromSnapshot) return resolvedFromSnapshot;

    const liveEpisode = withRetryEpisodeServerFallback(await getEpisodeDetail(retryEpisodeSlug), retryEpisodeSlug);
    const resolvedFromLive = await resolveFromEpisodeData(liveEpisode);
    if (resolvedFromLive) return resolvedFromLive;

    return {
      serverId,
      resolved: false,
      embedUrl: '',
      iframeHtml: null,
      source: 'retry-episode-failed'
    };
  }

  const directServer = decodeDirectServerId(serverId);
  if (directServer?.url) {
    const directQuality = String(directServer.quality || '').toLowerCase();
    const isDefaultDirect = !directQuality || directQuality === 'default';
    return {
      serverId,
      resolved: true,
      embedUrl: directServer.url,
      iframeHtml: `<iframe src="${directServer.url}" allowfullscreen="true"></iframe>`,
      source: isDefaultDirect ? 'direct-default-fallback' : 'direct-quality-match'
    };
  }

  let streamUrl = await getStreamUrl(serverId, options);
  if (!streamUrl?.resolved) {
    const snapshotFallback = findServerFallbackFromSnapshot(serverId);
    if (snapshotFallback) {
      streamUrl = snapshotFallback;
    }
  }

  return streamUrl || {
    serverId,
    resolved: false,
    embedUrl: '',
    iframeHtml: null,
    source: 'unresolved'
  };
}

async function resolveDownloadFallback({ serverId, quality = '', host = '', episodeSlug = '' }) {
  const normalizedQuality = String(quality || '').trim();
  const normalizedHost = String(host || '').trim();
  const normalizedEpisode = String(episodeSlug || '').trim();

  if (normalizedEpisode) {
    try {
      const episodeData = await getEpisodeDetail(normalizedEpisode);
      const fallback = findServerFallbackFromSnapshot(serverId, {
        quality: normalizedQuality,
        host: normalizedHost
      });

      const directEmbed = getBestEmbedUrlFromEpisodeData(episodeData, normalizedQuality);
      if (directEmbed) {
        return {
          serverId,
          resolved: true,
          embedUrl: directEmbed,
          iframeHtml: null,
          source: 'episode-download-match'
        };
      }

      if (fallback?.embedUrl) return fallback;
    } catch (_) {
      // ignore live episode fallback errors
    }
  }

  const snapshotFallback = findServerFallbackFromSnapshot(serverId, {
    quality: normalizedQuality,
    host: normalizedHost
  });

  return snapshotFallback || null;
}

// Server - Stream URL resolver
app.get('/anime/server/:serverId', async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const requestMeta = parseServerRequestMeta(serverId);
    const preferDownload = String(req.query.preferDownload || '').toLowerCase() === '1';
    const quality = String(req.query.quality || requestMeta.quality || '').trim();
    const host = String(req.query.host || '').trim();
    const episodeSlug = String(req.query.episode || '').trim();
    const streamUrl = await resolveServerStream(serverId, { episodeSlug });

    const streamSource = String(streamUrl?.source || '');

    // Force fallback for classic servers when quality match is uncertain,
    // especially when current stream comes from snapshot-derived source.
    const shouldForceQualityFallback =
      requestMeta.type === 'classic'
      && Boolean(quality)
      && (
        !streamSource.includes('quality-match')
        && !streamSource.includes('quality-derived')
      || streamSource.includes('snapshot-')
      );

    const shouldAttemptFallback =
      preferDownload ||
      shouldForceQualityFallback ||
      !Boolean(streamUrl?.resolved);

    let finalStream = streamUrl;
    if (shouldAttemptFallback) {
      const fallback = await resolveDownloadFallback({
        serverId,
        quality,
        host,
        episodeSlug
      });

      if (fallback?.embedUrl) {
        finalStream = {
          ...streamUrl,
          ...fallback,
          source: fallback.source || 'download-fallback'
        };
      }
    }

    let resolvedUrl = finalStream?.embedUrl || finalStream?.url || '';
    
    // Inject quality parameter to embed URL if quality is specified
    if (quality && resolvedUrl) {
      const urlWithQuality = injectQualityToEmbedUrl(resolvedUrl, quality);
      if (urlWithQuality !== resolvedUrl) {
        console.log(`Quality injection: ${quality} parameter added to embed URL`);
        resolvedUrl = urlWithQuality;
        finalStream = {
          ...finalStream,
          embedUrl: urlWithQuality,
          url: urlWithQuality,
          source: finalStream.source ? `${finalStream.source}+quality-param` : 'quality-param-injected'
        };
      }
    }

    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        ...finalStream,
        url: resolvedUrl
      },
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

// Server debug - cek kualitas terpilih dan URL resolve akhir
app.get('/anime/server-debug/:serverId', async (req, res) => {
  try {
    const serverId = req.params.serverId;
    const meta = parseServerRequestMeta(serverId);
    const streamUrl = await resolveServerStream(serverId);

    let embedHost = '';
    try {
      embedHost = streamUrl?.embedUrl ? new URL(streamUrl.embedUrl).host : '';
    } catch (_) {
      embedHost = '';
    }

    res.json({
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        request: meta,
        resolved: {
          resolved: Boolean(streamUrl?.resolved),
          source: streamUrl?.source || '',
          embedUrl: streamUrl?.embedUrl || '',
          embedHost,
          iframeHtml: streamUrl?.iframeHtml || null
        },
        note: 'Player menu quality di host iframe bisa berbeda dari quality request API.'
      },
      pagination: null
    });
  } catch (error) {
    console.error('Server debug error:', error.message);
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

    if (!hasItems(allAnime)) {
      const snapshotData = getSnapshotResponse('unlimited');
      if (snapshotData) return res.json(snapshotData);
    }
    
    cache.unlimited = { data: response, time: Date.now() };
    if (hasItems(allAnime)) {
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
