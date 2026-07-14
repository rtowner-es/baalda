// OpenContext brand logo — a viewfinder "bracket mark": two rounded square
// brackets framing a dot. Brackets render in `currentColor` (set by the
// caller); the dot is the fixed brand green. See tokens.css --brand-*.

export function BracketMark({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      {/* Left bracket [ */}
      <path
        d="M42 26 H32 A8 8 0 0 0 24 34 V66 A8 8 0 0 0 32 74 H42"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Right bracket ] */}
      <path
        d="M58 26 H68 A8 8 0 0 1 76 34 V66 A8 8 0 0 1 68 74 H58"
        stroke="currentColor"
        strokeWidth="10"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Center dot */}
      <circle cx="50" cy="50" r="8" fill="var(--brand-green)" />
    </svg>
  );
}

/** The "[open]context" wordmark — brackets in brand green, words inherit. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="wm-bracket">[</span>open<span className="wm-bracket">]</span>context
    </span>
  );
}
