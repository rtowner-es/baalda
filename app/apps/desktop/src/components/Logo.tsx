// Baalda brand logo — the official neural-connection wordmark (a node
// constellation forming the second "A"). Ink on light, chrome/silver on dark.

import wordmarkInk from "../assets/baalda-wordmark-ink.png";
import wordmarkSilver from "../assets/baalda-wordmark-silver.png";

/** The Baalda wordmark (neural mark in the second A). Ink version shows on
 *  the light theme, silver on dark — switched in App.css. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`wordmark ${className ?? ""}`} aria-label="Baalda">
      <img src={wordmarkInk} alt="" className="wordmark-img wordmark-ink" />
      <img src={wordmarkSilver} alt="" className="wordmark-img wordmark-silver" />
    </span>
  );
}
