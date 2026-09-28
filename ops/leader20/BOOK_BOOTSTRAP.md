# Top20 initial book synchronization

The first clock cohort connected 20 candidates but mostly had incomplete books.
The old rolling REST budget of 100 weight can initialize at most five depth1000
books per minute, before retries. Twenty initial books need 400 weight. Repeated
attempts in watch order could also consume the allowance before later candidates.

During an admitted candidate preparation/capture only, use min(600, one quarter
of live exchangeInfo's minute REQUEST_WEIGHT limit). Retain 100 otherwise, including
missing limit metadata, unfunded/empty watches and held-only watches. The same
rolling ledger survives transitions. Recovery rotates across candidate attempts,
with held exits retaining priority. All source continuity, depth completeness,
five-second interval and 24-bucket requirements remain unchanged.

The actual public exchangeInfo read on 2026-09-28 returned 2400 weight per minute.
Binance documents depth1000 as weight20:
https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book
This changes public-data throughput only, not provider budgets or trading authority.

Deploy the existing single collector image and its protocol digest together during
the idle part of the cycle. Preserve machine sizing, tokens, gateway and Edge
versions. Verify the next natural preparation and two-minute window separately
from synthetic tests; no order is sent merely to validate the collector.
