# 🎌 Otakudesu API

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/Zyuuxyncool/otakudesu_real_api)
[![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-green.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

Fast and stable REST API untuk scraping data anime dari [Otakudesu](https://otakudesu.best) menggunakan Node.js, Express, Axios, dan Cheerio.

## ✨ Features

- ⚡ **Cepat & Stabil** - Menggunakan Axios + Cheerio (tanpa Playwright untuk performa optimal)
- 🛡️ **Error Handling** - Fallback ke mock data jika scraping gagal
- 🔄 **Auto Retry** - Request retry dengan timeout handling
- 📦 **No Database** - Real-time scraping dari source
- 🚀 **Easy Deploy** - Deploy ke Vercel, Railway, Heroku, atau VPS
- 📖 **Complete API** - Semua endpoint yang dibutuhkan

## 📦 Installation

```bash
# Clone repository
git clone git@github.com:Zyuuxyncool/otakudesu_real_api.git
cd api-otakudesu

# Install dependencies
npm install

# Jalankan server
npm start
```

Server akan berjalan di `http://localhost:3000`

## 📚 API Endpoints

### Base URL: `http://localhost:3000`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/home` | GET | Anime terbaru yang diupdate |
| `/api/ongoing?page=1` | GET | Anime ongoing (tayang) |
| `/api/complete?page=1` | GET | Anime completed (tamat) |
| `/api/search?q={query}` | GET | Cari anime |
| `/api/anime/{slug}` | GET | Detail anime + episodes |
| `/api/episode/{slug}` | GET | Link download episode |
| `/api/batch?page=1` | GET | Batch downloads |
| `/api/genres` | GET | Daftar semua genre |
| `/api/schedule` | GET | Jadwal tayang |
| `/api/trending` | GET | Anime trending |

### Example Response

**GET /api/home**
```json
{
  "success": true,
  "total": 12,
  "data": [
    {
      "title": "Solo Leveling Season 2",
      "link": "https://otakudesu.best/anime/solo-leveling-s2-sub-indo/",
      "image": "https://otakudesu.best/wp-content/...",
      "slug": "solo-leveling-s2-sub-indo",
      "episode": "Episode 12"
    }
  ]
}
```

**GET /api/search?q=naruto**
```json
{
  "success": true,
  "query": "naruto",
  "total": 5,
  "results": [...]
}
```

**GET /api/anime/solo-leveling-s2-sub-indo**
```json
{
  "success": true,
  "data": {
    "title": "Solo Leveling Season 2",
    "image": "...",
    "synopsis": "...",
    "info": {...},
    "episodes": [...],
    "totalEpisodes": 12
  }
}
```

## 🚀 Deployment

### Vercel
```bash
npm i -g vercel
vercel
```

### Railway
1. Push ke GitHub
2. Connect di [Railway.app](https://railway.app)
3. Deploy otomatis

### VPS dengan PM2
```bash
npm install -g pm2
pm2 start index.js --name otakudesu-api
pm2 save
pm2 startup
```

## 🛠️ Tech Stack

- Node.js + Express
- Axios + Cheerio
- CORS enabled

## 📝 Notes

- Real-time scraping, response time tergantung website target
- Fallback ke mock data jika scraping gagal
- Untuk production: tambahkan rate limiting & caching

## ⭐ Support

Give a ⭐️ if this project helped you!

## 📄 License

MIT

---

**Disclaimer:** Hanya untuk edukasi. Data dari [Otakudesu](https://otakudesu.best). Use responsibly.
