# Upstox market-data mode

Set `MARKET_DATA_MODE=UPSTOX_ONLY` to select the Upstox market-context adapter. This mode does not call NSE market-data endpoints. The legacy mode continues to use the existing NSE path. Mutual-fund NAV and history, government rates, bank deposit rates, and RBI bond rules retain their own authoritative sources; an Upstox index quote never replaces a product-level fact.

The source register separately controls production access, storage, public display, commercial use, and redistribution. A configured analytics token or operator Boolean does not establish these rights. Production paths fail closed when the exact endpoint rights are unverified. The authenticated loopback private demo reads two qualified index quotes without provider-data persistence or recommendation changes. It requires `NODE_ENV=development`, `MARKET_DATA_PRIVATE_DEMO_ENABLED=true`, an authenticated session, and a loopback socket, Host, and Origin.

The admin raw-equity-history route uses Upstox ISIN-keyed candles and a qualified NSE session calendar. A caller-supplied symbol remains unverified. BSE and unsupported session ranges remain unavailable. The admin persistence route is separately rights-gated and does not write on a GET. Stored rows are rechecked for source rights at read time and expire under bounded retention.

The current exact Upstox quote registry contains NIFTY 50 and India VIX only. Those observations are market context, not FD rates, bond coupons, mutual-fund NAVs, individual equity prices, or expected returns. Expand product coverage only after source-backed instrument identity and the applicable use rights are verified.
