// GENERATED FROM the original EdgeDB error definitions
// DO NOT EDIT MANUALLY

export class EdgeDBError extends Error {
  public static readonly code: number = 0x00000000;

  constructor(message?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }

  public get code(): number {
    return (this.constructor as typeof EdgeDBError).code;
  }
}

export class EdgeDBMessage extends EdgeDBError {
  public static override readonly code: number = 0xF0000000;
}


export class InternalServerError extends EdgeDBError {
  public static override readonly code: number = 0x01000000;
}

export class UnsupportedFeatureError extends EdgeDBError {
  public static override readonly code: number = 0x02000000;
}

export class ProtocolError extends EdgeDBError {
  public static override readonly code: number = 0x03000000;
}

export class BinaryProtocolError extends ProtocolError {
  public static override readonly code: number = 0x03010000;
}

export class UnsupportedProtocolVersionError extends BinaryProtocolError {
  public static override readonly code: number = 0x03010001;
}

export class TypeSpecNotFoundError extends BinaryProtocolError {
  public static override readonly code: number = 0x03010002;
}

export class UnexpectedMessageError extends BinaryProtocolError {
  public static override readonly code: number = 0x03010003;
}

export class InputDataError extends ProtocolError {
  public static override readonly code: number = 0x03020000;
}

export class ParameterTypeMismatchError extends InputDataError {
  public static override readonly code: number = 0x03020100;
}

export class StateMismatchError extends InputDataError {
  public static override readonly code: number = 0x03020200;
}

export class ResultCardinalityMismatchError extends ProtocolError {
  public static override readonly code: number = 0x03030000;
}

export class CapabilityError extends ProtocolError {
  public static override readonly code: number = 0x03040000;
}

export class UnsupportedCapabilityError extends CapabilityError {
  public static override readonly code: number = 0x03040100;
}

export class DisabledCapabilityError extends CapabilityError {
  public static override readonly code: number = 0x03040200;
}

export class UnsafeIsolationLevelError extends CapabilityError {
  public static override readonly code: number = 0x03040300;
}

export class QueryError extends EdgeDBError {
  public static override readonly code: number = 0x04000000;
}

export class InvalidSyntaxError extends QueryError {
  public static override readonly code: number = 0x04010000;
}

export class EdgeQLSyntaxError extends InvalidSyntaxError {
  public static override readonly code: number = 0x04010100;
}

export class SchemaSyntaxError extends InvalidSyntaxError {
  public static override readonly code: number = 0x04010200;
}

export class GraphQLSyntaxError extends InvalidSyntaxError {
  public static override readonly code: number = 0x04010300;
}

export class InvalidTypeError extends QueryError {
  public static override readonly code: number = 0x04020000;
}

export class InvalidTargetError extends InvalidTypeError {
  public static override readonly code: number = 0x04020100;
}

export class InvalidLinkTargetError extends InvalidTargetError {
  public static override readonly code: number = 0x04020101;
}

export class InvalidPropertyTargetError extends InvalidTargetError {
  public static override readonly code: number = 0x04020102;
}

export class InvalidReferenceError extends QueryError {
  public static override readonly code: number = 0x04030000;
}

export class UnknownModuleError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030001;
}

export class UnknownLinkError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030002;
}

export class UnknownPropertyError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030003;
}

export class UnknownUserError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030004;
}

export class UnknownDatabaseError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030005;
}

export class UnknownParameterError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030006;
}

export class DeprecatedScopingError extends InvalidReferenceError {
  public static override readonly code: number = 0x04030007;
}

export class SchemaError extends QueryError {
  public static override readonly code: number = 0x04040000;
}

export class SchemaDefinitionError extends QueryError {
  public static override readonly code: number = 0x04050000;
}

export class InvalidDefinitionError extends SchemaDefinitionError {
  public static override readonly code: number = 0x04050100;
}

export class InvalidModuleDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050101;
}

export class InvalidLinkDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050102;
}

export class InvalidPropertyDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050103;
}

export class InvalidUserDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050104;
}

