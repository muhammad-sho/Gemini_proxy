import { getDb } from "../connection.js";
import { randomUUID } from "crypto";

export type RoutingStrategy = "round_robin" | "least_used" | "fastest" | "smartest";
export const ROUTING_STRATEGIES: RoutingStrategy[] = ["round_robin", "least_used", "fastest", "smartest"];

/** One routing target: a specific credential serving a specific model. */
export interface GroupPair {
  credentialId: string;
  modelId: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  description: string;
  routingStrategy: RoutingStrategy;
  fallbackStrategy: RoutingStrategy | null;
  pairs: GroupPair[];
  createdAt: number;
  updatedAt: number;
}

interface GroupRow {
  id: string;
  name: string;
  description: string;
  routing_strategy: RoutingStrategy;
  fallback_strategy: RoutingStrategy | null;
  created_at: number;
  updated_at: number;
}

/**
 * Groups route over explicit credential×model pairs — key1/model1 and
 * key2/model1 are different targets. Client keys reference groups by name.
 */
export class ModelGroupRepository {
  private db = getDb();

  private stmtAll = this.db.prepare("SELECT * FROM model_groups ORDER BY name");
  private stmtById = this.db.prepare("SELECT * FROM model_groups WHERE id = ?");
  private stmtByName = this.db.prepare("SELECT * FROM model_groups WHERE name = ?");
  private stmtInsert = this.db.prepare(`
    INSERT INTO model_groups (id, name, description, routing_strategy, fallback_strategy)
    VALUES (?, ?, ?, ?, ?)
  `);
  private stmtUpdate = this.db.prepare(`
    UPDATE model_groups
    SET name = ?, description = ?, routing_strategy = ?, fallback_strategy = ?, updated_at = strftime('%s', 'now')
    WHERE id = ?
  `);
  private stmtDelete = this.db.prepare("DELETE FROM model_groups WHERE id = ?");
  private stmtPairsFor = this.db.prepare("SELECT credential_id, model_id FROM model_group_pairs WHERE group_id = ?");
  private stmtReplacePairs = this.db.prepare("DELETE FROM model_group_pairs WHERE group_id = ?");
  private stmtInsertPair = this.db.prepare(
    "INSERT OR IGNORE INTO model_group_pairs (group_id, credential_id, model_id) VALUES (?, ?, ?)"
  );

  private hydrate(row: GroupRow): ModelGroup {
    const pairs = (this.stmtPairsFor.all(row.id) as Array<{ credential_id: string; model_id: string }>).map(p => ({
      credentialId: p.credential_id,
      modelId: p.model_id
    }));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      routingStrategy: row.routing_strategy,
      fallbackStrategy: row.fallback_strategy,
      pairs,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  list(): ModelGroup[] {
    return (this.stmtAll.all() as GroupRow[]).map(row => this.hydrate(row));
  }

  byNames(names: string[]): ModelGroup[] {
    if (names.length === 0) return [];
    const found: ModelGroup[] = [];
    for (const name of names) {
      const row = this.stmtByName.get(name) as GroupRow | undefined;
      if (row) found.push(this.hydrate(row));
    }
    return found;
  }

  create(input: {
    name: string;
    description?: string;
    routingStrategy: RoutingStrategy;
    fallbackStrategy?: RoutingStrategy | null;
    pairs: GroupPair[];
  }): ModelGroup {
    const id = `mg_${randomUUID()}`;
    this.stmtInsert.run(id, input.name, input.description ?? "", input.routingStrategy, input.fallbackStrategy ?? null);
    this.setPairs(id, input.pairs);
    return this.get(id)!;
  }

  update(
    id: string,
    patch: Partial<Pick<ModelGroup, "name" | "description" | "routingStrategy" | "fallbackStrategy" | "pairs">>
  ): ModelGroup | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    this.stmtUpdate.run(
      patch.name ?? existing.name,
      patch.description ?? existing.description,
      patch.routingStrategy ?? existing.routingStrategy,
      patch.fallbackStrategy !== undefined ? patch.fallbackStrategy : existing.fallbackStrategy,
      id
    );
    if (patch.pairs) this.setPairs(id, patch.pairs);
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.stmtDelete.run(id);
    return result.changes > 0;
  }

  get(id: string): ModelGroup | undefined {
    const row = this.stmtById.get(id) as GroupRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  setPairs(groupId: string, pairs: GroupPair[]): void {
    const tx = this.db.transaction(() => {
      this.stmtReplacePairs.run(groupId);
      for (const pair of pairs) {
        this.stmtInsertPair.run(groupId, pair.credentialId, pair.modelId);
      }
    });
    tx();
  }

  /** Distinct model ids reachable through the named groups. */
  expandModelIds(groupNames: string[]): string[] {
    const ids = new Set<string>();
    for (const group of this.byNames(groupNames)) {
      for (const pair of group.pairs) ids.add(pair.modelId);
    }
    return [...ids];
  }

  /**
   * Credential ids allowed to serve `modelId` through the named groups, plus
   * the strategies of the first matching group (deterministic by client-key
   * group order).
   */
  resolveForModel(
    groupNames: string[],
    modelId: string
  ): { credentialIds: string[]; routingStrategy: RoutingStrategy; fallbackStrategy: RoutingStrategy | null } | null {
    for (const group of this.byNames(groupNames)) {
      const credentialIds = [...new Set(group.pairs.filter(p => p.modelId === modelId).map(p => p.credentialId))];
      if (credentialIds.length > 0) {
        return { credentialIds, routingStrategy: group.routingStrategy, fallbackStrategy: group.fallbackStrategy };
      }
    }
    return null;
  }
}
