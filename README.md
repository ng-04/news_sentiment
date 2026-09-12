# ng-04

Personal site with a live Indian stock news sentiment analyzer.

## What it does

Type in an Indian stock or company name (e.g. "Reliance", "TCS", "Infosys") and the
tool:

1. Fetches recent headlines from Google News RSS for that stock.
2. Scores each headline's sentiment with **FinVADER** — a finance-tuned extension of
   the VADER sentiment model (Hutto & Gilbert, 2014) that layers a large finance
   lexicon (SentiBignomics) on top of VADER's base word list.
3. Rolls the per-article compound scores (each in [-1, 1]) up into a net average and
   a label (Strongly Positive / Positive / Neutral / Negative / Strongly Negative).

Everything runs client-side — no backend, no API keys, no build step:

- News is fetched through `rss2json.com`, a CORS-enabled RSS-to-JSON service (sends
  `Access-Control-Allow-Origin: *`), since Google News RSS itself doesn't allow direct
  browser requests. A generic CORS proxy is used as a fallback.
- Sentiment is scored by [`vader.js`](vader.js), a from-scratch JavaScript port of
  NLTK's VADER algorithm, paired with [`finvader-lexicon.json`](finvader-lexicon.json)
  — the same lexicon the Python [`finvader`](https://pypi.org/project/finvader/)
  package builds (base VADER lexicon + SentiBignomics finance terms scaled by 0.1).
  The actual Python `finvader` package can't run in a browser (it depends on NLTK),
  so this port reproduces its algorithm and lexicon exactly — verified against the
  real Python package on 13 test headlines with matching compound scores to 4
  decimal places, including negation, booster words, ALL-CAPS emphasis, punctuation
  emphasis, and "but"-clause reweighting.

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
