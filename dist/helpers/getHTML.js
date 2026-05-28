import errorinCuy from "./errorinCuy.js";
import axiosInstance from "./axiosInstance.js";
import sanitizeHtml from "sanitize-html";
export const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0";
export default async function getHTML(baseUrl, pathname, ref, sanitize = false) {
    const headers = {};
    if (ref) {
        headers.Referer = ref.startsWith("http") ? ref : new URL(ref, baseUrl).toString();
    }
    // Axios follows redirects and keeps the browser-like headers needed by the upstream site.
    const response = await axiosInstance.get(pathname, {
        headers,
        responseType: "text",
        validateStatus: () => true,
    });
    if (response.status >= 400) {
        errorinCuy(response.status);
    }
    const html = response.data;
    if (!html.trim())
        errorinCuy(404);
    if (sanitize) {
        return sanitizeHtml(html, {
            allowedTags: [
                "address",
                "article",
                "aside",
                "footer",
                "header",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "main",
                "nav",
                "section",
                "blockquote",
                "div",
                "dl",
                "figcaption",
                "figure",
                "hr",
                "li",
                "main",
                "ol",
                "p",
                "pre",
                "ul",
                "a",
                "abbr",
                "b",
                "br",
                "code",
                "data",
                "em",
                "i",
                "mark",
                "span",
                "strong",
                "sub",
                "sup",
                "time",
                "u",
                "img",
            ],
            allowedAttributes: {
                a: ["href", "name", "target"],
                img: ["src"],
                "*": ["class", "id"],
            },
        });
    }
    return html;
}
