-- Every scoring observation is appended here; nothing is ever updated in place.
-- The UI and /feed.json both read a rolling 10-day window out of this single table.
CREATE TABLE IF NOT EXISTS signal_history (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  p_beat REAL NOT NULL,
  imbalance REAL NOT NULL,
  strength INTEGER NOT NULL,
  current_stock_price REAL,
  pm_url TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_history_ticker_time ON signal_history(ticker, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_market_time ON signal_history(market_id, recorded_at DESC);
