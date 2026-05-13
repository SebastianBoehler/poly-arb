# Weather Strategy Discovery

Snapshot time: 2026-05-13.

## Collector Status

- Primary collector remains `polyarb-gamma-all`.
- Output directory: `data/all-polymarket-20260512T171924Z/`.
- The old broad C++ CLOB collector was stopped after producing no rows and repeated timeout/parse errors.

## Resolution Source Findings

Polymarket daily temperature markets resolve from the market-specific rules, typically a named airport station on Wunderground. Examples verified from live Polymarket pages:

- Austin: Austin-Bergstrom International Airport, Wunderground `KAUS`.
- Seoul: Incheon Intl Airport, Wunderground `RKSI`.
- Munich: Munich Airport, Wunderground `EDDM`.

This means weather strategy should be station-specific. City-center forecasts are not sufficient, and for Munich/Tuebingen specifically, the currently relevant Germany weather market is Munich Airport, not a local Tuebingen station.

## Data Seen So Far

- Weather rows in overnight CSV: 17,578.
- Unique weather markets: 638.
- Latest weather scan contained 638 weather markets.
- Latest grouped weather baskets: 57 city/date/high-low groups.

Top latest weather cities by observed volume included Seoul, Shanghai, Mexico City, Miami, Shenzhen, London, Denver, Singapore, Jakarta, Busan, Hong Kong, Milan, Taipei, Seattle, Los Angeles, Karachi, Paris, New York City, Amsterdam, and Qingdao.

## Strategy Tests

Do not interfere with weather stations or sensors. Physical site research is useful only for lawful observation: confirming station placement, exposure, shading, elevation, runway/airport microclimate, and whether market participants are using a mismatched city forecast.

### 1. Range Basket Arbitrage

For each weather event, group all outcomes such as:

`highest temperature in CITY on DATE`

Then sum the best YES asks. If the full exhaustive basket can be bought for less than 1.0, buying all outcomes is a deterministic range arb before fees/slippage.

Latest scan result: no clean buy-all weather basket arb was present. Lowest observed YES basket sums:

- Seoul high May 15: `1.011`
- Mexico City high May 15: `1.059`
- Denver high May 15: `1.061`
- Singapore high May 15: `1.065`
- Austin high May 15: `1.080`

Conclusion: keep this scanner, but do not expect frequent pure basket arbs after spreads.

### 2. Forecast-Latency Edge

Large overnight weather price moves show that the market reprices sharply when forecast or station information updates. Examples from the collected data:

- Miami low May 16 buckets moved roughly `-0.98` in YES price across the collection window.
- Shanghai low May 16 buckets moved roughly `-0.98` in YES price.
- Toronto/Cape Town/Tokyo examples also showed large repricing.

Conclusion: weather is promising for early signal discovery, but the edge is likely in ingesting better/faster forecast and station data, not in raw Polymarket top-of-book alone.

### 3. Direct Station Feed Edge

Airport weather markets can be monitored via direct aviation weather/METAR feeds before Wunderground daily history is finalized.

Tested live endpoints:

- `https://aviationweather.gov/api/data/metar?ids=KAUS&format=json&hours=3`
- `https://aviationweather.gov/api/data/metar?ids=EDDM&format=json&hours=3`
- `https://aviationweather.gov/api/data/metar?ids=RKSI&format=json&hours=3`

These returned current station observations with timestamps, temperature, raw METAR text, coordinates, and station names.

Conclusion: build a station-source module that maps Polymarket weather events to station IDs, polls direct station feeds, tracks daily max/min, and compares projected settlement to market prices.

## Candidate Strategy Modules

1. `weather_basket_arb`
   - Inputs: latest weather event groups.
   - Signal: sum of YES asks below `1 - fee/slippage_buffer`.
   - Current result: no live signal in latest scan.

2. `weather_station_settlement`
   - Inputs: market rules station ID, direct METAR/official station data, current Polymarket orderbook.
   - Signal: near-settlement bracket is already determined or nearly determined, but market is slow.
   - Best horizon: same-day final hours and immediately after station data updates.

3. `weather_forecast_latency`
   - Inputs: station-specific forecast model blend, local official forecast, direct station obs, market basket prices.
   - Signal: model probability minus market probability exceeds threshold after accounting for spread.
   - Best horizon: 12-48h before resolution, especially after new model runs.

4. `weather_source_mismatch`
   - Inputs: Polymarket rules station vs popular city forecast.
   - Signal: market appears to price city-center forecast while rules use airport station.
   - Examples to monitor: coastal airports, sea-breeze regimes, urban heat island differences, airport fog/cloud cover, elevation differences.

## Immediate Next Build

Implement a Gamma-driven weather discovery scanner:

- Parse active Polymarket weather pages for Wunderground station URLs.
- Extract station IDs such as `KAUS`, `EDDM`, `RKSI`.
- Poll direct station observations via AviationWeather for ICAO stations.
- Add Open-Meteo or official national weather-service forecast input as a first model source.
- Produce paper signals only when station-specific probability beats top-of-book by a configured edge threshold.

Do not live trade weather until slippage/depth and station mapping are validated.

## Pivot After Initial Weather Review

Because nearby Germany exposure appears to be Munich Airport rather than a local Tuebingen station, the more scalable path is traditional market microstructure:

- Fade naive momentum: early backtests show short-horizon continuation is weak across most categories.
- Track spread compression after stale/wide books tighten.
- Build passive market-making candidates from persistent tight/liquid markets.
- Treat wide tennis/esports books as source-research leads, not automatic value.
- Use weather only when station-specific forecast or direct observation creates a measurable edge over market price.
