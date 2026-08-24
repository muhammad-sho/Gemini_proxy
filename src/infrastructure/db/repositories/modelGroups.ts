import { getDb } from "../connection.js";

export type RoutingStrategy = "least_used" | "fastest" | "smartest" | "cost_optimized";

export interface ModelGroup {
  group_name: string;
  models: string[];
  description: string;
  routing_strategy: RoutingStrategy;
  created_at: number;
  updated_at: number;
}

export class ModelGroupRepository {
  private db = getDb();

  private stmtGetAll = this.db.prepare("SELECT * FROM model_groups ORDER BY group_name");
  private stmtGetByName = this.db.prepare("SELECT * FROM model_groups WHERE group_name = ?");
  private stmtInsert = this.db.prepare(`
    INSERT INTO model_groups (group_name, models, description, routing_strategy)
    VALUES (?, ?, ?, ?)
  `);
  private stmtUpdate = this.db.prepare(`
    UPDATE model_groups
    SET models = ?, description = ?, routing_strategy = ?, updated_at = ?
    WHERE group_name = ?
  `);
  private stmtDelete = this.db.prepare("DELETE FROM model_groups WHERE group_name = ?");

  findAll(): ModelGroup[] {
    const rows = this.stmtGetAll.all() as (ModelGroup & { models: string })[];
    return rows.map(row => ({
      ...row,
      models: JSON.parse(row.models)
    }));
  }

  findByName(groupName: string): ModelGroup | undefined {
    const row = this.stmtGetByName.get(groupName) as (ModelGroup & { models: string }) | undefined;
    if (!row) return undefined;
    return { ...row, models: JSON.parse(row.models) };
  }

  create(groupName: string, models: string[], description: string, routingStrategy: RoutingStrategy): ModelGroup {
    const now = Date.now();
    this.stmtInsert.run(groupName, JSON.stringify(models), description, routingStrategy);
    return {
      group_name: groupName,
      models,
      description,
      routing_strategy: routingStrategy,
      created_at: now,
      updated_at: now
    };
  }

  update(groupName: string, models: string[], description: string, routingStrategy: RoutingStrategy): boolean {
    const now = Date.now();
    const result = this.stmtUpdate.run(JSON.stringify(models), description, routingStrategy, now, groupName);
    return result.changes > 0;
  }

  delete(groupName: string): boolean {
    const result = this.stmtDelete.run(groupName);
    return result.changes > 0;
  }

  expandModels(groupNames: string[]): string[] {
    const allModels = new Set<string>();
    for (const groupName of groupNames) {
      const group = this.findByName(groupName);
      if (group) {
        for (const model of group.models) {
          allModels.add(model);
        }
      }
    }
    return Array.from(allModels);
  }
}