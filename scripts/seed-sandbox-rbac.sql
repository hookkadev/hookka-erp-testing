-- ---------------------------------------------------------------------------
-- seed-sandbox-rbac.sql — fake data so permission gates can actually be tested
--
-- WHY THIS EXISTS
--   An empty database makes a working gate and a broken query look identical:
--   both return zero rows. Every denial test in the RBAC work needs rows that
--   a permitted role can see, so that a refusal is distinguishable from an
--   empty result. See docs/RBAC-REMEDIATION.md.
--
-- WHERE IT MAY RUN
--   SANDBOX ONLY — Supabase project cjnewpxxmiucwirlcqpj (hookka-sandbox).
--   It refuses to run against a populated database (see the guard below), but
--   do not rely on that: check which project you are connected to first.
--   NEVER staging (zaxygxwadidiqcphibma). NEVER production (vpwdqtsxexpiqxzweivd).
--
-- WHAT IT WRITES
--   8 workers, ~320 attendance records over the last ~10 weeks, ~200 working
--   hour entries, 12 leave requests. Every row has an id prefixed 'seed-'.
--   All names, IC numbers, phone numbers and bank details are invented.
--
-- IDEMPOTENT
--   Re-running deletes the previous 'seed-' rows first. To remove it entirely:
--     delete from working_hour_entries where id like 'seed-%';
--     delete from attendance_records  where id like 'seed-%';
--     delete from leaves              where id like 'seed-%';
--     delete from workers             where id like 'seed-%';
--
-- LOGINS ARE NOT SEEDED. Password hashes are PBKDF2 and belong to the app, not
--   to a SQL file. The sandbox already has SUPER_ADMIN, FINANCE, SALES, HR and
--   QA accounts, which is enough to exercise the gates. Add OFFICE / R_AND_D
--   through the app's user creation if you need them.
-- ---------------------------------------------------------------------------

begin;

-- Guard: refuse to touch anything that looks like real data. -----------------
do $$
declare
  n_att bigint;
  n_usr bigint;
begin
  select count(*) into n_att from attendance_records;
  select count(*) into n_usr from users;
  if n_att > 100 or n_usr > 50 then
    raise exception
      'REFUSING TO SEED: this database already holds % attendance rows and % users. That is not the sandbox. Check your connection.',
      n_att, n_usr;
  end if;
end $$;

-- Clean out any previous run. ------------------------------------------------
delete from working_hour_entries where id like 'seed-%';
delete from attendance_records  where id like 'seed-%';
delete from leaves              where id like 'seed-%';
delete from workers             where id like 'seed-%';

-- Workers. -------------------------------------------------------------------
insert into workers (
  id, emp_no, name, department_code, position, phone, status,
  basic_salary_sen, working_hours_per_day, working_days_per_month,
  join_date, ic_number, nationality, pay_mode, daily_rate_sen,
  annual_leave_entitlement_days, medical_leave_entitlement_days
) values
  ('seed-w01','SB-001','Test Worker Alpha',   'FOAM_CUTTING','Operator',  '000-0000001','ACTIVE',180000,9,26,'2024-01-15','000000-00-0001','MY','MONTHLY',0,14,14),
  ('seed-w02','SB-002','Test Worker Bravo',   'FOAM_CUTTING','Operator',  '000-0000002','ACTIVE',175000,9,26,'2024-03-01','000000-00-0002','MY','MONTHLY',0,12,14),
  ('seed-w03','SB-003','Test Worker Charlie', 'WAREHOUSING', 'Storekeeper','000-0000003','ACTIVE',195000,9,26,'2023-08-20','000000-00-0003','MY','MONTHLY',0,16,14),
  ('seed-w04','SB-004','Test Worker Delta',   'WAREHOUSING', 'Picker',    '000-0000004','ACTIVE',170000,9,26,'2025-02-10','000000-00-0004','MY','DAILY',7000,8,14),
  ('seed-w05','SB-005','Test Worker Echo',    'REPAIR',      'Technician','000-0000005','ACTIVE',210000,9,26,'2022-11-05','000000-00-0005','MY','MONTHLY',0,18,14),
  ('seed-w06','SB-006','Test Worker Foxtrot', 'MAINTENANCE', 'Technician','000-0000006','ACTIVE',205000,9,26,'2023-05-18','000000-00-0006','MY','MONTHLY',0,16,14),
  ('seed-w07','SB-007','Test Worker Golf',    'R_AND_D',     'Assistant', '000-0000007','ACTIVE',230000,9,26,'2024-07-01','000000-00-0007','MY','MONTHLY',0,14,14),
  ('seed-w08','SB-008','Test Worker Hotel',   'REPAIR',      'Operator',  '000-0000008','RESIGNED',165000,9,26,'2023-02-14','000000-00-0008','MY','MONTHLY',0,10,14);

