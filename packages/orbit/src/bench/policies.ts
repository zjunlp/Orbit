import { existsSync, readFileSync } from "node:fs";
import { PolicyDefinition, type PolicyDefinitionInput, PolicyList } from "../contracts/index.ts";
import { writePrivateJson } from "../lib/private-json.ts";
import { UserError } from "../runs/errors.ts";

/** What each model connector needs declared explicitly; a new connector adds one entry. */
const CONNECTOR_RULES: Record<PolicyDefinition["connector"], (d: PolicyDefinition) => string[]> = {
  "openpi-ws": () => [],
  "openvla-ws": (d) => [
    ...(d.replanSteps !== 8 || d.ioAdapter !== "libero-native"
      ? ["OpenVLA-OFT requires the explicit eight-step native LIBERO I/O recipe"]
      : []),
    ...(d.kind === "model" && d.randomness.backend !== "torch"
      ? ["OpenVLA-OFT models require a torch random-stream declaration"]
      : []),
  ],
  "groot-zmq": (d) => [
    ...(!d.replanSteps ||
    !d.ioAdapter ||
    (d.ioAdapter === "gr00t-flat" && !d.profile.action.order?.length)
      ? ["GR00T requires an explicit execution horizon and action ordering"]
      : []),
    ...(d.kind === "model" && (d.randomness.backend !== "torch" || !d.backboneDigest)
      ? ["GR00T models require a torch random-stream declaration and backbone digest"]
      : []),
  ],
};

export function connectorIssues(definition: PolicyDefinition): string[] {
  const issues = CONNECTOR_RULES[definition.connector](definition);
  if (definition.normalizationKey && definition.connector !== "openvla-ws")
    issues.push("normalizationKey is supported by the OpenVLA connector");
  if (definition.ioAdapter === "robotwin-native" && definition.connector !== "openpi-ws")
    issues.push("The native RoboTwin recipe requires the OpenPI connector");
  return issues;
}

/** Persisted only by daemon routes, alongside the existing benchmark registry. */
export class PolicyRegistry {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  list(): PolicyDefinition[] {
    if (!existsSync(this.file)) return [];
    return PolicyList.parse(JSON.parse(readFileSync(this.file, "utf8"))).policies;
  }

  get(name: string): PolicyDefinition | null {
    return this.list().find((p) => p.name === name) ?? null;
  }

  put(input: PolicyDefinitionInput): PolicyDefinition {
    const policy = PolicyDefinition.parse(input);
    const issues = connectorIssues(policy);
    if (issues.length) throw new UserError(issues.join("; "));
    const policies = [...this.list().filter((p) => p.name !== policy.name), policy];
    policies.sort((a, b) => a.name.localeCompare(b.name));
    writePrivateJson(this.file, { policies });
    return policy;
  }

  remove(name: string): boolean {
    const policies = this.list();
    const remaining = policies.filter((p) => p.name !== name);
    if (remaining.length === policies.length) return false;
    writePrivateJson(this.file, { policies: remaining });
    return true;
  }
}
