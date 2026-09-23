from pathlib import Path
import hashlib
r=Path('.');s=r/'supabase/functions/_shared/gpt-final-review'
def replace(p,a,b):
 t=p.read_text();assert t.count(a)==1,(str(p),a[:60],t.count(a));p.write_text(t.replace(a,b))
replace(s/'contract.mjs',"GPT_FINAL_ENTRY_REVIEW_3_LATENCY","GPT_FINAL_ENTRY_REVIEW_4_FACTREF")
p=s/'openai.mjs'
replace(p,'MODEL,LIMITS,WIRE_OUTPUT_SCHEMA,compactInput,ensure,parseApiResponse,validateAnswer','MODEL,LIMITS,ensure,validateAnswer')
p.write_text("import {WIRE_OUTPUT_SCHEMA_V4 as WIRE_OUTPUT_SCHEMA,compactInputV4 as compactInput,parseApiResponseV4 as parseApiResponse} from './wire-v4.mjs';\n"+p.read_text())
replace(p,'boo-final-review-v3-latency','boo-final-review-v4-facts')
replace(p,'entry_final_review_v3_compact','entry_final_review_v4_factref')
p=s/'coordinator.mjs'
replace(p,'OUTPUT_SCHEMA,WIRE_OUTPUT_SCHEMA,canonical','OUTPUT_SCHEMA,canonical')
replace(p,'validateAnswer,parseApiResponse,ensure','validateAnswer,ensure')
p.write_text("import {WIRE_OUTPUT_SCHEMA_V4 as WIRE_OUTPUT_SCHEMA,parseApiResponseV4 as parseApiResponse} from './wire-v4.mjs';\n"+p.read_text())
p=s/'prompt.mjs';t=p.read_text();start=t.index('너는 현재 자동매매');t='export const SYSTEM_PROMPT = `'+t[start:]
t=t.replace('checked_claims에는 실제 확인한 원래 조건과 CURRENT_REACCELERATION을 기록한다.','k에는 실제 확인한 원래 조건과 CURRENT_REACCELERATION을 기록한다.')
t=t.replace('근거 field_path는 /original_model/metrics/필드, /original_model/factors/필드 또는 /current_market/metrics/필드다.','근거는 evidence_refs에 명시된 O_, F_, C_ 접두사의 식별자로만 선택한다. 배열 순서를 세지 않는다.')
t=t.replace('모든 observed_value와 unit은 해당 입력과 정확히 같아야 한다. 숫자를 새로 계산하지 않는다.','숫자와 단위를 출력에 복사하지 않는다. 서버가 선택한 근거의 입력값과 단위를 그대로 첨부한다. 없는 근거를 선택하거나 숫자를 새로 계산하지 않는다.')
t=t.replace('interpretation과 summary에는 숫자·목표가·기대수익·승률·확신 점수를 쓰지 말고 짧은 한국어로 작성한다.','해석과 요약 n에는 아라비아 숫자를 하나도 쓰지 않는다. 기간 표기나 분기 이름의 숫자도 금지한다. 예를 들어 기간은 단기·중기·최근 봉처럼 쓰고 목표가·수익률·승률은 제시하지 않는다.')
t=t.replace('checked_claims','k').replace('근거 경로','근거 식별자')
t=t.replace('export const SYSTEM_PROMPT = `','export const SYSTEM_PROMPT = `전송 형식: w는 FACTREF4, c는 candidate_id, h는 snapshot_hash, d는 최종 판정이다. k 항목의 i는 검토 조건, v는 검토 결과, e는 명시된 근거 식별자 배열이다. s와 o 항목은 p=근거 식별자와 n=짧은 해석만 담는다. m은 누락된 근거 식별자 배열이고 최상위 n은 짧은 한국어 요약이다. a나 observed_value 또는 unit 필드를 추가하지 않는다.\n')
p.write_text(t)
p=r/'development/gpt-final-review/tests/helpers.mjs'
replace(p,'decisionIdentity,MODEL,toWireAnswer','decisionIdentity,MODEL')
p.write_text("import {toWireV4 as toWireAnswer} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';\n"+p.read_text())
p=r/'development/gpt-final-review/tests/latency-v3.test.mjs'
p.write_text("import {WIRE_OUTPUT_SCHEMA_V4} from '../../../supabase/functions/_shared/gpt-final-review/wire-v4.mjs';\n"+p.read_text())
replace(p,'assert.deepEqual(a.text.format.schema,WIRE_OUTPUT_SCHEMA);','assert.deepEqual(a.text.format.schema,WIRE_OUTPUT_SCHEMA_V4);')
print('Fact-reference transport integrated. No deployment or trading commands.')
