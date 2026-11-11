import type {JsonValue} from '../../shared/pim-json';
/** SOURCE_CONTRACT2_ONLY. Exact contract6007 wire; namespace birth clarified, no active routes. */
export type UUID = string;
export type Version = string; // canonical unsigned decimal; product state and EMPTY dictionary namespace permit "0" when absent
export type Sha256 = string;
export type Utc6 = string; // YYYY-MM-DDTHH:mm:ss.ffffffZ

export const PIM_LIMITS = {
  categories: 500, definitions: 500, category_depth: 16,
  options_per_enum: 200, options_total: 5000, bindings_per_category: 50,
  values_per_product: 50, product_rows: 500, dictionary_changes: 100,
  request_bytes: 1048576, response_bytes: 2097152, preview_ttl_seconds: 900,
  page: 50,
} as const;

export type DefinitionShape =
  | { kind: 'text'; max_length: number }
  | { kind: 'decimal'; scale: number; unit: string | null; minimum: string | null; maximum: string | null }
  | { kind: 'boolean' }
  | { kind: 'enum'; options: Array<{ id: UUID; label: string; active: boolean }> };
export type Definition = {
  id: UUID; version: Version; name: string; active: boolean; shape: DefinitionShape;
};
export type Category = {
  id: UUID; version: Version; parent_id: UUID | null; name: string; active: boolean;
  bindings: Array<{ definition_id: UUID; required: boolean }>;
};
export type Value =
  | { definition_id: UUID; kind: 'text'; value: string }
  | { definition_id: UUID; kind: 'decimal'; value: string }
  | { definition_id: UUID; kind: 'boolean'; value: boolean }
  | { definition_id: UUID; kind: 'enum'; option_id: UUID };
// Unset is absence from the full replacement values array; boolean false is a real value.
export type Revision = {
  catalog_version: Version; dictionary_version: Version; schema_hash: Sha256;
};
export type Capabilities = { available: boolean; read_only: boolean; can_manage: boolean };
export type Dictionary = Capabilities & {
  catalog_id: UUID; revision: Revision; categories: Category[]; definitions: Definition[];
  effective_bindings: Array<{ category_id: UUID; definitions: Array<{
    definition_id: UUID; required: boolean; inherited_from: UUID[];
  }> }>;
  limits: typeof PIM_LIMITS;
};
export type ProductSource = Capabilities & {
  catalog_id: UUID; product_id: UUID; sku: string; name: string;
  revision: Revision; product_version: Version; state_version: Version; source_hash: Sha256;
  category_id: UUID | null; values: Value[];
  legacy: { category: string; attributes: Record<string, JsonValue> };
  effective_bindings: Dictionary['effective_bindings'][number]['definitions'];
};
export type ProductRow = {
  product_id: UUID; product_version: Version; state_version: Version; source_hash: Sha256;
  category_id: UUID | null; values: Value[];
};
export type DictionaryChange =
  | { kind: 'category_create'; id: UUID; parent_id: UUID | null; name: string }
  | { kind: 'category_update'; id: UUID; version: Version; parent_id: UUID | null; name: string; active: boolean }
  | { kind: 'definition_create'; id: UUID; name: string; shape: DefinitionShape }
  | { kind: 'definition_update'; id: UUID; version: Version; name: string; active: boolean; shape: DefinitionShape }
  | { kind: 'category_bindings'; id: UUID; version: Version; bindings: Category['bindings'] };
export type PreviewInput =
  | { kind: 'dictionary'; client_key: UUID; revision: Revision; changes: DictionaryChange[] }
  | { kind: 'product_values'; client_key: UUID; revision: Revision; rows: ProductRow[] };
export type RowError = { row: number; field: string; code: string; definition_id: UUID | null };
export type Preview = Capabilities & {
  id: UUID; catalog_id: UUID; actor_id: UUID; kind: PreviewInput['kind']; client_key: UUID;
  revision: Revision; request: PreviewInput; scope_hash: Sha256; created_at: Utc6; expires_at: Utc6;
  ready: boolean; can_apply: boolean; reused: boolean; operation_id: UUID | null;
  errors: RowError[];
  product_rows: Array<{ index: number; before: ProductSource; after: ProductRow; changed: boolean }>;
  dictionary_before: Dictionary | null; dictionary_after: Dictionary | null;
};
export type ApplyInput = { client_key: UUID; scope_hash: Sha256; confirmed: true };
export type Operation = Capabilities & {
  id: UUID; preview_id: UUID; catalog_id: UUID; actor_id: UUID; kind: PreviewInput['kind'];
  scope_hash: Sha256; created_at: Utc6; reused: boolean; changed_count: number;
  product_rows: Array<{ product_id: UUID; before: ProductRow; after: ProductRow }>;
  dictionary_before: Dictionary | null; dictionary_after: Dictionary | null;
};
export type History = { data: Array<{
  id: UUID; kind: PreviewInput['kind']; created_at: Utc6;
  operation_id: UUID | null; ready: boolean;
}>; meta: { cursor: UUID | null; limit: 50 } };

/** GET never creates a namespace. dictionary_version="0" requires categories/definitions/effective_bindings all empty; first approved dictionary apply creates version="1". Real category/definition/catalog/product versions stay positive. */
