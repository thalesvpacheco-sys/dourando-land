-- NIRF provável para imóveis do SIGEF/SNCI sem NIRF vinculado ao código INCRA:
-- exatamente um imóvel no CAFIR com mesma UF, mesmo município, mesmo nome (sem acento, até 55 letras, como o CAFIR guarda)
-- e área até 20% diferente. Se houver dois ou mais candidatos, nenhum é usado.
BEGIN;
DELETE FROM cafir_provavel;
WITH sem AS (
  SELECT t.id, t.uf, upper(unaccent(trim(t.municipio))) AS mun, left(upper(unaccent(trim(t.name))), 55) AS nome, t.area_ha
  FROM territory_features t
  WHERE t.layer IN ('sigef', 'snci') AND t.name IS NOT NULL AND t.area_ha > 0
    AND NOT EXISTS (SELECT 1 FROM cafir_imoveis c WHERE c.sncr = t.raw->>'codigo_imovel_sncr')
), cand AS (
  SELECT s.id, c.nirf, c.nome, c.area_ha, count(*) OVER (PARTITION BY s.id) AS n
  FROM sem s
  JOIN cafir_imoveis c ON c.uf = s.uf AND upper(unaccent(trim(c.municipio))) = s.mun AND upper(unaccent(trim(c.nome))) = s.nome
   AND c.area_ha BETWEEN s.area_ha * 0.8 AND s.area_ha * 1.2
)
INSERT INTO cafir_provavel (feature_id, nirf, nome, area_ha)
SELECT id, nirf, nome, area_ha FROM cand WHERE n = 1;
COMMIT;
ANALYZE cafir_provavel;
