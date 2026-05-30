// The cross-file string flows into a registered component sink (<Toast>),
// and a registered function sink (alert) is called directly. Both are
// user-facing; both require looking past a single JSX literal.
import { paymentError } from "./lib";

export const Checkout = () => {
  return <Toast message={paymentError} />;
};

export function confirmSaved() {
  alert("Your changes have been saved.");
}
