SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Keep eligibility/reference evaluation out of the face/reference cross product.
-- Aggregate and rank references for one candidate before proceeding to the next:
-- intermediate memory scales with one owner's references, not batch * references.
-- Matching thresholds, distinct-photo consensus, rejections and confirmed protections
-- are identical to the previous matcher; batch size and timeouts are unchanged.
CREATE OR REPLACE FUNCTION face_worker.match_candidates(owner text, model text, auto_at real, review_at real, candidates bigint[]) RETURNS integer
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE changed integer;
 BEGIN
 IF NOT (review_at>0 AND review_at<=auto_at AND auto_at<1) THEN RAISE EXCEPTION 'invalid thresholds'; END IF;
 WITH pending AS MATERIALIZED (
  SELECT f.face_id,f.photo_id,f.embedding,f.quality_ok, EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id) AS grouped FROM public.faces f
  WHERE f.owner_username=owner AND f.model_version=model AND f.source='detected' AND NOT f.ignored
  AND f.embedding IS NOT NULL AND (candidates IS NULL OR f.face_id=ANY(candidates))
  AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id
    AND NOT (a.status IN ('auto','suggested') AND EXISTS(
      SELECT FROM public.face_people p WHERE p.person_id=a.person_id
       AND p.owner_username=owner AND p.name IS NULL AND NOT p.hidden)))),
 refs AS MATERIALIZED (
  SELECT a.person_id,r.photo_id,r.embedding,(a.status='confirmed' AND p.name IS NOT NULL) AS named_reference FROM public.face_assignments a
  JOIN public.faces r ON r.face_id=a.face_id AND r.model_version=model AND NOT r.ignored AND r.embedding IS NOT NULL
  JOIN public.face_people p ON p.person_id=a.person_id AND NOT p.hidden
  WHERE a.owner_username=owner AND r.owner_username=owner AND p.owner_username=owner AND ((a.status='confirmed' AND (p.name IS NOT NULL OR r.quality_ok)) OR (p.name IS NULL AND a.status='auto' AND r.quality_ok))),
 scored AS (
  SELECT pf.face_id,pf.quality_ok,pf.grouped,s.person_id,s.named_reference,s.reference_count,s.score
  FROM pending pf CROSS JOIN LATERAL (
   SELECT x.person_id,x.named_reference,count(*) AS reference_count,avg(x.sim)::real AS score
   FROM (
    SELECT pp.*,row_number() OVER (PARTITION BY pp.person_id ORDER BY pp.sim DESC) AS rank
    FROM (
     SELECT rf.person_id,rf.photo_id,rf.named_reference,max(1-(pf.embedding<=>rf.embedding)) AS sim
     FROM refs rf
     WHERE (NOT pf.grouped OR rf.named_reference) AND (pf.quality_ok OR rf.named_reference)
      AND pf.photo_id<>rf.photo_id
      AND NOT EXISTS(SELECT FROM public.face_rejections j WHERE j.face_id=pf.face_id AND j.person_id=rf.person_id)
     GROUP BY rf.person_id,rf.photo_id,rf.named_reference
    ) pp
   ) x WHERE x.rank<=3 GROUP BY x.person_id,x.named_reference
  ) s),
 ranked AS (
  SELECT s.*,row_number() OVER (PARTITION BY s.face_id ORDER BY s.score DESC) pick,
   lead(s.score) OVER (PARTITION BY s.face_id ORDER BY s.score DESC) runner_up FROM scored s),
 inserted AS (
  INSERT INTO public.face_assignments(face_id,person_id,owner_username,status,score)
  SELECT r.face_id,r.person_id,owner,
   -- Ambiguity between two people downgrades an automatic match to a suggestion.
   CASE WHEN r.score>=CASE WHEN NOT r.named_reference THEN auto_at ELSE greatest(auto_at,0.75) END
    AND (NOT r.named_reference OR r.reference_count>=3)
    AND (r.runner_up IS NULL OR r.score-r.runner_up>=CASE WHEN NOT r.named_reference THEN 0.08 ELSE 0.12 END)
    THEN 'auto' ELSE 'suggested' END,
   r.score
  FROM ranked r WHERE r.pick=1 AND r.score>=CASE WHEN NOT r.named_reference THEN review_at ELSE greatest(review_at,0.60) END
  AND (NOT r.grouped OR (r.score>=greatest(auto_at,0.75) AND r.reference_count>=3
    AND (r.runner_up IS NULL OR r.score-r.runner_up>=0.12)))
  ON CONFLICT(face_id) DO UPDATE SET person_id=EXCLUDED.person_id,status=EXCLUDED.status,score=EXCLUDED.score
   WHERE face_assignments.owner_username=owner AND face_assignments.status IN ('auto','suggested')
    AND EXISTS(SELECT FROM public.face_people p WHERE p.person_id=face_assignments.person_id
      AND p.owner_username=owner AND p.name IS NULL AND NOT p.hidden)
    AND EXCLUDED.status='auto'
  RETURNING 1)
 SELECT count(*) INTO changed FROM inserted;
 RETURN changed;
 END $$;
