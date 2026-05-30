// Real-codebase traps the Excalidraw benchmark surfaced (next-steps bug-fixes):
//  - SVG/CSS presentation attributes (`viewBox`, `d`, `transform`) carry
//    geometry, never copy — wrapping them is a precision bug.
//  - An identifier-shaped attribute-sink value (`aria-label="Shade"`) is real
//    UI copy that a naive IDENT_SHAPE skip silently drops.
export const ShadeIcon = ({ color }: { color: string }) => (
  <svg viewBox="0 0 24 24" aria-label="Shade">
    <path d="M4 4h16v16H4z" transform="translate(2 2)" fill={color} />
  </svg>
);
