/** NBP table A replies for the 227 tests. RECORDED: one live smoke read of api.nbp.pl on
 * 23.10.2026 (range 2026-10-09..2026-10-22, day 2026-10-16, Saturday 2026-10-17 → 404 text).
 * SYNTHETIC (shape of the recorded replies, invented table numbers and rates): holiday
 * ranges and a business day without a table. Tests never read the live network. */
export const RECORDED_RANGE_20261009_20261022 = "{\"table\":\"A\",\"currency\":\"euro\",\"code\":\"EUR\",\"rates\":[{\"no\":\"197/A/NBP/2026\",\"effectiveDate\":\"2026-10-09\",\"mid\":4.3775},{\"no\":\"198/A/NBP/2026\",\"effectiveDate\":\"2026-10-12\",\"mid\":4.3889},{\"no\":\"199/A/NBP/2026\",\"effectiveDate\":\"2026-10-13\",\"mid\":4.3806},{\"no\":\"200/A/NBP/2026\",\"effectiveDate\":\"2026-10-14\",\"mid\":4.3706},{\"no\":\"201/A/NBP/2026\",\"effectiveDate\":\"2026-10-15\",\"mid\":4.3691},{\"no\":\"202/A/NBP/2026\",\"effectiveDate\":\"2026-10-16\",\"mid\":4.3661},{\"no\":\"203/A/NBP/2026\",\"effectiveDate\":\"2026-10-19\",\"mid\":4.3702},{\"no\":\"204/A/NBP/2026\",\"effectiveDate\":\"2026-10-20\",\"mid\":4.3716},{\"no\":\"205/A/NBP/2026\",\"effectiveDate\":\"2026-10-21\",\"mid\":4.3641},{\"no\":\"206/A/NBP/2026\",\"effectiveDate\":\"2026-10-22\",\"mid\":4.3685}]}";
export const RECORDED_DAY_20261016 = "{\"table\":\"A\",\"currency\":\"euro\",\"code\":\"EUR\",\"rates\":[{\"no\":\"202/A/NBP/2026\",\"effectiveDate\":\"2026-10-16\",\"mid\":4.3661}]}";
export const RECORDED_SATURDAY_404_BODY = "404 NotFound - Not Found - Brak danych";
const reply = (rates: [string, string, string][]) => JSON.stringify({ table: 'A', currency: 'euro', code: 'EUR', rates: rates.map(([no, effectiveDate, mid]) => ({ no, effectiveDate, mid: Number(mid) })) }).replace(/"mid":([0-9.]+)/g, (_m, v) => '"mid":' + rates.find(r => Number(r[2]) === Number(v))![2]);
/** Christmas 2025: 24 (Wigilia, a public holiday since 2025), 25 and 26 December without a table. */
export const SYNTHETIC_CHRISTMAS_20251219_20251231 = reply([['245/A/NBP/2025', '2025-12-19', '4.2201'], ['246/A/NBP/2025', '2025-12-22', '4.2250'], ['247/A/NBP/2025', '2025-12-23', '4.2312'],
  ['248/A/NBP/2025', '2025-12-29', '4.2105'], ['249/A/NBP/2025', '2025-12-30', '4.2150'], ['250/A/NBP/2025', '2025-12-31', '4.2200']]);
/** 11 November 2025 (Tuesday, Independence Day) without a table. */
export const SYNTHETIC_NOVEMBER_20251107_20251114 = reply([['216/A/NBP/2025', '2025-11-07', '4.2480'], ['217/A/NBP/2025', '2025-11-10', '4.2510'], ['218/A/NBP/2025', '2025-11-12', '4.2470'],
  ['219/A/NBP/2025', '2025-11-13', '4.2433'], ['220/A/NBP/2025', '2025-11-14', '4.2400']]);
/** A business day (Wednesday 2026-03-04) on which NBP did not publish table A. */
export const SYNTHETIC_NO_TABLE_WEDNESDAY_20260302_20260306 = reply([['042/A/NBP/2026', '2026-03-02', '4.3000'], ['043/A/NBP/2026', '2026-03-03', '4.3010'],
  ['044/A/NBP/2026', '2026-03-05', '4.3020'], ['045/A/NBP/2026', '2026-03-06', '4.3030']]);
