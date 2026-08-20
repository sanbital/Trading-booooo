#!/usr/bin/env python3
import json, os
from urllib.parse import urlencode
import psycopg
import binance_24h_logic_replay as replay

class DBHTTPResponse:
    def __init__(self,status,content):
        self.status_code=int(status)
        self.text=content or ''
        self.headers={}
    def json(self):
        return json.loads(self.text)

class DBHTTPSession:
    def __init__(self):
        self.conn=psycopg.connect(os.environ['SUPABASE_DB_URL'],autocommit=True)
        self.headers={}
    def get(self,url,params=None,timeout=20):
        full=url
        if params:
            full += ('&' if '?' in full else '?') + urlencode(params)
        with self.conn.cursor() as cur:
            cur.execute("select status, content from http_get(%s)",(full,))
            status,content=cur.fetchone()
        return DBHTTPResponse(status,content)

replay.requests.Session = DBHTTPSession
replay.main()
