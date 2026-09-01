-- 033: b2b_companies.status must not default to a claim we never verified.
--
-- The column defaulted to 'ACTIVE', and three code paths wrote that literal for
-- companies DaData never resolved (no API key, no suggestion, or a suggestion
-- with no state block). The dashboard renders the value as "Статус ФНС" and the
-- CRM sync ships it to the customer's CRM, so an unenriched org was asserting
-- an active tax-registry standing on no evidence. 'UNKNOWN' was already the
-- convention in the parser's empty branch and in the /api/b2b/companies mapper.

ALTER TABLE b2b_companies ALTER COLUMN status SET DEFAULT 'UNKNOWN';

-- Correct rows written under the old default. A row with no INN and no stored
-- DaData payload was never successfully enriched, so its 'ACTIVE' is invented,
-- never a status the registry actually returned. Idempotent.
UPDATE b2b_companies
   SET status = 'UNKNOWN',
       updated_at = NOW()
 WHERE status = 'ACTIVE'
   AND inn IS NULL
   AND raw_dadata IS NULL;
