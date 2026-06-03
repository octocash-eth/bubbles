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

  if (pathname.startsWith("/assets/")) {
    return serveDir(request, {
      fsRoot: `${buildClientDir}assets`,
      urlRoot: "assets",
      headers: [`Cache-Control: public, max-age=${ONE_YEAR}, immutable`],
      quiet: true,
    });
  }

  return handler(request);
});
