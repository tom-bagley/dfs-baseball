# FanGraphs Baseball Sim CSV Exporter

Exports the FanGraphs Lab Baseball Sim slate for a date into one flat CSV row per game.

## Usage

```powershell
node src/export-fangraphs-sim.js --date 2026-06-30 --output out/fangraphs-baseball-sim-2026-06-30.csv
```

Or through npm on Windows:

```powershell
npm.cmd run export -- --date 2026-06-30 --output out/fangraphs-baseball-sim-2026-06-30.csv
```

Options:

- `--date YYYY-MM-DD`: date to export. Defaults to your local today.
- `--output PATH`: CSV destination. Defaults to `fangraphs-baseball-sim-YYYY-MM-DD.csv`.
- `--projection NAME`: FanGraphs projection system. Defaults to `rSteamer`.

The CSV includes game ids, start time, teams, FanGraphs lineup source, starting pitchers, win percentages, implied American odds, projected runs, simulation count, score/status fields when available, and an `error` column if a game could not be fetched.

## Team Projection Viewer

```powershell
npm.cmd start
```

During development, `npm.cmd run dev` runs the same server under `node --watch`, which restarts it automatically whenever a file in `src/` changes. HTML pages never need a restart either way — they are read from disk on every request.

For an always-on local server, `scripts/start-viewer-hidden.vbs` launches the viewer in the background with no console window (also under `node --watch`). A shortcut to it in the Windows Startup folder (`shell:startup`) starts it at every login, so `http://localhost:8000/` is always available — and daily Pick6 snapshots land in the local repo where they can be committed. To stop the background server, end the `node` process in Task Manager; to disable autostart, delete the Startup shortcut.

Then open:

```text
http://localhost:8000/
```

If port 8000 is already in use, the viewer automatically tries the next port. Open the localhost URL printed in the terminal.

The viewer has Teams and Players pages. Pick a date and click `Refresh`; the server fetches the FanGraphs schedule for that date, reuses any cached simulation payloads it already has, fetches only new simulation ids, and returns table-ready JSON to the page. The Teams page also joins fresh ESPN odds. CSV exports still exist as command-line tools, but the app no longer depends on CSV files for normal use.

Cached FanGraphs sims are written to `out/cache/` by default. Set `CACHE_DIR` to move that cache somewhere else. Simulations for games that have already started are cached permanently (the backtests depend on the original pregame payloads), but pregame simulations expire after 30 minutes so anticipated starters and projected lineups keep tracking FanGraphs' updates; tune this with the `PREGAME_SIM_TTL_MINUTES` environment variable.

On the Players page, use the `DK Slate` dropdown to pull DraftKings salaries automatically: it lists that date's classic MLB slates (main, early, night, turbo) straight from the DraftKings lobby, and selecting one downloads the player pool and salaries for that slate. Salaries are cached by date, joined to player projections on refresh, and shown in the player table.

The lineup optimizer has Cash and GPP presets. GPP builds support 4+ or 5+ primary stacks and exact 5-3, 5-2-1, 4-4, 4-3-1, and 4-2-2 constructions. A primary stack can require adjacent batting-order positions (including the 8-9-1 wrap), and the optimizer rejects hitters facing either selected pitcher by default. Cash starts without a forced stack; every preset can be adjusted before building.

During off days, click `Demo Slate` or open `/player-projections.html?demo=1` to load deterministic fake projections, salaries, confirmed batting orders, and starting pitchers. Demo players are clearly labeled and never written to the projection cache.

After a slate loads, use the `Custom` button on any row to edit that game's batting orders and starting pitchers. The editor starts with FanGraphs' current sim inputs, lets you swap player ids from the loaded sim player list, then sends a custom FanGraphs simulation request and replaces that game in the table with the custom result. Repeated custom payloads are cached under `fangraphs-custom-sims`.

## Higher / Lower Board

The viewer's `Higher/Lower` page (`/higher-lower.html`) pulls the day's DraftKings Pick6 MLB board and grades every line against the FanGraphs simulations. The board is read from the React Router loader state DraftKings serializes into the page (decoded with a vendored copy of `turbo-stream` under `src/vendor/`), which exposes every pickable across every stat tab — not just the featured cards — plus each alternate line and its payout multiplier. If that decode ever breaks, the page falls back to scraping the server-rendered featured cards (default lines only).

