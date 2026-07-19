# github-webhook

GitHub App 웹훅을 수신해 XP를 지급하고 수신 이벤트를 기록하는 Edge Function.

흐름: `nginx → Kong → edge-runtime` → 서명 검증(HMAC-SHA256) → 이벤트 라우팅 → `awardXP()` → `add_pet_exp` RPC.

## XP 가중치 (env 외부화)

가중치는 `lib/xp-weights.ts`에서 env로 읽는다. env 미설정/파싱 실패 시 코드 기본값으로 폴백한다.
값은 `docker-compose.yml`의 functions 서비스 environment와 `.env`에서 주입된다.

| env | 기본값 | 의미 |
|---|---|---|
| `XP_PUSH_PER_COMMIT` | 10 | 커밋 1개당 XP |
| `XP_PUSH_MAX` | 50 | push 1회 최대 XP |
| `XP_PR_OPENED` | 15 | PR open |
| `XP_PR_MERGED` | 60 | PR merge |
| `XP_PR_CLOSED` | 10 | PR close |
| `XP_ISSUE_OPENED` | 8 | issue open |
| `XP_ISSUE_CLOSED` | 25 | issue close |
| `XP_STAR` | 3 | star |

### 값 변경 방법

1. `.env`에서 해당 키 수정 (예: `XP_STAR=5`)
2. functions 컨테이너 재시작: `docker compose up -d functions`

가중치는 모듈 로드 시점에 한 번 읽혀 고정된다. 따라서 재배포/재시작 없이 런타임 중 반영되지는 않는다.
(요청마다 재평가하는 방식은 핸들러 무수정 원칙과 트레이드오프가 있어 상수형을 택함.)

### 변경 사유 (2026-07 외부화 시점)

기존 하드코딩 → env 이전. 이관과 함께 노션 태스크 추천값을 반영:

- PR merged 50 → 60, issue opened 5 → 8, star 5 → 3
- **PR opened 0 → 15 (⚠️ 리뷰 확인 요청)**: 직전 튜닝(`feature/xp-weight-tuning-v1`)에서
  open/close 반복 어뷰징 방지를 위해 0으로 낮췄던 값을, 노션 추천값(15)에 맞춰 되돌린 것.
  어뷰징 방지 관점에서 재검토가 필요하면 이 값을 0으로 유지할 것.

## 수신 이벤트 로깅 (webhook_events)

지원 이벤트(push/pull_request/issues/star) 수신 시, 지급 결과와 함께 `webhook_events`에 기록한다
(`lib/log-event.ts`). 미가입 유저·스킵 케이스도 수신 자체는 기록된다.

- `delivery_id` unique → 동일 delivery 재전송(Kong retry 등) 시 중복 기록 방지
- 로깅 실패는 삼켜서 웹훅 200 응답을 막지 않는다 (GitHub 재전송 방지)
- 원본 페이로드는 저장하지 않고 SHA-256 해시(`raw_payload_hash`)만 기록

> XP 지급 자체의 멱등성은 `activities.github_event_id`(05_sync_activities)가 담당한다.
> `webhook_events`는 수신 감사 로그 관점이라 역할이 분리돼 있다.
