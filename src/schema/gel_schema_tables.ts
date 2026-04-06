export const GEL_SCHEMA_DDL = [
  // Core schema registry
  `CREATE TABLE IF NOT EXISTS gel_schema (
    id             TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    name           TEXT NOT NULL,
    name__internal TEXT NOT NULL,
    module         TEXT NOT NULL,
    abstract       INTEGER DEFAULT 0,
    builtin        INTEGER DEFAULT 0,
    internal       INTEGER DEFAULT 0,
    parent_ids     TEXT,
    metadata       TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_gel_schema_name ON gel_schema(name__internal)`,
  `CREATE INDEX IF NOT EXISTS idx_gel_schema_kind ON gel_schema(kind)`,
  `CREATE INDEX IF NOT EXISTS idx_gel_schema_module ON gel_schema(module)`,

  // Backend mapping
  `CREATE TABLE IF NOT EXISTS gel_backend (
    gel_id      TEXT PRIMARY KEY,
    sqlite_name TEXT,
    aspect      TEXT NOT NULL,
    is_shared   INTEGER DEFAULT 0
  )`,

  // Schema cache
  `CREATE TABLE IF NOT EXISTS gel_instdata (
    key  TEXT PRIMARY KEY,
    data TEXT
  )`,

  // Relationship tables

  // Inheritance: direct base relationships (ordered)
   `CREATE TABLE IF NOT EXISTS gel_bases (
     subject_id TEXT NOT NULL,
     object_id  TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    PRIMARY KEY (subject_id, idx)
  )`,

  // Full ancestor chain (transitive closure, ordered)
   `CREATE TABLE IF NOT EXISTS gel_ancestors (
     subject_id TEXT NOT NULL,
     object_id  TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    PRIMARY KEY (subject_id, idx)
  )`,

  // Annotations (subject → annotation with value)
   `CREATE TABLE IF NOT EXISTS gel_annotations (
     subject_id    TEXT NOT NULL,
     annotation_id TEXT NOT NULL,
    value         TEXT,
    PRIMARY KEY (subject_id, annotation_id)
  )`,

  // Ownership: which pointers belong to which types
   `CREATE TABLE IF NOT EXISTS gel_pointers (
     source_id  TEXT NOT NULL,
     pointer_id TEXT NOT NULL,
    PRIMARY KEY (source_id, pointer_id)
  )`,

  // Pointer source and target (for Link and Property)
   `CREATE TABLE IF NOT EXISTS gel_pointer_endpoints (
     pointer_id TEXT PRIMARY KEY,
     source_id  TEXT NOT NULL,
     target_id  TEXT NOT NULL
  )`,

  // Constraints on a subject
   `CREATE TABLE IF NOT EXISTS gel_subject_constraints (
     subject_id    TEXT NOT NULL,
     constraint_id TEXT NOT NULL,
    PRIMARY KEY (subject_id, constraint_id)
  )`,

  // Indexes on a subject
   `CREATE TABLE IF NOT EXISTS gel_subject_indexes (
     subject_id TEXT NOT NULL,
     index_id   TEXT NOT NULL,
    PRIMARY KEY (subject_id, index_id)
  )`,

  // Link properties (which properties belong to which links)
   `CREATE TABLE IF NOT EXISTS gel_link_properties (
     link_id     TEXT NOT NULL,
     property_id TEXT NOT NULL,
    PRIMARY KEY (link_id, property_id)
  )`,

  // Function parameter ordering
   `CREATE TABLE IF NOT EXISTS gel_function_params (
     function_id TEXT NOT NULL,
     param_id    TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    param_value TEXT,
    PRIMARY KEY (function_id, idx)
  )`,

  // Migration chain
   `CREATE TABLE IF NOT EXISTS gel_migration_parents (
     migration_id TEXT NOT NULL,
     parent_id    TEXT NOT NULL,
    PRIMARY KEY (migration_id, parent_id)
  )`,

  // Union/intersection composition
   `CREATE TABLE IF NOT EXISTS gel_type_union (
     type_id   TEXT NOT NULL,
     member_id TEXT NOT NULL,
    PRIMARY KEY (type_id, member_id)
  )`,

  `CREATE TABLE IF NOT EXISTS gel_type_intersection (
     type_id   TEXT NOT NULL,
     member_id TEXT NOT NULL,
    PRIMARY KEY (type_id, member_id)
  )`,

  // Access policies on a type
  `CREATE TABLE IF NOT EXISTS gel_type_policies (
     type_id   TEXT NOT NULL,
     policy_id TEXT NOT NULL,
    PRIMARY KEY (type_id, policy_id)
  )`,

  // Triggers on a type
  `CREATE TABLE IF NOT EXISTS gel_type_triggers (
     type_id    TEXT NOT NULL,
     trigger_id TEXT NOT NULL,
    PRIMARY KEY (type_id, trigger_id)
  )`,

  // Pointer rewrites
  `CREATE TABLE IF NOT EXISTS gel_pointer_rewrites (
     pointer_id TEXT NOT NULL,
     rewrite_id TEXT NOT NULL,
    PRIMARY KEY (pointer_id, rewrite_id)
  )`,

  // Function used globals (ordered)
  `CREATE TABLE IF NOT EXISTS gel_function_globals (
     function_id TEXT NOT NULL,
     global_id   TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    PRIMARY KEY (function_id, idx)
  )`,

  // Function required permissions (ordered)
  `CREATE TABLE IF NOT EXISTS gel_function_permissions (
     function_id   TEXT NOT NULL,
     permission_id TEXT NOT NULL,
    idx           INTEGER NOT NULL,
    PRIMARY KEY (function_id, idx)
  )`,

  // Tuple element ordering
  `CREATE TABLE IF NOT EXISTS gel_tuple_elements (
     tuple_id   TEXT NOT NULL,
     element_id TEXT NOT NULL,
    idx        INTEGER NOT NULL,
    PRIMARY KEY (tuple_id, idx)
  )`,

  // Collection type element types
  `CREATE TABLE IF NOT EXISTS gel_collection_element (
     collection_id TEXT NOT NULL,
     element_id    TEXT NOT NULL,
    PRIMARY KEY (collection_id)
  )`,

  // Alias target type
  `CREATE TABLE IF NOT EXISTS gel_alias_target (
     alias_id TEXT PRIMARY KEY,
     type_id  TEXT NOT NULL
  )`,

  // Global target type
  `CREATE TABLE IF NOT EXISTS gel_global_target (
     global_id TEXT PRIMARY KEY,
     type_id   TEXT NOT NULL
  )`,

  // Cast from/to types
  `CREATE TABLE IF NOT EXISTS gel_cast_types (
     cast_id TEXT PRIMARY KEY,
     from_id TEXT NOT NULL,
     to_id   TEXT NOT NULL
  )`,

  // Constraint subject
  `CREATE TABLE IF NOT EXISTS gel_constraint_subject (
     constraint_id TEXT PRIMARY KEY,
     subject_id    TEXT NOT NULL
  )`,

  // Access policy subject
  `CREATE TABLE IF NOT EXISTS gel_policy_subject (
     policy_id  TEXT PRIMARY KEY,
     subject_id TEXT NOT NULL
  )`,

  // Trigger subject
  `CREATE TABLE IF NOT EXISTS gel_trigger_subject (
     trigger_id TEXT PRIMARY KEY,
     subject_id TEXT NOT NULL
  )`,

  // Rewrite subject
  `CREATE TABLE IF NOT EXISTS gel_rewrite_subject (
     rewrite_id TEXT PRIMARY KEY,
     subject_id TEXT NOT NULL
  )`,
];

export const GEL_TABLE_NAMES = [
  "gel_schema",
  "gel_backend",
  "gel_instdata",
  "gel_bases",
  "gel_ancestors",
  "gel_annotations",
  "gel_pointers",
  "gel_pointer_endpoints",
  "gel_subject_constraints",
  "gel_subject_indexes",
  "gel_link_properties",
  "gel_function_params",
  "gel_migration_parents",
  "gel_type_union",
  "gel_type_intersection",
  "gel_type_policies",
  "gel_type_triggers",
  "gel_pointer_rewrites",
  "gel_function_globals",
  "gel_function_permissions",
  "gel_tuple_elements",
  "gel_collection_element",
  "gel_alias_target",
  "gel_global_target",
  "gel_cast_types",
  "gel_constraint_subject",
  "gel_policy_subject",
  "gel_trigger_subject",
  "gel_rewrite_subject",
];
