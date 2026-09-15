/**
 * An error carrying an HTTP status.
 *
 * Handlers throw these and the router renders them, so the happy path in each
 * handler stays a list of statements rather than a ladder of early returns
 * that build error responses by hand.
 */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
