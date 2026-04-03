import { AppError } from "../errors.js";
import type { RuntimeDatabaseAdapter } from "../runtime/adapter.js";
import { parseDeclarativeSchema, type DeclarativeSchema } from "./declarative.js";
import {
  applyMigrationPlanWithOptions,
  calculateMigrationChecksum,
  planSchemaMigration,
  renderMigrationSQL,
  type MigrationPlan,
  type MigrationStep,
} from "./migrations.js";

interface ActiveMigrationDraft {
  migrationId?: string;
  description?: string;
  targetSchemaSource: string;
  targetSchema: DeclarativeSchema;
  plan: MigrationPlan;
}

interface RewriteSession {
  steps: MigrationStep[];
  savepoints: Map<string, MigrationStep[]>;
}

export type MigrationDescribeFormat = "ddl" | "json";

export interface StartMigrationParams {
  targetSchemaSource: string;
  migrationId?: string;
}

export interface CommitMigrationParams {
  migrationId?: string;
  expectChecksum?: string;
}

export interface RewriteDDLStep {
  description: string;
  sql: string;
}

export interface MigrationCommitResult {
  migrationId: string;
  checksum: string;
  sql: string;
  stepCount: number;
}

export interface MigrationSessionState {
  hasActiveMigration: boolean;
  hasRewriteSession: boolean;
  currentSchemaSource: string;
  activeMigrationId?: string;
  activeMigrationDescription?: string;
}

const cloneSteps = (steps: MigrationStep[]): MigrationStep[] => steps.map((step) => ({ ...step }));

export class MigrationSession {
  private currentSchemaSource: string;
  private currentSchema: DeclarativeSchema;
  private readonly initialSchemaSource: string;
  private readonly initialSchema: DeclarativeSchema;

  private activeMigration?: ActiveMigrationDraft;
  private rewriteSession?: RewriteSession;

  constructor(
    private readonly db: RuntimeDatabaseAdapter,
    options: {
      initialSchemaSource: string;
      currentSchemaSource?: string;
    },
  ) {
    this.initialSchemaSource = options.initialSchemaSource;
    this.initialSchema = parseDeclarativeSchema(options.initialSchemaSource);

    this.currentSchemaSource = options.currentSchemaSource ?? options.initialSchemaSource;
    this.currentSchema = parseDeclarativeSchema(this.currentSchemaSource);
  }

  getState(): MigrationSessionState {
    return {
      hasActiveMigration: Boolean(this.activeMigration),
      hasRewriteSession: Boolean(this.rewriteSession),
      currentSchemaSource: this.currentSchemaSource,
      activeMigrationId: this.activeMigration?.migrationId,
      activeMigrationDescription: this.activeMigration?.description,
    };
  }

  startMigration(params: StartMigrationParams): MigrationPlan {
    this.requireNoActiveMigration("Cannot start migration: another migration is already active");
    const targetSchema = parseDeclarativeSchema(params.targetSchemaSource);
    const plan = planSchemaMigration(this.currentSchema, targetSchema);
    this.activeMigration = {
      migrationId: params.migrationId,
      targetSchemaSource: params.targetSchemaSource,
      targetSchema,
      plan,
    };
    return plan;
  }

  applyAutomaticMigration(params: StartMigrationParams & CommitMigrationParams): MigrationCommitResult {
    this.startMigration({
      targetSchemaSource: params.targetSchemaSource,
      migrationId: params.migrationId,
    });
    return this.commitMigration({
      migrationId: params.migrationId,
      expectChecksum: params.expectChecksum,
    });
  }

  createMigration(migrationId?: string): { migrationId: string; checksum: string; sql: string } {
    const active = this.requireActiveMigration("Cannot create migration: no active migration");
    if (migrationId) {
      active.migrationId = migrationId;
    }

    const sql = renderMigrationSQL(active.plan);
    return {
      migrationId: active.migrationId ?? `auto:${calculateMigrationChecksum(active.plan)}`,
      checksum: calculateMigrationChecksum(active.plan),
      sql,
    };
  }

