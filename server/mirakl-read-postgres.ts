/** Separate, explicitly selected connector control database. No pool creation, migrations,
 * HTTP, roles or configuration at import. Never run this initializer against the OMS database. */
import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {ensure, Problem} from './errors';
import type {MiraklReadRepository, MiraklAccountCache} from './mirakl-channel';

export const MIRAKL_CONTROL_DATABASE = /^dynaminds_connector_state(?:_test_[0-9]{13})?$/;
const DAY=86400000;
const digest=z.string().regex(/^[a-f0-9]{64}$/), uuid=z.uuid();
const operation=z.enum(['A01','OR11','OF21']);
const milliseconds=z.number().int().nonnegative().safe();
const text=(max:number)=>z.string().min(1).max(max).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const accountSchema=z.strictObject({shop_id:z.number().int().positive().safe(),shop_name:text(200),
  currency_iso_code:z.enum(['PLN','EUR','USD','GBP','CZK']),shop_state:text(80),model:z.literal('MARKETPLACE')});
const entrySchema=z.strictObject({schema:z.literal('mirakl-a01-cache/v1'),accountKey:digest,
  observedAt:milliseconds,expiresAt:milliseconds,account:accountSchema});
function parse<T extends z.ZodType>(schema:T,value:unknown):z.output<T>{
  const result=schema.safeParse(value);ensure(result.success,422,'Mirakl: nieprawidłowy stan repozytorium');return result.data;
}
async function database(c:PoolClient){
  const {rows:[row]}=await c.query('SELECT current_database() name');
  ensure(MIRAKL_CONTROL_DATABASE.test(row.name),422,'Mirakl: wymagana oddzielna baza sterująca konektorami');
}
async function tx<T>(pool:Pick<Pool,'connect'>,work:(c:PoolClient)=>Promise<T>,owner=false):Promise<T>{
  let c:PoolClient;
  try{c=await pool.connect();}catch{throw new Problem(503,'Mirakl: sterująca baza jest niedostępna');}
  try{
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await database(c);
    await c.query("SET LOCAL statement_timeout='5s'");await c.query("SET LOCAL lock_timeout='3s'");
    if(!owner)await c.query('SET LOCAL ROLE dyna_app');
    const result=await work(c);await c.query('COMMIT');return result;
  }catch(e){try{await c.query('ROLLBACK');}catch{/* unknown outcome remains fenced */}
    if(e instanceof Problem)throw e;
    throw new Problem(503,'Mirakl: nie potwierdzono trwałego stanu odczytu');
  }finally{c.release();}
}

/** Fresh owner-only initialization. Existing schema is an error, never an implicit upgrade.
 * The existing cluster role is reused; this function never creates/alters global roles. */
export async function initializeMiraklReadPostgres(pool:Pick<Pool,'connect'>):Promise<void>{
  await tx(pool,async c=>{
    const {rows:[who]}=await c.query(`SELECT current_user=pg_get_userbyid(datdba) AND current_user<>'dyna_app' owner,
      EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dyna_app' AND NOT rolsuper AND NOT rolbypassrls) app_role
      FROM pg_database WHERE datname=current_database()`);
    ensure(who.owner&&who.app_role,403,'Mirakl: inicjalizacja wymaga właściciela bazy i istniejącej roli aplikacji');
    await c.query(`CREATE SCHEMA mirakl_control;
      REVOKE ALL ON SCHEMA mirakl_control FROM PUBLIC;
      CREATE TABLE mirakl_control.budgets(
        budget_key text PRIMARY KEY CHECK(budget_key ~ '^[a-f0-9]{64}$'),
        operation text NOT NULL CHECK(operation IN('A01','OR11','OF21')),
        not_before timestamptz NOT NULL, UNIQUE(budget_key,operation));
      CREATE TABLE mirakl_control.claims(
        id uuid PRIMARY KEY, budget_key text NOT NULL, account_key text NOT NULL CHECK(account_key ~ '^[a-f0-9]{64}$'),
        operation text NOT NULL CHECK(operation IN('A01','OR11','OF21')),
        created_at timestamptz NOT NULL, account_payload jsonb,
        FOREIGN KEY(budget_key,operation) REFERENCES mirakl_control.budgets(budget_key,operation),
        CHECK(account_payload IS NULL OR operation='A01'));
      CREATE TABLE mirakl_control.account_cache(
        account_key text PRIMARY KEY CHECK(account_key ~ '^[a-f0-9]{64}$'),
        claim_id uuid NOT NULL REFERENCES mirakl_control.claims(id),
        observed_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        account jsonb NOT NULL CHECK(jsonb_typeof(account)='object'),
        CHECK(expires_at=observed_at+interval '24 hours'));
      REVOKE ALL ON ALL TABLES IN SCHEMA mirakl_control FROM PUBLIC;
      REVOKE ALL ON SCHEMA mirakl_control FROM dyna_app;
      REVOKE ALL ON ALL TABLES IN SCHEMA mirakl_control FROM dyna_app;
      GRANT USAGE ON SCHEMA mirakl_control TO dyna_app;
      GRANT SELECT,INSERT,UPDATE ON mirakl_control.budgets,mirakl_control.claims,mirakl_control.account_cache TO dyna_app;`);
  },true);
}

