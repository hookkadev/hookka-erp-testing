-- 0239_bom_master_templates_accessory.sql — allow the ACCESSORY category on
-- master BOM templates.
--
-- RECORD ONLY — deploys do not replay migration files. The load-bearing copy
-- is `ensureCategoryCheck` in src/api/routes/bom-master-templates.ts, awaited
-- at the top of both PUT handlers.
--
-- 0006 only allowed BEDFRAME/SOFA, so every Accessory master template save
-- from the BOM page was rejected.
ALTER TABLE bom_master_templates DROP CONSTRAINT IF EXISTS bom_master_templates_category_check;
ALTER TABLE bom_master_templates ADD CONSTRAINT bom_master_templates_category_check
  CHECK (category IN ('BEDFRAME','SOFA','ACCESSORY'));
