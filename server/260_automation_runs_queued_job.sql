-- Migration 260_automation_runs_queued_job (prepared as 276, registered after 259_jobs_running_lease; docs/parity/QUEUE-COUNTERS-P276-20261029.md).
-- The reaper in tick() of the generic worker (server/worker.ts) fails the queued automation runs whose job failed:
--   UPDATE automation_runs r ... FROM jobs j WHERE j.id=r.job_id AND j.state='failed' AND r.state='queued'
-- automation_runs had no index on state or job_id, so each tick read every run for the few queued ones: 12 ms at
-- 50 899 runs, 147 ms at 508 909 (finished runs are never pruned). Queued runs are the ones in flight, so this index
-- holds a handful of entries and the reaper reads it whole and probes jobs by id.
-- Cost: state is in the predicate, so the run completion (queued -> done) is no longer a HOT update; on a copy of the
-- 29.10 load-run data 253 of 2 000 completions were HOT without the index, 0 with it.
-- Only this index is created; no table, column, trigger, function or grant changes.
CREATE INDEX automation_runs_queued_job ON public.automation_runs(job_id) WHERE state='queued';