/** Readiness only: no initialization, DDL, role creation or auto-repair. */
export async function verifyMiraklReadPostgres(pool:Pick<Pool,'connect'>):Promise<void>{
  await tx(pool,async c=>{
    const {rows:[role]}=await c.query('SELECT NOT rolsuper AND NOT rolbypassrls safe FROM pg_roles WHERE rolname=current_user');
    ensure(role?.safe,503,'Mirakl: niedozwolona rola repozytorium sterującego');
    const {rows:[schema]}=await c.query(`SELECT n.nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user) not_owner,
      has_schema_privilege(current_user,n.oid,'USAGE') can_use,
      NOT has_schema_privilege(current_user,n.oid,'CREATE') no_create,
      NOT EXISTS(SELECT FROM aclexplode(n.nspacl) WHERE grantee=0) no_public
      FROM pg_namespace n WHERE n.nspname='mirakl_control'`);
    ensure(schema&&schema.not_owner&&schema.can_use&&schema.no_create&&schema.no_public,
      503,'Mirakl: nieprawidłowa gotowość lub uprawnienia schematu sterującego');
    const {rows}=await c.query(`SELECT t.relname,
      t.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user) not_owner,
      NOT t.relrowsecurity AND NOT t.relforcerowsecurity no_rls,
      has_table_privilege(current_user,t.oid,'SELECT') AND has_table_privilege(current_user,t.oid,'INSERT')
        AND has_table_privilege(current_user,t.oid,'UPDATE') required,
      NOT has_table_privilege(current_user,t.oid,'DELETE') AND NOT has_table_privilege(current_user,t.oid,'TRUNCATE')
        AND NOT has_table_privilege(current_user,t.oid,'TRIGGER') AND NOT has_table_privilege(current_user,t.oid,'REFERENCES')
        AND NOT has_table_privilege(current_user,t.oid,'MAINTAIN') restricted,
      NOT EXISTS(SELECT FROM aclexplode(t.relacl) WHERE grantee=0) no_public
      FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='mirakl_control'
        AND t.relkind='r' AND t.relname IN('budgets','claims','account_cache')`);
    ensure(rows.length===3&&rows.every(r=>r.not_owner&&r.no_rls&&r.required&&r.restricted&&r.no_public),
      503,'Mirakl: nieprawidłowa gotowość lub uprawnienia tabel sterujących');
    // These keys are concurrency/identity guarantees, not optional performance
    // indexes. Projection/ACL alone would admit duplicate budgets after schema drift.
    const {rows:keys}=await c.query(`WITH required(table_name,column_name) AS (
        VALUES('budgets','budget_key'),('claims','id'),('account_cache','account_key'))
      SELECT r.table_name,EXISTS(
        SELECT FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attname=r.column_name
        JOIN pg_index i ON i.indrelid=t.oid
        WHERE n.nspname='mirakl_control' AND t.relname=r.table_name AND t.relkind='r'
          AND a.attnotnull AND NOT a.attisdropped
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indimmediate
          AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=1
          AND i.indkey[0]=a.attnum) exact_key FROM required r`);
    ensure(keys.length===3&&keys.every(k=>k.exact_key),503,'Mirakl: brak atomowych kluczy repozytorium sterującego');
    // Exact runtime projection must exist before enabling a reader. No probe writes.
    await c.query('SELECT budget_key,operation,not_before FROM mirakl_control.budgets LIMIT 0');
    await c.query('SELECT id,budget_key,account_key,operation,created_at,account_payload FROM mirakl_control.claims LIMIT 0');
    await c.query('SELECT account_key,claim_id,observed_at,expires_at,account FROM mirakl_control.account_cache LIMIT 0');
  });
}

