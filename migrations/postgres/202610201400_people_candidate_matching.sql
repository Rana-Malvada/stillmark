SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Recognition candidates need not meet the stricter reference-quality gate.
-- Low-quality candidates use only named, confirmed, high-quality references.
-- Require three references, score >= 0.75 and a >= 0.12 margin for automatic
-- assignment; weaker matches (>= 0.60) require review. Existing configured
-- thresholds remain a floor. Never turn low-quality matches into references.
CREATE OR REPLACE FUNCTION face_worker.match(owner text, model text, auto_at real, review_at real) RETURNS integer
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE changed integer;
 BEGIN
 IF NOT (review_at>0 AND review_at<=auto_at AND auto_at<1) THEN RAISE EXCEPTION 'invalid thresholds'; END IF;
 WITH pending AS (
  SELECT f.face_id,f.embedding,f.quality_ok FROM public.faces f
  WHERE f.owner_username=owner AND f.model_version=model AND f.source='detected' AND NOT f.ignored
  AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id)),
 refs AS (
  SELECT a.person_id,r.embedding,(a.status='confirmed' AND p.name IS NOT NULL) AS named_reference FROM public.face_assignments a
  JOIN public.faces r ON r.face_id=a.face_id AND r.model_version=model AND r.quality_ok AND NOT r.ignored
  JOIN public.face_people p ON p.person_id=a.person_id AND NOT p.hidden
  WHERE a.owner_username=owner AND (a.status='confirmed' OR (p.name IS NULL AND a.status='auto'))),
 scored AS (
  SELECT x.face_id,x.person_id,x.quality_ok,count(*) AS reference_count,avg(x.sim)::real score FROM (
   SELECT pf.face_id,pf.quality_ok,rf.person_id,1-(pf.embedding<=>rf.embedding) sim,
    row_number() OVER (PARTITION BY pf.face_id,rf.person_id ORDER BY pf.embedding<=>rf.embedding) rank
   FROM pending pf CROSS JOIN refs rf
   WHERE (pf.quality_ok OR rf.named_reference)
   AND NOT EXISTS(SELECT FROM public.face_rejections j WHERE j.face_id=pf.face_id AND j.person_id=rf.person_id)) x
  WHERE x.rank<=3 GROUP BY x.face_id,x.person_id,x.quality_ok),
 ranked AS (
  SELECT s.*,row_number() OVER (PARTITION BY s.face_id ORDER BY s.score DESC) pick,
   lead(s.score) OVER (PARTITION BY s.face_id ORDER BY s.score DESC) runner_up FROM scored s),
 inserted AS (
  INSERT INTO public.face_assignments(face_id,person_id,owner_username,status,score)
  SELECT r.face_id,r.person_id,owner,
   -- Ambiguity between two people downgrades an automatic match to a suggestion.
   CASE WHEN r.score>=CASE WHEN r.quality_ok THEN auto_at ELSE greatest(auto_at,0.75) END
    AND (r.quality_ok OR r.reference_count>=3)
    AND (r.runner_up IS NULL OR r.score-r.runner_up>=CASE WHEN r.quality_ok THEN 0.08 ELSE 0.12 END)
    THEN 'auto' ELSE 'suggested' END,
   r.score
  FROM ranked r WHERE r.pick=1 AND r.score>=CASE WHEN r.quality_ok THEN review_at ELSE greatest(review_at,0.60) END
  ON CONFLICT(face_id) DO NOTHING RETURNING 1)
 SELECT count(*) INTO changed FROM inserted;
 RETURN changed;
 END $$;

