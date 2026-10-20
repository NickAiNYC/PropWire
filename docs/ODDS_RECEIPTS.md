# Odds receipt contract

A quote may influence qualification, EV, or stake only when it is traceable to a stored provider response.

`provider_quote_id` is the SHA-256 hash of these ordered identity fields:

1. provider
2. event ID
3. bookmaker
4. market
5. outcome
6. point
7. provider last-update timestamp

Each verified quote must also carry an HTTPS provider source URL, a SHA-256 hash of the raw response, the provider update timestamp, and our fetch timestamp. The browser rejects incomplete receipts, malformed values, future timestamps, and quotes more than ten minutes old. Rejected quotes remain visible only as `DATA CHECK` with zero qualification and zero stake.

The raw response belongs in durable server-side storage. The hash detects changes; it does not make a mutable database immutable.
