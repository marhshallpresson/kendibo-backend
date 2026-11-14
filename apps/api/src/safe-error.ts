// Body for an unhandled error. In production a 5xx never exposes driver or
// internal details (e.g. a pg code/message); the full error stays in the logs.
export function errorBody(status: number, err: unknown, production: boolean): unknown {
  if (status >= 500 && production) {
    return { statusCode: status, error: 'Internal Server Error', message: 'Something went wrong. Please try again.' };
  }
  return err;
}