-- Attendance: every weekday for the last 70 days, per active worker. ---------
-- Deterministic variation so reruns produce the same data: the pattern comes
-- from the day number and the worker number, not from random().
insert into attendance_records (
  id, employee_id, employee_name, department_code, department_name,
  date, clock_in, clock_out, status, working_minutes,
  production_time_minutes, efficiency_pct, overtime_minutes,
  dept_breakdown, notes, created_at, updated_at, org_id,
  clockinlat, clockinlng, clockinphoto
)
select
  'seed-att-' || w.id || '-' || to_char(d.day, 'YYYYMMDD'),
  w.id,
  w.name,
  w.department_code,
  initcap(replace(w.department_code, '_', ' ')),
  to_char(d.day, 'YYYY-MM-DD'),
  case when pat.kind = 'ABSENT' then null
       when pat.kind = 'LATE'   then '09:2' || (pat.seq % 10)::text
       else '08:0' || (pat.seq % 6)::text end,
  case when pat.kind = 'ABSENT' then null else '18:0' || (pat.seq % 5)::text end,
  pat.kind,
  case when pat.kind = 'ABSENT' then 0
       when pat.kind = 'LATE'   then 480
       else 540 + (pat.seq % 3) * 15 end,
  case when pat.kind = 'ABSENT' then 0 else 420 + (pat.seq % 5) * 12 end,
  case when pat.kind = 'ABSENT' then 0 else 78 + (pat.seq % 18) end,
  case when pat.seq % 7 = 0 then 90 when pat.seq % 11 = 0 then 60 else 0 end,
  '[]',
  case when pat.kind = 'ABSENT' then 'Seed data — unplanned absence' else '' end,
  to_char(d.day, 'YYYY-MM-DD') || 'T02:00:00.000Z',
  to_char(d.day, 'YYYY-MM-DD') || 'T11:00:00.000Z',
  'hookka',
  -- Balakong-ish coordinates, rounded. Fake, but plausible for the map view.
  3.0380 + (pat.seq % 5) * 0.0004,
  101.7420 + (pat.seq % 7) * 0.0004,
  -- A path only, no actual object in storage: enough to exercise the
  -- GET /:id/photo permission gate without planting an image.
  case when pat.seq % 4 = 0
       then 'seed/clock-in/' || w.id || '-' || to_char(d.day, 'YYYYMMDD') || '.jpg'
       else null end
from workers w
cross join lateral (
  select generate_series(current_date - 70, current_date - 1, interval '1 day')::date as day
) d
cross join lateral (
  select
    (extract(doy from d.day)::int + right(w.id, 1)::int) as seq
) s
cross join lateral (
  select
    case
      when (s.seq % 23) = 0 then 'ABSENT'
      when (s.seq % 9)  = 0 then 'LATE'
      else 'PRESENT'
    end as kind,
    s.seq as seq
) pat
where w.id like 'seed-%'
  and w.status = 'ACTIVE'
  and extract(isodow from d.day) between 1 and 5;

-- Working hour entries: one per attendance row for the production departments.
insert into working_hour_entries (
  id, attendance_id, worker_id, date, department_code, category,
  hours, notes, created_at, updated_at, org_id
)
select
  'seed-whe-' || a.id,
  a.id,
  a.employee_id,
  a.date,
  a.department_code,
  case when a.overtime_minutes > 0 then 'OVERTIME' else 'NORMAL' end,
  round((a.working_minutes / 60.0)::numeric, 2),
  '',
  a.date || 'T11:05:00.000Z',
  a.date || 'T11:05:00.000Z',
  'hookka'
from attendance_records a
where a.id like 'seed-%'
  and a.status <> 'ABSENT'
  and a.department_code in ('FOAM_CUTTING', 'WAREHOUSING', 'REPAIR');

-- Leave requests: a spread of statuses and types. ----------------------------
insert into leaves (
  id, worker_id, worker_name, type, start_date, end_date, days,
  status, reason, approved_by, created_at, updated_at, org_id
)
select
  'seed-lv-' || lpad(i::text, 2, '0'),
  w.id,
  w.name,
  (array['ANNUAL','MEDICAL','UNPAID','EMERGENCY'])[1 + (i % 4)],
  to_char(current_date - (i * 5), 'YYYY-MM-DD'),
  to_char(current_date - (i * 5) + (i % 3), 'YYYY-MM-DD'),
  1 + (i % 3),
  (array['APPROVED','PENDING','APPROVED','REJECTED'])[1 + (i % 4)],
  (array['Family matter','Medical appointment','Personal','Travel'])[1 + (i % 4)],
  case when (i % 4) in (0, 2) then 'seed-approver' else null end,
  to_char(current_date - (i * 5) - 3, 'YYYY-MM-DD') || 'T01:00:00.000Z',
  to_char(current_date - (i * 5) - 3, 'YYYY-MM-DD') || 'T01:00:00.000Z',
  'hookka'
from generate_series(1, 12) as i
join lateral (
  select id, name from workers
  where id like 'seed-%' and status = 'ACTIVE'
  order by id
  offset (i % 7) limit 1
) w on true;

commit;

-- What landed. ---------------------------------------------------------------
select 'workers'              as table, count(*) from workers             where id like 'seed-%'
union all select 'attendance_records',   count(*) from attendance_records where id like 'seed-%'
union all select 'working_hour_entries', count(*) from working_hour_entries where id like 'seed-%'
union all select 'leaves',               count(*) from leaves             where id like 'seed-%';
