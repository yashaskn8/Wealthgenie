-- Financial observations must not represent zero/unitless values as live assets.
-- NAV is end-of-day published information, not an intraday market quote.
ALTER TABLE finance.market_observations
  ADD CONSTRAINT market_observations_positive_trade_values
    CHECK (observation_type NOT IN ('PRICE','NAV') OR value>0);
ALTER TABLE finance.market_observations
  ADD CONSTRAINT market_observations_nav_end_of_day_only
    CHECK (observation_type<>'NAV' OR data_class='END_OF_DAY');
ALTER TABLE finance.market_observations
  ADD CONSTRAINT market_observations_rate_class_parity
    CHECK ((observation_type='PUBLISHED_RATE') = (data_class='PUBLISHED_RATE'));
ALTER TABLE finance.market_observations
  ADD CONSTRAINT market_observations_unit_format
    CHECK (
      observation_type NOT IN ('PRICE','NAV') OR
      (currency='INR' AND unit='INR_PER_UNIT')
    );
