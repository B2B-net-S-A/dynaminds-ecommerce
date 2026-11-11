-- Conservative local application-wide budget, not a claim about a seller's actual allowance.
CREATE TABLE amazon_api_buckets (
 scope_hash text PRIMARY KEY CHECK(scope_hash ~ '^[a-f0-9]{64}$'),
 family text NOT NULL CHECK(family IN ('search','order','oauth')),
 tokens double precision NOT NULL CHECK(tokens>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 cooldown_until timestamptz NOT NULL DEFAULT '-infinity',
 observed_rate double precision,limited_responses bigint NOT NULL DEFAULT 0
);
REVOKE ALL ON amazon_api_buckets FROM PUBLIC,dyna_app;
