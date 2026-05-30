// A user-facing string declared away from its sink — the cross-file case.
// A line-by-line linter sees only a const string here and misses it.
export const paymentError = "Your payment could not be processed.";