export class InvalidDatabaseDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050105;
}

export class InvalidOperatorDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050106;
}

export class InvalidAliasDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050107;
}

export class InvalidFunctionDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050108;
}

export class InvalidConstraintDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x04050109;
}

export class InvalidCastDefinitionError extends InvalidDefinitionError {
  public static override readonly code: number = 0x0405010A;
}

export class DuplicateDefinitionError extends SchemaDefinitionError {
  public static override readonly code: number = 0x04050200;
}

export class DuplicateModuleDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050201;
}

export class DuplicateLinkDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050202;
}

export class DuplicatePropertyDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050203;
}

export class DuplicateUserDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050204;
}

export class DuplicateDatabaseDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050205;
}

export class DuplicateOperatorDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050206;
}

export class DuplicateViewDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050207;
}

export class DuplicateFunctionDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050208;
}

export class DuplicateConstraintDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x04050209;
}

export class DuplicateCastDefinitionError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x0405020A;
}

export class DuplicateMigrationError extends DuplicateDefinitionError {
  public static override readonly code: number = 0x0405020B;
}

export class SessionTimeoutError extends QueryError {
  public static override readonly code: number = 0x04060000;
}

export class IdleSessionTimeoutError extends SessionTimeoutError {
  public static override readonly code: number = 0x04060100;
}

export class QueryTimeoutError extends SessionTimeoutError {
  public static override readonly code: number = 0x04060200;
}

export class TransactionTimeoutError extends SessionTimeoutError {
  public static override readonly code: number = 0x04060A00;
}

export class IdleTransactionTimeoutError extends TransactionTimeoutError {
  public static override readonly code: number = 0x04060A01;
}

export class ExecutionError extends EdgeDBError {
  public static override readonly code: number = 0x05000000;
}

export class InvalidValueError extends ExecutionError {
  public static override readonly code: number = 0x05010000;
}

export class DivisionByZeroError extends InvalidValueError {
  public static override readonly code: number = 0x05010001;
}

export class NumericOutOfRangeError extends InvalidValueError {
  public static override readonly code: number = 0x05010002;
}

export class AccessPolicyError extends InvalidValueError {
  public static override readonly code: number = 0x05010003;
}

export class QueryAssertionError extends InvalidValueError {
  public static override readonly code: number = 0x05010004;
}

export class IntegrityError extends ExecutionError {
  public static override readonly code: number = 0x05020000;
}

export class ConstraintViolationError extends IntegrityError {
  public static override readonly code: number = 0x05020001;
}

export class CardinalityViolationError extends IntegrityError {
  public static override readonly code: number = 0x05020002;
}

export class MissingRequiredError extends IntegrityError {
  public static override readonly code: number = 0x05020003;
}

export class TransactionError extends ExecutionError {
  public static override readonly code: number = 0x05030000;
}

export class TransactionConflictError extends TransactionError {
  public static override readonly code: number = 0x05030100;
}

export class TransactionSerializationError extends TransactionConflictError {
  public static override readonly code: number = 0x05030101;
}

export class TransactionDeadlockError extends TransactionConflictError {
  public static override readonly code: number = 0x05030102;
}

export class QueryCacheInvalidationError extends TransactionConflictError {
  public static override readonly code: number = 0x05030103;
}

export class WatchError extends ExecutionError {
  public static override readonly code: number = 0x05040000;
}

export class ConfigurationError extends EdgeDBError {
  public static override readonly code: number = 0x06000000;
}

export class AccessError extends EdgeDBError {
  public static override readonly code: number = 0x07000000;
}

export class AuthenticationError extends AccessError {
  public static override readonly code: number = 0x07010000;
}

export class AvailabilityError extends EdgeDBError {
  public static override readonly code: number = 0x08000000;
}

export class BackendUnavailableError extends AvailabilityError {
  public static override readonly code: number = 0x08000001;
}

export class ServerOfflineError extends AvailabilityError {
  public static override readonly code: number = 0x08000002;
}

export class UnknownTenantError extends AvailabilityError {
  public static override readonly code: number = 0x08000003;
}

