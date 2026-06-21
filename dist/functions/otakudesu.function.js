// Appwrite HTTP function handler for otakudesu routes.
// Use this function as the Appwrite function entrypoint and call it with URLs such as:
//   /otakudesu/home
//   /otakudesu/anime
//   /otakudesu/search?q=naruto
import otakudesuController from "../controllers/otakudesu.controller.js";
const routes = [
    { method: "GET", path: "/", handler: "getRoot" },
    { method: "GET", path: "/home", handler: "getHome" },
    { method: "GET", path: "/schedule", handler: "getSchedule" },
    { method: "GET", path: "/anime", handler: "getAllAnimes" },
    { method: "GET", path: "/genre", handler: "getAllGenres" },
    { method: "GET", path: "/ongoing", handler: "getOngoingAnimes" },
    { method: "GET", path: "/completed", handler: "getCompletedAnimes" },
    { method: "GET", path: "/search", handler: "getSearchedAnimes" },
    { method: "GET", path: "/genre/:genreId", handler: "getAnimesByGenre" },
    { method: "GET", path: "/batch/:batchId", handler: "getBatchDetails" },
    { method: "GET", path: "/anime/:animeId", handler: "getAnimeDetails" },
    { method: "GET", path: "/episode/:episodeId", handler: "getEpisodeDetails" },
    { method: "GET", path: "/server/:serverId", handler: "getServerDetails" },
    { method: "POST", path: "/server/:serverId", handler: "getServerDetails" },
];
function parseUrl(req) {
    const base = req.headers?.host ? `http://${req.headers.host}` : "http://localhost";
    return new URL(req.url, base);
}
function parseQueryParams(url) {
    return Object.fromEntries(url.searchParams.entries());
}
function createNativeResponse(res) {
    const appwriteRes = res;
    appwriteRes.statusCode = 200;
    appwriteRes.statusMessage = "OK";
    appwriteRes.status = function (code) {
        this.statusCode = code;
        return this;
    };
    appwriteRes.json = function (payload) {
        if (!this.headersSent) {
            this.setHeader("Content-Type", "application/json; charset=utf-8");
            this.writeHead(this.statusCode);
        }
        this.end(JSON.stringify(payload));
    };
    return appwriteRes;
}
function createInMemoryResponse() {
    const response = {
        statusCode: 200,
        statusMessage: "OK",
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
        },
    };
    return response;
}
function createResponse(res) {
    if (!res) {
        return createInMemoryResponse();
    }
    return createNativeResponse(res);
}
function matchRoute(pathname, method) {
    const normalizedPath = pathname.replace(/\/+$/, "") || "/";
    for (const route of routes) {
        if (route.method !== method) {
            continue;
        }
        if (route.path === normalizedPath) {
            return { route, params: {} };
        }
        const routeParts = route.path.split("/").filter((segment) => Boolean(segment));
        const requestParts = normalizedPath.split("/").filter((segment) => Boolean(segment));
        if (routeParts.length !== requestParts.length) {
            continue;
        }
        const params = {};
        let matched = true;
        for (let index = 0; index < routeParts.length; index += 1) {
            const routeSegment = routeParts[index];
            const requestSegment = requestParts[index];
            if (routeSegment.startsWith(":")) {
                params[routeSegment.slice(1)] = decodeURIComponent(requestSegment);
                continue;
            }
            if (routeSegment !== requestSegment) {
                matched = false;
                break;
            }
        }
        if (matched) {
            return { route, params };
        }
    }
    return null;
}
function createRequest(req, params) {
    return {
        method: req.method,
        url: req.url,
        headers: req.headers || {},
        query: parseQueryParams(parseUrl(req)),
        params,
        body: req.body,
    };
}
function normalizePathname(pathname) {
    const prefix = "/otakudesu";
    const index = pathname.indexOf(prefix);
    if (index !== -1) {
        const trimmed = pathname.slice(index + prefix.length);
        return trimmed === "" ? "/" : trimmed;
    }
    return pathname.replace(/\/+$|^\s+|\s+$/g, "") || "/";
}
export default async function (req, res) {
    const url = parseUrl(req);
    const pathname = normalizePathname(url.pathname);
    const method = req.method?.toUpperCase() || "GET";
    const match = matchRoute(pathname, method);
    const appwriteRes = createResponse(res);
    if (!match) {
        appwriteRes.status(404).json({
            statusCode: 404,
            statusMessage: "Not Found",
            message: "Route not found",
            data: {
                requestedUrl: req.url,
                pathname: url.pathname,
                normalizedPathname: pathname,
            },
            pagination: null,
        });
        if (!res) {
            return appwriteRes.payload;
        }
        return;
    }
    const requestObject = createRequest(req, match.params);
    const responseProxy = {
        statusCode: 200,
        statusMessage: "OK",
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            appwriteRes.statusCode = this.statusCode;
            appwriteRes.json(payload);
        },
    };
    const next = (error) => {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const statusCode = error instanceof Error && error.statusCode ? error.statusCode : 500;
        appwriteRes.status(statusCode).json({
            statusCode,
            statusMessage: "Error",
            message,
            data: null,
            pagination: null,
        });
    };
    try {
        const handler = otakudesuController[match.route.handler];
        await handler(requestObject, responseProxy, next);
    }
    catch (error) {
        next(error);
    }
    if (!res) {
        return appwriteRes.payload;
    }
}
