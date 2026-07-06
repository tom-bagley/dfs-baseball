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

Then open:

```text
http://localhost:8000/
```

If port 8000 is already in use, the viewer automatically tries the next port. Open the localhost URL printed in the terminal.

The viewer has Teams and Players pages. Pick a date and click `Refresh`; the server fetches the FanGraphs schedule for that date, reuses any cached simulation payloads it already has, fetches only new simulation ids, and returns table-ready JSON to the page. The Teams page also joins fresh ESPN odds. CSV exports still exist as command-line tools, but the app no longer depends on CSV files for normal use.

Cached FanGraphs sims are written to `out/cache/` by default. Set `CACHE_DIR` to move that cache somewhere else.

On the Players page, use `DK CSV` to import a DraftKings salary export for the selected date. Imported salaries are cached by date, joined to player projections on refresh, and shown as salary/value columns.

After a slate loads, use the `Custom` button on any row to edit that game's batting orders and starting pitchers. The editor starts with FanGraphs' current sim inputs, lets you swap player ids from the loaded sim player list, then sends a custom FanGraphs simulation request and replaces that game in the table with the custom result. Repeated custom payloads are cached under `fangraphs-custom-sims`.

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
