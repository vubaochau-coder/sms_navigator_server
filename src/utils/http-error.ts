/**
 * HTTP-aware error carrying the API error envelope fields
 * (`{ success: false, error: <CODE>, message }`) through the central
 * `errorHandler` middleware, which maps `err.status` / `err.code`.
 */
export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
