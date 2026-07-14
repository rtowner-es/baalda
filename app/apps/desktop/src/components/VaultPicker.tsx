import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { VaultInfo } from "../lib/ipc";
import * as ipc from "../lib/ipc";
import { useStore } from "../store";
import { BracketMark, Wordmark } from "./Logo";

// Springs tuned for small UI: snappy but soft-landing (no rubber-banding).
const SPRING = { type: "spring", stiffness: 300, damping: 24 } as const;
const SPRING_MARK = { type: "spring", stiffness: 320, damping: 15 } as const;

/** Orchestrated entrance: the card rises, then its children cascade in. */
const cardVariants = {
  hidden: { opacity: 0, y: 22, scale: 0.985 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...SPRING, staggerChildren: 0.07, delayChildren: 0.12 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: SPRING },
};

const markVariants = {
  hidden: { opacity: 0, scale: 0.4, rotate: -10 },
  show: { opacity: 1, scale: 1, rotate: 0, transition: SPRING_MARK },
};

/** Slow ambient drift for one aurora blob; each gets its own phase. */
function auroraDrift(dx: number, dy: number, duration: number) {
  return {
    x: [0, dx, -dx * 0.6, 0],
    y: [0, -dy, dy * 0.5, 0],
    scale: [1, 1.12, 0.94, 1],
    transition: { duration, repeat: Infinity, ease: "easeInOut" as const },
  };
}

export function VaultPicker() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<VaultInfo | null>(null);
  const reduceMotion = useReducedMotion();

  // Surface the last-opened vault as a one-tap "reopen" affordance.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const last = await ipc.getLastVault();
        if (alive) setRecent(last);
      } catch {
        /* no recent vault — ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function openVault(vault: VaultInfo | null) {
    if (!vault) return;
    useStore.getState().setVault(vault);
    await useStore.getState().refreshTree();
    await useStore.getState().refreshTitles();
  }

  async function pick() {
    setBusy(true);
    setError(null);
    try {
      const vault = await ipc.pickVault();
      await openVault(vault);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reopenRecent() {
    if (!recent) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.openVault(recent.path);
      await openVault(recent);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-picker">
      {/* Ambient aurora — three blurred color fields drifting very slowly. */}
      {!reduceMotion && (
        <div className="aurora" aria-hidden="true">
          <motion.span className="aurora-blob a1" animate={auroraDrift(60, 40, 26)} />
          <motion.span className="aurora-blob a2" animate={auroraDrift(-50, 55, 32)} />
          <motion.span className="aurora-blob a3" animate={auroraDrift(45, -35, 38)} />
        </div>
      )}

      <motion.div
        className="vault-picker-card"
        variants={cardVariants}
        initial={reduceMotion ? false : "hidden"}
        animate="show"
      >
        <motion.div
          className="vault-brand-mark"
          variants={markVariants}
          whileHover={reduceMotion ? undefined : { scale: 1.08, rotate: 3 }}
          whileTap={reduceMotion ? undefined : { scale: 0.94, rotate: -3 }}
          aria-hidden="true"
        >
          <BracketMark size={40} />
        </motion.div>

        <motion.h1 className="product-name" variants={itemVariants}>
          <Wordmark />
        </motion.h1>
        <motion.p className="tagline" variants={itemVariants}>
          Your notes are plain Markdown files on disk, synced, linked, and
          shared with your team.
        </motion.p>

        <motion.div className="vault-actions" variants={itemVariants}>
          <motion.button
            className="primary hero"
            disabled={busy}
            onClick={pick}
            whileHover={reduceMotion ? undefined : { scale: 1.04, y: -1 }}
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            transition={SPRING}
          >
            {busy ? "Opening…" : "Open vault"}
          </motion.button>

          {recent && (
            <motion.button
              className="recent-vault"
              disabled={busy}
              onClick={reopenRecent}
              title={recent.path}
              whileHover={reduceMotion ? undefined : { scale: 1.03, y: -1 }}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              transition={SPRING}
            >
              <span className="recent-label">Reopen</span>
              <strong>{recent.name}</strong>
            </motion.button>
          )}
        </motion.div>

        {error && <p className="error">{error}</p>}

        <motion.p className="hint" variants={itemVariants}>
          Choose any folder of <code>.md</code> files.
        </motion.p>
      </motion.div>
    </div>
  );
}