/** Runtime uses short transactions under the existing restricted role, never the owner. */
export function createMiraklReadPostgresRepository(pool:Pick<Pool,'connect'>):MiraklReadRepository{
  ensure(pool&&typeof pool.connect==='function',422,'Mirakl: wymagany jawny pool sterującej bazy');
  return {
    async readAccount(key){
      parse(digest,key);
      return tx(pool,async c=>{
        const {rows:[row]}=await c.query(`SELECT account_key,account,
          (extract(epoch FROM observed_at)*1000)::bigint observed,
          (extract(epoch FROM expires_at)*1000)::bigint expires FROM mirakl_control.account_cache WHERE account_key=$1`,[key]);
        if(!row)return null;
        return parse(entrySchema,{schema:'mirakl-a01-cache/v1',accountKey:row.account_key,
          observedAt:Number(row.observed),expiresAt:Number(row.expires),account:row.account}) as MiraklAccountCache;
      });
    },
    async reserveRead(input){
      const v=parse(z.strictObject({budgetKey:digest,accountKey:digest,operation,now:milliseconds,notBefore:milliseconds}),input);
      const delta=v.notBefore-v.now, expected=v.operation==='A01'?DAY:v.operation==='OR11'?900000:0;
      ensure(delta===expected,422,'Mirakl: nieprawidłowy interwał odczytu');
      return tx(pool,async c=>{
        await c.query(`INSERT INTO mirakl_control.budgets(budget_key,operation,not_before)
          VALUES($1,$2,'epoch') ON CONFLICT DO NOTHING`,[v.budgetKey,v.operation]);
        const {rows:[budget]}=await c.query('SELECT operation FROM mirakl_control.budgets WHERE budget_key=$1 FOR UPDATE',[v.budgetKey]);
        ensure(budget.operation===v.operation,409,'Mirakl: budżet przypisany do innej operacji');
        // Read clock after acquiring the row lock; caller timestamps only supply a bounded duration.
        const {rows:[clock]}=await c.query(`SELECT date_trunc('milliseconds',clock_timestamp()) now`);
        const {rows:[state]}=await c.query(`SELECT GREATEST(0,ceil(extract(epoch FROM(not_before-$2::timestamptz))*1000))::bigint remaining
          FROM mirakl_control.budgets WHERE budget_key=$1`,[v.budgetKey,clock.now]);
        if(Number(state.remaining)>0)return {retryAt:v.now+Number(state.remaining)};
        const claimId=randomUUID();
        await c.query(`UPDATE mirakl_control.budgets SET not_before=GREATEST(not_before,$2::timestamptz+($3::bigint*interval '1 millisecond')) WHERE budget_key=$1`,[v.budgetKey,clock.now,delta]);
        await c.query(`INSERT INTO mirakl_control.claims(id,budget_key,account_key,operation,created_at) VALUES($1,$2,$3,$4,$5)`,
          [claimId,v.budgetKey,v.accountKey,v.operation,clock.now]);
        return {claimId};
      });
    },
    async deferRead(input){
      const v=parse(z.strictObject({claimId:uuid,budgetKey:digest,operation,now:milliseconds,notBefore:milliseconds}),input);
      const delta=v.notBefore-v.now;
      ensure(Number.isSafeInteger(delta)&&delta>=1000&&delta<=2147483647*1000,422,'Mirakl: nieprawidłowy cooldown');
      await tx(pool,async c=>{
        const {rows:[claim]}=await c.query('SELECT budget_key,operation FROM mirakl_control.claims WHERE id=$1',[v.claimId]);
        ensure(claim&&claim.budget_key===v.budgetKey&&claim.operation===v.operation,409,'Mirakl: cooldown bez własnej rezerwacji');
        await c.query('SELECT budget_key FROM mirakl_control.budgets WHERE budget_key=$1 FOR UPDATE',[v.budgetKey]);
        await c.query(`UPDATE mirakl_control.budgets SET not_before=GREATEST(not_before,
          date_trunc('milliseconds',clock_timestamp())+($2::bigint*interval '1 millisecond')) WHERE budget_key=$1`,[v.budgetKey,delta]);
      });
    },
    async storeAccount(input){
      const v=parse(z.strictObject({claimId:uuid,entry:entrySchema}),input);
      await tx(pool,async c=>{
        const {rows:[claim]}=await c.query(`SELECT account_key,operation,created_at,account_payload,
          account_payload=$2::jsonb same_payload FROM mirakl_control.claims WHERE id=$1 FOR UPDATE`,[v.claimId,JSON.stringify(v.entry.account)]);
        ensure(claim&&claim.operation==='A01'&&claim.account_key===v.entry.accountKey,409,'Mirakl: zapis tożsamości bez własnej rezerwacji A01');
        ensure(claim.account_payload===null||claim.same_payload,409,'Mirakl: rezerwacja A01 ma już inny wynik');
        await c.query('UPDATE mirakl_control.claims SET account_payload=$2::jsonb WHERE id=$1',[v.claimId,JSON.stringify(v.entry.account)]);
        await c.query(`INSERT INTO mirakl_control.account_cache(account_key,claim_id,observed_at,expires_at,account)
          VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '24 hours',$4::jsonb)
          ON CONFLICT(account_key) DO UPDATE SET claim_id=EXCLUDED.claim_id,observed_at=EXCLUDED.observed_at,
            expires_at=EXCLUDED.expires_at,account=EXCLUDED.account
          WHERE mirakl_control.account_cache.observed_at<EXCLUDED.observed_at`,
          [v.entry.accountKey,v.claimId,claim.created_at,JSON.stringify(v.entry.account)]);
      });
    },
  };
}
