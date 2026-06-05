import { serveDir } from "@std/http/file-server";
import { createRequestHandler, type ServerBuild } from "react-router";

const buildServerUrl = new URL("./build/server/index.js", import.meta.url).href;
const buildClientDir = new URL("./build/client/", import.meta.url).pathname;

const handler = createRequestHandler(
  () => import(buildServerUrl) as Promise<ServerBuild>,
  "production",
);

const ONE_YEAR = 60 * 60 * 24 * 365;

Deno.serve(async (request) => {
  const pathname = new URL(request.url).pathname;

  // Fingerprinted bundles under `/assets/` are immutable and can be cached
  // aggressively.
  if (pathname.startsWith("/assets/")) {
    return serveDir(request, {
      fsRoot: `${buildClientDir}assets`,
      urlRoot: "assets",
      headers: [`Cache-Control: public, max-age=${ONE_YEAR}, immutable`],
      quiet: true,
    });
  }

  // Everything else copied from `public/` into the client build (images,
  // favicon, …) needs to be served too. Try the static dir first and only fall
  // through to the React Router handler when there's no matching file, so paths
  // like `/images/bg.svg` aren't swallowed by the `$key` route and returned as
  // 404 HTML.
  if (request.method === "GET" || request.method === "HEAD") {
    const response = await serveDir(request, {
      fsRoot: buildClientDir,
      quiet: true,
    });
    if (response.status !== 404) {
      return response;
    }
  }

  return handler(request);
});
