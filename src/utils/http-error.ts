/**
 * HTTP-aware error carrying the API error envelope fields
 * (`{ success: false, error: <CODE>, message }`) through the central
 * `errorHandler` middleware, which maps `err.status` / `err.code`.
 */
export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  /**
   * Optional machine-readable fields merged into the error envelope, e.g.
   * `{ current_epoch }` on 409 EPOCH_OUTDATED so the client can self-heal
   * without an extra round-trip.
   */
  public readonly details?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
