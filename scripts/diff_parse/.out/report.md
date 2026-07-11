# sqlite-ts ↔ Gel parser differential

Corpus: 716 snippets from tests/test_edgeql_syntax.py (Gel's parser is ground truth).

| quadrant | count |
|---|---|
| ✅ agree accept | 469 |
| ✅ agree reject | 242 |
| ❌ **GAP** (Gel accepts, sqlite-ts rejects) | **0** |
| ⚠️ over-accept (Gel rejects, sqlite-ts accepts) | 5 |

**Acceptance parity: 469/469 = 100.0%** of snippets Gel accepts also parse in sqlite-ts.

> ⚠️ Acceptance is a WEAK signal: sqlite-ts's parser is lenient and routes many
> statements through coarse buckets (a single `ddl` kind, the `select_expr` bare-expr
> wrapper). The sharper question — *does it build the right node?* — is below.

## Production faithfulness — the real worklist

Of the 469 both-accept snippets, **210 parse into a sqlite-ts kind that merges ≥2 distinct Gel productions** (fan-in > 1 below) — i.e. the parser accepts them but does not distinguish the grammar production. This is almost entirely DDL.

| sqlite-ts kind | snippets | distinct Gel productions (fan-in) |
|---|---|---|
| `ddl` ⚠️ | 175 | 45 |
| `describe` ⚠️ | 11 | 4 |
| `configure` ⚠️ | 5 | 3 |
| `(none)` ⚠️ | 7 | 2 |
| `transaction` ⚠️ | 10 | 2 |
| `describe+transaction` ⚠️ | 2 | 2 |
| `select_expr` | 156 | 1 |
| `select+select_expr` | 6 | 1 |
| `select` | 41 | 1 |
| `select_free` | 2 | 1 |
| `insert` | 9 | 1 |
| `update` | 5 | 1 |
| `group` | 13 | 1 |
| `insert+select_expr` | 2 | 1 |
| `delete` | 5 | 1 |
| `for` | 19 | 1 |
| `ddl+describe+transaction` | 1 | 1 |

### 45 Gel productions collapsed into `ddl` (→ split these out)

| count | Gel production |
|---|---|
| 33 | `AlterObjectType` |
| 29 | `CreateFunction` |
| 23 | `CreateObjectType` |
| 8 | `CreateMigration` |
| 6 | `CreateConstraint` |
| 6 | `CreateCast` |
| 5 | `CreateScalarType` |
| 5 | `CreateOperator` |
| 5 | `CreateGlobal` |
| 3 | `CreateDatabase` |
| 3 | `CreateRole` |
| 3 | `CreateExtensionPackage` |
| 3 | `CreateProperty` |
| 2 | `CreateDatabase+DropDatabase` |
| 2 | `DropDatabase` |
| 2 | `AlterRole` |
| 2 | `CreateExtension` |
| 2 | `CreateAnnotation` |
| 2 | `AlterConstraint` |
| 2 | `AlterFunction` |
| 2 | `CreateModule` |
| 2 | `CreateAlias` |
| 2 | `CreateIndex` |
| 2 | `CreateIndexMatch` |
| 1 | `DropRole` |
| 1 | `DropExtensionPackage` |
| 1 | `DropExtension` |
| 1 | `CreateFuture` |
| 1 | `DropFuture` |
| 1 | `CreatePseudoType` |
| 1 | `DropAnnotation` |
| 1 | `AlterAnnotation` |
| 1 | `AlterOperator` |
| 1 | `DropOperator` |
| 1 | `AlterCast` |
| 1 | `DropCast` |
| 1 | `AlterProperty` |
| 1 | `AlterProperty+CreateProperty+DropProperty` |
| 1 | `AlterLink+CreateLink+DropLink` |
| 1 | `AlterAlias+CreateAlias+DropAlias` |
| 1 | `AlterIndex` |
| 1 | `DropIndex` |
| 1 | `AlterGlobal+CreateGlobal+DropGlobal` |
| 1 | `AlterGlobal` |
| 1 | `DropIndexMatch` |

### 4 Gel productions collapsed into `describe` (→ split these out)

| count | Gel production |
|---|---|
| 8 | `DescribeStmt` |
| 1 | `AbortMigration+AlterCurrentMigrationRejectProposed+CommitMigration+DescribeCurrentMigration+PopulateMigration` |
| 1 | `SessionSetAliasDecl` |
| 1 | `SessionResetAliasDecl+SessionResetAllAliases+SessionResetModule` |

### 3 Gel productions collapsed into `configure` (→ split these out)

| count | Gel production |
|---|---|
| 2 | `ConfigSet` |
| 2 | `ConfigReset` |
| 1 | `ConfigInsert+ConfigReset+ConfigSet` |

### 2 Gel productions collapsed into `(none)` (→ split these out)

| count | Gel production |
|---|---|
| 5 | `(none)` |
| 2 | `SessionSetAliasDecl` |

### 2 Gel productions collapsed into `transaction` (→ split these out)

| count | Gel production |
|---|---|
| 8 | `StartMigration` |
| 2 | `StartTransaction` |

### 2 Gel productions collapsed into `describe+transaction` (→ split these out)

| count | Gel production |
|---|---|
| 1 | `AbortMigrationRewrite+CommitMigrationRewrite+StartMigration+StartMigrationRewrite` |
| 1 | `CommitTransaction+DeclareSavepoint+ReleaseSavepoint+RollbackToSavepoint+RollbackTransaction+StartTransaction` |
## GAP — snippets sqlite-ts outright rejects

None. sqlite-ts's parser accepts every snippet Gel accepts (it errs toward leniency, hence the 5 over-accepts). The divergence is structural, not acceptance — see *Production faithfulness* above.

## ⚠️ Over-acceptance samples (sqlite-ts accepts what Gel rejects)

- `test_edgeql_syntax_toplevel_if_01` (gel: EdgeQLSyntaxError: Unexpected keyword 'IF')
  > `ANALYZE IF true THEN (SELECT Foo) ELSE (INSERT Foo);`
- `test_edgeql_syntax_shape_45` (gel: EdgeQLSyntaxError: Missing ':')
  > `SELECT Foo { foo {} };`
- `test_edgeql_syntax_shape_46` (gel: EdgeQLSyntaxError: Missing ':')
  > `SELECT Foo { foo { bar } };`
- `test_edgeql_syntax_ddl_index_07` (gel: EdgeQLSyntaxError: Missing '{')
  > `CREATE ABSTRACT INDEX myindex1(conf: str = 'special'); CREATE ABSTRACT INDEX myindex2(val: int64); CREATE ABSTRACT INDEX`
- `test_edgeql_syntax_ddl_index_11` (gel: EdgeQLSyntaxError: Unexpected keyword 'ON')
  > `CREATE ABSTRACT INDEX std::btree ON anytype { USING SQL $$hash ((%) NULLS FIRST)$$; };`
