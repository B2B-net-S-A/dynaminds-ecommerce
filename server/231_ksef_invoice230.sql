-- Successor to230, registered in db.ts migrate() after230 (23.10.2026).
-- KSeF for FV-S invoices: the 229 submission table lists the document kinds it stores, and a
-- 230 invoice (mode invoice230) was not among them. 229 stays as it is; this migration widens
-- that one CHECK of the own 229 table ksef229_submissions by the kind 'invoice230', keeping
-- its name. Nothing else changes: the 229 guard (document, file and hash immutable, the state
-- machine, no DELETE/TRUNCATE), the grants, RLS and the partial UNIQUE stay untouched.
-- No trigger, column, constraint or grant is attached to a core table.
DO $dependency231$
BEGIN
 IF current_user <> 'postgres'
 OR to_regclass('public.ksef229_submissions') IS NULL
 OR to_regprocedure('public.ksef229_submission_guard()') IS NULL
 OR to_regclass('public.invoice230_documents') IS NULL
 OR NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.ksef229_submissions'::regclass AND conname='ksef229_submissions_document_kind_check' AND contype='c')
 THEN RAISE EXCEPTION 'KSeF dla faktur FV-S (231) wymaga zainstalowanych 229 i 230' USING ERRCODE='55000';END IF;
END
$dependency231$;

ALTER TABLE public.ksef229_submissions DROP CONSTRAINT ksef229_submissions_document_kind_check;
ALTER TABLE public.ksef229_submissions ADD CONSTRAINT ksef229_submissions_document_kind_check
 CHECK(document_kind IN ('local_invoice','b2b_invoice','local_consumer_credit','consumer_return_credit','b2b_correction','invoice230'));
