export async function sendIdempotentPaymentActivation(
  request: () => Promise<Response>,
): Promise<Response> {
  try {
    const response = await request();
    if (response.status < 500) return response;
  } catch {
    // A lost response is safe to replay because the Worker reuses both the
    // PaymentIntent and Reader-operation idempotency keys for this attempt.
  }
  return request();
}
