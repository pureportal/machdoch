import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { de } from "./i18n/de.ts";
import { en, type Messages } from "./i18n/en.ts";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.resolve(packageDirectory, "index.html");
const germanPagePath = path.resolve(packageDirectory, "de/index.html");
const developmentSocialImageUrl =
  "https://raw.githubusercontent.com/pureportal/machdoch/main/apps/landing/public/machdoch-app-social.jpg";

const locales = {
  en: { messages: en, pagePath: "", ogLocale: "en_US", legalPrefix: "" },
  de: { messages: de, pagePath: "de/", ogLocale: "de_DE", legalPrefix: "/de" },
} satisfies Record<
  string,
  {
    messages: Messages;
    pagePath: string;
    ogLocale: string;
    legalPrefix: string;
  }
>;

type Locale = keyof typeof locales;

function parseLandingUrl(value: string | undefined): URL | undefined {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  let landingUrl: URL;
  try {
    landingUrl = new URL(trimmedValue);
  } catch {
    throw new Error("MACHDOCH_LANDING_URL must be a valid absolute HTTPS URL.");
  }

  if (landingUrl.protocol !== "https:") {
    throw new Error("MACHDOCH_LANDING_URL must use HTTPS.");
  }
  if (landingUrl.username || landingUrl.password) {
    throw new Error("MACHDOCH_LANDING_URL must not contain credentials.");
  }
  if (
    landingUrl.search ||
    landingUrl.hash ||
    landingUrl.href.includes("?") ||
    landingUrl.href.includes("#")
  ) {
    throw new Error(
      "MACHDOCH_LANDING_URL must not contain a query or fragment.",
    );
  }
  if (!trimmedValue.endsWith("/")) {
    throw new Error("MACHDOCH_LANDING_URL must end with a trailing slash.");
  }

  return landingUrl;
}

function localizePage(
  html: string,
  locale: Locale,
  landingUrl: URL | undefined,
): string {
  const { messages, ogLocale, legalPrefix } = locales[locale];
  const alternateLocale: Locale = locale === "en" ? "de" : "en";
  const relativeRoot = locale === "en" ? "./" : "../";
  const pageUrl = (target: Locale): string =>
    landingUrl
      ? new URL(locales[target].pagePath, landingUrl).href
      : `${relativeRoot}${locales[target].pagePath}`;
  const currentAttribute = (target: Locale): string =>
    target === locale ? 'aria-current="page"' : "";
  const values: Record<string, string> = {
    ...messages,
    lang: locale,
    ogLocale,
    ogLocaleAlternate: locales[alternateLocale].ogLocale,
    canonicalUrl: pageUrl(locale),
    enUrl: pageUrl("en"),
    deUrl: pageUrl("de"),
    enHref: relativeRoot,
    deHref: `${relativeRoot}${locales.de.pagePath}`,
    enCurrent: currentAttribute("en"),
    deCurrent: currentAttribute("de"),
    socialImageUrl: landingUrl
      ? new URL("machdoch-app-social.jpg", landingUrl).href
      : developmentSocialImageUrl,
    imprintUrl: `https://pureportal.io${legalPrefix}/imprint`,
    privacyUrl: `https://pureportal.io${legalPrefix}/privacy`,
    termsUrl: `https://pureportal.io${legalPrefix}/terms`,
  };

  return html.replaceAll(/\{\{(\w+)\}\}/g, (_token, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Landing page token "${key}" has no value.`);
    }
    return value;
  });
}

function createSitemap(landingUrl: URL): string {
  const alternates = (Object.keys(locales) as Locale[]).map(
    (locale) =>
      `    <xhtml:link rel="alternate" hreflang="${locale}" href="${new URL(locales[locale].pagePath, landingUrl).href}" />`,
  );
  const entries = (Object.keys(locales) as Locale[]).flatMap((locale) => [
    "  <url>",
    `    <loc>${new URL(locales[locale].pagePath, landingUrl).href}</loc>`,
    ...alternates,
    "  </url>",
  ]);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    "</urlset>",
    "",
  ]
    .join("\n")
    .replaceAll("&", "&amp;");
}

function createLandingPagesPlugin(landingUrl: URL | undefined): Plugin {
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
    name: "machdoch-landing-pages",
    resolveId(id) {
      return path.resolve(packageDirectory, id) === germanPagePath
        ? germanPagePath
        : undefined;
    },
    load(id) {
      return id === germanPagePath ? readFile(templatePath, "utf8") : undefined;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        return localizePage(
          html,
          context.path.startsWith("/de/") ? "de" : "en",
          landingUrl,
        );
      },
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestPath = request.url?.split("?", 1)[0];
        if (requestPath === "/robots.txt") {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(robotsText);
          return;
        }
        if (requestPath !== "/de/" && requestPath !== "/de/index.html") {
          next();
          return;
        }

        try {
          const html = await server.transformIndexHtml(
            "/de/index.html",
            await readFile(templatePath, "utf8"),
            request.originalUrl,
          );
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: robotsText,
      });

      if (landingUrl) {
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: createSitemap(landingUrl),
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

  if (mode === "production" && !landingUrl) {
    throw new Error(
      "MACHDOCH_LANDING_URL must be set to a valid trailing-slash HTTPS URL for production builds.",
    );
  }

  return {
    appType: "mpa",
    base: "./",
    clearScreen: false,
    plugins: [createLandingPagesPlugin(landingUrl)],
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
      rolldownOptions: {
        input: [templatePath, germanPagePath],
      },
    },
  };
});
