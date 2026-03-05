const axios = require('axios');
const cheerio = require('cheerio');

(async () => {
  const url = 'https://otakudesu.blog/episode/yzpokb-episode-1-sub-indo/';
  const { data: html } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });

  const $ = cheerio.load(html);
  const rows = [];

  $('div.mirrorstream ul li').each((_, li) => {
    const name = $(li).text().trim();
    const encoded = ($(li).find('a').attr('data-content') || '').trim();
    if (!encoded) return;

    let decoded = '';
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf8');
    } catch (_) {
      decoded = '[decode-failed]';
    }

    rows.push({ name, decoded });
  });

  console.log('total payloads:', rows.length);
  console.log(JSON.stringify(rows.slice(0, 20), null, 2));
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
