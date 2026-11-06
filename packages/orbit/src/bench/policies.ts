import { existsSync, readFileSync } from "node:fs";
import { PolicyDefinition, type PolicyDefinitionInput, PolicyList } from "../contracts/index.ts";
import { writePrivateJson } from "../lib/private-json.ts";

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
