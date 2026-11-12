// Which trades a provider's skills put them in. A skill is a category id
// ('borehole'), a service id ('svc_ac_general') or a skill tag ('hvac',
// catalog.service.requires_skill). Used to enroll a provider when they add a
// skill and when they are approved.
import { q } from '../../packages/database/db.js';

export async function categoriesForSkills(skills: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const raw of new Set(skills.map((s) => String(s).trim()).filter(Boolean))) {
    const cat = await q(`SELECT 1 FROM catalog.category WHERE id=$1 AND active`, [raw]).catch(() => []);
    if (cat[0]) { out.add(raw); continue; }
    const viaService = await q<{ category_id: string }>(
      `SELECT category_id FROM catalog.service WHERE id=$1 OR requires_skill=$1`, [raw],
    ).catch(() => []);
    for (const r of viaService) out.add(String(r.category_id));
  }
  return [...out];
}

/** The provider's own skills (service id or tag), as stored in provider.skill. */
export async function providerSkillCategories(providerId: string): Promise<string[]> {
  const rows = await q<{ skill: string }>(
    `SELECT COALESCE(skill_tag, service_id) AS skill FROM provider.skill WHERE provider_id=$1`, [providerId],
  ).catch(() => []);
  return categoriesForSkills(rows.map((r) => String(r.skill)));
}