Single-stat categories (for example `Strikeouts Thrown`, `Hits`, `Home Runs`, `Stolen Bases`) are read exactly from the FanGraphs marginal histograms; composite hitter categories (`Hits + Runs + RBIs`, `Total Bases`, `Extra Base Hits`, `Fantasy Points`) run the shared correlated hitter outcome simulation and evaluate the sum per simulated game. Each line shows the probability of finishing above and below it, alternate-line payout multipliers, and a per-slot `Prob × Mult` expected multiple. Default-line rows whose better side clears the threshold input (55% by default) are flagged.

The Pick6 lobby only serves the current board, so historical dates fall back to boards cached under `out/cache/pick6/`.

### Pick6 Backtest

Every time the Higher/Lower board is refreshed, the server snapshots the matched pregame lines — probabilities, multipliers, and default flags — to `out/cache/pick6/snapshot-YYYY-MM-DD-<system>.json`. Lines keep updating until their game starts and are then frozen, so each snapshot ends up holding the final pregame odds. Grade them against official MLB box scores with:

```powershell
npm.cmd run backtest:pick6 -- --start 2026-07-16 --end 2026-07-20
```

The report shows best-side calibration by probability bucket, Brier score, win rate and realized per-slot multiple for flagged edges (`--threshold 0.55` by default), and the profit of the page's greedy best entries per size, graded with DraftKings' void rules (a pick that pushes or whose player does not appear drops the entry to the lower pick level). Outputs are `out/pick6-backtest-rows.csv` and `out/pick6-backtest-summary.json`. Remember that one slate is one heavily correlated observation — same-game picks live and die together — so judge the model on a few weeks of snapshots, not a single day.

The Entry Profitability panel turns line probabilities into entry-level economics. A Pick6 entry pays `base payout × product of pick multipliers` when every pick hits, so EV per $1 is `base payout × ∏ multiplier × ∏ probability`. Base payouts per pick count are editable on the page (defaults 3/6/12/20/35×, stored in the browser) because DraftKings defines them per contest. The panel shows the per-pick break-even probability for each entry size, the best model entry per size (greedy by probability × multiplier, one pick per player, at least two teams), and an interactive slip: add any purchasable Higher/Lower side from the board with the ▲/▼ buttons to see combined win probability, payout, EV, and ROI. Entry math assumes picks are independent — same-game picks are correlated and are flagged with a warning.

## Render Hosting

Create a Render Web Service from this repo with:

- Build command: leave blank, or use `npm install`
- Start command: `npm start`
- Optional environment variable: `CACHE_DIR=/var/data/cache`

For a cache that survives Render deploys/restarts, attach a persistent disk and point `CACHE_DIR` at a folder on that disk. Without a disk, the app still works, but Render may clear cached files when the service restarts.

## Moneyline Backtest

```powershell
node src/backtest-fangraphs-moneylines.js --start 2026-03-01 --end 2026-06-29
```

Or:

```powershell
npm.cmd run backtest:moneylines -- --start 2026-03-01 --end 2026-06-29
```

This joins FanGraphs simulator win percentages to ESPN's historical MLB scoreboard and odds feeds. A bet is selected when the FanGraphs win probability has positive expected ROI against the ESPN moneyline. By default the script uses the closing moneyline and the first odds provider returned by ESPN. Outputs are written as `*-games.csv`, `*-bets.csv`, and `*-summary.json`.

Options:

- `--start YYYY-MM-DD`: first game date. Defaults to March 1 of the end year.
- `--end YYYY-MM-DD`: last game date. Defaults to yesterday.
- `--line open|current|close`: ESPN moneyline snapshot. Defaults to `close`.
- `--provider NAME`: choose a specific ESPN odds provider; otherwise the first returned provider is used.
- `--min-ev NUMBER`: minimum expected ROI for a bet. Defaults to `0`.
- `--output-prefix PATH`: output prefix for the three generated files.
- `--request-delay-ms NUMBER`: delay before each HTTP request. Defaults to `250`.
- `--retries NUMBER`: retry count for 429/5xx responses. Defaults to `4`.

