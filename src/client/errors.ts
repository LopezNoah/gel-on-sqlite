// Error classes mirroring the gel-js driver's error hierarchy for the
// cardinality contracts the Client methods enforce. Names match gel-js so
// application code written against the real driver ports over unchanged.

export class GelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

// Query returned a number of elements incompatible with the method's
// cardinality contract (`querySingle` over a multi-element set, etc.).
export class ResultCardinalityMismatchError extends GelError {}

// `queryRequiredSingle` / `queryRequired` over an empty result set.
export class NoDataError extends GelError {}

// Client-side misuse (closed client, invalid options, …).
export class ClientError extends GelError {}

export class ClientClosedError extends ClientError {}
