"""Isolated PostgreSQL fixtures only. Never accepts the production DB secret."""
import os, pathlib, re, subprocess
from urllib.parse import urlparse
ROOT=pathlib.Path(__file__).resolve().parents[2]
URL=os.environ['TEST_DATABASE_URL']
u=urlparse(URL)
assert u.hostname in ('localhost','127.0.0.1') and u.path=='/observability_test', 'ISOLATED_TEST_DATABASE_REQUIRED'
def sql(text):
    p=subprocess.run(['psql',URL,'-X','-v','ON_ERROR_STOP=1'],input=text,text=True,capture_output=True)
    if p.returncode: raise RuntimeError(p.stdout+p.stderr)
    return p.stdout+p.stderr
def function(path,name):
    text=(ROOT/path).read_text()
    m=re.search(r'create or replace function public\.'+re.escape(name)+r'\([\s\S]*?\bas\s+(\$[a-zA-Z_0-9]*\$)[\s\S]*?\1\s*;',text,re.I)
    assert m, name
    return m[0]
schema='''
SET max_stack_depth='128kB';
CREATE TABLE public.trading_positions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exchange text,quote_currency text,market text,base_asset text,state text,
 is_paper boolean DEFAULT false,profile_version integer,initial_quantity numeric DEFAULT 0,remaining_quantity numeric DEFAULT 0,
 average_entry_price numeric,planned_entry_price numeric,stop_price numeric,target_1 numeric,target_2 numeric,
 tick_size numeric,quantity_step numeric,min_notional_quote numeric,t1_allocation_pct numeric,t1_completed boolean,
 exit_policy text,intended_horizon_hours integer,max_holding_at timestamptz,opened_at timestamptz,closed_at timestamptz,
 realized_cost_quote numeric DEFAULT 0,paid_fees_quote numeric DEFAULT 0,fee_accounting_quality text,fee_accounting_version text,
 metadata jsonb DEFAULT '{}',created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE public.trading_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),position_id uuid,exchange text,quote_currency text,identifier text UNIQUE,
 exchange_order_id text,market text,side text,purpose text,order_type text,requested_price numeric,requested_volume numeric,
 requested_notional_quote numeric,state text,executed_volume numeric,average_fill_price numeric,executed_funds_quote numeric,
 paid_fee_quote numeric,fee_asset text,requested_at timestamptz,completed_at timestamptz,raw_response jsonb,
 fee_accounting_quality text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE public.exchange_trade_fills (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),exchange text,account_scope text,market text,exchange_trade_id bigint,
 exchange_order_id text,client_order_id text,side text,price numeric,quantity numeric,quote_amount numeric,base_asset text,
 quote_asset text,fee_asset text,fee_amount numeric DEFAULT 0,fee_quote_amount numeric DEFAULT 0,
 source text CHECK(source IN ('AUTOMATED','MANUAL','UNCLASSIFIED')),position_id uuid,bot_order_id uuid,
 accounting_status text,executed_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
 UNIQUE(exchange,account_scope,market,exchange_trade_id));
CREATE FUNCTION test_entry_minimum() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.exchange='binance_futures' AND NEW.requested_notional_quote<40 THEN
 RAISE EXCEPTION 'FUTURES_ENTRY_MARGIN_BELOW_40_USDT' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER entry_minimum BEFORE INSERT ON public.trading_orders FOR EACH ROW EXECUTE FUNCTION test_entry_minimum();
CREATE FUNCTION test_assert(ok boolean,message text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL:%',message; END IF; RAISE NOTICE 'PASS:%',message; END $$;
'''
manual='supabase/migrations/20260809004200_manual_buy_auto_exit.sql'
attribution='supabase/migrations/20260821143000_manual_futures_sell_attribution.sql'
baseline=schema+'\n'+function(manual,'manual_fill_quantum')+'\n'+function(manual,'adopt_manual_trade_fill')+'\n'+function(manual,'trg_adopt_manual_trade_fill')+'\n'+function(attribution,'enforce_futures_fill_order_attribution')+'''
CREATE TRIGGER attribution BEFORE INSERT OR UPDATE OF exchange_order_id,bot_order_id,position_id ON exchange_trade_fills
 FOR EACH ROW EXECUTE FUNCTION enforce_futures_fill_order_attribution();
CREATE TRIGGER adoption AFTER INSERT OR UPDATE OF source,position_id,bot_order_id ON exchange_trade_fills
 FOR EACH ROW WHEN (NEW.source='MANUAL' AND NEW.side='BUY' AND NEW.position_id IS NULL AND NEW.bot_order_id IS NULL)
 EXECUTE FUNCTION trg_adopt_manual_trade_fill();
'''
reproduction='''
SET max_stack_depth='128kB';
DO $$ BEGIN
 BEGIN
 INSERT INTO exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,side,price,quantity,quote_amount,source)
 VALUES('binance_futures','futures','TAOUSDT',1,'BUY',10,1,10,'MANUAL');
 RAISE EXCEPTION 'EXPECTED_MINIMUM_FAILURE_NOT_REPRODUCED';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS:baseline historical fill hits entry minimum'; END;
 BEGIN
 INSERT INTO exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,side,price,quantity,quote_amount,source)
 VALUES('binance_futures','futures','LTCUSDT',2,'BUY',100,1,100,'MANUAL');
 RAISE EXCEPTION 'EXPECTED_RECURSION_NOT_REPRODUCED';
 EXCEPTION WHEN SQLSTATE '54001' THEN RAISE NOTICE 'PASS:baseline attribution-adoption recursion reproduced'; END;
END $$;
SELECT test_assert((SELECT count(*)=0 FROM trading_positions),'baseline failures roll back managed positions');
'''
print(sql(baseline)); print(sql(reproduction))
migration=(ROOT/'supabase/migrations/20260908000100_separate_futures_ingestion_from_adoption.sql').read_text()
print(sql(migration)); print(sql(migration))
checks='''
INSERT INTO exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,side,price,quantity,quote_amount,source)
VALUES('binance_futures','futures','TAOUSDT',1,'BUY',10,1,10,'MANUAL'),
 ('binance_futures','futures','LTCUSDT',2,'BUY',100,1,100,'MANUAL');
SELECT test_assert((SELECT count(*)=2 FROM exchange_trade_fills WHERE source='UNCLASSIFIED' AND position_id IS NULL),'unowned historical futures recorded without guessed ownership');
SELECT test_assert((SELECT count(*)=0 FROM trading_positions) AND (SELECT count(*)=0 FROM trading_orders),'ingestion creates no managed positions or synthetic orders');
UPDATE exchange_trade_fills SET exchange_order_id=NULL,position_id=NULL;
SELECT test_assert((SELECT count(*)=2 FROM exchange_trade_fills) AND (SELECT count(*)=0 FROM trading_orders),'repeated upsert attribution is nonrecursive');
ALTER TABLE exchange_trade_fills DISABLE TRIGGER attribution;
UPDATE exchange_trade_fills SET source='MANUAL';
SELECT adopt_manual_trade_fill(id) FROM exchange_trade_fills;
SELECT test_assert((SELECT count(*)=0 FROM trading_positions),'direct futures adoption RPC remains inert');
ALTER TABLE exchange_trade_fills ENABLE TRIGGER attribution;
UPDATE exchange_trade_fills SET position_id=NULL;
INSERT INTO exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,side,price,quantity,quote_amount,source)
VALUES('binance','spot','ETHUSDT',3,'BUY',100,1,100,'MANUAL');
SELECT test_assert((SELECT count(*)=1 FROM trading_positions WHERE exchange='binance') AND
 (SELECT count(*)=1 FROM trading_orders WHERE exchange='binance'),'existing spot adoption preserved');
DO $$ DECLARE p uuid; o uuid; BEGIN
 INSERT INTO trading_positions(exchange,market,state,opened_at) VALUES('binance_futures','ETHUSDT','OPEN',now()-interval '1 hour') RETURNING id INTO p;
 INSERT INTO trading_orders(position_id,exchange,identifier,exchange_order_id,market,side,purpose,requested_notional_quote)
 VALUES(p,'binance_futures','test-bot','77','ETHUSDT','BUY','ENTRY',120) RETURNING id INTO o;
 INSERT INTO exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,exchange_order_id,side,price,quantity,quote_amount,source)
 VALUES('binance_futures','futures','ETHUSDT',4,'77','BUY',120,1,120,'UNCLASSIFIED');
 PERFORM test_assert((SELECT source='AUTOMATED' AND bot_order_id=o AND position_id=p FROM exchange_trade_fills WHERE exchange_trade_id=4),'exact bot order attribution preserved');
 INSERT INTO exchange_trade_fills(exchange,account_scope,market,exchange_trade_id,exchange_order_id,side,price,quantity,quote_amount,source)
 VALUES('binance_futures','futures','ETHUSDT',5,'78','SELL',120,0.1,12,'UNCLASSIFIED');
 PERFORM test_assert((SELECT source='MANUAL' AND position_id=p FROM exchange_trade_fills WHERE exchange_trade_id=5),'existing evidence-linked manual exit attribution preserved');
 BEGIN
 INSERT INTO trading_orders(exchange,market,requested_notional_quote) VALUES('binance_futures','TESTUSDT',10);
 RAISE EXCEPTION 'ENTRY_GUARD_WAS_WEAKENED';
 EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS:new-order minimum remains enforced'; END;
END $$;
'''
print(sql(checks))
print('PASS: PostgreSQL ingestion regression suite complete; fixture data only')
