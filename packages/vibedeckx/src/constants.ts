import { homedir } from "os";
import path from "path";

export const VIBEDECKX_HOME = path.join(homedir(), ".vibedeckx");
export const DB_PATH = path.join(VIBEDECKX_HOME, "data.sqlite");
export const DEFAULT_PORT = 5173;

/**
 * Oldest worker version the hub considers current. Phase 1
 * (docs/server-worker-compat-design.md §2): warning line only — workers below
 * it (or reporting no version at all) connect fine but get a hub-side log
 * warning. Rejection ("Phase 4") is deliberately not implemented until version
 * adoption is observable. Bump when a tunnel-contract deprecation completes.
 */
export const MIN_WORKER_VERSION = "0.0.0";

/**
 * Date the first version-reporting worker release (v0.3.3) was published to
 * npm. Anchor for the Phase 4 deprecation window: enforcement may only start
 * once a full window has passed since workers COULD report — before that,
 * "unknown" is simply "hasn't had a chance to upgrade yet".
 */
export const WORKER_VERSION_REPORTING_SINCE = "2026-08-03";