export class ServerBlockedError extends AvailabilityError {
  public static override readonly code: number = 0x08000004;
}

export class BackendError extends EdgeDBError {
  public static override readonly code: number = 0x09000000;
}

export class UnsupportedBackendFeatureError extends BackendError {
  public static override readonly code: number = 0x09000100;
}

export class LogMessage extends EdgeDBMessage {
  public static override readonly code: number = 0xF0000000;
}

export class WarningMessage extends LogMessage {
  public static override readonly code: number = 0xF0010000;
}

export class StatusMessage extends LogMessage {
  public static override readonly code: number = 0xF0020000;
}

export class MigrationStatusMessage extends StatusMessage {
  public static override readonly code: number = 0xF0020001;
}

export const all = [
  'InternalServerError',
  'UnsupportedFeatureError',
  'ProtocolError',
  'BinaryProtocolError',
  'UnsupportedProtocolVersionError',
  'TypeSpecNotFoundError',
  'UnexpectedMessageError',
  'InputDataError',
  'ParameterTypeMismatchError',
  'StateMismatchError',
  'ResultCardinalityMismatchError',
  'CapabilityError',
  'UnsupportedCapabilityError',
  'DisabledCapabilityError',
  'UnsafeIsolationLevelError',
  'QueryError',
  'InvalidSyntaxError',
  'EdgeQLSyntaxError',
  'SchemaSyntaxError',
  'GraphQLSyntaxError',
  'InvalidTypeError',
  'InvalidTargetError',
  'InvalidLinkTargetError',
  'InvalidPropertyTargetError',
  'InvalidReferenceError',
  'UnknownModuleError',
  'UnknownLinkError',
  'UnknownPropertyError',
  'UnknownUserError',
  'UnknownDatabaseError',
  'UnknownParameterError',
  'DeprecatedScopingError',
  'SchemaError',
  'SchemaDefinitionError',
  'InvalidDefinitionError',
  'InvalidModuleDefinitionError',
  'InvalidLinkDefinitionError',
  'InvalidPropertyDefinitionError',
  'InvalidUserDefinitionError',
  'InvalidDatabaseDefinitionError',
  'InvalidOperatorDefinitionError',
  'InvalidAliasDefinitionError',
  'InvalidFunctionDefinitionError',
  'InvalidConstraintDefinitionError',
  'InvalidCastDefinitionError',
  'DuplicateDefinitionError',
  'DuplicateModuleDefinitionError',
  'DuplicateLinkDefinitionError',
  'DuplicatePropertyDefinitionError',
  'DuplicateUserDefinitionError',
  'DuplicateDatabaseDefinitionError',
  'DuplicateOperatorDefinitionError',
  'DuplicateViewDefinitionError',
  'DuplicateFunctionDefinitionError',
  'DuplicateConstraintDefinitionError',
  'DuplicateCastDefinitionError',
  'DuplicateMigrationError',
  'SessionTimeoutError',
  'IdleSessionTimeoutError',
  'QueryTimeoutError',
  'TransactionTimeoutError',
  'IdleTransactionTimeoutError',
  'ExecutionError',
  'InvalidValueError',
  'DivisionByZeroError',
  'NumericOutOfRangeError',
  'AccessPolicyError',
  'QueryAssertionError',
  'IntegrityError',
  'ConstraintViolationError',
  'CardinalityViolationError',
  'MissingRequiredError',
  'TransactionError',
  'TransactionConflictError',
  'TransactionSerializationError',
  'TransactionDeadlockError',
  'QueryCacheInvalidationError',
  'WatchError',
  'ConfigurationError',
  'AccessError',
  'AuthenticationError',
  'AvailabilityError',
  'BackendUnavailableError',
  'ServerOfflineError',
  'UnknownTenantError',
  'ServerBlockedError',
  'BackendError',
  'UnsupportedBackendFeatureError',
  'LogMessage',
  'WarningMessage',
  'StatusMessage',
  'MigrationStatusMessage',
] as const;

export type EdgeDBErrorName = (typeof all)[number];
