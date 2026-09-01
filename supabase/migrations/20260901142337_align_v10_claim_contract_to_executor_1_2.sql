do $block$
declare
  v_def text;
begin
  v_def := pg_get_functiondef('public.claim_v10_lane_signal_v3()'::regprocedure);

  if position('V10-LANE-EXECUTOR-1.1.0' in v_def) = 0 then
    raise exception 'EXPECTED_EXECUTOR_1_1_IDENTITY_NOT_FOUND';
  end if;
  if position('18c1f8d1ac0ec4b0387894a58965eadfc7ebb943587ccb2bac4d7e326f076f35' in v_def) = 0 then
    raise exception 'EXPECTED_EXECUTOR_1_1_SHA_NOT_FOUND';
  end if;

  v_def := replace(
    v_def,
    'V10-LANE-EXECUTOR-1.1.0',
    'V10-LANE-EXECUTOR-1.2.0'
  );
  v_def := replace(
    v_def,
    '18c1f8d1ac0ec4b0387894a58965eadfc7ebb943587ccb2bac4d7e326f076f35',
    '3d392cc71c8ea6d56834ec4aa2d1d2efe715082d658e4dd0e6a03509c7a4c016'
  );

  execute v_def;
end
$block$;
