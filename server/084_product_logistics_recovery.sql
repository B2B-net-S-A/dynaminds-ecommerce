-- Preserve the same validation while making the deparsed CHECK stable after pg_dump/restore.
-- BETWEEN inside another AND becomes a nested BoolExpr on its first parse;
-- explicit bounds retain the same canonical grouping when the dump is parsed again.
ALTER TABLE product_logistics DROP CONSTRAINT product_logistics_manufacturer_check;
ALTER TABLE product_logistics ADD CONSTRAINT product_logistics_manufacturer_check
 CHECK (manufacturer IS NULL OR (
  char_length(manufacturer)>=1 AND char_length(manufacturer)<=200
  AND manufacturer=btrim(manufacturer)
 ));