  setDescription(description: string): void {
    const active = this.requireActiveMigration("Cannot set description: no active migration");
    active.description = description;
  }

  populateMigration(): MigrationPlan {
    return this.requireActiveMigration("Cannot populate migration: no active migration").plan;
  }

  describeCurrentMigration(format: MigrationDescribeFormat = "ddl"): string | MigrationPlan {
    const active = this.requireActiveMigration("Cannot describe migration: no active migration");
    return format === "json" ? active.plan : renderMigrationSQL(active.plan);
  }

  commitMigration(params: CommitMigrationParams = {}): MigrationCommitResult {
    const active = this.requireActiveMigration("Cannot commit migration: no active migration");
    const migrationId = params.migrationId ?? active.migrationId;
    applyMigrationPlanWithOptions(this.db, active.plan, {
      migrationId,
      expectChecksum: params.expectChecksum,
    });

    this.currentSchema = active.targetSchema;
    this.currentSchemaSource = active.targetSchemaSource;
    this.activeMigration = undefined;
    this.rewriteSession = undefined;

    const checksum = calculateMigrationChecksum(active.plan);
    return {
      migrationId: migrationId ?? `auto:${checksum}`,
      checksum,
      sql: renderMigrationSQL(active.plan),
      stepCount: active.plan.steps.length,
    };
  }

  abortMigration(): void {
    this.requireActiveMigration("Cannot abort migration: no active migration");
    this.activeMigration = undefined;
    this.rewriteSession = undefined;
  }

  resetSchemaToInitial(migrationId = "reset_schema_to_initial"): MigrationCommitResult {
    this.activeMigration = undefined;
    this.rewriteSession = undefined;

    const plan = planSchemaMigration(this.currentSchema, this.initialSchema);
    applyMigrationPlanWithOptions(this.db, plan, { migrationId });
    this.currentSchema = this.initialSchema;
    this.currentSchemaSource = this.initialSchemaSource;

    return {
      migrationId,
      checksum: calculateMigrationChecksum(plan),
      sql: renderMigrationSQL(plan),
      stepCount: plan.steps.length,
    };
  }

  startMigrationRewrite(): void {
    const active = this.requireActiveMigration("Cannot start migration rewrite: no active migration");
    if (this.rewriteSession) {
      throw new AppError("E_RUNTIME", "Cannot start migration rewrite: rewrite session is already active", 1, 1);
    }

    this.rewriteSession = {
      steps: cloneSteps(active.plan.steps),
      savepoints: new Map(),
    };
  }

  applyMigrationRewriteDDL(step: RewriteDDLStep): void {
    const rewrite = this.requireRewriteSession("Cannot apply rewrite DDL: no active rewrite session");
    rewrite.steps.push({
      description: step.description,
      sql: step.sql,
    });
  }

  declareSavepoint(name: string): void {
    if (name.trim().length === 0) {
      throw new AppError("E_RUNTIME", "Savepoint name cannot be empty", 1, 1);
    }
    const rewrite = this.requireRewriteSession("Cannot declare savepoint: no active rewrite session");
    rewrite.savepoints.set(name, cloneSteps(rewrite.steps));
  }

  releaseSavepoint(name: string): void {
    const rewrite = this.requireRewriteSession("Cannot release savepoint: no active rewrite session");
    if (!rewrite.savepoints.has(name)) {
      throw new AppError("E_RUNTIME", `Savepoint '${name}' does not exist`, 1, 1);
    }
    rewrite.savepoints.delete(name);
  }

  rollbackToSavepoint(name: string): void {
    const rewrite = this.requireRewriteSession("Cannot rollback to savepoint: no active rewrite session");
    const snapshot = rewrite.savepoints.get(name);
    if (!snapshot) {
      throw new AppError("E_RUNTIME", `Savepoint '${name}' does not exist`, 1, 1);
    }

    rewrite.steps = cloneSteps(snapshot);
  }

