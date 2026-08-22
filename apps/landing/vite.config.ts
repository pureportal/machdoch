import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const canonicalUrlToken = "__MACHDOCH_CANONICAL_URL__";
const siteUrlToken = "__MACHDOCH_SITE_URL__";
const socialImageUrlToken = "__MACHDOCH_SOCIAL_IMAGE_URL__";
const repositorySocialImageUrl =
  "https://raw.githubusercontent.com/pureportal/machdoch/main/apps/landing/public/machdoch-app-social.jpg";

function parseLandingUrl(value: string | undefined): URL | undefined {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  const landingUrl = new URL(trimmedValue);
  if (landingUrl.protocol !== "https:") {
    throw new Error("MACHDOCH_LANDING_URL must use HTTPS.");
  }
  if (landingUrl.username || landingUrl.password) {
    throw new Error("MACHDOCH_LANDING_URL must not contain credentials.");
  }
  if (landingUrl.search || landingUrl.hash) {
    throw new Error(
      "MACHDOCH_LANDING_URL must not contain a query or fragment.",
    );
  }
  if (!landingUrl.pathname.endsWith("/")) {
    throw new Error("MACHDOCH_LANDING_URL must end with a trailing slash.");
  }

  return landingUrl;
}

function createLandingSeoPlugin(landingUrl: URL | undefined): Plugin {
  const canonicalUrl = landingUrl?.href ?? "./";
  const socialImageUrl = landingUrl
    ? new URL("machdoch-app-social.jpg", landingUrl).href
    : repositorySocialImageUrl;
  const sitemapUrl = landingUrl
    ? new URL("sitemap.xml", landingUrl).href
    : undefined;
  const robotsText = [
    "User-agent: *",
    "Allow: /",
    ...(sitemapUrl ? ["", `Sitemap: ${sitemapUrl}`] : []),
    "",
  ].join("\n");

  return {
    name: "machdoch-landing-seo",
    transformIndexHtml(html) {
      let transformedHtml = html
        .replaceAll(canonicalUrlToken, canonicalUrl)
        .replaceAll(socialImageUrlToken, socialImageUrl);

      if (landingUrl) {
        return transformedHtml.replaceAll(siteUrlToken, landingUrl.href);
      }

      transformedHtml = transformedHtml.replace(
        new RegExp(
          `\\s*<meta property="og:url" content="${siteUrlToken}" \\/>`,
        ),
        "",
      );
      return transformedHtml;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?", 1)[0] !== "/robots.txt") {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(robotsText);
      });
    },
    buildStart() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: robotsText,
      });

      if (landingUrl) {
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            `  <url><loc>${landingUrl.href.replaceAll("&", "&amp;")}</loc></url>`,
            "</urlset>",
            "",
          ].join("\n"),
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, packageDirectory, "");
  const landingUrl = parseLandingUrl(
    process.env.MACHDOCH_LANDING_URL ?? environment.MACHDOCH_LANDING_URL,
  );

  return {
    appType: "mpa",
    base: "./",
    clearScreen: false,
    plugins: [createLandingSeoPlugin(landingUrl)],
    publicDir: path.resolve(packageDirectory, "public"),
    server: {
      host: "127.0.0.1",
      port: 4174,
      strictPort: true,
    },
    preview: {
      host: "127.0.0.1",
      port: 4174,
    },
    build: {
      target: "es2022",
    },
  };
});
