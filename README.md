# auto-trading

Toss Securities Open API 기반 페이퍼 트레이딩 / 자동매매 플랫폼.
전략을 페이퍼에서 검증 → 성과 기준 통과 시 실거래로 승격.

- 설계: [`PLAN.md`](./PLAN.md)
- API 스펙: [`docs/toss-api-spec.md`](./docs/toss-api-spec.md)

## 스택
- **Node + TypeScript** — TossApiClient, Broker(Paper/Live), MarketDataWorker, 대시보드 API
- **Python** — 백테스트, 성과/지표 계산(MDD/Profit Factor) — `python/`
- **PostgreSQL** — 영속 저장

## 보안 (필독)
- `client_secret`은 `.env`에만. **커밋 금지, 채팅 붙여넣기 금지.** `.env`는 gitignore됨.
- 토큰/시크릿은 로그·파일에 절대 안 찍음. `docs/probe-result.json`도 gitignore(마스킹됨).

## 빠른 시작
```bash
cp .env.example .env          # 그리고 client_id/secret 채우기
npm install
npm run probe                 # live API 검증 (읽기 전용, 주문 안 넣음)
```
`npm run probe` 결과로 확정되는 것: 토큰 수명(`expires_in`), 경로 prefix(`/v1` vs `/api/v1`),
rate-limit 헤더, accounts/holdings/price/orders 응답 shape.

## 현재 상태 (Phase 1)
- [x] Phase 0 — API 스펙 검증 (`docs/toss-api-spec.md`)
- [x] 스캐폴드: env config, TokenManager, TossApiClient 골격, live probe
- [ ] probe 실행 → ⚠️ 항목 확정 → TossApiClient 경로/파라미터 fix
- [ ] Broker 인터페이스 + PaperBroker (TDD)
- [ ] MarketDataWorker (폴링)
- [ ] DB 스키마(PLAN §7) 마이그레이션
# auto-trade
