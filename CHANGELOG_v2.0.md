# CHANGELOG — v2.0.1

## v2.0.1 — GitHub 웹 전용 배포

- VS Code, PowerShell, Git, npm, 로컬 Supabase CLI가 필요 없는 설치 흐름으로 변경
- GitHub Actions 자동배포 파일 `.github/workflows/deploy-supabase.yml` 추가
- GitHub Repository Secrets에서 Supabase 연결·개인 접속 토큰을 안전하게 주입
- 함수 배포 시 `SCAN_ACCESS_TOKEN`, `ALLOWED_ORIGINS`, `DEEP_SCAN_LIMIT` 자동 설정
- GitHub 웹 편집기로 `docs/config.js`를 설정하는 단계별 가이드 제공
- 기존 시장 스캔·추천 로직은 v2.0.0과 동일

## v2.0.0 — 전체시장 기간 스캐너

## 구조 변경

- 수동 종목 선택 방식 제거
- 업비트 KRW 상장 종목 전체 자동 1차 스캔 도입
- 단일 시점 호가 분석에서 5분·15분·4시간·일봉 기간 분석으로 확장
- 기간분석 상위 후보에 최신 호가 4회·최근 체결을 결합하는 2단계 정밀검증 도입
- Supabase Auth 로그인 화면·소유자 이메일 설정·사용자 테이블 제거
- URL fragment 개인 토큰과 Edge Function Secret을 이용한 무화면 접근검증 도입

## 추천 결과 추가

- 현재 매수 후보 최대 3개
- 단기 목표가·중기 목표가
- 비용·슬리피지 반영 손절가격과 순손익비
- 위험예산 기반 추천 투입금
- 장중·단기·중기·중장기 보유 분류
- 추세 유지기간 범위와 무효화 조건
- GPT/Claude용 Markdown 전체 리포트 및 후보별 복사 버튼

## 안전장치

- 유의·주의·경고 종목 강제 제외
- 24시간 거래대금·최근 체결 최신성 필터
- 과열 RSI·당일 급등·과도한 EMA 이격 페널티
- 기간 데이터·스프레드·호가·체결 표본·손절폭·순손익비·점수 강제 게이트
- 모든 조건을 통과한 종목이 없을 때 `현재 매수 추천 없음` 반환
- WAIT/AVOID 종목의 진입가·목표가·손절가 UI 미제시
- 자동 주문 및 거래소 개인 API Key 코드 없음

## 데이터 범위

- 원화마켓 전 종목: 현재가·거래대금·시장경보 1차 점검
- 안전필터 통과 전 종목: 15분봉 96개(약 24시간) 기간 점검
- 정밀 기간분석: 기본 30종목(환경변수로 20~40)
- 호가·체결 최종검증: 8종목

## 공식 API 변경 반영

- `/v1/ticker/all?quote_currencies=KRW`로 원화마켓 현재가 일괄 조회
- `/v1/orderbook/instruments`의 공식 `tick_size` 사용
- 서버 간 호출에서 업비트 API 그룹별 초당 제한을 보수적으로 준수하도록 캔들 요청을 7개 단위로 순차 처리
