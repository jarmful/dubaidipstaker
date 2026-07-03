# dubaidipstaker
UAE licensed crypto sites

## CompanyCap — /companies/

A CoinMarketCap-style ranking of the world's largest public companies by
market capitalization. Static site, no backend:

- `companies/index.html` — the page (self-contained HTML/CSS/JS, light + dark mode, mobile layout).
- `companies/data/companies.json` — the dataset the page renders. Currently a labeled seed snapshot.
- `scripts/tickers.json` — the list of companies to track. Edit this to add/remove companies.
- `scripts/update-companies.mjs` — fetches live prices, market caps and 7-day history from Yahoo Finance and rewrites the dataset (Node 18+, zero dependencies).
- `.github/workflows/update-companies.yml` — runs the updater twice each weekday and commits the refreshed data.

To refresh data manually: `node scripts/update-companies.mjs`, or trigger the
"Update company market data" workflow from the Actions tab.