  rollback(): void {
    this.requireRewriteSession("Cannot rollback: no active rewrite session");
    this.rewriteSession = undefined;
  }

  commitMigrationRewrite(): void {
    const active = this.requireActiveMigration("Cannot commit migration rewrite: no active migration");
    const rewrite = this.requireRewriteSession("Cannot commit migration rewrite: no active rewrite session");
    active.plan = {
      steps: cloneSteps(rewrite.steps),
    };
    this.rewriteSession = undefined;
  }

  executeMigrationCommand(command: string): unknown {
    const normalized = command.trim().replace(/;+$/, "");
    const lowered = normalized.toLowerCase();

    const startMatch = normalized.match(/^start\s+migration\s+to\s+(["'])([\s\S]*)\1$/i);
    if (startMatch) {
      return this.startMigration({ targetSchemaSource: startMatch[2] });
    }

    const createMatch = normalized.match(/^create\s+migration(?:\s+([A-Za-z0-9_.:-]+))?$/i);
    if (createMatch) {
      return this.createMigration(createMatch[1]);
    }

    const descriptionMatch = normalized.match(/^set\s+migration\s+description\s+(["'])([\s\S]*)\1$/i);
    if (descriptionMatch) {
      this.setDescription(descriptionMatch[2]);
      return { ok: true };
    }

    const savepointMatch = normalized.match(/^declare\s+savepoint\s+([A-Za-z0-9_.:-]+)$/i);
    if (savepointMatch) {
      this.declareSavepoint(savepointMatch[1]);
      return { ok: true };
    }

    const releaseMatch = normalized.match(/^release\s+savepoint\s+([A-Za-z0-9_.:-]+)$/i);
    if (releaseMatch) {
      this.releaseSavepoint(releaseMatch[1]);
      return { ok: true };
    }

    const rollbackToSavepointMatch = normalized.match(/^rollback\s+to\s+savepoint\s+([A-Za-z0-9_.:-]+)$/i);
    if (rollbackToSavepointMatch) {
      this.rollbackToSavepoint(rollbackToSavepointMatch[1]);
      return { ok: true };
    }

    if (lowered === "populate migration") {
      return this.populateMigration();
    }

    if (lowered === "describe current migration") {
      return this.describeCurrentMigration("ddl");
    }

    if (lowered === "describe current migration as ddl") {
      return this.describeCurrentMigration("ddl");
    }

    if (lowered === "describe current migration as json") {
      return this.describeCurrentMigration("json");
    }

    if (lowered === "commit migration") {
      return this.commitMigration();
    }

    if (lowered === "abort migration") {
      this.abortMigration();
      return { ok: true };
    }

    if (lowered === "reset schema to initial") {
      return this.resetSchemaToInitial();
    }

    if (lowered === "start migration rewrite") {
      this.startMigrationRewrite();
      return { ok: true };
    }

    if (lowered === "rollback") {
      this.rollback();
      return { ok: true };
    }

    if (lowered === "commit migration rewrite") {
      this.commitMigrationRewrite();
      return { ok: true };
    }

    throw new AppError("E_SYNTAX", `Unknown migration command '${command}'`, 1, 1);
  }

  private requireNoActiveMigration(message: string): void {
    if (this.activeMigration) {
      throw new AppError("E_RUNTIME", message, 1, 1);
    }
  }

  private requireActiveMigration(message: string): ActiveMigrationDraft {
    if (!this.activeMigration) {
      throw new AppError("E_RUNTIME", message, 1, 1);
    }
    return this.activeMigration;
  }

  private requireRewriteSession(message: string): RewriteSession {
    if (!this.rewriteSession) {
      throw new AppError("E_RUNTIME", message, 1, 1);
    }
    return this.rewriteSession;
  }
}