## Projection Calibration Backtest

```powershell
node src/backtest-projection-calibration.js --start 2026-05-04 --end 2026-07-05
```

Compares FanGraphs sim projection systems (`rSteamer`, `rSteamerPN`, `Steamer`, `ZiPS` by default) on how accurate their fair moneylines are. For every final game it bets the sim favorite at that system's fair moneyline, then compares the predicted win percentage (average favorite probability) against the actual win percentage from historical results, along with fair-odds profit and Brier score. Stored sims begin on 2026-05-04. Per-date responses are cached under `out/cache/projection-calibration/` so reruns only fetch new dates.

Options:

- `--start YYYY-MM-DD`: first game date. Defaults to `2026-05-04`.
- `--end YYYY-MM-DD`: last game date. Defaults to yesterday.
- `--systems A,B,C`: projection systems to compare.
- `--output-prefix PATH`: output prefix for the games CSV and summary JSON.
- `--cache-dir PATH`: per-date cache directory.
- `--concurrency`, `--request-delay-ms`, `--retries`: request pacing, same defaults as the moneyline backtest.

## Player Expected Points

```powershell
node src/export-fangraphs-players.js --date 2026-06-30 --output out/fangraphs-baseball-sim-players-2026-06-30.csv
```

Or:

```powershell
npm.cmd run export:players -- --date 2026-06-30 --output out/fangraphs-baseball-sim-players-2026-06-30.csv
```

This writes one row per simulated hitter and pitcher, sorted by `expectedPoints` from highest to lowest. Hitter and pitcher points use the scoring rules from the request. Complete-game, complete-game shutout, and no-hitter pitcher bonuses are estimated from FanGraphs' marginal simulation histograms.

Starting pitchers in the Players viewer also receive deterministic P10, P20, P50, P80, and P90 DraftKings outcomes from a 10,000-start conditional Monte Carlo model. The model connects workload, strikeouts, baserunners, runs, and win eligibility, then recenters the distribution on the FanGraphs expected-points projection. Historical experience can widen the distribution without changing its mean.

Hitters receive deterministic P10, P20, P50, P80, and P90 DraftKings outcomes from 10,000 simulated games. The hitter model samples the matchup-specific FanGraphs histograms for each scoring event and uses shared game-quality, power, and speed factors so hits, runs, RBI, and steals are not treated as unrelated outcomes. Live `expectedPoints` currently retains the raw FanGraphs mean; experimental calibration and Bayesian models must improve out-of-sample player differentiation before replacing it.

Validate hitter percentiles against official MLB box scores with `npm.cmd run backtest:hitters -- --start 2026-07-06 --end 2026-07-12`. Because hitter scoring is discrete and bounded at zero, the summary reports both the fraction strictly below and at-or-below each quantile; a calibrated quantile target should fall between those two rates.

### Hitter Mean Calibration

```powershell
npm.cmd run backtest:hitters:calibration
```

This is a research benchmark, not the player-level Bayesian updater described below. Candidate selection uses rolling dates where every prediction is trained only on earlier games. Its conservative offset reduced holdout MAE from 5.76 to 5.62, but it cannot change player rankings and is therefore not used by live projections.

### Player-Level Bayesian Experiment

```powershell
node src/fetch-hitter-season-histories.js
npm.cmd run backtest:hitters:bayesian
```

The article-style experiment uses each current FanGraphs component rate as the prior and all MLB game-log evidence strictly before the projection date as the likelihood. A Gamma–Poisson posterior updates singles, extra-base hits, walks, runs, RBI, and stolen-base rates per plate appearance. Prior strength, recency, and posterior caps are chosen on rolling development dates before the July 6–12 holdout. This model is not used in production: validation selected a very strong 400-PA prior, and on holdout MAE remained 5.76 while RMSE moved from 7.26 to 7.27 and correlation declined from 0.1199 to 0.1166. The evidence therefore did not justify overriding FanGraphs player rankings.

