# Landing page

For deployment, set `MACHDOCH_LANDING_URL` to the canonical HTTPS URL, including a trailing slash. The production build uses it for absolute canonical and Open Graph URLs and for the sitemap advertised in `robots.txt`.

The release workflow reads that value from the `MACHDOCH_LANDING_URL` repository variable and publishes the production container to `ghcr.io/pureportal/machdoch-landing`. Every `main` build updates `latest` and a commit SHA tag; release builds also publish the matching `vX.Y.Z` tag. The container listens on port 80.
