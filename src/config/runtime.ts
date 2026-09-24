import type { ConfigDoc, RuntimeConfig } from "../types";
import {
  applyRuntimeConfigPatch,
  configDocForRuntime,
  runtimeConfigFor,
} from "./document";

/** Owns runtime settings and returns detached snapshots. */
export class RuntimeConfiguration {
  private value: RuntimeConfig;

  /** Resolve saved settings and copy startup overrides. */
  constructor(
    configPath: string,
    doc: ConfigDoc,
    overrides: Partial<RuntimeConfig>,
  ) {
    this.value = applyRuntimeConfigPatch(
      runtimeConfigFor(configPath, doc),
      structuredClone(overrides),
    );
  }

  /** Return a detached copy of runtime settings. */
  snapshot(): RuntimeConfig {
    return structuredClone(this.value);
  }

  /** Apply overrides and return the updated snapshot. */
  update(patch: Partial<RuntimeConfig>): RuntimeConfig {
    this.value = applyRuntimeConfigPatch(
      this.value,
      structuredClone(patch),
    );
    return this.snapshot();
  }

  /** Return a detached copy of persistable settings. */
  persistedConfig(): ConfigDoc["config"] {
    return structuredClone(configDocForRuntime(this.value));
  }
}
