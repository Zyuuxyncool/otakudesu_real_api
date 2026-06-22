import otakudesuConfig from "@configs/otakudesu.config.js";
import axiosInstance from "@helpers/axiosInstance.js";
import getHTML from "@helpers/getHTML.js";
import { parse, type HTMLElement } from "node-html-parser";

const { baseUrl } = otakudesuConfig;

const otakudesuScraper = {
  async scrapeDOM(pathname: string, ref?: string, sanitize: boolean = false): Promise<HTMLElement> {
    const html = await getHTML(baseUrl, pathname, ref, sanitize);
    const document = parse(html, {
      parseNoneClosedTags: true,
    });

    return document;
  },

  async scrapeNonce(body: string, referer: string): Promise<{ data?: string }> {
    const nonceResponse = await axiosInstance.post<{ data?: string }>(
      "/wp-admin/admin-ajax.php",
      body,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: referer,
          Origin: baseUrl,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
        responseType: "json",
        validateStatus: () => true,
      }
    );

    return nonceResponse.data;
  },

  async scrapeServer(body: string, referer: string): Promise<{ data?: string }> {
    const serverResponse = await axiosInstance.post<{ data?: string }>(
      "/wp-admin/admin-ajax.php",
      body,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: baseUrl,
          Referer: referer,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
        },
        responseType: "json",
        validateStatus: () => true,
      }
    );

    return serverResponse.data;
  },
};

export default otakudesuScraper;
