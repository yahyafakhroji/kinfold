// The opt-in impact test's two constants, on their own so `kinfold status`
// and the dashboard's data can name them without loading the daemon's route.

/** About 1 prompt in 10 goes without recall while the impact test is on. */
export const HOLDOUT_RATE = 0.1

/**
 * The agents whose turn usage Kinfold can read, so a held-out turn produces
 * something to compare. Every other agent keeps full recall: none loses
 * memory without yielding data.
 */
export const HOLDOUT_HOSTS: readonly string[] = ['claude-code']
