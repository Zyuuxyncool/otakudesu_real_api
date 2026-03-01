const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// Disable SSL for testing
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const BASE_URL = 'https://otakudesu.best';

async function scrapeHomeData() {
  try {
    console.log('🔄 Scraping data from otakudesu.best...');
    
    // Scrape ongoing anime
    const ongoingHTML = await axios.get(`${BASE_URL}/ongoing-anime/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });
    
    const $ongoing = cheerio.load(ongoingHTML.data);
    const ongoingAnime = [];
    
    $ongoing('div.venz ul li').each((idx, elem) => {
      try {
        const $item = $ongoing(elem);
        const linkEl = $item.find('a').first();
        const href = linkEl.attr('href') || '';
        const title = $item.find('h2.jdlflm').text().trim();
        const poster = $item.find('img.wp-post-image').attr('src') || '';
        const animeId = href.split('/anime/')[1]?.replace(/\/$/, '') || '';
        
        const fullText = $item.text();
        const epMatch = fullText.match(/Episode\s+(\d+)/i);
        const episodes = epMatch ? parseInt(epMatch[1]) : 0;
        
        const epztipeText = $item.find('div.epztipe').text().trim();
        let releaseDay = '';
        const days = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
        for (const day of days) {
          if (epztipeText.includes(day)) {
            releaseDay = day;
            break;
          }
        }
        
        const dateText = $item.find('div.newnime').text().trim();
        const latestReleaseDate = dateText || '';
        
        if (title && animeId && poster) {
          ongoingAnime.push({
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
      } catch (e) {
        // Skip
      }
    });
    
    // Scrape completed anime
    const completedHTML = await axios.get(`${BASE_URL}/complete-anime/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 20000
    });
    
    const $completed = cheerio.load(completedHTML.data);
    const completedAnime = [];
    
    $completed('div.venz ul li').each((idx, elem) => {
      try {
        const $item = $completed(elem);
        const linkEl = $item.find('a').first();
        const href = linkEl.attr('href') || '';
        const title = $item.find('h2.jdlflm').text().trim();
        const poster = $item.find('img.wp-post-image').attr('src') || '';
        const animeId = href.split('/anime/')[1]?.replace(/\/$/, '') || '';
        
        const fullText = $item.text();
        const epMatch = fullText.match(/Episode\s+(\d+)/i);
        const episodes = epMatch ? parseInt(epMatch[1]) : 0;
        
        const scoreMatch = fullText.match(/([\d.]+)\s*(?:\/|★|⭐)/);
        const score = scoreMatch ? scoreMatch[1] : '';
        
        const dateText = $item.find('div.newnime').text().trim();
        const lastReleaseDate = dateText || '';
        
        if (title && animeId && poster) {
          completedAnime.push({
            title,
            poster,
            episodes,
            score,
            lastReleaseDate,
            animeId,
            href: `/anime/anime/${animeId}`,
            otakudesuUrl: href
          });
        }
      } catch (e) {
        // Skip
      }
    });
    
    console.log(`✅ Berhasil scrape ${ongoingAnime.length} ongoing & ${completedAnime.length} completed anime`);
    
    return {
      status: 'success',
      creator: 'Lloyd.ID1112',
      statusCode: 200,
      statusMessage: 'OK',
      message: '',
      ok: true,
      data: {
        ongoing: {
          href: '/anime/ongoing-anime',
          otakudesuUrl: `${BASE_URL}/ongoing-anime/`,
          animeList: ongoingAnime.slice(0, 16)
        },
        completed: {
          href: '/anime/complete-anime',
          otakudesuUrl: `${BASE_URL}/complete-anime/`,
          animeList: completedAnime.slice(0, 10)
        }
      },
      pagination: null
    };
    
  } catch (error) {
    console.error('❌ SCRAPING GAGAL:', error.message);
    console.error('⚠️ TIDAK ADA FALLBACK - Data harus dari web!');
    throw new Error(`Failed to scrape otakudesu.best: ${error.message}`);
  }
}

module.exports = { scrapeHomeData };
