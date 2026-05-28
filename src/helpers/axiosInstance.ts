import axios from "axios";
import otakudesuConfig from "@configs/otakudesu.config.js";

const axiosInstance = axios.create({
  baseURL: otakudesuConfig.baseUrl,
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: "https://otakudesu.blog/",
    "Upgrade-Insecure-Requests": "1",
  },
});

export default axiosInstance;