/**
 * Resolve a human-typed unit reference to its UnitPlan. Shared by the CLI
 * (`verify --unit`, `ledger set`) and the MCP tools so both accept the same
 * flexible forms: 1-based order, content id, exact/slugged label, or a member
 * module name.
 */

import { slug } from '../schema';
import { MigrationPlan, UnitPlan } from './index';

/** Resolve a unit by 1-based order, id, label, or member module name. */
export function resolveUnit(plan: MigrationPlan, query: string): UnitPlan | null {
  const q = query.trim();
  if (q === '') return null;
  const n = Number.parseInt(q, 10);
  if (Number.isInteger(n) && String(n) === q) {
    return plan.units.find((u) => u.order + 1 === n) ?? null;
  }
  const byId = plan.units.find((u) => u.id === q);
  if (byId) return byId;
  const qs = slug(q);
  const byLabel = plan.units.find((u) => u.label === q || slug(u.label) === qs);
  if (byLabel) return byLabel;
  return (
    plan.units.find((u) => u.modules.some((m) => m.moduleName === q || slug(m.moduleName) === qs)) ??
    plan.units.find((u) => slug(u.label).includes(qs)) ??
    null
  );
}
