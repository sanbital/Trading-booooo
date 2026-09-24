-- V30 is now the live front policy; the order-free shadow observer is retired.
select cron.unschedule('v30-front-shadow-30s');