A second experiment reduces prior weight only for statistically large disagreements and can require the signal to agree across recent and full-season windows. This correctly raised Jordan Walker's July average from 8.02 to 9.35 and reduced his RMSE from 6.87 to 6.32. It did not generalize across all hitters: the persistence-selected model worsened holdout RMSE and correlation. Treat `seasonBayesianProjection` as a research disagreement signal, not a replacement for `expectedPoints`.

### Statcast Hitter Evidence

```powershell
npm.cmd run fetch:statcast -- --start 2026-03-26 --end 2026-07-11
npm.cmd run backtest:hitters:statcast
npm.cmd run backtest:hitters:statcast-regression
```

The Statcast collector downloads small, restartable Baseball Savant date chunks and caches them under `out/cache/statcast/chunks`. The feature builder aggregates only pitches strictly before each projection date. It supplies full-season and trailing-30-day plate appearances, batted balls, average exit velocity, launch angle, hard-hit rate, barrel rate, xwOBA, expected slugging on contact, and bat speed. It also measures full-season and recent xwOBA disagreement with the FanGraphs component projection.

Two deliberately different models consume those features. The gated Bayesian model uses Statcast to confirm only large same-direction game-log disagreements; it is useful as a research flag but failed the population holdout. The zero-prior ridge model learns direct residual weights without an intercept. Its ranking-selected xwOBA version slightly improved holdout daily correlation from 0.1247 to 0.1249 and the realized score of the projected top 10% from 9.48 to 9.58, but moved Jordan Walker only 0.01 points per game. That is too weak to replace live `expectedPoints`. Walker's July 12 pregame evidence remains available in the research CSV: 94.2 mph average exit velocity, 51.5% hard-hit rate, 14.1% barrel rate, and .373 xwOBA versus the component projection's .325 wOBA.

Single-game fantasy results are an especially noisy target for player-skill disagreements. The forward-window benchmark instead asks whether an adjustment made on an anchor date improves the player's aggregate DraftKings rate over the following games:

```powershell
npm.cmd run backtest:hitters:forward-disagreements -- --horizon-days 7 --holdout-start 2026-07-06
```

The benchmark requires at least 12 future plate appearances and rejects incomplete horizons. Training examples are eligible only after their entire future window has ended. On the complete July 6 seven-day holdout, the selected season/recent xwOBA model improved weighted RMSE from 0.7829 to 0.7772 DK points per PA, correlation from 0.0910 to 0.1087, and the top-20% realized rate from 1.6983 to 1.7485. Among the 27 largest adjustments it improved RMSE from 0.7740 to 0.7543 and chose the correct direction 66.7% of the time. Five- and ten-day tests also improved RMSE, but these windows overlap and the clean seven-day holdout contains only 129 hitters. Treat this as the first positive player-specific evidence, not yet as sufficient support for changing live `expectedPoints`.

Refresh the evidence periodically, then restart the viewer so its in-memory Statcast cache is rebuilt:

```powershell
npm.cmd run fetch:statcast -- --start 2026-07-12 --end 2026-07-18
npm.cmd run viewer
```

## Pitcher Percentile Backtest

```powershell
npm.cmd run backtest:pitchers -- --start 2026-05-04 --end 2026-07-05
```

The pitcher backtest joins the original historical FanGraphs simulation to the official MLB box score, calculates actual DraftKings pitcher points, and measures P10/P20/P50/P80/P90 calibration. It compares the base simulation with an experience-adjusted distribution using season innings, prior MLB innings, and recent starts available before each game. Date payloads and pitcher histories are cached under `out/cache/pitcher-percentile-backtest/` so model tuning does not repeatedly download historical data.

To validate simulations already saved by the viewer without requesting them from FanGraphs again, pass `--local-sim-cache out/cache/fangraphs-sims/rSteamer`.

The provisional experience-strength value (`0.10`) was selected on May 4–June 15 and then frozen for a June 16–July 5 test. On 501 untouched test starts, actual outcomes fell below P20 20.96% of the time and exceeded P80 21.16% of the time. P10/P90 were somewhat narrow at 11.78% and 12.57%. Across all 1,549 matched starts, the adjusted rates were 10.39%, 22.08%, 20.08%, and 10.91% for P10/P20/P80/P90 respectively. Treat P20/P80 as the better-calibrated decision band for now, especially for low-confidence pitchers.
