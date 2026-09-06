import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the DSH home directory.
 *
 * A machine may run several independent DSH installs side by side, each with
 * its own directory (sessions, storages, profiles, ...). The active install
 * advertises itself via `$DSH_HOME`, so every path the plugin touches MUST
 * derive from it. Only when the variable is absent (e.g. unit tests, very
 * old launchers) do we fall back to the default `~/.dsh` — mirroring core.
 */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".dsh");
}

/** `<DSH_HOME>/sessions` — where session logs live. */
export function sessionsDir(): string {
  return join(dshHome(), "sessions");
}

/** `<DSH_HOME>/storages` — where plugins persist local data. */
export function storagesDir(): string {
  return join(dshHome(), "storages");
}
