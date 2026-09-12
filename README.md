# ng-04

Personal site with a live Indian stock news sentiment analyzer.

## What it does

Type in an Indian stock or company name (e.g. "Reliance", "TCS", "Infosys") and the
tool:

1. Fetches recent headlines from Google News RSS for that stock.
2. Scores each headline's sentiment using a built-in positive/negative word-list model
   (finance-flavored terms like "surge", "downgrade", "profit", "loss", etc.).
3. Rolls the per-article scores up into a net sentiment score and label.

Everything runs client-side — no backend, no API keys, no build step. News is fetched
through a free public CORS proxy since GitHub Pages only serves static files and
Google News RSS doesn't allow direct browser requests.

This is a heuristic demo, not investment advice.

## Local preview

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

then visit http://localhost:8000.

## Deploying to GitHub Pages

1. Create a new GitHub repo named `news_sentiment` under your account.
2. Push this folder to it (see the commands the assistant ran, or):
   ```bash
   git remote add origin https://github.com/ng-04/news_sentiment.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**, set **Source** to `Deploy from a branch`,
   branch `main`, folder `/ (root)`, and save.
4. The site will be live at `https://ng-04.github.io/news_sentiment/` within a minute
   or two.
