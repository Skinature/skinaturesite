-- Browser details captured at checkout for the Meta Conversions API Purchase.
-- The Razorpay webhook usually finalises an order before the browser's verify
-- call arrives, and a webhook has no customer IP, user agent or Meta cookies, so
-- they are saved here while the customer's own request is in hand.
-- Temporary by design: cleared after the Purchase is sent, and on unpaid orders
-- by the daily cron after 7 days.
alter table public.orders add column if not exists browser_context jsonb;
