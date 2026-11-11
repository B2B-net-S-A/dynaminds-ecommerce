-- Preserve 094 validation while making CHECK deparse/reparse stable for recovery.
-- Explicit comparisons avoid BETWEEN expanding into a nested AND after pg_dump.
ALTER TABLE stocktake_scan_receipts DROP CONSTRAINT stocktake_scan_receipts_location_check;
ALTER TABLE stocktake_scan_receipts ADD CONSTRAINT stocktake_scan_receipts_location_check
 CHECK (char_length(location)>=1 AND char_length(location)<=80
  AND location=btrim(location) AND location !~ '[[:cntrl:]]');

ALTER TABLE stocktake_scan_receipts DROP CONSTRAINT stocktake_scan_receipts_code_check;
ALTER TABLE stocktake_scan_receipts ADD CONSTRAINT stocktake_scan_receipts_code_check
 CHECK (char_length(code)>=1 AND char_length(code)<=80
  AND code=btrim(code) AND code !~ '[[:cntrl:]]');
