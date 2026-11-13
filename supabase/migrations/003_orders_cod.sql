-- Cash on Delivery (client decision 2026-11-14). Additive only: existing orders
-- keep payment_method 'prepaid' and a zero COD fee, so nothing already stored changes.
--
-- A COD order skips Razorpay. It is confirmed at checkout with status 'cod'
-- (placed, cash not collected yet), moves to 'shipped' when dispatched, and
-- cod_paid_at is stamped when the admin records that the courier's remittance
-- arrived. Revenue reporting counts a COD order only once cod_paid_at is set.
alter table public.orders
  add column if not exists payment_method text not null default 'prepaid'
    check (payment_method in ('prepaid', 'cod'));
alter table public.orders
  add column if not exists cod_fee_paise integer not null default 0
    check (cod_fee_paise >= 0);
alter table public.orders
  add column if not exists cod_paid_at timestamptz;

-- Widen the status list with 'cod'. Every existing value stays valid.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('pending', 'paid', 'shipped', 'delivered', 'cancelled', 'cod'));
